/**
 * Phase 9 — radar execution modes.
 *
 * Covers the rule that keeps the production schedule honest: discovery runs six
 * times a day, so if a discovery run could notify, the daily digest would go out
 * six times instead of once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RADAR_MODES,
  resolveRunMode,
  deriveDigestRunStatus,
} from '../src/radar/index.js';

test('Phase 9 — resolveRunMode', async (t) => {
  await t.test("defaults to 'full' when no mode is supplied", () => {
    // Backwards compatibility: runRadar() and `npm run radar` must still run the
    // complete pipeline.
    assert.deepEqual(resolveRunMode(), {
      mode: 'full',
      runDiscovery: true,
      runNotification: true,
    });
    assert.deepEqual(resolveRunMode({}), {
      mode: 'full',
      runDiscovery: true,
      runNotification: true,
    });
  });

  await t.test("'discovery' searches and persists but never notifies", () => {
    assert.deepEqual(resolveRunMode({ mode: 'discovery' }), {
      mode: 'discovery',
      runDiscovery: true,
      runNotification: false,
    });
  });

  await t.test("'digest' delivers stored posts without searching", () => {
    assert.deepEqual(resolveRunMode({ mode: 'digest' }), {
      mode: 'digest',
      runDiscovery: false,
      runNotification: true,
    });
  });

  await t.test('honours the legacy digest:false flag as a scan-only run', () => {
    // `npm run scan` calls runRadar({ digest: false }); it must stay scan-only.
    assert.deepEqual(resolveRunMode({ digest: false }), {
      mode: 'full',
      runDiscovery: true,
      runNotification: false,
    });
  });

  await t.test('digest:false cannot re-enable a discovery-mode run', () => {
    const resolved = resolveRunMode({ mode: 'discovery', digest: false });
    assert.equal(resolved.runNotification, false);
  });

  await t.test('rejects an unknown mode instead of defaulting', () => {
    // A silent fallback here would send a digest on every 4-hour discovery run.
    assert.throws(() => resolveRunMode({ mode: 'notify' }), /Unsupported radar mode "notify"/);
    assert.throws(() => resolveRunMode({ mode: '' }), /Unsupported radar mode/);
    assert.throws(() => resolveRunMode({ mode: 'DIGEST' }), /Unsupported radar mode/);
    assert.throws(() => resolveRunMode({ mode: 42 }), /Unsupported radar mode/);
  });

  await t.test('exposes exactly the three supported modes', () => {
    assert.deepEqual(Object.values(RADAR_MODES).sort(), ['digest', 'discovery', 'full']);
  });
});

test('Phase 9 — deriveDigestRunStatus', async (t) => {
  await t.test('a delivered digest is operational', () => {
    const status = deriveDigestRunStatus({
      dbReady: true,
      digest: { empty: false },
      delivery: { attempted: true, success: true, markedCount: 4 },
    });
    assert.equal(status.status, 'OPERATIONAL');
    assert.match(status.reason, /4 post/);
  });

  await t.test('a failed delivery is FAILED, not a quiet success', () => {
    const status = deriveDigestRunStatus({
      dbReady: true,
      digest: { empty: false },
      delivery: { attempted: true, success: false, errorType: 'network', error: 'ntfy unreachable' },
    });
    assert.equal(status.status, 'FAILED');
    assert.match(status.reason, /ntfy unreachable/);
  });

  await t.test('an empty digest is not a failure', () => {
    // Nothing eligible to send is the same as a previous run already covering
    // these posts — there was nothing to deliver.
    const status = deriveDigestRunStatus({
      dbReady: true,
      digest: { empty: true },
      delivery: { attempted: false, success: false, skipped: true, reason: 'no_eligible_posts' },
    });
    assert.equal(status.status, 'OPERATIONAL');
    assert.match(status.reason, /Nothing to deliver/);
  });

  await t.test('reports PARTIAL when the database was unavailable', () => {
    const status = deriveDigestRunStatus({ dbReady: false, digest: null, delivery: null });
    assert.equal(status.status, 'PARTIAL');
    assert.match(status.reason, /Database not configured/);
  });

  await t.test('reports PARTIAL when a digest was built but nothing was attempted', () => {
    const status = deriveDigestRunStatus({ dbReady: true, digest: { empty: false }, delivery: null });
    assert.equal(status.status, 'PARTIAL');
  });
});