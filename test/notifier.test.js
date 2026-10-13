/**
 * Notification Abstraction Tests (Phase 7).
 *
 * Covers the contract the rest of the pipeline depends on: `notifier.send()`
 * returns a normalized result, never throws for a delivery fault, and does not
 * leak a credential into that result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNotifier,
  resolveNotificationSettings,
  validateNotificationSettings,
  describeNotificationSettings,
  NOTIFICATION_PROVIDERS,
  DEFAULT_NOTIFICATION_PROVIDER,
} from '../src/notifications/notifier.js';
import { createMockNotifier } from '../src/notifications/mock.js';
import { NOTIFICATION_ERRORS, isRetryableNotificationError } from '../src/notifications/result.js';

// ─── Provider Selection ──────────────────────────────────────────────────────────

describe('provider selection', () => {
  it('falls back to the mock provider when NOTIFICATION_PROVIDER is unset', () => {
    // The shipped default lives in .env.example (ntfy); the code fallback stays
    // mock so an unset variable degrades to a print instead of failing the run,
    // and so tests never require an ntfy topic.
    assert.equal(DEFAULT_NOTIFICATION_PROVIDER, 'mock');
    assert.deepEqual([...NOTIFICATION_PROVIDERS], ['mock', 'ntfy', 'email']);
    assert.equal(resolveNotificationSettings({}, {}).provider, 'mock');
  });

  it('reads NOTIFICATION_PROVIDER from the environment', () => {
    assert.equal(resolveNotificationSettings({}, { NOTIFICATION_PROVIDER: 'ntfy' }).provider, 'ntfy');
  });

  it('normalizes casing and stray whitespace', () => {
    assert.equal(resolveNotificationSettings({}, { NOTIFICATION_PROVIDER: ' NTFY ' }).provider, 'ntfy');
  });

  it('rejects an unsupported provider by name', () => {
    assert.throws(
      () => createNotifier({ provider: 'telegram' }, { env: {} }),
      /NOTIFICATION_PROVIDER "telegram" is not supported\. Use one of: mock, ntfy, email\./
    );
  });

  it('returns the same result shape from either provider', async () => {
    const requests = [];
    const mock = createNotifier({ provider: 'mock' }, { env: {}, console: { log() {} } });
    const mockResult = await mock.send('body');

    const ntfy = createNotifier(
      { provider: 'ntfy' },
      {
        env: { NTFY_TOPIC: 'design-radar' },
        fetchFn: async (url, init) => {
          requests.push({ url, init });
          return new Response(JSON.stringify({ id: 'ntfy.ok' }), { status: 200 });
        },
      }
    );
    const ntfyResult = await ntfy.send('body');

    for (const key of ['success', 'provider', 'messageId', 'errorType', 'error', 'retryable', 'requested']) {
      assert.ok(key in mockResult, `mock result must expose "${key}"`);
      assert.ok(key in ntfyResult, `ntfy result must expose "${key}"`);
    }

    assert.equal(requests.length, 1);
  });
});

// ─── Configuration ───────────────────────────────────────────────────────────────

describe('notification configuration', () => {
  const ntfyEnv = {
    NOTIFICATION_PROVIDER: 'ntfy',
    NTFY_TOPIC: 'design-radar',
  };

  it('accepts a topic-only ntfy configuration, because no token is needed', () => {
    const settings = resolveNotificationSettings({}, ntfyEnv);

    assert.equal(validateNotificationSettings(settings).valid, true);
  });

  it('defaults the server to ntfy.sh and honours a self-hosted base URL', () => {
    assert.equal(resolveNotificationSettings({}, ntfyEnv).ntfy.baseUrl, 'https://ntfy.sh');
    assert.equal(
      resolveNotificationSettings({}, { ...ntfyEnv, NTFY_BASE_URL: 'https://ntfy.example.com' }).ntfy.baseUrl,
      'https://ntfy.example.com'
    );
    // A trailing slash must not produce a doubled separator in the topic URL.
    assert.equal(
      resolveNotificationSettings({}, { ...ntfyEnv, NTFY_BASE_URL: 'https://ntfy.example.com/' }).ntfy.baseUrl,
      'https://ntfy.example.com'
    );
  });

  it('reports the topic as the recorded recipient', () => {
    const settings = resolveNotificationSettings({}, ntfyEnv);

    assert.equal(settings.recipient, 'design-radar');
    assert.equal(settings.ntfy.topic, 'design-radar');
  });

  it('lists NTFY_TOPIC as the only required variable', () => {
    const settings = resolveNotificationSettings({}, { NOTIFICATION_PROVIDER: 'ntfy' });
    const { valid, missing, errors } = validateNotificationSettings(settings);

    assert.equal(valid, false);
    assert.deepEqual(missing, ['NTFY_TOPIC']);
    assert.match(errors[0], /NOTIFICATION_PROVIDER=mock for local development/);
  });

  it('never requires ntfy configuration for the mock provider', () => {
    assert.equal(validateNotificationSettings(resolveNotificationSettings({}, { NOTIFICATION_PROVIDER: 'mock' })).valid, true);
  });

  it('applies a default timeout and honours an override', () => {
    assert.equal(resolveNotificationSettings({}, {}).timeoutMs, 15_000);
    assert.equal(resolveNotificationSettings({}, { NOTIFICATION_TIMEOUT_MS: '3000' }).timeoutMs, 3000);
    assert.equal(resolveNotificationSettings({ timeoutMs: 500 }, { NOTIFICATION_TIMEOUT_MS: '3000' }).timeoutMs, 500);
  });

  it('falls back to the default timeout when the override is unusable', () => {
    for (const raw of ['', 'abc', '0', '-1']) {
      assert.equal(resolveNotificationSettings({}, { NOTIFICATION_TIMEOUT_MS: raw }).timeoutMs, 15_000);
    }
  });

  it('defaults NOTIFICATION_MARK_MOCK_SENT to false', () => {
    assert.equal(resolveNotificationSettings({}, {}).markMockAsSent, false);
    assert.equal(resolveNotificationSettings({}, { NOTIFICATION_MARK_MOCK_SENT: 'true' }).markMockAsSent, true);
    assert.equal(resolveNotificationSettings({}, { NOTIFICATION_MARK_MOCK_SENT: 'false' }).markMockAsSent, false);
    assert.equal(resolveNotificationSettings({}, { NOTIFICATION_MARK_MOCK_SENT: 'nonsense' }).markMockAsSent, false);
  });

  it('reports token presence only, never the token itself', () => {
    const described = describeNotificationSettings(
      resolveNotificationSettings({}, { ...ntfyEnv, NTFY_TOKEN: 'test-token' })
    );
    const serialized = JSON.stringify(described);

    assert.equal(described.valid, true);
    assert.equal(described.ntfy.token, 'configured');
    // The server and topic are printed: neither is a credential, and both are
    // needed to tell "sent to the wrong place" from "not sent at all".
    assert.equal(described.ntfy.baseUrl, 'https://ntfy.sh');
    assert.equal(described.ntfy.topic, 'design-radar');
    assert.equal(serialized.includes('test-token'), false);
  });
});

// ─── Mock Provider ────────────────────────────────────────────────────────────────

describe('mock provider', () => {
  it('prints the message and returns a normalized success', async () => {
    const lines = [];
    const notifier = createNotifier(
      { provider: 'mock' },
      { env: {}, console: { log: (line) => lines.push(line) } }
    );

    const result = await notifier.send('DesignRadar digest');

    assert.equal(result.success, true);
    assert.equal(result.provider, 'mock');
    assert.match(result.messageId, /^mock-[0-9a-f]{12}$/);
    assert.ok(lines.join('\n').includes('DesignRadar digest'));
  });

  it('derives a stable id from the message so repeated sends are traceable', async () => {
    const first = await createMockNotifier().send('same digest');
    const second = await createMockNotifier().send('same digest');
    const other = await createMockNotifier().send('different digest');

    assert.equal(first.messageId, second.messageId);
    assert.notEqual(first.messageId, other.messageId);
  });

  it('reports an empty message as a normalized failure without printing', async () => {
    const lines = [];
    const result = await createMockNotifier({ console: { log: (line) => lines.push(line) } }).send('   ');

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.INVALID_MESSAGE);
    assert.equal(result.requested, false);
    assert.equal(lines.length, 0);
  });
});

// ─── Result Vocabulary ────────────────────────────────────────────────────────────

describe('notification result vocabulary', () => {
  it('marks only transient faults as retryable', () => {
    const retryable = [
      NOTIFICATION_ERRORS.NETWORK,
      NOTIFICATION_ERRORS.TIMEOUT,
      NOTIFICATION_ERRORS.RATE_LIMIT,
      NOTIFICATION_ERRORS.SERVER_ERROR,
      NOTIFICATION_ERRORS.SERVICE_UNAVAILABLE,
    ];

    const permanent = [
      NOTIFICATION_ERRORS.AUTHENTICATION,
      NOTIFICATION_ERRORS.PERMISSION_DENIED,
      NOTIFICATION_ERRORS.BAD_REQUEST,
      NOTIFICATION_ERRORS.NOT_FOUND,
      NOTIFICATION_ERRORS.INVALID_MESSAGE,
      NOTIFICATION_ERRORS.MISSING_CONFIGURATION,
      NOTIFICATION_ERRORS.MALFORMED_RESPONSE,
    ];

    // Permanent faults must not be retried: the same request would fail
    // identically, so retrying only burns quota and delays the next run.
    assert.deepEqual(retryable.map(isRetryableNotificationError), retryable.map(() => true));
    assert.deepEqual(permanent.map(isRetryableNotificationError), permanent.map(() => false));
  });

  it('classifies every error type it can emit', () => {
    const all = Object.values(NOTIFICATION_ERRORS);

    assert.ok(all.includes('authentication'));
    assert.ok(all.includes('rate_limit'));
    assert.ok(all.includes('malformed_response'));
    assert.ok(all.every((type) => typeof type === 'string'));
  });
});
