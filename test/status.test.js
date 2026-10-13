/**
 * Recency Evaluation and Status Derivation Tests (PROJECT_SPEC §18, §17).
 *
 * Covers:
 * - Timestamp parsing for the formats search providers actually return
 * - The 24-hour recent/stale boundary
 * - §18 rule 3: unverified timestamps are not fabricated
 * - Status precedence across recency, role gate, confidence, and score
 * - A six-month-old opening never resolves to 'qualified'
 *
 * Time is pinned everywhere so results are reproducible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePublishedAt,
  evaluateRecency,
  resolvePostStatus,
  evaluateCandidate,
  isWithinValidityWindow,
  RECENCY_WINDOW_HOURS,
  RECENT_PIVOT_HOURS,
  RECENCY_STATES,
  POST_STATUSES,
} from '../src/filtering/status.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

/** Hours as milliseconds offset from NOW. */
function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Builds a Phase 4 classification with defaults.
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
    is_hiring_manager_or_recruiter: true,
    location: 'Europe',
    remote_status: 'Remote',
    application_url: null,
    confidence: 0.9,
    reason: 'test',
    ...overrides,
  };
}

const CANDIDATE = {
  title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
  snippet: 'AcmePay is hiring a Senior Product Designer for our fintech payments platform. Remote in Europe.',
};

describe('Recency — Timestamp Parsing', () => {
  it('parses an ISO timestamp with a Z offset', () => {
    const result = parsePublishedAt('2026-10-01T08:00:00Z', { now: NOW });
    assert.equal(result.verified, true);
    assert.equal(result.iso, '2026-10-01T08:00:00.000Z');
  });

  it('parses an ISO timestamp with a numeric offset', () => {
    const result = parsePublishedAt('2026-10-01T09:00:00+01:00', { now: NOW });
    assert.equal(result.verified, true);
    assert.equal(result.iso, '2026-10-01T08:00:00.000Z');
  });

  it('parses a bare date as UTC midnight, not host-local midnight', () => {
    // Date.parse('2026-09-30') is UTC, but '2026-09-30 10:00' is local without help.
    const result = parsePublishedAt('2026-09-30', { now: NOW });
    assert.equal(result.iso, '2026-09-30T00:00:00.000Z');
  });

  it('treats a naive date-time as UTC so values do not vary by host timezone', () => {
    const result = parsePublishedAt('2026-10-01 08:00:00', { now: NOW });
    assert.equal(result.verified, true);
    assert.equal(result.iso, '2026-10-01T08:00:00.000Z');
  });

  it('rejects locale strings that Date.parse would resolve against the host timezone', () => {
    // "Sep 30, 2026" parses in V8 but means different instants per machine.
    const result = parsePublishedAt('Sep 30, 2026', { now: NOW });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'unparseable');
  });

  it('parses the relative ages Brave and Serper return', () => {
    const cases = [
      ['3 days ago', '2026-09-28T12:00:00.000Z'],
      ['2 weeks ago', '2026-09-17T12:00:00.000Z'],
      ['6 months ago', '2026-04-04T12:00:00.000Z'],
      ['1 hour ago', '2026-10-01T11:00:00.000Z'],
      ['30 minutes ago', '2026-10-01T11:30:00.000Z'],
    ];

    for (const [input, expected] of cases) {
      const result = parsePublishedAt(input, { now: NOW });
      assert.equal(result.verified, true, `${input} should parse`);
      assert.equal(result.iso, expected, input);
    }
  });

  it('parses shorthand relative units', () => {
    assert.equal(parsePublishedAt('3d ago', { now: NOW }).iso, '2026-09-28T12:00:00.000Z');
    assert.equal(parsePublishedAt('2h ago', { now: NOW }).iso, '2026-10-01T10:00:00.000Z');
  });

  it('parses today and yesterday', () => {
    assert.equal(parsePublishedAt('today', { now: NOW }).iso, NOW.toISOString());
    assert.equal(parsePublishedAt('yesterday', { now: NOW }).iso, hoursAgo(24));
  });

  it('parses a Date instance and epoch milliseconds', () => {
    assert.equal(parsePublishedAt(NOW).iso, NOW.toISOString());
    assert.equal(parsePublishedAt(NOW.getTime()).iso, NOW.toISOString());
  });

  it('reports missing, empty, and unparseable values without inventing a date', () => {
    assert.equal(parsePublishedAt(null, { now: NOW }).reason, 'missing');
    assert.equal(parsePublishedAt(undefined, { now: NOW }).reason, 'missing');
    assert.equal(parsePublishedAt('   ', { now: NOW }).reason, 'empty');
    assert.equal(parsePublishedAt('unknown', { now: NOW }).reason, 'unparseable');
    assert.equal(parsePublishedAt('a month ago', { now: NOW }).reason, 'unparseable');
    assert.equal(parsePublishedAt({}, { now: NOW }).reason, 'unsupported_type');

    for (const value of [null, undefined, '   ', 'unknown']) {
      assert.equal(parsePublishedAt(value, { now: NOW }).iso, null);
    }
  });
});

describe('Recency — Window Classification', () => {
  it('uses a fixed one-week validity window', () => {
    assert.equal(RECENCY_WINDOW_HOURS, 168);
    assert.equal(evaluateRecency(hoursAgo(1), { now: NOW }).windowHours, 168);
  });

  it('classifies a post from four hours ago as recent', () => {
    const recency = evaluateRecency(hoursAgo(4), { now: NOW });
    assert.equal(recency.state, RECENCY_STATES.RECENT);
    assert.equal(recency.verified, true);
    assert.equal(recency.ageHours, 4);
  });

  it('treats a post from 24 hours ago as valid', () => {
    assert.equal(evaluateRecency(hoursAgo(24), { now: NOW }).state, RECENCY_STATES.RECENT);
  });

  it('treats a post from 25 hours ago as valid, not stale', () => {
    assert.equal(evaluateRecency(hoursAgo(25), { now: NOW }).state, RECENCY_STATES.RECENT);
  });

  it('treats a post from exactly one week ago as valid', () => {
    assert.equal(evaluateRecency(hoursAgo(168), { now: NOW }).state, RECENCY_STATES.RECENT);
  });

  it('classifies a six-month-old opening as stale', () => {
    const recency = evaluateRecency('2026-04-01T09:00:00Z', { now: NOW });
    assert.equal(recency.state, RECENCY_STATES.STALE);
    assert.ok(recency.ageHours > 4000);
  });

  it('classifies a relative "6 months ago" as stale', () => {
    assert.equal(evaluateRecency('6 months ago', { now: NOW }).state, RECENCY_STATES.STALE);
  });

  it('classifies a missing timestamp as unverified', () => {
    const recency = evaluateRecency(null, { now: NOW });
    assert.equal(recency.state, RECENCY_STATES.UNVERIFIED);
    assert.equal(recency.verified, false);
    assert.equal(recency.iso, null);
  });

  it('treats a future timestamp as recent and flags it', () => {
    const recency = evaluateRecency(hoursAgo(-2), { now: NOW });
    assert.equal(recency.state, RECENCY_STATES.RECENT);
    assert.equal(recency.inFuture, true);
  });

  it('returns an ISO string suitable for a timestamptz column', () => {
    assert.equal(evaluateRecency(hoursAgo(2), { now: NOW }).iso, hoursAgo(2));
  });

  it('reports the one-week window regardless of stray input', () => {
    const attempts = [{}, { now: NOW }, { windowHours: 1 }, { windowHours: 9999 }, { windowHours: 'abc' }];

    for (const options of attempts) {
      assert.equal(evaluateRecency(hoursAgo(4), options).windowHours, 168);
    }
  });

});

describe('Recency — Validity Window Is 24h To 168h', () => {
  it('uses a one-week window as a fixed invariant', () => {
    assert.equal(RECENCY_WINDOW_HOURS, 168);
    assert.equal(RECENCY_WINDOW_HOURS, 7 * 24);
    assert.equal(RECENT_PIVOT_HOURS, 24);
  });

  it('treats every age from 0h through 168h as valid', () => {
    // The whole band the user asked to keep valid, sampled densely.
    const band = [
      0, 0.5, 1, 6, 12, 23, 24, 24.5, 25, 36, 47, 48, 49, 60, 72, 96,
      120, 143, 144, 160, 167, 167.9, 168,
    ];

    for (const age of band) {
      const recency = evaluateRecency(hoursAgo(age), { now: NOW });
      assert.equal(recency.state, RECENCY_STATES.RECENT, `${age}h should be valid`);
      assert.equal(isWithinValidityWindow(recency.ageHours), true, `${age}h`);
    }
  });

  it('treats anything after 168h as stale', () => {
    const beyond = [168.1, 169, 170, 192, 240, 336, 720, 1440, 4380, 8760];

    for (const age of beyond) {
      const recency = evaluateRecency(hoursAgo(age), { now: NOW });
      assert.equal(recency.state, RECENCY_STATES.STALE, `${age}h should be stale`);
      assert.equal(isWithinValidityWindow(recency.ageHours), false, `${age}h`);
    }
  });

  it('holds the 168h boundary exactly', () => {
    // Inclusive upper bound: exactly one week old is still valid.
    assert.equal(evaluateRecency(hoursAgo(168), { now: NOW }).state, RECENCY_STATES.RECENT);

    const justOver = new Date(NOW.getTime() - (168 * 60 * 60 * 1000 + 1000));
    assert.equal(evaluateRecency(justOver.toISOString(), { now: NOW }).state, RECENCY_STATES.STALE);
  });

  it('flags the first 24h as verified-recent for digest prioritization', () => {
    assert.equal(evaluateRecency(hoursAgo(2), { now: NOW }).verifiedRecent, true);
    assert.equal(evaluateRecency(hoursAgo(24), { now: NOW }).verifiedRecent, true);
    assert.equal(evaluateRecency(hoursAgo(48), { now: NOW }).verifiedRecent, false);
    assert.equal(evaluateRecency(hoursAgo(168), { now: NOW }).verifiedRecent, false);
  });

  it('never reports a window other than one week', () => {
    for (const options of [{}, { now: NOW }, { windowHours: 1 }, { windowHours: 99999 }]) {
      assert.equal(evaluateRecency(hoursAgo(1), options).windowHours, 168);
    }
  });

  it('qualifies a scoring post anywhere in the valid band', () => {
    for (const age of [1, 24, 48, 120, 167, 168]) {
      const result = evaluateCandidate(classification(), {
        candidate: CANDIDATE,
        publishedAt: hoursAgo(age),
        now: NOW,
      });

      assert.equal(result.score, 95);
      assert.equal(result.status, 'qualified', `${age}h old should be valid`);
    }
  });

  it('marks a scoring post stale just past the band', () => {
    for (const age of [169, 240, 4380]) {
      const result = evaluateCandidate(classification(), {
        candidate: CANDIDATE,
        publishedAt: hoursAgo(age),
        now: NOW,
      });

      assert.equal(result.status, 'stale', `${age}h old should be stale`);
      assert.equal(result.explanation.recency.state, 'stale');
    }
  });

  it('cannot be widened by configuration', () => {
    const stale = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(200),
      now: NOW,
      windowHours: 999999,
    });

    assert.equal(stale.status, 'stale');
    assert.equal(stale.explanation.recency.windowHours, 168);
  });

  it('reports unverified timestamps as neither valid-by-age nor stale', () => {
    // §18 rule 3: no date means no age, so the window cannot disqualify it.
    const recency = evaluateRecency(null, { now: NOW });
    assert.equal(recency.state, RECENCY_STATES.UNVERIFIED);
    assert.equal(isWithinValidityWindow(recency.ageHours), false);
    assert.equal(recency.verifiedRecent, false);
  });

  it('ignores a stray windowHours argument rather than trusting it', () => {
    const narrowed = evaluateRecency(hoursAgo(100), { now: NOW, windowHours: 1 });
    assert.equal(narrowed.state, RECENCY_STATES.RECENT);
    assert.equal(narrowed.windowHours, 168);
  });
});

describe('Status Derivation — Precedence', () => {
  it('marks a recent qualified post qualified', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    assert.equal(result.score, 95);
    assert.equal(result.status, 'qualified');
    assert.match(result.reason, /score 95 >= 60/);
  });

  it('marks a stale post stale even with a perfect score', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: '2026-04-01T09:00:00Z',
      now: NOW,
    });

    assert.equal(result.score, 95);
    assert.equal(result.status, 'stale');
    assert.match(result.reason, /stale/);
  });

  it('marks a six-month-old opening stale — the primary goal', () => {
    const sixMonthsAgo = new Date('2026-04-01T09:00:00Z');
    const result = evaluateCandidate(classification(), {
      candidate: {
        title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
        snippet: 'We are hiring a Senior Product Designer for our fintech platform. Remote worldwide.',
      },
      publishedAt: sixMonthsAgo.toISOString(),
      now: NOW,
    });

    assert.equal(result.status, 'stale');
    assert.ok(POST_STATUSES.includes(result.status));
  });

  it('marks a one-year-old post stale', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: '2025-10-01T08:00:00Z',
      now: NOW,
    });

    assert.equal(result.status, 'stale');
  });

  it('lets stale outrank the role gate, since staleness is irrecoverable', () => {
    const result = evaluateCandidate(
      classification({ is_product_design_role: false, job_title: 'Graphic Designer' }),
      { candidate: CANDIDATE, publishedAt: '2026-04-01T09:00:00Z', now: NOW }
    );

    assert.equal(result.status, 'stale');
    assert.equal(result.eligible, false);
  });

  it('lets stale outrank low confidence', () => {
    const result = evaluateCandidate(
      classification({ confidence: 0.3, job_title: 'Head of Product Design' }),
      {
        candidate: CANDIDATE,
        publishedAt: '2026-04-01T09:00:00Z',
        now: NOW,
      }
    );

    assert.equal(result.status, 'stale');
  });

  it('keeps a below-threshold recent post qualified as standard priority', () => {
    const result = evaluateCandidate(
      classification({ seniority: 'Mid', job_title: 'Product Designer', location: null, remote_status: 'Unknown' }),
      { candidate: CANDIDATE, publishedAt: hoursAgo(3), now: NOW }
    );

    // The score never decided status; it only reports how weak the match is.
    assert.equal(result.eligible, true);
    assert.equal(result.status, 'qualified');
    assert.equal(result.priority, 'standard');
    assert.match(result.reason, /score \d+ < 60/);
  });

  it('marks a low-confidence post low_confidence even when recent and high-scoring', () => {
    const result = evaluateCandidate(
      classification({ confidence: 0.5, job_title: 'Head of Product Design' }),
      {
        candidate: CANDIDATE,
        publishedAt: hoursAgo(3),
        now: NOW,
      }
    );

    assert.equal(result.score, 95);
    assert.equal(result.status, 'low_confidence');
  });

  it('exempts an unlevelled product design role from the confidence gate', () => {
    const result = evaluateCandidate(
      classification({ confidence: 0.5, job_title: 'Product Designer', seniority: 'Unknown' }),
      {
        candidate: CANDIDATE,
        publishedAt: hoursAgo(3),
        now: NOW,
      }
    );

    // Flat-titled posts carry the thinnest snippets, so the gate would otherwise
    // discard exactly what the profile searches for.
    assert.equal(result.status, 'qualified');
  });

  it('keeps a junior post out even when it would pass the confidence gate', () => {
    const result = evaluateCandidate(
      classification({ seniority: 'Junior', job_title: 'Junior Product Designer', confidence: 0.95 }),
      {
        candidate: CANDIDATE,
        publishedAt: hoursAgo(3),
        now: NOW,
      }
    );

    assert.equal(result.status, 'irrelevant');
    assert.match(result.reason, /role gate/);
  });

  it('marks a role-gate failure irrelevant regardless of age within the window', () => {
    const result = evaluateCandidate(
      classification({ is_product_design_role: false, job_title: 'Graphic Designer' }),
      { candidate: CANDIDATE, publishedAt: hoursAgo(3), now: NOW }
    );

    assert.equal(result.status, 'irrelevant');
    assert.match(result.reason, /role gate/);
  });

  it('marks a low-confidence post low_confidence even when recent and high-scoring', () => {
    const result = evaluateCandidate(
      classification({ confidence: 0.5, job_title: 'Head of Product Design' }),
      {
        candidate: CANDIDATE,
        publishedAt: hoursAgo(3),
        now: NOW,
      }
    );

    assert.equal(result.score, 95);
    assert.equal(result.status, 'low_confidence');
  });

  it('treats an unverified timestamp as qualifying (§18 rule 3)', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: null,
      now: NOW,
    });

    assert.equal(result.recency.state, RECENCY_STATES.UNVERIFIED);
    assert.equal(result.status, 'qualified');
    assert.equal(result.recency.iso, null, 'no date is invented');
  });

  it('treats an unparseable timestamp as unverified rather than recent', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: 'a month ago',
      now: NOW,
    });

    assert.equal(result.recency.state, RECENCY_STATES.UNVERIFIED);
    assert.equal(result.recency.parseReason, 'unparseable');
  });

  it('never returns a status outside the schema CHECK constraint', () => {
    const cases = [
      { classification: classification(), publishedAt: hoursAgo(2) },
      { classification: classification(), publishedAt: '2026-01-05T09:00:00Z' },
      { classification: classification({ confidence: 0.2 }), publishedAt: hoursAgo(2) },
      { classification: classification({ is_product_design_role: false }), publishedAt: hoursAgo(2) },
      { classification: classification({ seniority: 'Mid', remote_status: 'On-site' }), publishedAt: null },
      { classification: classification(), publishedAt: 'garbage' },
    ];

    for (const testCase of cases) {
      const { status } = evaluateCandidate(testCase.classification, {
        candidate: CANDIDATE,
        publishedAt: testCase.publishedAt,
        now: NOW,
      });
      assert.ok(POST_STATUSES.includes(status), `unexpected status: ${status}`);
    }
  });

  it('resolvePostStatus is usable standalone', () => {
    const scored = {
      eligible: true,
      status: 'qualified',
      score: 80,
      threshold: 60,
      priority: 'high',
      qualificationReason: 'recruiting product design post; high priority: score 80 >= 60',
    };
    const recency = evaluateRecency(hoursAgo(1), { now: NOW });

    assert.equal(resolvePostStatus({ scored, classification: classification(), recency }).status, 'qualified');
    assert.equal(
      resolvePostStatus({
        scored,
        classification: classification(),
        recency: evaluateRecency('2026-01-05T09:00:00Z', { now: NOW }),
      }).status,
      'stale'
    );
  });

  it('resolvePostStatus ignores the score entirely', () => {
    const recency = evaluateRecency(hoursAgo(1), { now: NOW });

    // Same eligibility and confidence, wildly different score: the status cannot
    // move, because scorePost never let the score reach this function.
    for (const score of [0, 15, 45, 95]) {
      const { status } = resolvePostStatus({
        scored: { eligible: true, score, threshold: 60, priority: 'standard' },
        classification: classification(),
        recency,
      });
      assert.equal(status, 'qualified', `score ${score}`);
    }

    // And an ineligible post is irrelevant at any score.
    assert.equal(
      resolvePostStatus({
        scored: { eligible: false, score: 100, threshold: 60, priority: null },
        classification: classification(),
        recency,
      }).status,
      'irrelevant'
    );
  });
});

describe('Status Derivation — Score Explainability', () => {
  it('exposes signal lines and structured detail for persistence', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    assert.ok(Array.isArray(result.explanation.explain));
    assert.ok(result.explanation.explain.some((line) => line.includes('seniority: +30')));
    assert.ok(result.explanation.explain.some((line) => line.includes('domain_match: +10')));

    assert.ok(Array.isArray(result.explanation.breakdown));
    const seniority = result.explanation.breakdown.find((b) => b.signal === 'seniority');
    assert.equal(seniority.points, 30);
    assert.equal(seniority.matched, 'Senior');

    assert.equal(result.explanation.recency.state, 'recent');
    assert.equal(result.explanation.recency.ageHours, 2);
    assert.match(result.explanation.statusReason, /score 95 >= 60/);
  });

  it('records recency state for a stale post', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: '2026-04-01T09:00:00Z',
      now: NOW,
    });

    assert.equal(result.explanation.recency.state, 'stale');
    assert.equal(result.explanation.breakdown.length, 5);
  });

  it('returns an empty breakdown for a role-gate failure', () => {
    const result = evaluateCandidate(
      classification({ is_product_design_role: false, job_title: 'Graphic Designer' }),
      { candidate: CANDIDATE, publishedAt: hoursAgo(2), now: NOW }
    );

    assert.deepEqual(result.explanation.breakdown, []);
    assert.match(result.explanation.explain[0], /role gate/);
  });

  it('serializes the explanation to JSON for a JSONB column', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    const roundTripped = JSON.parse(JSON.stringify(result.explanation));
    assert.deepEqual(roundTripped, result.explanation);
    assert.ok(Array.isArray(roundTripped.breakdown));
  });

  it('is deterministic for the same input and reference time', () => {
    const first = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      now: NOW,
    });
    const second = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    assert.deepEqual(first, second);
  });

  it('honours a custom threshold as a priority band only', () => {
    const relaxed = evaluateCandidate(classification({ seniority: 'Mid' }), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      minScore: 10,
      now: NOW,
    });
    const strict = evaluateCandidate(classification({ seniority: 'Mid' }), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      minScore: 99,
      now: NOW,
    });

    // The threshold changes the label and nothing else: a mid-level product
    // design vacancy is a legitimate opportunity at both settings.
    assert.equal(relaxed.status, 'qualified');
    assert.equal(strict.status, 'qualified');
    assert.equal(relaxed.score, strict.score);
    assert.equal(relaxed.priority, 'high');
    assert.equal(strict.priority, 'standard');
  });
});

describe('Status Derivation — Eligibility and Priority', () => {
  // A Senior post whose snippet is too thin to reach 60: the only surviving
  // signals are seniority and the explicit Remote arrangement.
  const THIN = { title: 'Senior Product Designer', snippet: 'Remote.' };
  const THIN_CLASSIFICATION = classification({
    location: null,
    is_hiring_manager_or_recruiter: false,
  });

  it('keeps a thin Senior + Remote post qualified as standard priority', () => {
    const result = evaluateCandidate(THIN_CLASSIFICATION, {
      candidate: THIN,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    assert.equal(result.score, 45);
    assert.equal(result.eligible, true);
    assert.equal(result.status, 'qualified');
    assert.equal(result.priority, 'standard');
    assert.match(result.reason, /standard priority/);
    assert.match(result.reason, /score 45 < 60/);
  });

  it('records the qualification method in the persisted explanation', () => {
    const result = evaluateCandidate(THIN_CLASSIFICATION, {
      candidate: THIN,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    assert.deepEqual(result.explanation.qualification, {
      method: 'eligibility',
      score: 45,
      threshold: 60,
      priority: 'standard',
    });
    assert.ok(
      result.explanation.explain.some((line) => line.includes('eligibility')),
      'score_explain must name the qualification method'
    );
    assert.match(result.explanation.statusReason, /standard priority/);
  });

  it('records a high-priority post with its own band', () => {
    const result = evaluateCandidate(classification(), {
      candidate: CANDIDATE,
      publishedAt: hoursAgo(2),
      now: NOW,
    });

    assert.deepEqual(result.explanation.qualification, {
      method: 'eligibility',
      score: 95,
      threshold: 60,
      priority: 'high',
    });
  });

  it('does not let a qualifying post bypass the confidence gate', () => {
    const result = evaluateCandidate(
      classification({
        ...THIN_CLASSIFICATION,
        confidence: 0.5,
        // A levelled title the profile policy does not exempt, so the gate is
        // genuinely exercised here.
        job_title: 'Founding Designer',
      }),
      {
        candidate: THIN,
        publishedAt: hoursAgo(2),
        now: NOW,
      }
    );

    assert.equal(result.status, 'low_confidence');
    assert.match(result.reason, /confidence below/);
    assert.equal(result.eligible, true, 'eligibility itself is unchanged');
  });

  it('does not let a qualifying post bypass staleness', () => {
    const result = evaluateCandidate(THIN_CLASSIFICATION, {
      candidate: THIN,
      publishedAt: '2026-04-01T09:00:00Z',
      now: NOW,
    });

    assert.equal(result.status, 'stale');
    assert.match(result.reason, /stale/);
    assert.equal(result.eligible, true);
  });

  it('does not let the priority threshold bypass the role gate', () => {
    const result = evaluateCandidate(
      classification({
        ...THIN_CLASSIFICATION,
        job_title: 'Senior Product Manager',
        is_product_design_role: false,
      }),
      { candidate: THIN, publishedAt: hoursAgo(2), minScore: 0, now: NOW }
    );

    assert.equal(result.status, 'irrelevant');
    assert.equal(result.eligible, false);
    assert.equal(result.priority, null);
    assert.match(result.reason, /role gate/);
    assert.equal(result.explanation.qualification.method, 'none');
  });

  it('keeps an unverified-timestamp qualifying post rather than dropping it', () => {
    // §18 rule 3: an unverifiable date must not cost a post its digest.
    const result = evaluateCandidate(THIN_CLASSIFICATION, {
      candidate: THIN,
      publishedAt: null,
      now: NOW,
    });

    assert.equal(result.recency.state, RECENCY_STATES.UNVERIFIED);
    assert.equal(result.status, 'qualified');
  });

  it('keeps a Senior post without a remote signal, as standard priority', () => {
    const result = evaluateCandidate(
      classification({ ...THIN_CLASSIFICATION, remote_status: 'Unknown' }),
      { candidate: { title: 'Senior Product Designer', snippet: 'We are hiring.' }, publishedAt: hoursAgo(2), now: NOW }
    );

    assert.equal(result.score, 50);
    assert.equal(result.eligible, true);
    assert.equal(result.status, 'qualified');
    assert.equal(result.priority, 'standard');
    assert.match(result.reason, /score 50 < 60/);
    assert.equal(result.explanation.qualification.method, 'eligibility');
  });
});
