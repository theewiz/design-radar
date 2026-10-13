/**
 * Phase 9 — environment configuration coverage.
 *
 * The Edge Function receives its configuration from the Supabase Edge
 * environment, not from `.env`. A variable that only the Node CLI knows about is
 * therefore a variable that fails silently in production: the run reports
 * something like "0 classified" rather than "GEMINI_API_KEY is missing".
 *
 * These tests check the declarations rather than the values. Nothing here reads a
 * real secret, and no assertion prints one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getEnv, isConfigured } from '../src/utils/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every environment variable the radar pipeline reads, with what it is for.
 * Kept in one place so the README and `.env.example` can be checked against it.
 */
const REQUIRED_VARIABLES = {
  SUPABASE_URL: 'Supabase project URL. Required for dedup, persistence, and the digest.',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service-role credential. Required for all database access.',
  SEARCH_API_KEY: 'Search provider credential (Serper by default). Required for discovery mode.',
  SEARCH_PROVIDER: 'Search provider name. Optional; defaults to "serper".',
  GEMINI_API_KEY: 'Gemini credential. Required for classification.',
  GEMINI_MODEL: 'Gemini model name. Optional; a default is used when unset.',
  NOTIFICATION_PROVIDER: 'Notification provider name. Optional; defaults to the configured default.',
  NTFY_BASE_URL: 'ntfy server URL. Required for notification delivery.',
  NTFY_TOPIC: 'ntfy topic. Required for notification delivery.',
  NTFY_TOKEN: 'ntfy access token. Optional; required only for protected topics.',
  TIMEZONE: 'Display timezone for the CLI banner. Does not affect cron, which is UTC.',
  DIGEST_LOOKBACK_HOURS: 'Digest lookback window in hours. Optional; defaults to 168.',
  MIN_RELEVANCE_SCORE: 'Priority threshold in points. Ranks qualified posts; never gates them.',
};

describe('Phase 9 — environment variable coverage', () => {
  it('getEnv reads the current environment on Node', () => {
    const env = getEnv();
    assert.equal(typeof env, 'object');
    // A live view, not a copy: a caller that mutates the environment sees it.
    process.env.DESIGN_RADAR_PHASE9_PROBE = 'set-at-runtime';
    assert.equal(env.DESIGN_RADAR_PHASE9_PROBE, 'set-at-runtime');
    delete process.env.DESIGN_RADAR_PHASE9_PROBE;
  });

  it('getEnv never throws when no environment is available', () => {
    assert.doesNotThrow(() => getEnv());
  });

  it('isConfigured reports presence without revealing a value', () => {
    assert.equal(isConfigured({ KEY: 'a-secret-value' }, 'KEY'), true);
    assert.equal(isConfigured({ KEY: '' }, 'KEY'), false);
    assert.equal(isConfigured({ KEY: '   ' }, 'KEY'), false, 'whitespace is not configuration');
    assert.equal(isConfigured({}, 'KEY'), false);
    assert.equal(isConfigured(undefined, 'KEY'), false);
    assert.equal(isConfigured({ KEY: 42 }, 'KEY'), false, 'a non-string is not a usable credential');
  });

  it('documents every required variable in .env.example', async () => {
    const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');

    for (const name of Object.keys(REQUIRED_VARIABLES)) {
      assert.ok(
        example.includes(name),
        `.env.example is missing ${name}, which the pipeline requires`
      );
    }
  });

  it('documents every required variable in the README', async () => {
    const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');

    for (const name of Object.keys(REQUIRED_VARIABLES)) {
      assert.ok(
        readme.includes(name),
        `README.md is missing ${name}, which the pipeline requires`
      );
    }
  });

  it('never commits a real credential', async () => {
    const files = [
      '.env.example',
      'README.md',
      'supabase/functions/daily-radar/index.js',
      'supabase/config.toml',
      'supabase/migrations/005_phase9_scheduling.sql',
    ];

    // Shapes that indicate a live credential rather than a placeholder.
    const credentialPatterns = [
      /AIza[0-9A-Za-z_-]{20,}/,
      /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/,
      /sk-[0-9A-Za-z]{20,}/,
    ];

    for (const file of files) {
      const contents = await readFile(path.join(ROOT, file), 'utf8');
      for (const pattern of credentialPatterns) {
        assert.equal(
          pattern.test(contents),
          false,
          `${file} appears to contain a live credential matching ${pattern}`
        );
      }
    }
  });
});