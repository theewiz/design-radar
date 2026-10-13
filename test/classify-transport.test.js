/**
 * Gemini Transport Integration Tests.
 *
 * These run the real transport in `src/ai/classify.js` against a local HTTP
 * server, using genuine `Response` objects over a real socket rather than
 * hand-built mocks. That covers what a mock cannot: reading the error body,
 * parsing `Retry-After` and `retryDelay` headers, and the exact shape of a 2xx
 * Gemini JSON envelope.
 *
 * Scenarios verified: 503 capacity (B), 429 quota (C), 401 (D), 404 (E).
 * Backoff is scaled down via `initialRetryDelayMs` so the suite stays fast; the
 * timing itself is asserted in test/classify.test.js.
 *
 * The API key used here is the literal string 'test-key'. No real credential is
 * involved and no request leaves the machine.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { classifyPost, classifyCandidates } from '../src/ai/classify.js';

/** Base URL the production code builds its requests against. */
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Queue of scripted server behaviours; each request consumes one entry. */
let script = [];

/** Status codes of every request the server received, in order. */
let requestLog = [];

let server;
let baseUrl;

/** A valid classification payload the server can return on success. */
const PAYLOAD = {
  is_recruiting_post: true,
  is_product_design_role: true,
  job_title: 'Senior Product Designer',
  seniority: 'Senior',
  company_name: 'AcmePay',
  author_name: null,
  is_hiring_manager_or_recruiter: true,
  location: 'Europe',
  remote_status: 'Remote',
  application_url: null,
  confidence: 0.92,
  reason: 'The text explicitly advertises an open Senior Product Designer role.',
};

/**
 * Wraps text in the Gemini `generateContent` success envelope.
 *
 * @param {string} text
 * @returns {object}
 */
function envelope(text) {
  return {
    candidates: [
      {
        index: 0,
        finishReason: 'STOP',
        content: { role: 'model', parts: [{ text }] },
      },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60, totalTokenCount: 180 },
  };
}

/**
 * Scripts a single response.
 *
 * @param {{ status?: number, body?: string|object, headers?: object }} [spec]
 *   `body` becomes the model text on 2xx, and the raw response body otherwise.
 * @returns {object}
 */
function step(spec = {}) {
  return { status: 200, body: PAYLOAD, headers: {}, ...spec };
}

/**
 * Renders a scripted step as the HTTP response the server should send.
 *
 * @param {object} current
 * @returns {{ status: number, body: string, headers: object }}
 */
function render(current) {
  const isSuccess = current.status >= 200 && current.status < 300;
  const text = typeof current.body === 'string' ? current.body : JSON.stringify(current.body);

  return {
    status: current.status,
    body: isSuccess ? JSON.stringify(envelope(text)) : text,
    headers: current.headers,
  };
}

before(async () => {
  server = createServer((req, res) => {
    const current = script.length > 1 ? script.shift() : script[0];
    requestLog.push(current.status);

    const { status, body, headers } = render(current);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

/**
 * Fetch that redirects the Gemini endpoint to the local test server.
 *
 * The production code, including its timeout and response handling, is unchanged.
 *
 * @returns {typeof fetch}
 */
function localFetch() {
  return (url, init) => globalThis.fetch(String(url).replace(GEMINI_API_URL, baseUrl), init);
}

const OPTIONS = {
  apiKey: 'test-key',
  model: 'gemini-test-model',
  systemPrompt: 'test prompt',
  initialRetryDelayMs: 5,
  fetchFn: localFetch(),
};

const POST = { title: 'Senior Product Designer', snippet: 'Remote Europe' };

describe('Gemini transport against a real HTTP server', () => {
  // Scenario A.
  it('A: classifies on the first attempt over a real connection', async () => {
    script = [step()];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 2 });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.classification.company_name, 'AcmePay');
    assert.deepEqual(requestLog, [200]);
  });

  // Scenario B.
  it('B: backs off and recovers when capacity returns', async () => {
    script = [
      step({ status: 503, body: 'This model is currently experiencing high demand.' }),
      step({ status: 503, body: 'This model is currently experiencing high demand.' }),
      step(),
    ];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 2 });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.deepEqual(requestLog, [503, 503, 200]);
  });

  it('B: fails in a controlled way when capacity never returns', async () => {
    script = [step({ status: 503, body: 'high demand' })];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 2 });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'retries_exhausted');
    assert.deepEqual(requestLog, [503, 503, 503]);
  });

  // Scenario C.
  it('C: makes a single request when the account quota is spent', async () => {
    script = [
      step({
        status: 429,
        body: JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'You exceeded your current quota, please check your plan and billing details.',
          },
        }),
      }),
    ];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 3 });

    assert.equal(result.error, 'quota_exhausted');
    assert.deepEqual(requestLog, [429], 'an exhausted quota must not be retried');
  });

  it('C: retries a per-minute rate limit within the bound', async () => {
    script = [step({ status: 429, body: 'rate limit exceeded' })];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 1 });

    assert.equal(result.error, 'retries_exhausted');
    assert.deepEqual(requestLog, [429, 429]);
  });

  it('C: honors a Retry-After header and then succeeds', async () => {
    script = [
      step({ status: 429, body: 'rate limit exceeded', headers: { 'retry-after': '0' } }),
      step(),
    ];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 1 });

    assert.equal(result.ok, true);
    assert.deepEqual(requestLog, [429, 200]);
  });

  it('C: honors the Google retryDelay hint when present', async () => {
    script = [
      step({
        status: 503,
        body: JSON.stringify({
          error: {
            status: 'UNAVAILABLE',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' },
            ],
          },
        }),
      }),
      step(),
    ];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 1 });

    assert.equal(result.ok, true);
    assert.deepEqual(requestLog, [503, 200]);
  });

  // Scenario D.
  it('D: fails immediately on 401', async () => {
    script = [step({ status: 401, body: 'API key not valid.' })];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 5 });

    assert.equal(result.error, 'authentication_failed');
    assert.deepEqual(requestLog, [401]);
  });

  // Scenario E.
  it('E: fails immediately on 404 and names the model', async () => {
    script = [step({ status: 404, body: 'models/gemini-test-model is not found.' })];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 5 });

    assert.equal(result.error, 'model_unavailable');
    assert.match(result.hint, /gemini-test-model/);
    assert.deepEqual(requestLog, [404]);
  });

  it('reports a schema rejection as a permanent request failure', async () => {
    script = [
      step({ status: 400, body: JSON.stringify({ error: { message: 'Invalid JSON payload received.' } }) }),
    ];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 3 });

    assert.equal(result.error, 'request_failed');
    assert.deepEqual(requestLog, [400]);
  });

  it('recovers JSON delivered inside a markdown fence', async () => {
    script = [step({ body: '```json\n' + JSON.stringify(PAYLOAD) + '\n```' })];
    requestLog = [];

    const result = await classifyPost(POST, { ...OPTIONS, maxRetries: 0 });

    assert.equal(result.ok, true);
    assert.equal(result.classification.company_name, 'AcmePay');
  });

  it('isolates one broken candidate from the rest of the batch', async () => {
    script = [
      step({ status: 404, body: 'model not found' }),
      step({ status: 500, body: 'internal error' }),
      step(),
    ];
    requestLog = [];

    const batch = await classifyCandidates(
      [
        { ...POST, title: 'Senior Product Designer' },
        { ...POST, title: 'Lead Product Designer' },
        { ...POST, title: 'Staff Product Designer' },
      ],
      { ...OPTIONS, maxRetries: 0 }
    );

    assert.equal(batch.succeeded, 1);
    assert.equal(batch.failed, 2);
    assert.deepEqual(batch.failureReasons, { model_unavailable: 1, retries_exhausted: 1 });
    assert.equal(batch.infrastructureFailure, false, 'one candidate did succeed');
  });

  it('marks the batch as an infrastructure failure when nothing was classified', async () => {
    script = [step({ status: 503, body: 'high demand' })];
    requestLog = [];

    const batch = await classifyCandidates([POST, { ...POST }], { ...OPTIONS, maxRetries: 0 });

    assert.equal(batch.succeeded, 0);
    assert.equal(batch.infrastructureFailure, true);
  });
});