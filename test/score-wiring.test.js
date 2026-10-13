/**
 * Phase 5 Pipeline Wiring Tests.
 *
 * Verifies that the deterministic score produced by src/ai/score.js is what
 * reaches the database row, and that status is derived correctly from the score
 * and confidence gate.
 *
 * Covers:
 * - Score/status propagation into the linkedin_posts row
 * - Status precedence: role gate and confidence — never the score
 * - Nothing is inferred for missing fields
 * - A post the role gate rejected can never be persisted as qualified
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPostRow } from '../src/database/posts.js';
import { DEFAULT_MIN_RELEVANCE_SCORE } from '../src/ai/score.js';
import { DEFAULT_MIN_CONFIDENCE, meetsConfidenceThreshold } from '../src/ai/classify.js';
import { evaluateCandidate, POST_STATUSES } from '../src/filtering/status.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

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
    reason: 'Explicit Senior Product Designer vacancy.',
    ...overrides,
  };
}

const CANDIDATE = {
  title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
  snippet: 'AcmePay is hiring a Senior Product Designer for our fintech payments platform. Fully remote in Europe.',
};

/**
 * Runs the real scoring + status pipeline and returns the row the pipeline would
 * persist, so this test covers the actual wiring rather than a reimplementation.
 *
 * @param {object} ai
 * @param {Object} [options]
 * @returns {{ evaluation: object, row: object }}
 */
function persist(ai, options = {}) {
  const evaluation = evaluateCandidate(ai, {
    candidate: CANDIDATE,
    publishedAt: options.publishedAt ?? null,
    now: NOW,
  });

  const row = buildPostRow({
    linkedin_url: 'https://www.linkedin.com/posts/acmepay-111',
    job_title: ai.job_title,
    seniority: ai.seniority,
    company_name: ai.company_name,
    author_name: ai.author_name,
    location: ai.location,
    remote_status: ai.remote_status,
    application_url: ai.application_url,
    is_hiring_manager_or_recruiter: ai.is_hiring_manager_or_recruiter,
    is_recruiting_post: ai.is_recruiting_post,
    is_product_design_role: ai.is_product_design_role,
    confidence: ai.confidence,
    classification_reason: ai.reason,
    published_at: evaluation.recency.iso,
    relevance_score: evaluation.score,
    status: evaluation.status,
    score_explain: evaluation.explanation.explain.join('\n'),
    score_breakdown: evaluation.explanation,
  });

  return { evaluation, row };
}

describe('Phase 5 Wiring — Score Reaches the Database Row', () => {
  it('persists the computed relevance score and status', () => {
    const { row } = persist(classification());

    assert.equal(row.relevance_score, 95);
    assert.equal(row.status, 'qualified');
  });

  it('persists all Phase 4 classification fields alongside the score', () => {
    const { row } = persist(
      classification({ author_name: 'Jane Recruiter', application_url: 'https://apply.example' })
    );

    assert.equal(row.job_title, 'Senior Product Designer');
    assert.equal(row.seniority, 'Senior');
    assert.equal(row.company_name, 'AcmePay');
    assert.equal(row.author_name, 'Jane Recruiter');
    assert.equal(row.location, 'Europe');
    assert.equal(row.remote_status, 'Remote');
    assert.equal(row.application_url, 'https://apply.example');
    assert.equal(row.is_hiring_manager_or_recruiter, true);
    assert.equal(row.is_recruiting_post, true);
    assert.equal(row.is_product_design_role, true);
    assert.equal(row.confidence, 0.9);
    assert.equal(row.relevance_score, 95);
    assert.equal(row.status, 'qualified');
  });

  it('persists the score explanation for later auditing', () => {
    const { row } = persist(classification());

    assert.ok(row.score_explain.includes('seniority: +30'));
    assert.ok(row.score_explain.includes('domain_match: +10'));

    assert.deepEqual(row.score_breakdown.explain, row.score_explain.split('\n'));
    const seniority = row.score_breakdown.breakdown.find((b) => b.signal === 'seniority');
    assert.equal(seniority.points, 30);
    assert.equal(row.score_breakdown.recency.state, 'unverified');
    assert.match(row.score_breakdown.statusReason, /score 95 >= 60/);
  });

  it('serializes the breakdown to JSON without loss', () => {
    const { row } = persist(classification());
    assert.deepEqual(JSON.parse(JSON.stringify(row.score_breakdown)), row.score_breakdown);
  });

  it('produces a row that satisfies every linkedin_posts column', () => {
    const row = buildPostRow({ linkedin_url: 'https://www.linkedin.com/posts/x-1' });
    for (const column of [
      'linkedin_url', 'search_run_id', 'source_provider', 'source_query', 'post_text',
      'published_at', 'discovered_at', 'author_name', 'company_name', 'job_title',
      'seniority', 'location', 'remote_status', 'application_url',
      'is_hiring_manager_or_recruiter', 'is_recruiting_post', 'is_product_design_role',
      'confidence', 'classification_reason', 'relevance_score', 'status',
      'score_explain', 'score_breakdown', 'is_notified',
    ]) {
      assert.ok(column in row, `missing column: ${column}`);
    }
  });

  it('never marks an unscored post as qualified', () => {
    // A row built without a score is a role-gate failure by default, and its URL
    // deduplicates all future runs — so it must not reach a digest.
    const row = buildPostRow({ linkedin_url: 'https://www.linkedin.com/posts/x-2' });

    assert.equal(row.relevance_score, 0);
    assert.equal(row.status, 'irrelevant');
    assert.equal(row.score_explain, null);
    assert.equal(row.score_breakdown, null);
  });

  it('stores missing values as null rather than fabricating them', () => {
    const row = buildPostRow({
      linkedin_url: 'https://www.linkedin.com/posts/x-3',
      relevance_score: 60,
      status: 'qualified',
    });

    assert.equal(row.company_name, null);
    assert.equal(row.author_name, null);
    assert.equal(row.job_title, null);
    assert.equal(row.published_at, null);
    assert.equal(row.is_hiring_manager_or_recruiter, null);
    assert.equal(row.confidence, null);
    assert.equal(row.is_recruiting_post, false);
    assert.equal(row.is_product_design_role, false);
  });

  it('does not mark a newly inserted post as already notified', () => {
    const row = buildPostRow({
      linkedin_url: 'https://www.linkedin.com/posts/x-4',
      status: 'qualified',
      relevance_score: 80,
      is_notified: true,
    });

    assert.equal(row.is_notified, false, 'a fresh post must not skip the digest');
  });

  it('stamps discovered_at with a parseable timestamp', () => {
    const row = buildPostRow({ linkedin_url: 'https://www.linkedin.com/posts/x-5' });
    assert.ok(!Number.isNaN(Date.parse(row.discovered_at)));
  });
});

describe('Phase 5 Wiring — Status Derivation', () => {
  it('marks a high-scoring post qualified', () => {
    const { evaluation, row } = persist(classification());

    assert.equal(evaluation.score, 95);
    assert.equal(evaluation.priority, 'high');
    assert.equal(row.status, 'qualified');
  });

  it('marks a below-threshold post qualified, at standard priority', () => {
    const { evaluation, row } = persist(
      classification({
        seniority: 'Mid',
        job_title: 'Product Designer',
        location: null,
        remote_status: 'Unknown',
        company_name: 'Generic Corp',
      })
    );

    // 0 seniority + 20 hiring + 10 recruiter + 0 geography + 10 domain ("payments").
    assert.equal(evaluation.score, 40);
    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.priority, 'standard');
    // The score the row carries is the honest 40, not something lifted to clear
    // a threshold that no longer gates anything.
    assert.equal(row.relevance_score, 40);
    assert.equal(row.status, 'qualified');
    assert.match(row.score_breakdown.statusReason, /standard priority: score 40 < 60/);
  });

  it('marks a role-gate failure irrelevant regardless of seniority', () => {
    const { evaluation, row } = persist(
      classification({ is_product_design_role: false, job_title: 'Graphic Designer' })
    );

    assert.equal(evaluation.score, 0);
    assert.equal(evaluation.eligible, false);
    assert.equal(evaluation.priority, null);
    assert.equal(row.status, 'irrelevant');
  });

  it('marks a low-confidence post low_confidence even when the score is high', () => {
    const { evaluation, row } = persist(
      classification({ confidence: 0.5, job_title: 'Head of Product Design' })
    );

    assert.equal(evaluation.score, 95, 'scoring still runs and is recorded');
    assert.equal(row.status, 'low_confidence');
    assert.match(row.score_breakdown.statusReason, /confidence/);
  });

  it('exempts an unlevelled product design title from the confidence gate', () => {
    const { row } = persist(
      classification({ confidence: 0.5, job_title: 'Product Designer', seniority: 'Unknown' })
    );

    assert.equal(row.status, 'qualified');
  });

  it('stores a junior post as irrelevant rather than qualified', () => {
    const { evaluation, row } = persist(
      classification({ seniority: 'Junior', job_title: 'Junior Product Designer' })
    );

    assert.equal(evaluation.score, 0);
    assert.equal(evaluation.eligible, false);
    assert.equal(row.status, 'irrelevant');
  });

  it('uses the documented default confidence boundary inclusively', () => {
    assert.equal(DEFAULT_MIN_CONFIDENCE, 0.7);
    assert.equal(meetsConfidenceThreshold({ confidence: 0.7 }), true);
    assert.equal(meetsConfidenceThreshold({ confidence: 0.699 }), false);
    assert.equal(meetsConfidenceThreshold({ confidence: null }), false);
  });

  it('stores only statuses the schema CHECK constraint allows', () => {
    const cases = [
      classification(),
      classification({ seniority: 'Junior', remote_status: 'On-site' }),
      classification({ is_product_design_role: false }),
      classification({ confidence: 0.2 }),
    ];

    for (const ai of cases) {
      const { row } = persist(ai);
      assert.ok(POST_STATUSES.includes(row.status), `unexpected status: ${row.status}`);
    }
  });

  it('keeps the score observable for digest ordering', () => {
    const high = evaluateCandidate(classification(), { candidate: CANDIDATE, now: NOW });
    const low = evaluateCandidate(classification({ seniority: 'Mid', remote_status: 'On-site' }), {
      candidate: { title: 'We are hiring a Product Designer', snippet: 'Join our team.' },
      now: NOW,
    });

    // getUnsentPosts orders by relevance_score DESC, so distinct scores matter —
    // and both of these posts are qualified and delivered, only ranked apart.
    assert.ok(high.score > low.score);
    assert.ok(low.score < DEFAULT_MIN_RELEVANCE_SCORE);
    assert.equal(high.priority, 'high');
    assert.equal(low.priority, 'standard');
    assert.equal(low.status, 'qualified');
  });

  it('is deterministic end to end', () => {
    const ai = classification();
    const first = persist(ai).row;
    const second = persist(ai).row;

    assert.equal(first.relevance_score, second.relevance_score);
    assert.equal(first.status, second.status);
    assert.deepEqual(first.score_breakdown, second.score_breakdown);
  });
});

describe('Phase 5 Wiring — Stale Openings Never Reach a Digest', () => {
  const STALE_POSTS = [
    ['six months ago (relative)', '6 months ago'],
    ['six months ago (ISO)', '2026-04-01T09:00:00Z'],
    ['one year ago', '2025-10-01T08:00:00Z'],
    ['nine days old (past the 168h window)', '2026-09-22T12:00:00Z'],
  ];

  for (const [label, publishedAt] of STALE_POSTS) {
    it(`stores a post from ${label} as stale, not qualified`, () => {
      const { evaluation, row } = persist(classification(), { publishedAt });

      assert.equal(evaluation.score, 95, 'still scored, so the reason is auditable');
      assert.equal(evaluation.status, 'stale');
      assert.equal(row.status, 'stale');
      assert.equal(row.relevance_score, 95);
    });
  }

  it('excludes stale posts from the unsent-post digest query', () => {
    // getUnsentPosts filters `.eq('status', 'qualified')`, so a stale row can
    // never be selected regardless of its score.
    const { row } = persist(classification(), { publishedAt: '2026-04-01T09:00:00Z' });
    const digestSelects = row.status === 'qualified';

    assert.equal(digestSelects, false);
  });

  it('records the normalized publication date so the age survives', () => {
    const { row } = persist(classification(), { publishedAt: '6 months ago' });

    assert.equal(row.published_at, '2026-04-04T12:00:00.000Z');
    assert.ok(!Number.isNaN(Date.parse(row.published_at)));
  });

  it('stores null rather than an unparseable provider string', () => {
    // A raw "3 days ago" string cannot be inserted into a timestamptz column.
    const { row } = persist(classification(), { publishedAt: '3 days ago' });
    assert.equal(row.published_at, '2026-09-28T12:00:00.000Z');

    const garbage = persist(classification(), { publishedAt: 'sometime last spring' });
    assert.equal(garbage.row.published_at, null);
  });

  it('still qualifies a post published an hour ago', () => {
    const { row } = persist(classification(), { publishedAt: '2026-10-01T11:00:00Z' });

    assert.equal(row.status, 'qualified');
    assert.equal(row.published_at, '2026-10-01T11:00:00.000Z');
  });
});
