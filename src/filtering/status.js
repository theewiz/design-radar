/**
 * Recency Evaluation and Status Derivation (PROJECT_SPEC §18, §17).
 *
 * Two responsibilities, kept together because status depends on both:
 *
 *   1. Recency  — classify a publication timestamp as recent / stale / unverified
 *                 against a 24-hour window (§18).
 *   2. Status   — combine recency, the eligibility gate (§14 rule 1), and the
 *                 confidence gate (§11) into one stored status (§17).
 *
 * Timestamps from search providers arrive in mixed formats: ISO strings from
 * Serper, but also relative strings such as "3 days ago" from Brave's page_age
 * and Serper's date field. Those relative forms are converted here rather than
 * guessed at, because a six-month-old opening must be recognised as stale
 * instead of being treated as unverified and slipping into a digest.
 *
 * The deterministic relevance score (§14) is not consulted here. Scoring already
 * decided eligibility; the score's remaining job is priority and ordering.
 *
 * Nothing is fabricated. A timestamp that cannot be interpreted with confidence
 * becomes null, which §18 rule 3 handles as "unverified" rather than guessing.
 */

import { scorePost, QUALIFICATION_METHODS } from '../ai/score.js';
import { meetsConfidenceThreshold } from '../ai/classify.js';

/**
 * Validity window: every post published within the last week is valid.
 *
 * Anything older than this is stale — persisted for deduplication (§18 rule 2)
 * but never surfaced in a digest. This is a fixed invariant rather than
 * configuration, so no environment value can widen the window and let an old
 * opening qualify.
 */
export const RECENCY_WINDOW_HOURS = 168;

/** §18 rule 1 boundary: posts inside this band are verified-recent. */
export const RECENT_PIVOT_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Tests whether an age in hours falls inside the validity window.
 *
 * The band is inclusive at both ends: 0h through 168h are valid, anything
 * greater is stale.
 *
 * @param {number | null | undefined} ageHours Age in hours, or null when unknown.
 * @returns {boolean}
 */
export function isWithinValidityWindow(ageHours) {
  return typeof ageHours === 'number' && Number.isFinite(ageHours) && ageHours <= RECENCY_WINDOW_HOURS;
}

/** Recency states produced by evaluateRecency (§18 rules 1-3). */
export const RECENCY_STATES = Object.freeze({
  RECENT: 'recent',
  STALE: 'stale',
  UNVERIFIED: 'unverified',
});

/** Statuses permitted by the linkedin_posts CHECK constraint (§17). */
export const POST_STATUSES = Object.freeze(['qualified', 'stale', 'irrelevant', 'low_confidence']);

/**
 * Approximate day counts for relative units that do not divide evenly. Only used
 * for month/year, where the 24-hour cutoff is unaffected by the approximation:
 * both 30 and 31 days are stale.
 */
const RELATIVE_UNIT_DAYS = Object.freeze({
  second: 1 / 86400,
  minute: 1 / 1440,
  hour: 1 / 24,
  day: 1,
  week: 7,
  month: 30,
  year: 365,
});

/**
 * Matches an absolute timestamp we accept without ambiguity: an ISO 8601 date
 * or date-time that either carries an explicit offset or is a bare date.
 *
 * Locale-style strings such as "Sep 30, 2026" are deliberately excluded —
 * Date.parse would resolve them against the host timezone, making the stored
 * value depend on which machine ran the job.
 */
const ABSOLUTE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|z|[+-]\d{2}:?\d{2})?$/;

/**
 * Maps every accepted time-unit spelling to its canonical unit, so both "days"
 * and "d" resolve identically.
 */
const UNIT_LOOKUP = Object.freeze({
  second: 'second', seconds: 'second', sec: 'second', secs: 'second', s: 'second',
  minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', m: 'minute',
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', h: 'hour',
  day: 'day', days: 'day', d: 'day',
  week: 'week', weeks: 'week', w: 'week',
  month: 'month', months: 'month', mo: 'month',
  year: 'year', years: 'year', yr: 'year',
});

/**
 * Matches a relative age such as "3 days ago", "2 weeks ago", "3d ago",
 * "yesterday", or "today". Longer spellings come first so alternation is
 * unambiguous ("months" is never truncated to "month").
 */
const UNIT_ALTERNATION = Object.keys(UNIT_LOOKUP)
  .sort((a, b) => b.length - a.length)
  .join('|');

const RELATIVE_PATTERN = new RegExp(`^(\\d+)\\s*(${UNIT_ALTERNATION})\\s+ago$`, 'i');

/**
 * Resolves the reference "now" used for every comparison.
 *
 * Accepts a Date, an epoch number, or an ISO string so tests can pin time.
 *
 * @param {Date | number | string} [now]
 * @returns {Date}
 */
function resolveNow(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return new Date();
}

/**
 * Normalizes a bare date-time to UTC.
 *
 * "2026-09-30 10:00:00" has no offset, so Date.parse would read it in the host
 * timezone. Appending 'Z' keeps the stored value reproducible across machines.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeAbsolute(value) {
  const hasExplicitOffset = /(Z|z|[+-]\d{2}:?\d{2})$/.test(value);
  if (hasExplicitOffset) {
    // Date-only values ("2026-09-30") are already parsed as UTC midnight; a
    // date-time without an offset needs it supplied.
    return /[T ]\d{2}:\d{2}/.test(value) ? value.replace(' ', 'T') : value;
  }
  return /[T ]\d{2}:\d{2}/.test(value) ? `${value.replace(' ', 'T')}Z` : `${value}T00:00:00.000Z`;
}

/**
 * Converts a relative age such as "3 days ago" into a concrete timestamp.
 *
 * @param {string} value Lowercased, trimmed relative string.
 * @param {Date} now Reference time.
 * @returns {Date | null} Null when the string is not a form we recognize.
 */
function parseRelative(value, now) {
  if (value === 'today') return now;
  if (value === 'yesterday') return new Date(now.getTime() - 24 * MS_PER_HOUR);

  const match = RELATIVE_PATTERN.exec(value);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = UNIT_LOOKUP[match[2].toLowerCase()];
  const days = RELATIVE_UNIT_DAYS[unit];

  if (days === undefined || !Number.isFinite(amount)) return null;

  return new Date(now.getTime() - amount * days * 24 * MS_PER_HOUR);
}

/**
 * Parses a provider-supplied publication timestamp.
 *
 * Accepts absolute ISO dates (with or without an offset) and relative ages.
 * Everything else — including locale strings and non-date text — is reported as
 * unverified so nothing is invented.
 *
 * @param {string | number | Date | null | undefined} value Raw provider value.
 * @param {Object} [options]
 * @param {Date | number | string} [options.now] Reference time for relative ages.
 * @returns {{ verified: boolean, date: Date | null, iso: string | null, reason: string | null }}
 */
export function parsePublishedAt(value, options = {}) {
  const now = resolveNow(options.now);

  if (value === null || value === undefined) {
    return { verified: false, date: null, iso: null, reason: 'missing' };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { verified: false, date: null, iso: null, reason: 'invalid' }
      : { verified: true, date: value, iso: value.toISOString(), reason: null };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { verified: false, date: null, iso: null, reason: 'invalid' };
    }
    // Epoch values are seconds or milliseconds; anything below this threshold
    // cannot be a millisecond timestamp for a 2020s-era post.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime())
      ? { verified: false, date: null, iso: null, reason: 'invalid' }
      : { verified: true, date, iso: date.toISOString(), reason: null };
  }

  if (typeof value !== 'string') {
    return { verified: false, date: null, iso: null, reason: 'unsupported_type' };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { verified: false, date: null, iso: null, reason: 'empty' };
  }

  if (ABSOLUTE_PATTERN.test(trimmed)) {
    const parsed = Date.parse(normalizeAbsolute(trimmed));
    if (!Number.isNaN(parsed)) {
      return { verified: true, date: new Date(parsed), iso: new Date(parsed).toISOString(), reason: null };
    }
  }

  const relative = parseRelative(trimmed.toLowerCase(), now);
  if (relative) {
    return { verified: true, date: relative, iso: relative.toISOString(), reason: null };
  }

  return { verified: false, date: null, iso: null, reason: 'unparseable' };
}

/**
 * Classifies a publication timestamp against the one-week validity window.
 *
 * Every post up to RECENCY_WINDOW_HOURS old is valid; anything older is stale.
 * The upper bound is inclusive, so exactly 168h old is still valid.
 *
 * @param {string | number | Date | null | undefined} publishedAt Raw provider value.
 * @param {Object} [options]
 * @param {Date | number | string} [options.now] Reference time.
 * @returns {{
 *   state: 'recent' | 'stale' | 'unverified',
 *   verified: boolean,
 *   iso: string | null,
 *   ageHours: number | null,
 *   windowHours: number,
 *   verifiedRecent: boolean,
 *   raw: unknown,
 *   parseReason: string | null,
 *   inFuture: boolean
 * }}
 */
export function evaluateRecency(publishedAt, options = {}) {
  const now = resolveNow(options.now);
  const windowHours = RECENCY_WINDOW_HOURS;
  const parsed = parsePublishedAt(publishedAt, { now });

  if (!parsed.verified) {
    return {
      state: RECENCY_STATES.UNVERIFIED,
      verified: false,
      iso: null,
      ageHours: null,
      windowHours,
      // §18 rule 3: an unknown timestamp is not treated as verified-recent.
      verifiedRecent: false,
      raw: publishedAt ?? null,
      parseReason: parsed.reason,
      inFuture: false,
    };
  }

  const ageMs = now.getTime() - parsed.date.getTime();
  const ageHours = Math.round((ageMs / MS_PER_HOUR) * 100) / 100;
  const state = ageMs > windowHours * MS_PER_HOUR ? RECENCY_STATES.STALE : RECENCY_STATES.RECENT;

  return {
    state,
    verified: true,
    iso: parsed.iso,
    ageHours,
    windowHours,
    // §18 rule 1: inside the 24h pivot is "verified recent" and is prioritized
    // at the top of the digest. The rest of the validity window is still valid,
    // just not prioritized.
    verifiedRecent: ageHours <= RECENT_PIVOT_HOURS,
    raw: publishedAt,
    parseReason: null,
    // Providers and clock skew can yield future dates; treated as recent.
    inFuture: ageMs < 0,
  };
}

/**
 * Combines recency, the eligibility gate, and confidence into one status.
 *
 * Precedence, highest first:
 *
 *   1. 'stale'          — verified and older than the window. Staleness is
 *                         irrecoverable: the URL is now deduplicated away, so
 *                         if it is not recorded the age is lost forever. The
 *                         classification fields remain on the row for analysis.
 *   2. 'irrelevant'     — eligibility gate failure (§14 rule 1): the post is not
 *                         a recruiting product design post.
 *   3. 'low_confidence' — confidence below the §11 gate.
 *   4. 'qualified'      — recent (or unverified) and eligible.
 *
 * The relevance score does not appear in this precedence. It is recorded on the
 * row and used to order the digest, but a low score is a low-priority match, not
 * a reason to reject an otherwise valid opportunity.
 *
 * §18 rule 3: an unverified timestamp does not disqualify a post. It is treated
 * as recent for status purposes and surfaced under "Recent Discoveries".
 *
 * @param {Object} params
 * @param {object} params.scored Output of scorePost.
 * @param {object} params.classification Phase 4 classification.
 * @param {object} params.recency Output of evaluateRecency.
 * @returns {{ status: string, reason: string }}
 */
export function resolvePostStatus({ scored, classification, recency }) {
  if (recency?.state === RECENCY_STATES.STALE) {
    return {
      status: 'stale',
      reason: `stale: published ${recency.ageHours}h ago, window ${recency.windowHours}h (§18)`,
    };
  }

  if (scored?.eligible === false) {
    return {
      status: 'irrelevant',
      reason: 'role gate: not a recruiting product design post (§14 rule 1)',
    };
  }

  if (!meetsConfidenceThreshold(classification)) {
    return { status: 'low_confidence', reason: 'confidence below the §11 gate' };
  }

  // Eligible and confident: qualified at any score. The reason states the score
  // and the band it landed in, so a stored `qualified` row is auditable without
  // having to know which threshold convention produced it.
  return {
    status: 'qualified',
    reason: scored.qualificationReason
      ? `${scored.qualificationReason} (§14)`
      : `eligible: recruiting product design post; score ${scored.score} (§14)`,
  };
}

/**
 * Scores a classified post and derives its final status in one step.
 *
 * This is the entry point used by the pipeline, so scoring and status stay
 * consistent and remain testable without a database.
 *
 * @param {object} classification Phase 4 classification.
 * @param {Object} [options]
 * @param {{ title?: string | null, snippet?: string | null }} [options.candidate] Original search result.
 * @param {number} [options.minScore] High-priority threshold; labels priority, never qualifies.
 * @param {Date | number | string} [options.now] Reference time for recency.
 * @returns {{
 *   score: number,
 *   eligible: boolean,
 *   priority: 'high' | 'standard' | null,
 *   status: string,
 *   reason: string,
 *   recency: object,
 *   scored: object,
 *   explanation: object
 * }}
 */
export function evaluateCandidate(classification, options = {}) {
  const scored = scorePost(classification, {
    candidate: options.candidate,
    minScore: options.minScore,
  });

  const recency = evaluateRecency(options.publishedAt ?? classification?.published_at, {
    now: options.now,
  });

  const { status, reason } = resolvePostStatus({ scored, classification, recency });

  return {
    score: scored.score,
    eligible: scored.eligible,
    priority: scored.priority,
    status,
    reason,
    recency,
    scored,
    // Persisted alongside the post so a score can be audited later.
    explanation: {
      explain: scored.explain,
      breakdown: scored.breakdown,
      recency: {
        state: recency.state,
        ageHours: recency.ageHours,
        windowHours: recency.windowHours,
        verifiedRecent: recency.verifiedRecent,
        parseReason: recency.parseReason,
      },
      // Why the post qualified is recorded separately from what it scored, so a
      // qualified row at any score stays explainable: eligibility is the reason,
      // and the score is the priority.
      qualification: {
        method: scored.qualificationMethod ?? QUALIFICATION_METHODS.NONE,
        score: scored.score,
        threshold: scored.threshold,
        priority: scored.priority,
      },
      statusReason: reason,
    },
  };
}