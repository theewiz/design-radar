/**
 * Phase 9 — Edge Function request/response contract.
 *
 * `supabase/functions/daily-radar/index.js` is the scheduled entry point, so its
 * contract is what cron depends on. These tests exercise it with the orchestrator
 * replaced, so nothing here calls Serper, Gemini, Supabase, or ntfy.
 *
 * Two properties are load-bearing:
 *   - An unqualified request must never notify. The default mode is 'discovery',
 *     so a stray health check or manual hit cannot consume the daily digest.
 *   - A response must never carry a secret, whatever the pipeline put in an error.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../supabase/functions/daily-radar/index.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────────

/** A silent logger, so tests do not depend on log output. */
const silentLog = { info() {}, error() {}, warn() {}, debug() {} };

/**
 * Builds a run summary in the shape `runRadar()` returns.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function runSummary(overrides = {}) {
  return {
    success: true,
    mode: 'discovery',
    status: 'OPERATIONAL',
    statusReason: 'test',
    queriesRun: 3,
    searchResults: 10,
    uniqueResults: 8,
    candidates: 6,
    classified: 5,
    qualified: 4,
    notificationSent: false,
    ...overrides,
  };
}

/**
 * Builds a handler with a recording orchestrator.
 *
 * @param {object} [options]
 * @returns {{ handle: Function, calls: object[] }}
 */
function handlerWith(options = {}) {
  const calls = [];

  const run = options.run ?? (async (opts) => {
    calls.push(opts);
    return runSummary({ mode: opts.mode });
  });

  const handle = createHandler({
    run,
    log: silentLog,
    env: options.env ?? (() => ({})),
  });

  return { handle, calls };
}

/**
 * Issues a POST to the function.
 *
 * @param {Function} handle
 * @param {object|string|null} [body] JSON body, raw string, or null for no body.
 * @param {object} [init] Extra Request init.
 * @returns {Promise<Response>}
 */
function post(handle, body = null, init = {}) {
  return handle(
    new Request('https://project.supabase.co/functions/v1/daily-radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : body === null ? undefined : JSON.stringify(body),
      ...init,
    })
  );
}

// ─── Mode handling ───────────────────────────────────────────────────────────────

describe('Phase 9 — Edge Function mode handling', () => {
  it('Test 1 — discovery mode never notifies', async () => {
    const { handle, calls } = handlerWith({
      run: async (opts) => {
        calls.push(opts);
        return runSummary({ mode: opts.mode, notificationSent: false });
      },
    });

    const response = await post(handle, { mode: 'discovery' });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].mode, 'discovery');
    assert.equal(body.success, true);
    assert.equal(body.statistics.notificationSent, false);
  });

  it('Test 2 — digest mode reports a delivered notification', async () => {
    const { handle, calls } = handlerWith({
      run: async (opts) => {
        calls.push(opts);
        return runSummary({
          mode: opts.mode,
          queriesRun: 0,
          searchResults: 0,
          uniqueResults: 0,
          candidates: 0,
          classified: 0,
          qualified: 0,
          notificationSent: true,
        });
      },
    });

    const response = await post(handle, { mode: 'digest' });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].mode, 'digest');
    assert.equal(body.success, true);
    assert.equal(body.statistics.notificationSent, true);
  });

  it('Test 3 — a failed notification reports success:false and is not sent', async () => {
    const { handle } = handlerWith({
      run: async () => {
        throw new Error('ntfy notification failed: connection refused');
      },
    });

    const response = await post(handle, { mode: 'digest' });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error, 'ntfy notification failed: connection refused');
  });

  it('defaults to discovery when no body is supplied', async () => {
    const { handle, calls } = handlerWith();

    const response = await post(handle, null);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].mode, 'discovery', 'a bare request must not notify');
    assert.equal(body.mode, 'discovery');
    assert.equal(body.statistics.notificationSent, false);
  });

  it('defaults to discovery for an empty JSON object', async () => {
    const { handle, calls } = handlerWith();

    await post(handle, {});

    assert.equal(calls[0].mode, 'discovery');
  });

  it('accepts full mode for a manual end-to-end run', async () => {
    const { handle, calls } = handlerWith();

    const response = await post(handle, { mode: 'full' });

    assert.equal(response.status, 200);
    assert.equal(calls[0].mode, 'full');
  });

  it('rejects an unknown mode with 400 before invoking the pipeline', async () => {
    const { handle, calls } = handlerWith();

    const response = await post(handle, { mode: 'notify-everything' });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.match(body.error, /Unsupported mode/);
    // Order is not part of the contract, so each supported mode is checked
    // individually rather than against one fixed string.
    for (const mode of ['full', 'discovery', 'digest']) {
      assert.match(body.error, new RegExp(mode), `"${mode}" should be listed as supported`);
    }
    assert.equal(calls.length, 0, 'the pipeline was never invoked');
  });

  it('rejects a malformed JSON body with 400', async () => {
    const { handle, calls } = handlerWith();

    const response = await post(handle, '{ not json');
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.match(body.error, /JSON object/);
    assert.equal(calls.length, 0);
  });

  it('rejects a non-object JSON body with 400', async () => {
    const { handle } = handlerWith();

    for (const raw of ['[1,2,3]', '"discovery"', 'null']) {
      const response = await post(handle, raw);
      assert.equal(response.status, 400, `body ${raw} should be rejected`);
    }
  });

  it('rejects a non-POST method with 405', async () => {
    const { handle } = handlerWith();

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await handle(
        new Request('https://project.supabase.co/functions/v1/daily-radar', { method })
      );
      assert.equal(response.status, 405, `${method} should not be allowed`);
      assert.equal(response.headers.get('Allow'), 'POST');
    }
  });
});

// ─── Response contract ───────────────────────────────────────────────────────────

describe('Phase 9 — Edge Function response contract', () => {
  it('reports exactly the documented statistics', async () => {
    const { handle } = handlerWith({
      run: async () =>
        runSummary({
          queriesRun: 3,
          searchResults: 10,
          uniqueResults: 8,
          candidates: 6,
          classified: 5,
          qualified: 4,
          notificationSent: false,
        }),
    });

    const response = await post(handle, { mode: 'discovery' });
    const body = await response.json();

    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(body.success, true);
    assert.deepEqual(body.statistics, {
      queriesRun: 3,
      searchResults: 10,
      uniqueResults: 8,
      candidates: 6,
      classified: 5,
      qualified: 4,
      notificationSent: false,
    });
  });

  it('passes statistics through from the run rather than recomputing them', async () => {
    const { handle } = handlerWith({
      run: async () => runSummary({ queriesRun: 11, searchResults: 22, qualified: 33 }),
    });

    const body = await (await post(handle, { mode: 'discovery' })).json();

    assert.equal(body.statistics.queriesRun, 11);
    assert.equal(body.statistics.searchResults, 22);
    assert.equal(body.statistics.qualified, 33);
  });

  it('reports a missing statistic as null rather than a fabricated zero', async () => {
    const { handle } = handlerWith({
      run: async () => ({ success: true, mode: 'digest', notificationSent: false }),
    });

    const body = await (await post(handle, { mode: 'digest' })).json();

    assert.equal(body.statistics.queriesRun, null, 'an absent value is not a real zero');
    assert.equal(body.statistics.qualified, null);
    assert.equal(body.statistics.notificationSent, false);
  });

  it('reports success:false when the pipeline reports failure', async () => {
    const { handle } = handlerWith({
      run: async () =>
        runSummary({ success: false, mode: 'digest', notificationSent: false, status: 'FAILED' }),
    });

    const body = await (await post(handle, { mode: 'digest' })).json();

    assert.equal(body.success, false);
    assert.equal(body.statistics.notificationSent, false);
  });
});

// ─── Secret containment ───────────────────────────────────────────────────────────

describe('Phase 9 — the Edge Function never exposes secrets', () => {
  const SECRETS = {
    SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.super-secret-service-role-value',
    GEMINI_API_KEY: 'AIzaSyD-not-a-real-key-but-secret-looking',
    SEARCH_API_KEY: 'search-key-abcdef123456',
    NTFY_TOKEN: 'tk_secretntfytokenvalue',
  };

  it('redacts a secret echoed back by the pipeline', async () => {
    const { handle } = handlerWith({
      env: () => SECRETS,
      run: async () => {
        throw new Error(`Upstream rejected key ${SECRETS.GEMINI_API_KEY} for model gemini-3.5-flash-lite`);
      },
    });

    const response = await post(handle, { mode: 'discovery' });
    const raw = await response.text();

    assert.equal(response.status, 500);
    assert.equal(raw.includes(SECRETS.GEMINI_API_KEY), false, 'the key must not appear in the response');
    assert.match(raw, /\[redacted\]/);
  });

  it('redacts a token-like value that did not come from the environment', async () => {
    const leaked = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

    const { handle } = handlerWith({
      env: () => SECRETS,
      run: async () => {
        throw new Error(`Request rejected: ${leaked}`);
      },
    });

    const raw = await (await post(handle, { mode: 'digest' })).text();

    assert.equal(raw.includes(leaked), false);
    assert.match(raw, /\[redacted\]/);
  });

  it('never returns a stack trace', async () => {
    const { handle } = handlerWith({
      env: () => SECRETS,
      run: async () => {
        const err = new Error('boom');
        err.stack = 'Error: boom\n    at file:///private/secret/path/to/module.js:12:34';
        throw err;
      },
    });

    const body = await (await post(handle, { mode: 'digest' })).json();

    assert.equal(Object.hasOwn(body, 'stack'), false);
    assert.equal(JSON.stringify(body).includes('at file://'), false);
  });

  it('does not echo the whole environment back', async () => {
    const { handle } = handlerWith({ env: () => SECRETS });

    const raw = await (await post(handle, { mode: 'discovery' })).text();

    for (const secret of Object.values(SECRETS)) {
      assert.equal(raw.includes(secret), false, 'no configured secret may appear in a response');
    }
  });

  it('keeps an ordinary error message readable', async () => {
    const { handle } = handlerWith({
      run: async () => {
        throw new Error('Digest generation failed: database not configured');
      },
    });

    const body = await (await post(handle, { mode: 'digest' })).json();

    assert.match(body.error, /Digest generation failed: database not configured/);
    assert.equal(body.success, false);
  });
});

// ─── Bundle integrity ────────────────────────────────────────────────────────────

describe('Phase 9 — the Edge bundle shares the Node implementation', () => {
  it('exposes the same three modes the CLI uses', async () => {
    const shared = await import('../supabase/functions/_shared/src/radar/index.js');
    const cli = await import('../src/radar/index.js');

    assert.deepEqual(Object.keys(shared).sort(), Object.keys(cli).sort());
    assert.deepEqual(
      Object.values(shared.RADAR_MODES).sort(),
      Object.values(cli.RADAR_MODES).sort()
    );
  });

  it('resolves the same mode decisions as the CLI', async () => {
    const shared = await import('../supabase/functions/_shared/src/radar/index.js');
    const cli = await import('../src/radar/index.js');

    for (const options of [{}, { mode: 'discovery' }, { mode: 'digest' }, { digest: false }]) {
      assert.deepEqual(
        shared.resolveRunMode(options),
        cli.resolveRunMode(options),
        `mode resolution diverged for ${JSON.stringify(options)}`
      );
    }
  });
});