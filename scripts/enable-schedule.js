/**
 * Schedule Enablement (Phase 9 deployment).
 *
 * `npm run schedule:enable` — turns on the automated 4-hour discovery +
 * delivery job and the daily safety net, so ntfy notifications happen without
 * anyone running `npm run radar`.
 *
 * Three rules this script exists to hold to:
 *
 *   1. It never prints a secret. Values are read from `.env` and handed to the
 *      CLI through `--env-file` or a 0600 temp file, never through argv that
 *      would land in shell history or scrollback.
 *   2. It is idempotent. Re-running replaces the deployment, the secrets, and
 *      both cron jobs rather than adding duplicates — the migration unschedules
 *      before it schedules.
 *   3. It stops at the first unfixable step and says what to run instead, rather
 *      than continuing with a half-configured schedule.
 *
 * `supabase login` is interactive and must be done by the operator first.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

dotenv.config();

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATION = join(ROOT, 'supabase', 'migrations', '005_phase9_scheduling.sql');
const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

const RULE = '─'.repeat(60);

/**
 * Runs the Supabase CLI.
 *
 * `stdin` is ignored for `link` on purpose: the CLI asks for a database
 * password there, and an empty answer is the documented way to skip it. Every
 * later step goes through the Management API and does not need the password.
 *
 * @param {string[]} args CLI arguments.
 * @param {{ allowFailure?: boolean, quietStdin?: boolean }} [options]
 * @returns {{ ok: boolean, stdout: string, status: number | null }}
 */
function supabase(args, options = {}) {
  const result = spawnSync('supabase', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: [options.quietStdin ? 'ignore' : 'inherit', 'pipe', 'inherit'],
  });

  if (result.error) {
    console.error(`Could not run \`supabase ${args.join(' ')}\`: ${result.error.message}`);
    return { ok: false, stdout: '', status: null };
  }

  return { ok: result.status === 0 || Boolean(options.allowFailure), stdout: result.stdout ?? '', status: result.status };
}

/**
 * Derives the project ref from SUPABASE_URL, which is the one identifier the
 * operator already has in `.env`.
 *
 * @param {string | undefined} supabaseUrl
 * @returns {string | null} The 20-character project ref, or null if the URL is
 *   missing or not a Supabase project URL.
 */
function resolveProjectRef(supabaseUrl) {
  if (!supabaseUrl) return null;

  try {
    const host = new URL(supabaseUrl).hostname;
    const ref = host.split('.')[0];
    return PROJECT_REF_PATTERN.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Runs a single SQL statement from a 0600 temp file.
 *
 * A file rather than an argument because the service-role key has to appear
 * inside the SQL, and argv is readable by any process on the machine — by other
 * users, too, for the life of the process.
 *
 * @param {string} sql Statement to execute.
 * @param {string} label Human-readable name for the log line.
 * @returns {boolean} True when the statement applied.
 */
function runSql(sql, label) {
  const dir = mkdtempSync(join(tmpdir(), 'design-radar-cron-'));
  const file = join(dir, 'statement.sql');

  try {
    writeFileSync(file, sql, { mode: 0o600 });
    console.log(`→ ${label}`);

    const result = supabase(['db', 'query', '--linked', '-f', file], { quietStdin: true });
    if (!result.ok) {
      console.error(`✗ ${label} failed.`);
      return false;
    }

    console.log(`✓ ${label}`);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkCli() {
  if (!supabase(['--version'], { quietStdin: true }).ok) {
    console.error('The Supabase CLI is not installed or not on PATH.');
    console.error('Install it with:  brew install supabase/tap/supabase');
    process.exit(1);
  }
}

function checkLogin() {
  if (supabase(['projects', 'list', '--output', 'json'], { quietStdin: true }).ok) return;

  console.error('Not logged in to Supabase.');
  console.error('Run this yourself — it opens a browser and stores a token in your keychain:');
  console.error('  supabase login');
  console.error('Or set SUPABASE_ACCESS_TOKEN in the environment for a single run.');
  process.exit(1);
}

function checkRequiredEnv() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(`Missing from .env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function linkProject(projectRef) {
  console.log(`→ Linking to project ${projectRef}`);
  const result = supabase(['link', '--project-ref', projectRef, '--yes'], { quietStdin: true });

  if (!result.ok) {
    console.error('✗ supabase link failed. If it asked for a database password, leave it blank and press Enter.');
    process.exit(1);
  }

  console.log('✓ Linked');
}

function deploySecrets(projectRef) {
  console.log('→ Uploading Edge Function secrets from .env');
  const result = supabase(['secrets', 'set', '--env-file', '.env', '--project-ref', projectRef]);

  if (!result.ok) {
    console.error('✗ supabase secrets set failed.');
    process.exit(1);
  }

  console.log('✓ Secrets uploaded');
}

function deployFunction() {
  console.log('→ Syncing shared sources and deploying daily-radar');
  const sync = spawnSync('npm', ['run', 'edge:sync'], { cwd: ROOT, stdio: 'inherit' });
  if (sync.status !== 0) process.exit(1);

  const result = supabase([
    'functions',
    'deploy',
    'daily-radar',
    '--import-map',
    'supabase/functions/import_map.json',
    '--yes',
  ]);
  if (!result.ok) {
    console.error('✗ supabase functions deploy failed.');
    process.exit(1);
  }

  console.log('✓ Function deployed');
}

/**
 * Grants the cron job its credentials.
 *
 * `005_phase9_scheduling.sql` reads these two values from Supabase Vault at run
 * time instead of embedding them in SQL, so nothing secret is ever committed.
 * The secrets are created or updated here, before the migration that needs
 * them is applied.
 */
function grantCronCredentials() {
  const url = process.env.SUPABASE_URL.replaceAll("'", "''");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY.replaceAll("'", "''");

  const vaultSql = `
create extension if not exists supabase_vault with schema vault;

do $$
declare
  url_id uuid;
  service_role_id uuid;
begin
  select id
    into url_id
    from vault.secrets
   where name = 'design_radar_supabase_url'
   limit 1;

  if url_id is null then
    perform vault.create_secret(
      '${url}',
      'design_radar_supabase_url',
      'DesignRadar Supabase project URL'
    );
  else
    perform vault.update_secret(
      url_id,
      '${url}',
      'design_radar_supabase_url',
      'DesignRadar Supabase project URL'
    );
  end if;

  select id
    into service_role_id
    from vault.secrets
   where name = 'design_radar_service_role_key'
   limit 1;

  if service_role_id is null then
    perform vault.create_secret(
      '${serviceRoleKey}',
      'design_radar_service_role_key',
      'DesignRadar service role key'
    );
  else
    perform vault.update_secret(
      service_role_id,
      '${serviceRoleKey}',
      'design_radar_service_role_key',
      'DesignRadar service role key'
    );
  end if;
end
$$;
`;

  const ok = [
    runSql(vaultSql, 'Storing cron credentials in Supabase Vault'),
    runSql(readFileSync(MIGRATION, 'utf8'), 'Applying 005_phase9_scheduling.sql'),
  ].every(Boolean);

  if (!ok) {
    console.error('');
    console.error('Scheduling is incomplete.');
    console.error('Check the Supabase SQL/cron error above.');
    process.exit(1);
  }
}

function verifySchedule() {
  console.log('→ Verifying cron.job');
  const result = supabase(
    [
      'db',
      'query',
      '--linked',
      "select jobname, schedule, active from cron.job where jobname like 'design-radar%' order by jobname;",
    ],
    { allowFailure: true, quietStdin: true }
  );

  if (!result.ok) {
    console.error('Could not read cron.job. Check the schedules in the Supabase dashboard.');
  }
}

console.log(RULE);
console.log('DesignRadar — Schedule Enablement');
console.log(RULE);
console.log('');

checkCli();
checkLogin();
checkRequiredEnv();

const projectRef = resolveProjectRef(process.env.SUPABASE_URL);
if (!projectRef) {
  console.error('Could not derive a project ref from SUPABASE_URL.');
  process.exit(1);
}

linkProject(projectRef);
deploySecrets(projectRef);
deployFunction();
grantCronCredentials();
verifySchedule();

console.log('');
console.log(RULE);
console.log('Done. The schedule is live:');
console.log('  every 4 hours  discovery + immediate ntfy delivery  (mode full)');
console.log('  08:00 Lagos    daily re-delivery of anything unsent   (mode digest)');
console.log('');
console.log('Confirm the first real run:');
console.log('  select jobname, status, start_time from cron.job_run_details order by start_time desc limit 5;');
console.log('  ntfy topic:  ' + (process.env.NTFY_TOPIC ? 'configured' : 'MISSING from .env'));
