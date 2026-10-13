/**
 * Resend Email Provider Tests (Phase 10).
 *
 * The provider in `src/notifications/email.js` is exercised through a mocked
 * `fetch()`, so nothing in this file can reach api.resend.com. The mock returns
 * real `Response` objects so `.ok`, `.status` and `.text()` behave exactly as
 * the production code expects.
 *
 * The API key used here is the literal string 'test-api-key'. It is a stand-in,
 * not a credential.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NOTIFICATION_ERRORS } from '../src/notifications/result.js';
import { createNotifier } from '../src/notifications/notifier.js';
import {
  createEmailNotifier,
  readResendMessageId,
  renderEmailHtml,
  sanitizeEmailErrorBody,
  sendEmailMessage,
  RESEND_ENDPOINT,
} from '../src/notifications/email.js';
import {
  resolveNotificationSettings,
  validateNotificationSettings,
} from '../src/notifications/config.js';

const TEST_API_KEY = 'test-api-key';
const TEST_TO = 'test@example.com';
const TEST_FROM = 'radar@example.com';
const DIGEST = '🎨 *DESIGNRADAR*\nDaily Digest — 7 Oct 2026\n\n🔥 *Senior Product Designer* (Score: 85)';

// ─── Fetch Double ─────────────────────────────────────────────────────────────

/**
 * Builds a fetch double that records every call.
 *
 * @param {Object} [script]
 * @param {number} [script.status=200]
 * @param {string} [script.body=''] Response body.
 * @param {Error} [script.throws] Fail the request instead of answering it.
 * @returns {{ fetchFn: Function, calls: Array<{ url: string, init: object }> }}
 */
function fetchDouble(script = {}) {
  const calls = [];

  const fetchFn = async (url, init) => {
    calls.push({ url, init });

    if (script.throws) throw script.throws;

    return new Response(script.body ?? '', { status: script.status ?? 200 });
  };

  return { fetchFn, calls };
}

/** Complete email settings for tests. */
function emailSettings(overrides = {}) {
  return {
    provider: 'email',
    email: {
      apiKey: TEST_API_KEY,
      to: TEST_TO,
      from: TEST_FROM,
      subject: 'DesignRadar — Daily Digest',
      ...overrides,
    },
    timeoutMs: 15_000,
    ntfy: { baseUrl: 'https://ntfy.sh', topic: '', token: '', title: '', priority: '', tags: '' },
    recipient: TEST_TO,
    markMockAsSent: false,
  };
}

// ─── Provider Configuration ───────────────────────────────────────────────────

describe('email provider configuration', () => {
  it('email is a recognized provider', () => {
    const settings = resolveNotificationSettings(
      {},
      { NOTIFICATION_PROVIDER: 'email', RESEND_API_KEY: TEST_API_KEY, DESIGN_RADAR_EMAIL_TO: TEST_TO, DESIGN_RADAR_EMAIL_FROM: TEST_FROM }
    );

    assert.equal(settings.provider, 'email');
    const { valid } = validateNotificationSettings(settings);
    assert.equal(valid, true);
  });

  it('reports RESEND_API_KEY as missing when absent', () => {
    const settings = resolveNotificationSettings(
      {},
      { NOTIFICATION_PROVIDER: 'email', DESIGN_RADAR_EMAIL_TO: TEST_TO, DESIGN_RADAR_EMAIL_FROM: TEST_FROM }
    );
    const { valid, missing, errors } = validateNotificationSettings(settings);

    assert.equal(valid, false);
    assert.ok(missing.includes('RESEND_API_KEY'));
    assert.ok(errors.some((e) => e.includes('RESEND_API_KEY')));
  });

  it('reports DESIGN_RADAR_EMAIL_TO as missing when absent', () => {
    const settings = resolveNotificationSettings(
      {},
      { NOTIFICATION_PROVIDER: 'email', RESEND_API_KEY: TEST_API_KEY, DESIGN_RADAR_EMAIL_FROM: TEST_FROM }
    );
    const { valid, missing } = validateNotificationSettings(settings);

    assert.equal(valid, false);
    assert.ok(missing.includes('DESIGN_RADAR_EMAIL_TO'));
  });

  it('reports DESIGN_RADAR_EMAIL_FROM as missing when absent', () => {
    const settings = resolveNotificationSettings(
      {},
      { NOTIFICATION_PROVIDER: 'email', RESEND_API_KEY: TEST_API_KEY, DESIGN_RADAR_EMAIL_TO: TEST_TO }
    );
    const { valid, missing } = validateNotificationSettings(settings);

    assert.equal(valid, false);
    assert.ok(missing.includes('DESIGN_RADAR_EMAIL_FROM'));
  });

  it('resolves all three required email fields from the environment', () => {
    const settings = resolveNotificationSettings(
      {},
      {
        NOTIFICATION_PROVIDER: 'email',
        RESEND_API_KEY: TEST_API_KEY,
        DESIGN_RADAR_EMAIL_TO: TEST_TO,
        DESIGN_RADAR_EMAIL_FROM: TEST_FROM,
      }
    );

    assert.equal(settings.email.apiKey, TEST_API_KEY);
    assert.equal(settings.email.to, TEST_TO);
    assert.equal(settings.email.from, TEST_FROM);
  });

  it('throws at the factory when required email configuration is missing', () => {
    // A missing API key is a configuration mistake, not a delivery failure.
    assert.throws(
      () =>
        createNotifier(
          { provider: 'email' },
          { env: { NOTIFICATION_PROVIDER: 'email', DESIGN_RADAR_EMAIL_TO: TEST_TO, DESIGN_RADAR_EMAIL_FROM: TEST_FROM } }
        ),
      /Notification configuration error.*RESEND_API_KEY/s
    );
  });

  it('uses recipient = to address for email provider', () => {
    const settings = resolveNotificationSettings(
      {},
      { NOTIFICATION_PROVIDER: 'email', RESEND_API_KEY: TEST_API_KEY, DESIGN_RADAR_EMAIL_TO: TEST_TO, DESIGN_RADAR_EMAIL_FROM: TEST_FROM }
    );

    assert.equal(settings.recipient, TEST_TO);
  });
});

// ─── Request Construction ─────────────────────────────────────────────────────

describe('email request construction', () => {
  it('posts to the Resend endpoint as application/json', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_abc' }) });

    await sendEmailMessage(DIGEST, { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, RESEND_ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  });

  it('sends the API key as a Bearer token only in the Authorization header', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_abc' }) });

    await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    // Token must not appear in the URL.
    assert.equal(calls[0].url.includes(TEST_API_KEY), false);
  });

  it('includes from, to, subject, text, and html in the request body', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_abc' }) });

    await sendEmailMessage(DIGEST, { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    const body = JSON.parse(calls[0].init.body);

    assert.equal(body.from, TEST_FROM);
    assert.deepEqual(body.to, [TEST_TO]);
    assert.ok(typeof body.subject === 'string' && body.subject.length > 0);
    assert.equal(body.text, DIGEST);
    assert.ok(typeof body.html === 'string' && body.html.includes('DesignRadar'));
  });

  it('sends the digest verbatim as the text field', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_abc' }) });
    const message = '🎨 *DESIGNRADAR*\nTest digest body';

    await sendEmailMessage(message, { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.text, message);
  });
});

// ─── Success ──────────────────────────────────────────────────────────────────

describe('email successful delivery', () => {
  it('returns a normalized success result', async () => {
    const { fetchFn } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_msgid_abc123' }) });

    const result = await sendEmailMessage(DIGEST, {
      email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM },
      fetchFn,
    });

    assert.equal(result.success, true);
    assert.equal(result.provider, 'email');
    assert.equal(result.messageId, 're_msgid_abc123');
    assert.equal(result.errorType, null);
    assert.equal(result.error, null);
    assert.equal(result.retryable, false);
    assert.equal(result.requested, true);
  });

  it('captures the provider message id Resend returns', () => {
    assert.equal(readResendMessageId('{"id":"re_abc123"}'), 're_abc123');
    assert.equal(readResendMessageId('{"id":"  re_trimmed  "}'), 're_trimmed');
  });

  it('returns null for message id when Resend returns no id', () => {
    for (const body of ['', '   ', 'not json', '{}', '{"id":""}', '{"id":42}', '[]']) {
      assert.equal(readResendMessageId(body), null, `${JSON.stringify(body)} must not invent an id`);
    }
  });

  it('treats any 2xx as successful delivery', async () => {
    for (const status of [200, 201]) {
      const { fetchFn } = fetchDouble({ status, body: JSON.stringify({ id: 're_ok' }) });
      const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

      assert.equal(result.success, true, `HTTP ${status} must count as delivered`);
    }
  });

  it('returns the same result shape as other providers', async () => {
    const { fetchFn } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_ok' }) });
    const notifier = createNotifier(
      { provider: 'email' },
      { env: { NOTIFICATION_PROVIDER: 'email', RESEND_API_KEY: TEST_API_KEY, DESIGN_RADAR_EMAIL_TO: TEST_TO, DESIGN_RADAR_EMAIL_FROM: TEST_FROM }, fetchFn }
    );
    const result = await notifier.send('test message');

    for (const key of ['success', 'provider', 'messageId', 'errorType', 'error', 'retryable', 'requested']) {
      assert.ok(key in result, `result must expose "${key}"`);
    }
  });
});

// ─── Failure Mapping ──────────────────────────────────────────────────────────

describe('email failure mapping', () => {
  it('reports a non-2xx response as a failure carrying the status', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 500, body: 'internal server error' });

    const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.provider, 'email');
    assert.equal(result.errorType, NOTIFICATION_ERRORS.SERVER_ERROR);
    assert.equal(result.status, 500);
    assert.equal(result.retryable, true);
    assert.equal(result.requested, true);
    assert.equal(calls.length, 1);
  });

  it('maps HTTP 401 to authentication error', async () => {
    const { fetchFn } = fetchDouble({ status: 401, body: JSON.stringify({ message: 'Unauthorized' }) });

    const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.AUTHENTICATION);
    assert.equal(result.retryable, false);
    assert.equal(result.status, 401);
    // Authentication error message must not expose the API key.
    assert.equal(JSON.stringify(result).includes(TEST_API_KEY), false);
  });

  it('maps HTTP 403 to permission denied', async () => {
    const { fetchFn } = fetchDouble({ status: 403, body: JSON.stringify({ message: 'Forbidden' }) });

    const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.PERMISSION_DENIED);
    assert.equal(result.retryable, false);
  });

  it('maps HTTP 429 to rate limit', async () => {
    const { fetchFn } = fetchDouble({ status: 429, body: JSON.stringify({ message: 'Rate limit exceeded' }) });

    const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.RATE_LIMIT);
    assert.equal(result.retryable, true);
  });

  it('maps HTTP 400 to bad_request', async () => {
    const { fetchFn } = fetchDouble({ status: 400, body: JSON.stringify({ message: 'Invalid from address' }) });

    const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.BAD_REQUEST);
    assert.equal(result.retryable, false);
  });

  it('maps HTTP 5xx to server_error and marks retryable', async () => {
    const cases = [500, 502, 503];

    for (const status of cases) {
      const { fetchFn } = fetchDouble({ status, body: 'error' });
      const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

      assert.equal(result.success, false);
      assert.equal(result.retryable, true, `HTTP ${status} must be retryable`);
    }
  });

  it('reports a network failure without pretending it was delivered', async () => {
    const { fetchFn, calls } = fetchDouble({ throws: new TypeError('fetch failed') });

    const result = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.NETWORK);
    assert.equal(result.retryable, true);
    assert.equal(result.requested, true);
    assert.match(result.error, /Email notification failed: network error/);
    assert.equal(calls.length, 1);
  });

  it('reports an abort as a timeout, not a network fault', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const { fetchFn } = fetchDouble({ throws: abort });

    const result = await sendEmailMessage('body', {
      email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM },
      timeoutMs: 25,
      fetchFn,
    });

    assert.equal(result.errorType, NOTIFICATION_ERRORS.TIMEOUT);
    assert.match(result.error, /timeout/i);
  });

  it('survives an error body that is HTML or empty', async () => {
    const html = fetchDouble({ status: 502, body: '<html><title>502 Bad Gateway</title></html>' });
    const htmlResult = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn: html.fetchFn });
    assert.equal(htmlResult.errorType, NOTIFICATION_ERRORS.SERVER_ERROR);

    const empty = fetchDouble({ status: 403, body: '' });
    const emptyResult = await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn: empty.fetchFn });
    assert.equal(emptyResult.errorType, NOTIFICATION_ERRORS.PERMISSION_DENIED);
  });
});

// ─── Pre-flight Guards ────────────────────────────────────────────────────────

describe('email pre-flight validation', () => {
  it('rejects an empty message without attempting a request', async () => {
    const { fetchFn, calls } = fetchDouble();

    for (const message of ['', '   ', null, undefined, 42, {}]) {
      const notifier = createEmailNotifier(emailSettings());
      const result = await notifier.send(message);

      assert.equal(result.success, false);
      assert.equal(result.errorType, NOTIFICATION_ERRORS.INVALID_MESSAGE);
      assert.equal(result.requested, false);
    }

    // No request should have been made.
    assert.equal(calls.length, 0);
  });

  it('reports missing API key as configuration error without a request', async () => {
    const settings = emailSettings({ apiKey: '' });
    const notifier = createEmailNotifier(settings);
    const result = await notifier.send('body');

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.MISSING_CONFIGURATION);
    assert.equal(result.requested, false);
    assert.match(result.error, /RESEND_API_KEY/);
  });

  it('reports missing recipient as configuration error without a request', async () => {
    const settings = emailSettings({ to: '' });
    const notifier = createEmailNotifier(settings);
    const result = await notifier.send('body');

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.MISSING_CONFIGURATION);
    assert.equal(result.requested, false);
    assert.match(result.error, /DESIGN_RADAR_EMAIL_TO/);
  });

  it('reports missing sender as configuration error without a request', async () => {
    const settings = emailSettings({ from: '' });
    const notifier = createEmailNotifier(settings);
    const result = await notifier.send('body');

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.MISSING_CONFIGURATION);
    assert.equal(result.requested, false);
    assert.match(result.error, /DESIGN_RADAR_EMAIL_FROM/);
  });
});

// ─── Secret Safety ────────────────────────────────────────────────────────────

describe('email secret safety', () => {
  it('never echoes the API key in an error result', async () => {
    const { fetchFn } = fetchDouble({
      status: 401,
      body: JSON.stringify({ message: `Invalid API key: ${TEST_API_KEY}` }),
    });

    const result = await sendEmailMessage('body', {
      email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM },
      fetchFn,
    });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.AUTHENTICATION);
    // The API key must not appear anywhere in the result.
    assert.equal(JSON.stringify(result).includes(TEST_API_KEY), false);
  });

  it('redacts the API key from an untrusted error body', () => {
    const sanitized = sanitizeEmailErrorBody(`Authorization: Bearer ${TEST_API_KEY} rejected`, TEST_API_KEY);

    assert.equal(sanitized.includes(TEST_API_KEY), false);
    assert.ok(sanitized.includes('[redacted]'));
  });

  it('truncates a long error body', () => {
    const sanitized = sanitizeEmailErrorBody('x'.repeat(5000));

    assert.ok(sanitized.length <= 301);
    assert.ok(sanitized.endsWith('…'));
  });

  it('never puts the API key in the URL', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 200, body: JSON.stringify({ id: 're_ok' }) });

    await sendEmailMessage('body', { email: { apiKey: TEST_API_KEY, to: TEST_TO, from: TEST_FROM }, fetchFn });

    assert.equal(calls[0].url.includes(TEST_API_KEY), false);
  });
});

// ─── HTML Rendering ───────────────────────────────────────────────────────────

describe('email HTML rendering', () => {
  it('wraps the digest in a valid HTML envelope', () => {
    const html = renderEmailHtml('Test digest body');

    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<body'));
    assert.ok(html.includes('DesignRadar'));
  });

  it('converts *bold* markdown to <strong>', () => {
    const html = renderEmailHtml('Hello *world* today');

    assert.ok(html.includes('<strong>world</strong>'));
  });

  it('turns bare URLs into anchor tags', () => {
    const html = renderEmailHtml('See https://linkedin.com/posts/example');

    assert.ok(html.includes('href="https://linkedin.com/posts/example"'));
  });

  it('escapes HTML special characters in the digest text', () => {
    const html = renderEmailHtml('<script>alert("xss")</script>');

    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('uses the configured subject in the HTML title', () => {
    const html = renderEmailHtml('body', { subject: 'Custom Subject Line' });

    assert.ok(html.includes('Custom Subject Line'));
  });
});

// ─── Factory Integration ──────────────────────────────────────────────────────

describe('email factory integration', () => {
  it('createNotifier with email provider returns a notifier with name "email"', () => {
    const notifier = createNotifier(
      { provider: 'email' },
      { env: { NOTIFICATION_PROVIDER: 'email', RESEND_API_KEY: TEST_API_KEY, DESIGN_RADAR_EMAIL_TO: TEST_TO, DESIGN_RADAR_EMAIL_FROM: TEST_FROM } }
    );

    assert.equal(notifier.name, 'email');
    assert.equal(typeof notifier.send, 'function');
  });

  it('createNotifier throws when the email provider is missing required config', () => {
    assert.throws(
      () =>
        createNotifier(
          { provider: 'email' },
          { env: { NOTIFICATION_PROVIDER: 'email' } }
        ),
      /Notification configuration error/
    );
  });
});
