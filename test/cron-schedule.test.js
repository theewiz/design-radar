/**
 * Phase 9 — production schedule.
 *
 * The schedule is the one part of this feature that cannot fail loudly. A wrong
 * cron expression does not throw: it simply runs discovery eleven times a day, or
 * sends the digest at 09:00 in Lagos, and nobody notices for a week. These tests
 * read the migration as text and pin the properties that matter, so a careless
 * edit to the SQL fails the build instead.
 *
 * This is a static check, not an integration test. Nothing here talks to
 * Postgres — the migration has never been applied (see README, Known Gaps).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RADAR_MODES } from '../src/radar/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '005_phase9_scheduling.sql');

const CRON_DISCOVERY = '0 */4 * * *';
const CRON_DIGEST = '0 7 * * *';

/**
 * Reads the scheduling migration.
 *
 * @returns {Promise<string>}
 */
async function migration() {
  return readFile(MIGRATION, 'utf8');
}

/**
 * Extracts the cron expression passed to `cron.schedule` for a job name.
 *
 * @param {string} sql Migration source.
 * @param {string} jobName
 * @returns {string | null} The expression, or null when the job is absent.
 */
function scheduleFor(sql, jobName) {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`cron\\.schedule\\(\\s*'${escaped}'\\s*,\\s*\\$cron\\$([^$]+)\\$cron\\$`, 'i')
  );
  return match ? match[1].trim() : null;
}

/**
 * Extracts the JSON body a job posts to the Edge Function.
 *
 * The search starts at the job's `cron.schedule(` call rather than at its first
 * mention: the migration also names both jobs in the preceding unschedule block,
 * so a naive search would read the wrong occurrence.
 *
 * @param {string} sql Migration source.
 * @param {string} jobName
 * @returns {string | null} The mode, or null when the job is absent.
 */
function modeFor(sql, jobName) {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Bounded by the job's `$body$ ... $body$` block. Matching to the next `$$`
  // instead would stop inside `do $$`, before the request body.
  const schedule = sql.match(
    new RegExp(`cron\\.schedule\\(\\s*'${escaped}'[\\s\\S]*?\\$body\\$[\\s\\S]*?\\$body\\$`, 'i')
  );
  if (!schedule) {
    return null;
  }

  const match = schedule[0].match(/jsonb_build_object\(\s*'mode',\s*'(\w+)'\s*\)/i);
  return match ? match[1] : null;
}

describe('Phase 9 — cron schedule', () => {
  it('registers exactly the two expected jobs', async () => {
    const sql = await migration();
    const jobs = [...sql.matchAll(/cron\.schedule\(\s*'([^']+)'/g)].map((m) => m[1]);

    assert.deepEqual(jobs.sort(), ['design-radar-digest', 'design-radar-discovery']);
  });

  it('runs discovery every 4 hours', async () => {
    const sql = await migration();
    assert.equal(scheduleFor(sql, 'design-radar-discovery'), CRON_DISCOVERY);
  });

  it('runs the digest daily at 07:00 UTC', async () => {
    const sql = await migration();
    assert.equal(scheduleFor(sql, 'design-radar-digest'), CRON_DIGEST);
  });

  it('does not schedule the digest at 08:00 UTC', async () => {
    // 08:00 UTC is 09:00 in Lagos (UTC+1). Scheduling there would deliver the
    // daily digest an hour late, every day.
    const sql = await migration();

    for (const [, expression] of sql.matchAll(/\$cron\$([^$]+)\$cron\$/g)) {
      assert.notEqual(
        expression.trim(),
        '0 8 * * *',
        `the digest must not be scheduled at 08:00 UTC (found "${expression.trim()}")`
      );
    }
  });

  it('invokes full mode from the 4-hour job, so new posts are delivered immediately', async () => {
    // Mode 'discovery' would search, classify, and persist without notifying —
    // a new opportunity would then wait for the daily job. The 4-hour job must
    // deliver, and only new posts are sent, so this is not six digests a day.
    const sql = await migration();
    assert.equal(modeFor(sql, 'design-radar-discovery'), RADAR_MODES.FULL);
  });

  it('keeps the daily job on digest mode as a re-delivery safety net', async () => {
    const sql = await migration();
    assert.equal(modeFor(sql, 'design-radar-digest'), RADAR_MODES.DIGEST);
  });

  it('waits long enough for a run to report back', async () => {
    // net.http_post defaults to a 5000 ms timeout, which is shorter than a
    // real mode-'full' run. The first scheduled invocation therefore recorded
    // timed_out = true at 5 s while the function kept running — the job looked
    // broken even when it delivered, and net._http_response held no status or
    // body to check. Both jobs must pass an explicit timeout of their own.
    const sql = await migration();
    const timeouts = [...sql.matchAll(/timeout_milliseconds\s*:=\s*(\d+)/g)].map((m) =>
      Number(m[1])
    );

    assert.equal(timeouts.length, 2, 'every net.http_post must set an explicit timeout');
    for (const timeout of timeouts) {
      assert.ok(
        timeout >= 60_000,
        `a ${timeout} ms timeout is shorter than a full run, which needs 15-60 s`
      );
    }
  });

  it('schedules the digest exactly once', async () => {
    // The failure this guards against: a re-applied migration that appends a
    // second digest job, delivering every post twice a day.
    const sql = await migration();
    const digestJobs = [...sql.matchAll(/cron\.schedule\(\s*'([^']*digest[^']*)'/gi)];

    assert.equal(digestJobs.length, 1, 'exactly one job may deliver a digest');
    assert.equal(scheduleFor(sql, 'design-radar-digest'), CRON_DIGEST);
  });

  it('is re-runnable, so re-applying replaces rather than duplicates', async () => {
    const sql = await migration();

    assert.match(sql, /cron\.unschedule/, 'the migration must unschedule before rescheduling');
    for (const jobName of ['design-radar-discovery', 'design-radar-digest']) {
      assert.ok(
        sql.includes(`'${jobName}'`),
        `${jobName} must be named in the unschedule step`
      );
    }
  });

  it('states that the schedules are UTC', async () => {
    const sql = await migration();
    assert.match(sql, /UTC/, 'the migration must state the timezone its schedules use');
    assert.match(sql, /Africa\/Lagos/i, 'and record the local time the digest corresponds to');
  });

  it('does not change the database timezone', async () => {
    const sql = await migration();
    assert.equal(
      /^\s*(alter\s+database|set\s+timezone|alter\s+role)/im.test(sql),
      false,
      'the migration must not alter the database timezone'
    );
  });

  it('contains no plaintext credential', async () => {
    const sql = await migration();

    // Reads its credential from Supabase Vault at run time, by secret name.
    assert.match(
      sql,
      /from\s+vault\.decrypted_secrets/i,
      'the service role key must be read from Vault, not embedded'
    );
    assert.match(
      sql,
      /design_radar_service_role_key/i,
      'and under the documented secret name, so an operator can update it'
    );

    // No literal credential-shaped value anywhere in the file.
    const credentialPatterns = [
      /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/,
      /AIza[0-9A-Za-z_-]{20,}/,
      /sk-[0-9A-Za-z]{20,}/,
    ];
    for (const pattern of credentialPatterns) {
      assert.equal(pattern.test(sql), false, `migration contains a credential matching ${pattern}`);
    }

    // Any assignment to the settings must be an operator instruction, not SQL
    // this migration executes.
    const executed = sql
      .split('\n')
      .filter((line) => /^\s*alter\s+database/i.test(line));
    assert.deepEqual(
      executed,
      [],
      'the provisioning statements must be documented, not executed by the migration'
    );
  });

  it('fails loudly when the credential is not configured', async () => {
    // A misconfigured cron that silently no-ops would be discovered only when the
    // user notices no digest arrived.
    const sql = await migration();
    const raiseCount = (sql.match(/raise\s+exception/gi) || []).length;

    assert.ok(
      raiseCount >= 4,
      `expected a raise for each job and each missing setting, found ${raiseCount}`
    );
    assert.match(sql, /Supabase URL is missing from Vault/i);
    assert.match(sql, /service-role key is missing from Vault/i);
  });

  it('requires the extensions it schedules with', async () => {
    const sql = await migration();
    assert.match(sql, /create extension if not exists pg_cron/i);
    assert.match(sql, /create extension if not exists pg_net/i);
    // Credentials come from Vault, so the migration must provision it too.
    assert.match(sql, /create extension if not exists supabase_vault/i);
  });

  it('does not modify an earlier migration', async () => {
    // Historical migrations are immutable; Phase 9 adds a new file only.
    const earlier = await readFile(
      path.join(ROOT, 'supabase', 'migrations', '001_initial_schema.sql'),
      'utf8'
    );
    assert.equal(
      /cron|net\.http_post|pg_net/i.test(earlier),
      false,
      'scheduling must not leak into an earlier migration'
    );
  });
});

describe('Phase 9 — Supabase configuration', () => {
  it('registers the function with JWT verification enabled', async () => {
    const config = await readFile(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');

    assert.match(config, /\[functions\.daily-radar\]/);
    assert.match(
      config,
      /verify_jwt\s*=\s*true/,
      'the function calls paid APIs and can notify, so it must not be anonymous'
    );
  });
});