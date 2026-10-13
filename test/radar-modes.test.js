/**
 * Phase 9 — scheduled execution modes, end to end.
 *
 * The production schedule runs discovery six times a day and the digest once, so
 * the question these tests answer is not "does each mode work" but "can the two
 * ever be confused". A discovery run that notified, or a digest run that
 * searched, would either spam the user or spend provider quota outside the
 * intended window.
 *
 * Every collaborator that reaches the network or the database is replaced, so no
 * test here calls Serper, Gemini, Supabase, or ntfy.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runRadar } from '../src/radar/index.js';
import { deliverDigest } from '../src/notifications/deliver.js';
import { NOTIFICATION_ERRORS } from '../src/notifications/result.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────────

/** Ordered side effects, so a mode can be shown to skip or perform each stage. */
let calls;

/** Rows handed to persistence. */
let persisted;

let consoleLog;

beforeEach(() => {
  calls = [];
  persisted = [];
  consoleLog = console.log;
  console.log = () => {};
});

function restoreConsole() {
  console.log = consoleLog;
}

function postUrl(slug) {
  return `https://www.linkedin.com/posts/${slug}`;
}

function classification(overrides = {}) {
  return {
    is_recruiting_post: true,
    is_product_design_role: true,
    job_title: 'Senior Product Designer',
    seniority: 'Senior',
    company_name: 'AcmePay',
    author_name: null,
    is_hiring_manager_or_recruiter: false,
    location: null,
    remote_status: 'Unknown',
    application_url: null,
    confidence: 0.9,
    reason: 'test',
    ...overrides,
  };
}

/** Scores 50 against the threshold of 60 — qualified, standard priority. */
function standardCandidate() {
  return {
    url: postUrl('acme_senior-product-designer-1'),
    title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
    snippet: 'AcmePay is hiring a Senior Product Designer to own end-to-end product design for our platform.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
    source_query: 'query-1',
  };
}

function digestFixture(ids) {
  const message = 'DesignRadar\n2 new opportunities';

  return {
    source: 'database',
    dbReady: true,
    mock: false,
    empty: ids.length === 0,
    included: ids.map((id) => ({ id })),
    message,
    chunks: [message],
    stats: { window_hours: 168, included: ids.length },
  };
}

function notifierFixture(script = {}) {
  return {
    name: 'ntfy',
    async send() {
      calls.push('send');
      return script.result ?? {
        success: true,
        provider: 'ntfy',
        messageId: 'ntfy.ok',
        errorType: null,
        error: null,
      };
    },
  };
}

function fakeClient() {
  return {
    from: (table) => ({
      insert: (row) => {
        calls.push(`record:${table}`);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: { id: 'n1', ...row }, error: null }),
          }),
        };
      },
      select: (columns) => {
        if (columns === 'id' && table === 'notifications') {
          return {
            eq: () => ({
              contains: async () => {
                calls.push('duplicate-check');
                return { data: [], error: null };
              },
            }),
          };
        }
        throw new Error(`unexpected select on ${table}`);
      },
      update: () => ({
        in: async () => {
          calls.push('mark');
          return { error: null };
        },
      }),
    }),
  };
}

const PROVIDER_FAILURE = {
  success: false,
  provider: 'ntfy',
  messageId: null,
  errorType: NOTIFICATION_ERRORS.NETWORK,
  error: 'ntfy notification failed: connection refused',
  retryable: true,
};

const TEST_ENV = {
  SEARCH_PROVIDER: 'mock',
  SEARCH_API_KEY: 'test-search-key',
  GEMINI_API_KEY: 'test-gemini-key',
  MIN_RELEVANCE_SCORE: '60',
};

const NOTIFICATION_SETTINGS = {
  provider: 'ntfy',
  recipient: 'design-radar',
  markMockAsSent: false,
  ntfy: { baseUrl: 'https://ntfy.sh', topic: 'design-radar', token: '[redacted]' },
};

async function runRadarWith(overrides = {}, options = {}) {
  const deps = {
    isDatabaseConfigured: () => true,
    resolveNotificationSettings: () => NOTIFICATION_SETTINGS,
    describeNotificationSettings: () => ({
      provider: 'ntfy',
      recipient: 'configured',
      markMockAsSent: false,
      ntfy: { baseUrl: 'https://ntfy.sh', topic: 'design-radar', token: '[redacted]' },
    }),
    assertNotificationSettings: () => {},
    findExistingUrls: async () => new Set(),
    findUrlCaseDrift: async () => [],
    realignUrlCase: async () => 0,
    createSearchRun: async () => {
      calls.push('search-run:create');
      return { id: 'run-1' };
    },
    completeSearchRun: async (runId, metrics) => {
      calls.push(`search-run:complete:${metrics.status}`);
    },
    createPosts: async (rows) => {
      persisted.push(...rows);
      calls.push('persist');
      return { created: rows.length, skipped: 0, errors: 0 };
    },
    runDigest: async () => {
      calls.push('digest');
      return digestFixture([]);
    },
    notifyDigest: async ({ digest, notificationSettings }) => {
      const notifier = overrides.__notifier ?? notifierFixture();
      delete overrides.__notifier;
      const result = await deliverDigest({
        digest,
        notifier,
        recipient: notificationSettings.recipient,
        persist: true,
        client: fakeClient(),
      });
      calls.push(`notify:${result.success ? 'ok' : 'failed'}`);
      return result;
    },
    ...overrides,
  };

  try {
    return await runRadar({ env: TEST_ENV, deps, ...options });
  } finally {
    restoreConsole();
  }
}

function discoveryResult(config = {}) {
  const candidates = config.candidates ?? [];
  const failedQueries = config.failedQueries ?? [];
  const queries = config.queries ?? ['query-1', 'query-2', 'query-3'];

  return {
    queries,
    candidates,
    failedQueries,
    metrics: {
      queryCount: queries.length,
      successfulQueries: queries.length - failedQueries.length,
      failedQueryCount: failedQueries.length,
      candidateCount: candidates.length,
      durationMs: 12,
    },
  };
}

function classificationBatch(entries) {
  const results = entries.map((entry) =>
    entry.failed
      ? { ok: false, url: entry.url, error: 'invalid_json', errors: ['Model returned unparseable JSON'] }
      : { ok: true, url: entry.url, classification: entry.classification }
  );

  return {
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalUsage: { total_tokens: 0 },
    failureReasons: results.some((r) => !r.ok) ? { invalid_json: 1 } : {},
    infrastructureFailure: false,
  };
}

/** A discovery pass that records that it ran. */
function discoverySpy(candidates = []) {
  return async () => {
    calls.push('discover');
    return discoveryResult({ candidates });
  };
}

// ─── Discovery mode ─────────────────────────────────────────────────────────────

describe('Phase 9 — discovery mode (every 4 hours)', () => {
  it('searches, classifies, scores, qualifies, and persists without notifying', async () => {
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: discoverySpy([candidate]),
        classifyCandidates: async () => {
          calls.push('classify');
          return classificationBatch([{ url: candidate.url, classification: classification() }]);
        },
      },
      { mode: 'discovery' }
    );

    assert.equal(result.mode, 'discovery');
    assert.equal(result.success, true);
    assert.equal(result.queriesRun, 3);
    assert.equal(result.candidates, 1);
    assert.equal(result.classified, 1);
    assert.equal(result.qualified, 1);
    assert.equal(persisted.length, 1, 'the qualified post is persisted for the daily digest');

    // The whole point of splitting the schedule: a 4-hour run must stay silent.
    assert.equal(result.notificationSent, false);
    assert.equal(result.notification, null, 'no notification was attempted at all');
    assert.equal(calls.includes('digest'), false, 'no digest was generated');
    assert.equal(calls.includes('send'), false, 'ntfy was never called');
    assert.equal(calls.includes('mark'), false, 'nothing was marked as sent');
  });

  it('records search-run statistics so the 4-hour cadence is auditable', async () => {
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: discoverySpy([candidate]),
        classifyCandidates: async () =>
          classificationBatch([{ url: candidate.url, classification: classification() }]),
      },
      { mode: 'discovery' }
    );

    assert.equal(calls.includes('search-run:create'), true);
    assert.equal(
      calls.some((c) => c.startsWith('search-run:complete:')),
      true,
      'the run is closed out with a status'
    );
    assert.equal(result.notificationSent, false);
  });

  it('does not require a working notification provider', async () => {
    // ntfy being unconfigured must not stop discovery: the digest job is the only
    // thing that needs it, and it runs once a day.
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: discoverySpy([candidate]),
        classifyCandidates: async () =>
          classificationBatch([{ url: candidate.url, classification: classification() }]),
        assertNotificationSettings: () => {
          throw new Error('notification provider unusable');
        },
      },
      { mode: 'discovery' }
    );

    assert.equal(result.success, true);
    assert.equal(persisted.length, 1);
  });

  it('keeps a qualified post scoring below 60 qualified and persisted', async () => {
    // MIN_RELEVANCE_SCORE is a priority threshold only. A discovery run must not
    // turn it into a persistence gate, or posts would be silently discarded
    // between digests.
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: discoverySpy([candidate]),
        classifyCandidates: async () =>
          classificationBatch([{ url: candidate.url, classification: classification() }]),
      },
      { mode: 'discovery' }
    );

    assert.equal(result.minRelevanceScore, 60);
    assert.equal(result.qualified, 1, 'a sub-threshold post is still qualified');
    assert.equal(persisted.length, 1, 'and still persisted');

    assert.equal(persisted[0].relevance_score, 50, 'the score itself is unchanged');
    assert.equal(persisted[0].status, 'qualified', 'eligibility is independent of the threshold');
    assert.equal(persisted[0].job_title, 'Senior Product Designer');
  });

  it('does not abort when one search query fails', async () => {
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: async () => {
          calls.push('discover');
          return discoveryResult({
            candidates: [candidate],
            failedQueries: [{ query: 'query-2', error: 'serper timeout' }],
          });
        },
        classifyCandidates: async () =>
          classificationBatch([{ url: candidate.url, classification: classification() }]),
      },
      { mode: 'discovery' }
    );

    assert.equal(result.success, true, 'one failed query degrades coverage, not the run');
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.search.queriesFailed, 1);
    assert.equal(result.qualified, 1, 'results from the surviving queries are still processed');
    assert.equal(persisted.length, 1);
    assert.equal(result.notificationSent, false);
  });
});

// ─── Digest mode ─────────────────────────────────────────────────────────────────

describe('Phase 9 — digest mode (daily at 07:00 UTC)', () => {
  it('delivers stored posts and marks them sent, without searching', async () => {
    const result = await runRadarWith(
      {
        runDiscovery: async () => {
          calls.push('discover');
          throw new Error('discovery must not run in digest mode');
        },
        runDigest: async () => {
          calls.push('digest');
          return digestFixture(['p-1', 'p-2']);
        },
      },
      { mode: 'digest' }
    );

    assert.equal(result.mode, 'digest');
    assert.equal(result.success, true);
    assert.equal(result.notificationSent, true);
    assert.equal(calls.includes('send'), true, 'ntfy was called');
    assert.equal(calls.includes('mark'), true, 'posts were marked after delivery');

    // No search: a daily digest must not widen coverage or spend search quota.
    assert.equal(calls.includes('discover'), false, 'no web search was performed');
    assert.equal(calls.includes('classify'), false);
    assert.equal(calls.includes('persist'), false);
    assert.equal(result.queriesRun, 0);
    assert.equal(result.candidates, 0);
    assert.equal(result.qualified, 0);
    assert.equal(result.notification.markedCount, 2);
  });

  it('reports the delivery as the run outcome', async () => {
    const result = await runRadarWith(
      {
        runDiscovery: async () => {
          throw new Error('discovery must not run in digest mode');
        },
        runDigest: async () => digestFixture(['p-1']),
      },
      { mode: 'digest' }
    );

    assert.equal(result.status, 'OPERATIONAL');
    assert.match(result.statusReason, /Digest delivered/);
  });

  it('leaves posts unsent when ntfy fails', async () => {
    const result = await runRadarWith(
      {
        __notifier: notifierFixture({ result: PROVIDER_FAILURE }),
        runDiscovery: async () => {
          throw new Error('discovery must not run in digest mode');
        },
        runDigest: async () => digestFixture(['p-1', 'p-2']),
      },
      { mode: 'digest' }
    );

    assert.equal(result.success, false, 'an attempted-and-failed send is a failed run');
    assert.equal(result.notificationSent, false);
    assert.equal(result.status, 'FAILED');
    assert.match(result.statusReason, /ntfy notification failed/);

    // The safety rule: never mark before a confirmed delivery.
    assert.equal(calls.includes('mark'), false, 'posts were NOT marked as sent');
    assert.equal(
      calls.includes('record:notifications'),
      true,
      'the failed attempt is still recorded, as status=failed, for audit'
    );
  });

  it('treats an empty digest as a success, not a failure', async () => {
    // Nothing eligible means a previous run already covered these posts. Reporting
    // a failure here would page the operator every morning for no reason.
    const result = await runRadarWith(
      {
        runDiscovery: async () => {
          throw new Error('discovery must not run in digest mode');
        },
        runDigest: async () => digestFixture([]),
      },
      { mode: 'digest' }
    );

    assert.equal(result.success, true);
    assert.equal(result.notificationSent, false);
    assert.equal(result.status, 'OPERATIONAL');
    assert.equal(calls.includes('send'), false);
  });

  it('does not duplicate delivery when triggered twice against the same queue', async () => {
    // The second invocation sees an empty digest because the first already marked
    // the posts sent. Notification deduplication is what makes a double-triggered
    // cron harmless.
    const result = await runRadarWith(
      {
        runDiscovery: async () => {
          throw new Error('discovery must not run in digest mode');
        },
        runDigest: async () => digestFixture([]),
      },
      { mode: 'digest' }
    );

    assert.equal(result.notificationSent, false);
    assert.equal(calls.includes('send'), false, 'nothing eligible means nothing to resend');
  });
});

// ─── Backwards compatibility ─────────────────────────────────────────────────────

describe('Phase 9 — backwards compatibility', () => {
  it('runRadar() with no mode still runs the complete pipeline', async () => {
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: discoverySpy([candidate]),
        classifyCandidates: async () =>
          classificationBatch([{ url: candidate.url, classification: classification() }]),
        runDigest: async () => {
          calls.push('digest');
          return digestFixture(['p-1']);
        },
      },
      {}
    );

    assert.equal(result.mode, 'full');
    assert.equal(calls.includes('discover'), true);
    assert.equal(calls.includes('digest'), true);
    assert.equal(calls.includes('send'), true);
    assert.equal(result.notificationSent, true);
    assert.equal(result.success, true);
  });

  it('runRadar({ digest: false }) still behaves as a scan-only run', async () => {
    const candidate = standardCandidate();

    const result = await runRadarWith(
      {
        runDiscovery: discoverySpy([candidate]),
        classifyCandidates: async () =>
          classificationBatch([{ url: candidate.url, classification: classification() }]),
      },
      { digest: false }
    );

    assert.equal(result.notificationSent, false);
    assert.equal(calls.includes('send'), false);
    assert.equal(persisted.length, 1);
  });

  it('rejects an unknown mode before any provider call', async () => {
    await assert.rejects(
      runRadarWith({ runDiscovery: discoverySpy([]) }, { mode: 'everything' }),
      /Unsupported radar mode "everything"/
    );
    assert.equal(calls.includes('discover'), false, 'nothing ran');
  });
});