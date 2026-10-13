/**
 * Radar Orchestrator Tests (Phase 8).
 *
 * These tests pin the behaviour of a whole run rather than of one stage. Every
 * collaborator that talks to the network or the database is replaced through
 * `options.deps`, so nothing here calls Serper, Gemini, Supabase, or ntfy. The
 * pure rules — keyword filtering, eligibility, scoring, status — are the real
 * implementations, because the point of these tests is that the orchestrator
 * wires the real rules together correctly.
 *
 * The invariant behind most of them: a run that loses a query, a candidate, or
 * its notification must still finish and must never report delivery it did not
 * get, or mark posts it did not send.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { runRadar } from '../src/radar/index.js';
import { deliverDigest } from '../src/notifications/deliver.js';
import { NOTIFICATION_ERRORS } from '../src/notifications/result.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────────

/** Ordered side effects, reset per test, so sequencing can be asserted. */
let calls;

/** Row groups handed to persistence, so stored values can be inspected. */
let persisted;

let consoleLog;

beforeEach(() => {
  calls = [];
  persisted = [];
  // runRadar prints its progress banner. Kept out of the test output so a failure
  // is not buried under stage-by-stage logging.
  consoleLog = console.log;
  console.log = () => {};
});

/**
 * Restores console.log. Registered per test rather than in an afterEach so a
 * failing assertion cannot leave stdout silenced for the rest of the file.
 */
function restoreConsole() {
  console.log = consoleLog;
}

/**
 * A post URL that survives normalization unchanged.
 *
 * @param {string} slug
 * @returns {string}
 */
function postUrl(slug) {
  return `https://www.linkedin.com/posts/${slug}`;
}

/**
 * Builds a Phase 4 classification result with the same defaults the scoring
 * tests use, so a fixture's score is the score those tests already pin.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
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

/**
 * A candidate that passes the keyword filter and scores below the threshold:
 * seniority and hiring language only, so no recruiter, location, or domain
 * points. Scores 50 against a threshold of 60.
 *
 * @returns {object}
 */
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

/**
 * A candidate that scores above the threshold: adds a named recruiter and a
 * remote arrangement. Scores 75 against a threshold of 60.
 *
 * @returns {object}
 */
function highPriorityCandidate() {
  return {
    url: postUrl('globex_lead-product-designer-2'),
    title: 'Globex on LinkedIn: We are hiring a Lead Product Designer',
    snippet: 'Globex is hiring a Lead Product Designer to lead our design team. Fully remote.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
    source_query: 'query-2',
  };
}

/** A post the keyword filter must reject. */
function irrelevantCandidate() {
  return {
    url: postUrl('chef_pasta-recipe-3'),
    title: 'My amazing pasta recipe',
    snippet: 'Delicious homemade pasta.',
    publishedAt: null,
    source: 'mock',
    source_query: 'query-3',
  };
}

/**
 * Builds a Phase 6 digest carrying the given post ids.
 *
 * @param {string[]} ids
 * @returns {object}
 */
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

/**
 * A notifier that returns a scripted result for every message.
 *
 * @param {object} [script]
 * @returns {object}
 */
function notifierFixture(script = {}) {
  return {
    name: 'ntfy',
    async send(message) {
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

/**
 * A Supabase double matching the chains delivery issues, so the real
 * deliverDigest can run and its marking behaviour can be asserted.
 *
 * @returns {object}
 */
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

/** The result a provider returns when the send does not go through. */
const PROVIDER_FAILURE = {
  success: false,
  provider: 'ntfy',
  messageId: null,
  errorType: NOTIFICATION_ERRORS.NETWORK,
  error: 'ntfy notification failed: connection refused',
  retryable: true,
};

/**
 * Environment that keeps every real module on its normal path. Keys are read, not
 * verified: the credentials never reach a provider because the I/O modules are
 * replaced.
 */
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

/**
 * Runs the orchestrator with every I/O collaborator replaced.
 *
 * @param {object} [overrides] Dependency overrides, merged over the defaults.
 * @param {object} [options] runRadar options.
 * @returns {Promise<object>} Run summary.
 */
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
    // Stubbed rather than left real: these reach Supabase, and no test in this
    // file is allowed to make a live call.
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
    ...overrides,
  };

  try {
    return await runRadar({ env: TEST_ENV, deps, ...options });
  } finally {
    restoreConsole();
  }
}

/**
 * Builds a discovery result.
 *
 * @param {object} [config]
 * @returns {object}
 */
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

/**
 * Builds a classification batch result.
 *
 * @param {Array<{ url: string, classification?: object, failed?: boolean }>} entries
 * @returns {object}
 */
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

// ─── Full run ────────────────────────────────────────────────────────────────────

describe('Phase 8 — full successful run', () => {
  it('carries two qualified posts from discovery to a delivered digest', async () => {
    const standard = standardCandidate();
    const high = highPriorityCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [standard, high, irrelevantCandidate()] }),
      classifyCandidates: async () =>
        classificationBatch([
          { url: standard.url, classification: classification() },
          {
            url: high.url,
            classification: classification({
              job_title: 'Lead Product Designer',
              is_hiring_manager_or_recruiter: true,
              remote_status: 'Remote',
              company_name: 'Globex',
            }),
          },
        ]),
      runDigest: async () => {
        calls.push('digest');
        return digestFixture(['p-1', 'p-2']);
      },
      notifyDigest: async () => {
        calls.push('notify');
        return { attempted: true, success: true, provider: 'ntfy', markedCount: 2 };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.queriesRun, 3);
    assert.equal(result.searchResults, 3);
    assert.equal(result.uniqueResults, 3);
    assert.equal(result.candidates, 2, 'the recipe post is filtered out');
    assert.equal(result.classified, 2);
    assert.equal(result.qualified, 2);
    assert.equal(result.notificationSent, true);

    assert.equal(result.status, 'OPERATIONAL');
    assert.equal(persisted.length, 2);
    assert.ok(persisted.every((row) => row.status === 'qualified'));
    assert.deepEqual(calls, [
      'search-run:create',
      'persist',
      'digest',
      'notify',
      'search-run:complete:completed',
    ]);
  });
});

// ─── Profile role policy ────────────────────────────────────────────────────────

describe('Phase 8 — profile role policy', () => {
  /** A candidate the broad-title query retrieves: no level marker in the title. */
  function unlevelledCandidate() {
    return {
      url: postUrl('initech_product-designer-9'),
      title: 'Initech is hiring a Product Designer',
      snippet: 'Initech is hiring a Product Designer for our payments platform. Remote in Europe.',
      publishedAt: new Date().toISOString(),
      source: 'mock',
      source_query: 'query-1',
    };
  }

  it('scores and stores an unlevelled post at the profile seniority', async () => {
    const candidate = unlevelledCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [candidate] }),
      classifyCandidates: async () =>
        classificationBatch([
          {
            url: candidate.url,
            // The model reports exactly what the title says: no level marker.
            classification: classification({
              job_title: 'Product Designer',
              seniority: 'Unknown',
              confidence: 0.68,
              company_name: 'Initech',
              remote_status: 'Remote',
              location: 'Europe',
            }),
          },
        ]),
      runDigest: async () => digestFixture(['p-1']),
      notifyDigest: async () => ({ attempted: true, success: true, provider: 'ntfy', markedCount: 1 }),
    });

    assert.equal(result.qualified, 1, 'a flat-titled post must not be dropped');
    assert.equal(result.status, 'OPERATIONAL');
    assert.equal(persisted.length, 1);

    const [row] = persisted;
    // The stored seniority is the resolved one, so the row and the score agree.
    assert.equal(row.seniority, 'Senior');
    // 30 seniority + 20 hiring + 25 location (remote + Europe) + 10 domain = 85.
    assert.equal(row.relevance_score, 85);
    assert.equal(row.status, 'qualified');
    assert.match(row.score_breakdown.statusReason, /high priority/);
  });

  it('stores a junior post as irrelevant without scoring it', async () => {
    const candidate = {
      ...unlevelledCandidate(),
      url: postUrl('acme_junior-product-designer-9'),
      title: 'Acme is hiring a Junior Product Designer',
      snippet: 'Acme is hiring a Junior Product Designer for our payments platform. Remote in Europe.',
    };

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [candidate] }),
      classifyCandidates: async () =>
        classificationBatch([
          {
            url: candidate.url,
            classification: classification({
              job_title: 'Junior Product Designer',
              seniority: 'Junior',
              company_name: 'Acme',
            }),
          },
        ]),
      runDigest: async () => digestFixture([]),
      notifyDigest: async () => ({ attempted: true, success: false, provider: 'ntfy', markedCount: 0 }),
    });

    assert.equal(result.qualified, 0);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].status, 'irrelevant');
    assert.equal(persisted[0].relevance_score, 0);
    assert.equal(persisted[0].seniority, 'Junior', 'the policy never rewrites a junior title');
  });
});

// ─── Partial search ──────────────────────────────────────────────────────────────

describe('Phase 8 — one search query fails', () => {
  it('records the failed query, keeps the results it did get, and still delivers', async () => {
    const survivor = standardCandidate();

    const result = await runRadarWith({
      runDiscovery: async () =>
        discoveryResult({
          candidates: [survivor],
          failedQueries: [{ query: 'query-2', error: 'search provider query failed' }],
        }),
      classifyCandidates: async () =>
        classificationBatch([{ url: survivor.url, classification: classification() }]),
      runDigest: async () => digestFixture(['p-1']),
      notifyDigest: async () => ({ attempted: true, success: true, provider: 'ntfy', markedCount: 1 }),
    });

    assert.equal(result.success, true, 'a lost query degrades coverage, it does not fail the run');
    assert.equal(result.status, 'PARTIAL');
    assert.match(result.statusReason, /1 search query failed/);
    assert.equal(result.queriesRun, 3);
    assert.equal(result.search.queriesFailed, 1);
    assert.equal(result.search.queriesSucceeded, 2);
    assert.deepEqual(result.search.failedQueries, [
      { query: 'query-2', error: 'search provider query failed' },
    ]);

    assert.equal(result.candidates, 1, 'the surviving query still produced a usable candidate');
    assert.equal(result.qualified, 1);
    assert.equal(result.notificationSent, true);

    assert.ok(calls.includes('search-run:complete:partial'), 'a partial run is recorded as partial');
  });
});

// ─── Partial classification ──────────────────────────────────────────────────────

describe('Phase 8 — one classification fails', () => {
  it('drops only the failed candidate and keeps the rest of the run', async () => {
    const good = standardCandidate();
    const bad = highPriorityCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [good, bad] }),
      classifyCandidates: async () =>
        classificationBatch([
          { url: good.url, classification: classification() },
          { url: bad.url, failed: true },
        ]),
      runDigest: async () => digestFixture(['p-1']),
      notifyDigest: async () => ({ attempted: true, success: true, provider: 'ntfy', markedCount: 1 }),
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.candidates, 2, 'both candidates entered classification');
    assert.equal(result.classified, 1, 'only one classification succeeded');
    assert.equal(result.classification.failed, 1);
    assert.equal(result.qualified, 1);

    assert.equal(persisted.length, 1, 'a candidate with no classification cannot be stored');
    assert.equal(persisted[0].linkedin_url, good.url);
    assert.ok(!persisted.some((row) => row.linkedin_url === bad.url));
  });
});

// ─── Score does not gate qualification ───────────────────────────────────────────

describe('Phase 8 — a qualified post below the threshold', () => {
  it('stores, digests, and notifies it as standard priority', async () => {
    const standard = standardCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [standard] }),
      classifyCandidates: async () =>
        classificationBatch([{ url: standard.url, classification: classification() }]),
      runDigest: async () => digestFixture(['p-1']),
      notifyDigest: async () => ({ attempted: true, success: true, provider: 'ntfy', markedCount: 1 }),
    });

    assert.equal(result.qualified, 1);
    assert.equal(result.notificationSent, true);
    assert.equal(result.success, true);

    assert.equal(result.scoring.eligible, 1);
    assert.equal(result.scoring.highPriority, 0);
    assert.equal(result.scoring.standardPriority, 1);

    assert.equal(persisted.length, 1);
    assert.ok(
      persisted[0].relevance_score < 60,
      `expected a score below the threshold, got ${persisted[0].relevance_score}`
    );
    assert.equal(persisted[0].status, 'qualified', 'a low score does not disqualify a post');
    assert.equal(persisted[0].score_breakdown.qualification.priority, 'standard');
  });
});

describe('Phase 8 — a qualified post at or above the threshold', () => {
  it('stores it with high priority', async () => {
    const high = highPriorityCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [high] }),
      classifyCandidates: async () =>
        classificationBatch([
          {
            url: high.url,
            classification: classification({
              job_title: 'Lead Product Designer',
              is_hiring_manager_or_recruiter: true,
              remote_status: 'Remote',
              company_name: 'Globex',
            }),
          },
        ]),
      runDigest: async () => digestFixture(['p-1']),
      notifyDigest: async () => ({ attempted: true, success: true, provider: 'ntfy', markedCount: 1 }),
    });

    assert.equal(result.qualified, 1);
    assert.equal(result.scoring.highPriority, 1);
    assert.equal(result.scoring.standardPriority, 0);

    assert.equal(persisted.length, 1);
    assert.ok(
      persisted[0].relevance_score >= 60,
      `expected a score at or above the threshold, got ${persisted[0].relevance_score}`
    );
    assert.equal(persisted[0].status, 'qualified');
    assert.equal(persisted[0].score_breakdown.qualification.priority, 'high');
  });
});

// ─── Notification outcomes ───────────────────────────────────────────────────────

describe('Phase 8 — the notification fails', () => {
  it('reports the failure and marks nothing as sent', async () => {
    const standard = standardCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [standard] }),
      classifyCandidates: async () =>
        classificationBatch([{ url: standard.url, classification: classification() }]),
      runDigest: async () => digestFixture(['p-1']),
      // The real delivery module runs here so the marking rule under test is the
      // one that ships, not a stand-in that could agree with a broken pipeline.
      notifyDigest: async ({ digest }) =>
        deliverDigest({
          digest,
          notifier: notifierFixture({ result: PROVIDER_FAILURE }),
          recipient: 'design-radar',
          client: fakeClient(),
        }),
    });

    assert.equal(result.notificationSent, false);
    assert.equal(result.success, false, 'an attempted send that failed must surface as a failed run');
    assert.equal(result.notification.errorType, NOTIFICATION_ERRORS.NETWORK);

    assert.ok(calls.includes('send'), 'the provider was actually called');
    assert.ok(!calls.includes('mark'), 'a failed send must never mark posts as sent');
    assert.ok(calls.includes('record:notifications'), 'the failure is still recorded for audit');

    assert.equal(persisted.length, 1, 'the scan result survives a delivery failure');
    assert.equal(result.qualified, 1);
  });
});

describe('Phase 8 — the notification succeeds', () => {
  it('marks the posts sent, after the provider confirms', async () => {
    const standard = standardCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [standard] }),
      classifyCandidates: async () =>
        classificationBatch([{ url: standard.url, classification: classification() }]),
      runDigest: async () => {
        calls.push('digest');
        return digestFixture(['p-1']);
      },
      notifyDigest: async ({ digest }) => {
        calls.push('notify');
        return deliverDigest({
          digest,
          notifier: notifierFixture(),
          recipient: 'design-radar',
          client: fakeClient(),
        });
      },
    });

    assert.equal(result.notificationSent, true);
    assert.equal(result.success, true);
    assert.equal(result.notification.markedCount, 1);

    assert.deepEqual(calls, [
      'search-run:create',
      'persist',
      'digest',
      'notify',
      'duplicate-check',
      'send',
      'record:notifications',
      'mark',
      'search-run:complete:completed',
    ]);
  });
});

// ─── Stored URL case repair ──────────────────────────────────────────────────────

describe('Phase 8 — a stored post URL differs only by case', () => {
  it('repairs the stored link instead of storing the post twice', async () => {
    const standard = standardCandidate();
    const corrected = `${standard.url}-AbC`;
    const repaired = [];

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [{ ...standard, url: corrected }] }),
      classifyCandidates: async () =>
        classificationBatch([{ url: corrected, classification: classification() }]),
      findExistingUrls: async () => new Set([corrected]),
      findUrlCaseDrift: async () => [
        { id: 'p1', stored: standard.url, incoming: corrected },
      ],
      realignUrlCase: async (drift) => {
        repaired.push(...drift);
        return drift.length;
      },
      runDigest: async () => digestFixture([]),
      notifyDigest: async ({ digest }) =>
        deliverDigest({ digest, notifier: notifierFixture(), recipient: 'design-radar', client: fakeClient() }),
    });

    assert.equal(repaired.length, 1, 'the stale casing is repaired');
    assert.equal(repaired[0].incoming, corrected);
    assert.equal(persisted.length, 0, 'the post is a duplicate and must not be stored again');
    assert.equal(result.qualified, 1);
  });

  it('does not fail the run when the repair fails', async () => {
    const standard = standardCandidate();

    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [standard] }),
      classifyCandidates: async () =>
        classificationBatch([{ url: standard.url, classification: classification() }]),
      findUrlCaseDrift: async () => {
        throw new Error('supabase unavailable');
      },
      runDigest: async () => digestFixture(['p-1']),
      notifyDigest: async () => ({ attempted: true, success: true, provider: 'ntfy', markedCount: 1 }),
    });

    assert.equal(result.success, true, 'a stale link is cosmetic and must not fail a scan');
    assert.equal(result.qualified, 1);
    assert.equal(persisted.length, 1);
  });
});

// ─── Nothing found ───────────────────────────────────────────────────────────────

describe('Phase 8 — discovery returns nothing', () => {
  it('completes as a successful run without notifying or storing anything', async () => {
    const result = await runRadarWith({
      runDiscovery: async () => discoveryResult({ candidates: [] }),
      classifyCandidates: async () => {
        throw new Error('classification must not run without candidates');
      },
      runDigest: async () => digestFixture([]),
      notifyDigest: async ({ digest }) =>
        deliverDigest({
          digest,
          notifier: notifierFixture(),
          recipient: 'design-radar',
          client: fakeClient(),
        }),
    });

    assert.equal(result.success, true, 'finding nothing is a successful run');
    assert.equal(result.status, 'OPERATIONAL');
    assert.equal(result.queriesRun, 3);
    assert.equal(result.searchResults, 0);
    assert.equal(result.uniqueResults, 0);
    assert.equal(result.candidates, 0);
    assert.equal(result.classified, 0);
    assert.equal(result.qualified, 0);

    assert.equal(result.notificationSent, false, 'an empty digest is not a delivery');
    assert.equal(result.notification.skipped, true);
    assert.equal(result.notification.reason, 'empty_digest');

    assert.equal(persisted.length, 0);
    assert.ok(!calls.includes('mark'));
    assert.ok(!calls.includes('send'), 'nothing to deliver means nothing is published');
  });
});
