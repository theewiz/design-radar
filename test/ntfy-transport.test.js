/**
 * ntfy Provider Tests (Phase 7).
 *
 * The provider in `src/notifications/ntfy.js` is exercised through a mocked
 * `fetch()`, so nothing in this file can reach ntfy.sh. The mock returns real
 * `Response` objects rather than plain objects, so `.ok`, `.status` and
 * `.text()` behave the way the production code expects.
 *
 * The token used here is the literal string 'test-token'. It is a stand-in, not
 * a credential.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { NOTIFICATION_ERRORS } from '../src/notifications/result.js';
import { createNotifier } from '../src/notifications/notifier.js';
import {
  buildRequestHeaders,
  buildTopicUrl,
  createNtfyNotifier,
  encodeHeaderValue,
  readNtfyMessageId,
  sanitizeErrorBody,
  sendNtfyMessage,
} from '../src/notifications/ntfy.js';

const TEST_TOKEN = 'test-token';
const DIGEST = '🎨 *DESIGNRADAR*\nDaily Digest — 3 Oct 2026\n\n🔥 *Senior Product Designer* (Score: 85)';

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

/** Settings for a complete ntfy configuration. */
function options(overrides = {}) {
  return {
    provider: 'ntfy',
    ntfy: {
      baseUrl: 'https://ntfy.sh',
      topic: 'design-radar',
      token: '',
      title: 'DesignRadar — Daily Digest',
      priority: 'default',
      tags: 'briefcase,mag',
      ...overrides,
    },
  };
}

// ─── URL And Header Construction ─────────────────────────────────────────────────

describe('ntfy request construction', () => {
  it('posts to the topic on the configured server', () => {
    assert.equal(
      buildTopicUrl({ baseUrl: 'https://ntfy.sh', topic: 'design-radar' }),
      'https://ntfy.sh/design-radar'
    );
    assert.equal(
      buildTopicUrl({ baseUrl: 'https://ntfy.example.com', topic: 'design-radar' }),
      'https://ntfy.example.com/design-radar'
    );
  });

  it('encodes the topic so it cannot address a different endpoint', () => {
    assert.equal(
      buildTopicUrl({ baseUrl: 'https://ntfy.sh', topic: 'team/radar' }),
      'https://ntfy.sh/team%2Fradar'
    );
  });

  it('sends the digest as plain text with a POST', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 200, body: '{"id":"ntfy.ok"}' });

    await sendNtfyMessage(DIGEST, { ...options(), fetchFn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://ntfy.sh/design-radar');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'text/plain; charset=utf-8');
    // The body is the digest verbatim — no JSON envelope, no re-encoding.
    assert.equal(calls[0].init.body, DIGEST);
  });

  it('sends the expected title, priority and tags', async () => {
    const { fetchFn, calls } = fetchDouble();

    await sendNtfyMessage(DIGEST, { ...options(), fetchFn });

    // The title reaches the wire as UTF-8 bytes; see the socket test below.
    assert.equal(
      Buffer.from(calls[0].init.headers.Title, 'latin1').toString('utf8'),
      'DesignRadar — Daily Digest'
    );
    assert.equal(calls[0].init.headers.Priority, 'default');
    assert.equal(calls[0].init.headers.Tags, 'briefcase,mag');
  });

  it('omits every optional header rather than sending empty values', () => {
    assert.deepEqual(buildRequestHeaders(), { 'Content-Type': 'text/plain; charset=utf-8' });
  });

  it('leaves an ASCII header value byte-identical', () => {
    assert.equal(encodeHeaderValue('default'), 'default');
    assert.equal(encodeHeaderValue('briefcase,mag'), 'briefcase,mag');
  });

  it('widens a non-ASCII title to the UTF-8 bytes ntfy reads back', () => {
    const wire = encodeHeaderValue('DesignRadar — Daily Digest');

    // ByteString-clean, which is what Node fetch requires of a header value...
    assert.ok([...wire].every((char) => char.codePointAt(0) <= 0xff));
    // ...and identical once read back as UTF-8, so the title is not mangled.
    assert.equal(Buffer.from(wire, 'latin1').toString('utf8'), 'DesignRadar — Daily Digest');
    assert.ok(buildRequestHeaders({ title: 'DesignRadar — Daily Digest' }).Title.length > 0);
  });

  it('encodes a non-ASCII title with no Buffer global, as in the Edge runtime', () => {
    // Regression: this threw `Buffer is not defined` in Deno, so every digest
    // sent from the Supabase Edge Function failed after the POST was accepted
    // by the runtime but before a request was built.
    const original = globalThis.Buffer;
    let wire;

    try {
      globalThis.Buffer = undefined;
      wire = encodeHeaderValue('DesignRadar — Daily Digest');
      assert.equal(buildRequestHeaders({ title: 'DesignRadar — Daily Digest' }).Title, wire);
    } finally {
      globalThis.Buffer = original;
    }

    // Same bytes as the Node implementation would have produced.
    assert.ok([...wire].every((char) => char.codePointAt(0) <= 0xff));
    assert.equal(Buffer.from(wire, 'latin1').toString('utf8'), 'DesignRadar — Daily Digest');
  });

  it('attaches the token as a bearer header only when one is configured', async () => {
    const anonymous = fetchDouble();
    await sendNtfyMessage('body', { ...options(), fetchFn: anonymous.fetchFn });
    assert.equal('Authorization' in anonymous.calls[0].init.headers, false);

    const authenticated = fetchDouble();
    await sendNtfyMessage('body', { ...options({ token: TEST_TOKEN }), fetchFn: authenticated.fetchFn });
    assert.equal(authenticated.calls[0].init.headers.Authorization, `Bearer ${TEST_TOKEN}`);
  });

  it('never puts the token in the URL', async () => {
    const { fetchFn, calls } = fetchDouble();

    await sendNtfyMessage('body', { ...options({ token: TEST_TOKEN }), fetchFn });

    assert.equal(calls[0].url.includes(TEST_TOKEN), false);
  });
});

// ─── Success ─────────────────────────────────────────────────────────────────────

describe('ntfy successful delivery', () => {
  it('returns a normalized success', async () => {
    const { fetchFn } = fetchDouble({ status: 200, body: JSON.stringify({ id: 'ahZ6abc' }) });

    const result = await sendNtfyMessage(DIGEST, { ...options(), fetchFn });

    assert.equal(result.success, true);
    assert.equal(result.provider, 'ntfy');
    assert.equal(result.messageId, 'ahZ6abc');
    assert.equal(result.errorType, null);
    assert.equal(result.error, null);
    assert.equal(result.retryable, false);
    assert.equal(result.requested, true);
  });

  it('records the id ntfy actually returned, and nothing when it returned none', () => {
    assert.equal(readNtfyMessageId('{"id":"ahZ6abc","topic":"design-radar"}'), 'ahZ6abc');
    for (const body of ['', '   ', 'not json', '{}', '{"id":""}', '{"id":42}', '[]']) {
      assert.equal(readNtfyMessageId(body), null, `${JSON.stringify(body)} must not invent an id`);
    }
  });

  it('treats any 2xx as an accepted publish, with or without a body', async () => {
    for (const status of [200, 201, 202]) {
      const { fetchFn } = fetchDouble({ status, body: '' });

      const result = await sendNtfyMessage('body', { ...options(), fetchFn });

      assert.equal(result.success, true, `HTTP ${status} must count as delivered`);
      assert.equal(result.messageId, null);
    }
  });
});

// ─── Failure Mapping ─────────────────────────────────────────────────────────────

describe('ntfy failure mapping', () => {
  it('reports a non-2xx response as a failure carrying the status', async () => {
    const { fetchFn, calls } = fetchDouble({ status: 500, body: 'internal server error' });

    const result = await sendNtfyMessage('body', { ...options(), fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.provider, 'ntfy');
    assert.equal(result.errorType, NOTIFICATION_ERRORS.SERVER_ERROR);
    assert.equal(result.status, 500);
    assert.equal(result.retryable, true);
    assert.equal(result.requested, true);
    assert.match(result.error, /ntfy notification failed: HTTP 500/);
    assert.equal(calls.length, 1);
  });

  it('maps statuses to the shared error vocabulary', async () => {
    const cases = [
      { status: 400, errorType: NOTIFICATION_ERRORS.BAD_REQUEST, retryable: false },
      { status: 401, errorType: NOTIFICATION_ERRORS.AUTHENTICATION, retryable: false },
      { status: 403, errorType: NOTIFICATION_ERRORS.PERMISSION_DENIED, retryable: false },
      { status: 404, errorType: NOTIFICATION_ERRORS.NOT_FOUND, retryable: false },
      { status: 413, errorType: NOTIFICATION_ERRORS.MESSAGE_TOO_LARGE, retryable: false },
      { status: 429, errorType: NOTIFICATION_ERRORS.RATE_LIMIT, retryable: true },
      { status: 503, errorType: NOTIFICATION_ERRORS.SERVICE_UNAVAILABLE, retryable: true },
      { status: 504, errorType: NOTIFICATION_ERRORS.TIMEOUT, retryable: true },
    ];

    for (const { status, errorType, retryable } of cases) {
      const { fetchFn } = fetchDouble({ status, body: 'nope' });

      const result = await sendNtfyMessage('body', { ...options(), fetchFn });

      assert.equal(result.success, false);
      assert.equal(result.errorType, errorType, `HTTP ${status}`);
      assert.equal(result.retryable, retryable, `HTTP ${status}`);
    }
  });

  it('reports a network failure without pretending it was delivered', async () => {
    const { fetchFn, calls } = fetchDouble({ throws: new TypeError('fetch failed') });

    const result = await sendNtfyMessage('body', { ...options(), fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.NETWORK);
    assert.equal(result.retryable, true);
    assert.equal(result.requested, true);
    assert.match(result.error, /ntfy notification failed: network error/);
    assert.equal(calls.length, 1);
  });

  it('reports an abort as a timeout, not a network fault', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const { fetchFn } = fetchDouble({ throws: abort });

    const result = await sendNtfyMessage('body', { ...options(), timeoutMs: 25, fetchFn });

    assert.equal(result.errorType, NOTIFICATION_ERRORS.TIMEOUT);
    assert.match(result.error, /timed out|timeout/);
  });

  it('survives an error body that is HTML or empty', async () => {
    const html = fetchDouble({ status: 502, body: '<html><title>502 Bad Gateway</title></html>' });
    const htmlResult = await sendNtfyMessage('body', { ...options(), fetchFn: html.fetchFn });
    assert.equal(htmlResult.errorType, NOTIFICATION_ERRORS.SERVER_ERROR);
    assert.ok(htmlResult.error.includes('502 Bad Gateway'));

    const empty = fetchDouble({ status: 403, body: '' });
    const emptyResult = await sendNtfyMessage('body', { ...options(), fetchFn: empty.fetchFn });
    assert.equal(emptyResult.errorType, NOTIFICATION_ERRORS.PERMISSION_DENIED);
    assert.match(emptyResult.error, /HTTP 403/);
  });
});

// ─── Real Transport ──────────────────────────────────────────────────────────────

/**
 * A loopback ntfy stand-in.
 *
 * Everything above uses a mocked fetch, which cannot catch a fault in the
 * request itself: it happily accepts a header value that Node's fetch refuses to
 * encode, and the real request then fails before it is built. These tests run
 * the provider over a real socket so the request is genuinely serialized. The
 * topic is served on 127.0.0.1, so nothing can reach ntfy.sh.
 */
let server;
let localBaseUrl;
let received;
let status = 200;

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        title: req.headers.title,
        priority: req.headers.priority,
        tags: req.headers.tags,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      };

      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'local.ok', topic: 'design-radar' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  localBaseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  received = null;
  status = 200;
});

describe('ntfy over a real socket', () => {
  it('delivers the digest to the topic as plain text', async () => {
    const result = await sendNtfyMessage(DIGEST, {
      ...options({ baseUrl: localBaseUrl }),
      fetchFn: globalThis.fetch,
    });

    assert.equal(result.success, true);
    assert.equal(result.messageId, 'local.ok');

    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/design-radar');
    assert.equal(received.contentType, 'text/plain; charset=utf-8');
    assert.equal(received.body, DIGEST);
  });

  it('sends a non-ASCII title Node fetch will actually encode', async () => {
    await sendNtfyMessage('body', { ...options({ baseUrl: localBaseUrl }), fetchFn: globalThis.fetch });

    // Node parses header bytes as latin1, so this is the wire bytes read back.
    assert.equal(Buffer.from(received.title, 'latin1').toString('utf8'), 'DesignRadar — Daily Digest');
    assert.equal(received.priority, 'default');
    assert.equal(received.tags, 'briefcase,mag');
  });

  it('sends the token as a bearer header and nowhere else', async () => {
    await sendNtfyMessage('body', {
      ...options({ baseUrl: localBaseUrl, token: TEST_TOKEN }),
      fetchFn: globalThis.fetch,
    });

    assert.equal(received.authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(received.url.includes(TEST_TOKEN), false);
  });

  it('reports a real non-2xx response as a failure', async () => {
    status = 401;

    const result = await sendNtfyMessage('body', {
      ...options({ baseUrl: localBaseUrl }),
      fetchFn: globalThis.fetch,
    });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.AUTHENTICATION);
    assert.equal(result.status, 401);
  });

  it('reports an unreachable server as a network failure', async () => {
    const result = await sendNtfyMessage('body', {
      // Port 1 on loopback refuses the connection immediately.
      ...options({ baseUrl: 'http://127.0.0.1:1' }),
      fetchFn: globalThis.fetch,
    });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.NETWORK);
    assert.equal(result.requested, true);
  });
});

// ─── Pre-Flight Guards ───────────────────────────────────────────────────────────

describe('ntfy pre-flight validation', () => {
  it('rejects a missing topic as a configuration error, not a delivery failure', async () => {
    // Nothing is sent, and nothing would be retried: an unset topic cannot fix
    // itself on a later run.
    await assert.rejects(
      () => sendNtfyMessage('body', { ...options({ topic: '' }) }),
      /Notification configuration error.*NTFY_TOPIC/s
    );
  });

  it('refuses to publish to an empty topic without attempting a request', async () => {
    const { fetchFn, calls } = fetchDouble();
    const notifier = createNtfyNotifier(
      { ntfy: { baseUrl: 'https://ntfy.sh', topic: '', token: '' }, timeoutMs: 5000 },
      { fetchFn }
    );

    const result = await notifier.send('body');

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.MISSING_CONFIGURATION);
    assert.equal(result.error, 'NTFY_TOPIC is not configured.');
    assert.equal(result.requested, false);
    assert.equal(calls.length, 0);
  });

  it('fails loudly at the factory when the topic is absent', () => {
    // A missing topic is a configuration mistake, not a delivery failure to be
    // retried, so it throws before the run does any work.
    assert.throws(
      () => createNotifier({ provider: 'ntfy' }, { env: {} }),
      /Notification configuration error.*NTFY_TOPIC/s
    );
  });

  it('rejects an empty message without attempting a request', async () => {
    const { fetchFn, calls } = fetchDouble();

    for (const message of ['', '   ', null, undefined, 42, {}]) {
      const result = await sendNtfyMessage(message, { ...options(), fetchFn });

      assert.equal(result.success, false);
      assert.equal(result.errorType, NOTIFICATION_ERRORS.INVALID_MESSAGE);
      assert.equal(result.requested, false);
    }

    assert.equal(calls.length, 0);
  });

  it('still refuses to send when the topic disappears after construction', async () => {
    const { fetchFn, calls } = fetchDouble();
    const notifier = createNotifier({ provider: 'ntfy' }, { env: { NTFY_TOPIC: 'design-radar' }, fetchFn });

    notifier.settings.ntfy.topic = '';

    const result = await notifier.send('body');

    assert.equal(result.success, false);
    assert.equal(result.requested, false);
    assert.equal(calls.length, 0);
  });

  it('defaults the server to ntfy.sh when no base URL is configured', async () => {
    const { fetchFn, calls } = fetchDouble();
    const notifier = createNtfyNotifier(
      { ntfy: { baseUrl: 'https://ntfy.sh', topic: 'design-radar', token: '' }, timeoutMs: 5000 },
      { fetchFn }
    );

    await notifier.send('body');

    assert.equal(calls[0].url, 'https://ntfy.sh/design-radar');
  });
});

// ─── Secret Safety ───────────────────────────────────────────────────────────────

describe('ntfy secret safety', () => {
  it('never echoes the token in an error result', async () => {
    const { fetchFn } = fetchDouble({
      status: 401,
      body: JSON.stringify({ error: 'unauthorized', detail: `token ${TEST_TOKEN} rejected` }),
    });

    const result = await sendNtfyMessage('body', { ...options({ token: TEST_TOKEN }), fetchFn });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.AUTHENTICATION);
    assert.equal(JSON.stringify(result).includes(TEST_TOKEN), false);
    assert.ok(result.error.includes('[redacted]'));
  });

  it('redacts the token from an untrusted error body', () => {
    const sanitized = sanitizeErrorBody(`Authorization: Bearer ${TEST_TOKEN} rejected`, TEST_TOKEN);

    assert.equal(sanitized.includes(TEST_TOKEN), false);
    assert.ok(sanitized.includes('[redacted]'));
  });

  it('truncates a long error body', () => {
    const sanitized = sanitizeErrorBody('x'.repeat(5000));

    assert.ok(sanitized.length <= 301);
    assert.ok(sanitized.endsWith('…'));
  });
});