/**
 * Deterministic Relevance Scoring for DesignRadar (Phase 5).
 *
 * Implements PROJECT_SPEC §14 (Relevance Scoring) and §15 (Relevant Domains).
 *
 * The LLM supplies classification only. This module — not the model — computes
 * the final relevance score, so the result is reproducible and explainable for
 * a given input.
 *
 * Signals (PROJECT_SPEC §14):
 *
 *   Seniority (non-cumulative, max +30)
 *     Head / Staff / Principal / Lead / Senior   +30
 *     Founding                                  +28
 *     Mid / Junior / Unknown                     +0
 *
 *   Explicit hiring language                    +20
 *   Recruiter / hiring manager identified       +10
 *   Remote                                      +15
 *   Global / Worldwide                          +15
 *   Europe                                      +10
 *   UK                                          +10
 *   US                                          +10
 *     (location/arrangement subtotal capped at +25)
 *
 *   Relevant domain match                       +10  (capped, total)
 *
 * Role gating: a post that is not a recruiting post, or is not a product design
 * role, or advertises a junior seat the profile excludes, scores 0 regardless of
 * any other signal.
 *
 * Eligibility and score are two different decisions, and they are decided
 * separately:
 *
 *   ELIGIBILITY (§14 rule 1)
 *     is_recruiting_post === true && is_product_design_role === true
 *     seniority !== 'Junior'   — profile rule (§16)
 *
 *   PRIORITY
 *     score >= MIN_RELEVANCE_SCORE  ->  'high'
 *     score <  MIN_RELEVANCE_SCORE  ->  'standard'
 *
 * Eligibility answers "is this a legitimate Product Design recruiting
 * opportunity?". The score answers "how strongly does this match my target
 * profile?". A post can clear the gate and still be a weak match, so the
 * threshold is no longer a qualification gate — it only labels priority.
 *
 * Nothing here inflates a score to make a post qualify. A Senior product design
 * post with a thin snippet still scores 45, is still stored as 45, and is
 * reported as standard priority rather than being discarded.
 */

import { normalizeText } from '../utils/hash.js';
import { isJuniorRole } from '../profile/role-policy.js';

// ─── Signal Weights (PROJECT_SPEC §14) ────────────────────────────────────────

export const SCORE_WEIGHTS = Object.freeze({
  SENIORITY_TOP_TIER: 30,
  SENIORITY_FOUNDING: 28,
  HIRING_SIGNAL: 20,
  RECRUITER_IDENTIFIED: 10,
  REMOTE: 15,
  GLOBAL: 15,
  EUROPE: 10,
  UK: 10,
  US: 10,
  DOMAIN_MATCH: 10,
});

/** Seniority tiers awarding the full top-tier value (§14 rule 2). */
export const SENIORITY_TOP_TIER = Object.freeze(['Head', 'Staff', 'Principal', 'Lead', 'Senior']);

/** Seniority tiers awarding the reduced founding value (§14 rule 2). */
export const SENIORITY_FOUNDING = Object.freeze(['Founding']);

/** Seniority tiers awarding nothing (§14 rule 2). */
export const SENIORITY_UNSCORED = Object.freeze(['Mid', 'Junior', 'Unknown']);

/** Maximum combined location/arrangement contribution (§14 rule 3). */
export const LOCATION_CAP = 25;

/** Maximum score after clamping (§14 rule 7). */
export const MAX_SCORE = 100;

/** Default high-priority relevance threshold, from MIN_RELEVANCE_SCORE (§14). */
export const DEFAULT_MIN_RELEVANCE_SCORE = 60;

/** Priority bands derived from the score and the threshold (§14). */
export const PRIORITY_LEVELS = Object.freeze({
  /** At or above MIN_RELEVANCE_SCORE. */
  HIGH: 'high',
  /** Eligible, but below MIN_RELEVANCE_SCORE. */
  STANDARD: 'standard',
});

/** How a post was found eligible (§14 rule 1). */
export const QUALIFICATION_METHODS = Object.freeze({
  /** The post is a recruiting post for a product design role. */
  ELIGIBILITY: 'eligibility',
  /** Not a recruiting product design post; no qualification of any kind. */
  NONE: 'none',
});


/**
 * Canonical relevant-domain list from PROJECT_SPEC §15, plus the §6 domain
 * terms used for querying. Matching any one awards the full domain points.
 *
 * Retained verbatim as the canonical §15 vocabulary. `DOMAIN_GROUPS` below is
 * the maintained synonym map; every entry here appears in one of its groups, so
 * this list stays a valid subset of what is actually matched.
 */
export const RELEVANT_DOMAINS = Object.freeze([
  // Strong matches
  'fintech',
  'financial infrastructure',
  'payments',
  'ai',
  'b2b saas',
  'compliance',
  'regtech',
  // Additional relevant domains
  'web3',
  'blockchain',
  'digital assets',
  'crypto',
  'developer tools',
  'design tools for developers',
  'ai design tools',
  'enterprise software',
  'design systems',
  'complex data-heavy products',
]);

/**
 * Curated synonym map for domain detection (§15).
 *
 * A LinkedIn post says "payments" where the profile says "fintech", "banking
 * infrastructure" where it says "financial infrastructure", and "machine
 * learning" where it says "AI". Matching one literal list of phrases therefore
 * loses real matches to vocabulary drift. Grouping the phrases fixes that
 * deterministically — no model, no embeddings, no external taxonomy.
 *
 * Rules for adding a term:
 *
 *   1. Keep every existing RELEVANT_DOMAINS entry in its group. Dropping one
 *      silently narrows the signal.
 *   2. Never add a standalone generic noun. "technology", "software", "product",
 *      "platform", "digital" and "innovation" appear in almost every post and
 *      would turn the signal off entirely. Qualify them: "enterprise software",
 *      "software platform", "data platform".
 *   3. Prefer the phrase a candidate would actually write over a formal term
 *      ("payment rails", not "payment processing").
 *   4. Matching stays word-bounded, so "ai" still cannot match inside "chair".
 *
 * Groups are ordered only for reporting; the longest matching phrase wins, so
 * "banking infrastructure" is reported as financial infrastructure rather than
 * as the generic "banking" it contains.
 */
export const DOMAIN_GROUPS = Object.freeze({
  fintech: Object.freeze([
    'fintech',
    'financial technology',
    'financial services',
    'banking',
    'neobank',
  ]),
  financialInfrastructure: Object.freeze([
    'financial infrastructure',
    'banking infrastructure',
    'financial rails',
    'payments infrastructure',
    'financial services infrastructure',
    'financial platform',
  ]),
  payments: Object.freeze([
    'payments',
    'payment',
    'payment infrastructure',
    'payment rails',
    'payment platform',
    'payments platform',
    'cross-border payments',
    'settlement',
    'merchant payments',
  ]),
  ai: Object.freeze([
    'ai',
    'artificial intelligence',
    'machine learning',
    'generative ai',
    'genai',
    'agentic ai',
    'ai agents',
  ]),
  b2bSaaS: Object.freeze([
    'b2b saas',
    'saas',
    'software platform',
    'enterprise saas',
    'business software',
  ]),
  compliance: Object.freeze([
    'compliance',
    'regulatory compliance',
    'financial compliance',
    'risk management',
  ]),
  regtech: Object.freeze(['regtech', 'regulatory technology', 'regulatory software']),
  web3: Object.freeze([
    'web3',
    'web 3',
    'blockchain',
    'crypto',
    'cryptocurrency',
    'digital assets',
    'virtual assets',
    'tokenization',
    'tokenisation',
  ]),
  developerTools: Object.freeze([
    'developer tools',
    'developer platform',
    'developer infrastructure',
    'api platform',
    'developer experience',
    'devtools',
    'sdk',
  ]),
  designToolsForDevelopers: Object.freeze([
    'design tools for developers',
    'design-to-code',
    'design to code',
    'developer design tools',
  ]),
  aiDesignTools: Object.freeze([
    'ai design tools',
    'ai-powered design',
    'ai design',
    'generative design',
  ]),
  enterpriseSoftware: Object.freeze([
    'enterprise software',
    'enterprise platform',
    'enterprise technology',
  ]),
  designSystems: Object.freeze([
    'design system',
    'design systems',
    'component library',
    'design tokens',
  ]),
  dataHeavyProducts: Object.freeze([
    'complex data-heavy products',
    'data-heavy products',
    'data platform',
    'analytics platform',
    'data infrastructure',
    'complex data',
    'data-intensive',
  ]),
});


/**
 * Hiring terms reused from PROJECT_SPEC §10 Condition A. Used here to award the
 * explicit-hiring-language signal, which §14 scores independently of the AI's
 * `is_recruiting_post` flag: a snippet can be recruiting without the verb
 * surviving truncation.
 */
export const HIRING_TERMS = Object.freeze([
  'hiring',
  "we're hiring",
  'we are hiring',
  'looking for',
  'open role',
  'open position',
  'join our team',
  'my team is hiring',
  'recruiting',
]);

/**
 * Geographic signals. Long forms are aliases for the same region rather than
 * additional signals, so they carry the same weight as their short form.
 */
const GEOGRAPHIC_SIGNALS = Object.freeze([
  { signal: 'global', weight: SCORE_WEIGHTS.GLOBAL, patterns: ['global', 'worldwide', 'world wide', 'anywhere'] },
  { signal: 'europe', weight: SCORE_WEIGHTS.EUROPE, patterns: ['europe', 'european', 'emea'] },
  { signal: 'uk', weight: SCORE_WEIGHTS.UK, patterns: ['uk', 'united kingdom'] },
  { signal: 'us', weight: SCORE_WEIGHTS.US, patterns: ['us', 'u.s.', 'usa', 'united states'] },
]);

// ─── Text Matching ────────────────────────────────────────────────────────────

/**
 * Escapes a literal string for use inside a regular expression.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a matcher for a literal phrase that will not match inside a longer
 * word.
 *
 * Word boundaries are essential here: a naive substring test would score "AI"
 * in "said", "US" in "industry", and "UK" in "surveyor".
 *
 * @param {string} phrase
 * @returns {RegExp}
 */
function buildPhraseMatcher(phrase) {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(phrase)}(?![a-z0-9])`, 'i');
}

/**
 * Tests whether a corpus contains any of the given phrases on word boundaries.
 *
 * @param {string} corpus Lowercased searchable text.
 * @param {readonly string[]} phrases
 * @returns {boolean}
 */
function containsAnyPhrase(corpus, phrases) {
  return phrases.some((phrase) => buildPhraseMatcher(phrase).test(corpus));
}

/**
 * Finds the first matching phrase from a list, for reporting in the breakdown.
 *
 * @param {string} corpus
 * @param {readonly string[]} phrases
 * @returns {string | null}
 */
function findFirstPhrase(corpus, phrases) {
  for (const phrase of phrases) {
    if (buildPhraseMatcher(phrase).test(corpus)) {
      return phrase;
    }
  }
  return null;
}

/**
 * Compiled domain matchers, built once at module load.
 *
 * The map holds well over a hundred phrases, and recompiling a regular
 * expression per phrase for every post would be pure overhead. The `i` flag
 * without `g` keeps these stateless, so reusing them across calls is safe.
 *
 * @type {ReadonlyArray<{ term: string, group: string, matcher: RegExp }>}
 */
const DOMAIN_MATCHERS = Object.freeze(
  Object.entries(DOMAIN_GROUPS).flatMap(([group, terms]) =>
    terms.map((term) => ({ term, group, matcher: buildPhraseMatcher(term) }))
  )
);

/**
 * Finds the most specific domain phrase present in a corpus.
 *
 * Every matching group is considered and the longest phrase wins, so a post
 * mentioning "banking infrastructure" is reported under financialInfrastructure
 * rather than under the shorter "banking" it also contains. Ties fall back to
 * the first group in DOMAIN_GROUPS order, which keeps the result deterministic.
 *
 * @param {string} corpus Lowercased searchable text.
 * @returns {{ term: string, group: string } | null}
 */
export function matchDomains(corpus) {
  if (typeof corpus !== 'string' || corpus === '') {
    return null;
  }

  let best = null;

  for (const { term, group, matcher } of DOMAIN_MATCHERS) {
    if (!matcher.test(corpus)) continue;
    if (best === null || term.length > best.term.length) {
      best = { term, group };
    }
  }

  return best;
}


// ─── Individual Signal Evaluators ─────────────────────────────────────────────

/**
 * Evaluates the seniority signal. Non-cumulative: only the single highest
 * matching tier contributes (§14 rule 2).
 *
 * @param {string | null} seniority
 * @returns {{ signal: string, points: number, matched: string | null }}
 */
export function scoreSeniority(seniority) {
  if (typeof seniority !== 'string') {
    return { signal: 'seniority', points: 0, matched: null };
  }

  const normalized = seniority.trim().toLowerCase();
  const match = (levels) => levels.find((level) => level.toLowerCase() === normalized) || null;

  const top = match(SENIORITY_TOP_TIER);
  if (top) {
    return { signal: 'seniority', points: SCORE_WEIGHTS.SENIORITY_TOP_TIER, matched: top };
  }

  const founding = match(SENIORITY_FOUNDING);
  if (founding) {
    return { signal: 'seniority', points: SCORE_WEIGHTS.SENIORITY_FOUNDING, matched: founding };
  }

  const unscored = match(SENIORITY_UNSCORED);
  return { signal: 'seniority', points: 0, matched: unscored };
}

/**
 * Evaluates the explicit hiring language signal from post text (§14 rule 5).
 *
 * @param {string} corpus
 * @returns {{ signal: string, points: number, matched: string | null }}
 */
export function scoreHiringSignal(corpus) {
  const matched = findFirstPhrase(corpus, HIRING_TERMS);
  return {
    signal: 'hiring_language',
    points: matched ? SCORE_WEIGHTS.HIRING_SIGNAL : 0,
    matched,
  };
}

/**
 * Evaluates the recruiter identification signal (§14 rule 6).
 * Requires the classifier to have explicitly identified the author as a
 * recruiter or hiring manager; null never awards points.
 *
 * @param {boolean | null} isHiringManagerOrRecruiter
 * @returns {{ signal: string, points: number, matched: boolean }}
 */
export function scoreRecruiter(isHiringManagerOrRecruiter) {
  const awarded = isHiringManagerOrRecruiter === true;
  return {
    signal: 'recruiter_identified',
    points: awarded ? SCORE_WEIGHTS.RECRUITER_IDENTIFIED : 0,
    matched: awarded,
  };
}

/**
 * Evaluates location and working-arrangement signals, capped at +25 (§14 rule 3).
 *
 * The Remote signal comes from the classifier's `remote_status` rather than from
 * text, so remote status is never inferred from geography wording. "Hybrid" and
 * "On-site" deliberately award nothing.
 *
 * @param {{ location?: string | null, remote_status?: string | null }} classification
 * @returns {{ signal: string, points: number, matched: string[], capped: boolean }}
 */
export function scoreLocation(classification) {
  const matched = [];
  let rawPoints = 0;

  if (classification?.remote_status === 'Remote') {
    rawPoints += SCORE_WEIGHTS.REMOTE;
    matched.push('Remote');
  }

  const locationText = normalizeText(classification?.location);
  if (locationText) {
    for (const geo of GEOGRAPHIC_SIGNALS) {
      const hit = findFirstPhrase(locationText, geo.patterns);
      if (hit) {
        rawPoints += geo.weight;
        matched.push(hit);
      }
    }
  }

  const points = Math.min(rawPoints, LOCATION_CAP);
  return {
    signal: 'location_arrangement',
    points,
    matched,
    capped: rawPoints > LOCATION_CAP,
  };
}

/**
 * Evaluates the relevant domain signal, capped at +10 total (§14 rule 4).
 *
 * Recognition comes from `matchDomains` over DOMAIN_GROUPS, so vocabulary
 * variants such as "payment rails" or "machine learning" count without
 * inventing any new signal. The award stays a flat +10 however many groups
 * match: a post naming four relevant domains is not four times as relevant.
 *
 * @param {string} corpus Post text, title, and company name combined.
 * @returns {{ signal: string, points: number, matched: string | null, group: string | null }}
 */
export function scoreDomain(corpus) {
  const match = matchDomains(corpus);
  return {
    signal: 'domain_match',
    points: match ? SCORE_WEIGHTS.DOMAIN_MATCH : 0,
    matched: match ? match.term : null,
    group: match ? match.group : null,
  };
}

// ─── Eligibility (§14 rule 1) ──────────────────────────────────────────────────

/**
 * Decides whether a post is an eligible Product Design opportunity.
 *
 * This is the whole qualification decision, and it is deliberately narrow:
 *
 *   is_recruiting_post === true
 *   is_product_design_role === true
 *   seniority !== 'Junior'          — profile rule, §16
 *
 * The first two flags come from the Phase 4 classification, which is the only
 * component that reads the post's meaning, so nothing here widens the semantic
 * gate. A Senior Product Manager vacancy, a design conference announcement, a
 * portfolio article, and a Senior Software Engineer opening all fail it.
 *
 * Junior is excluded rather than merely scored low. The relevance profile does
 * not want junior seats at all (§16), so a Junior product design post is not a
 * weak match to be delivered — it is out of scope. It fails the gate and is
 * stored as `irrelevant`, which keeps it out of the digest and burns its URL
 * against dedup (§9) instead of re-classifying it on every future run.
 *
 * The relevance score is deliberately *not* consulted. Using it here is exactly
 * the conflation this module was changed to remove: a weak-but-valid signal
 * match is a low-priority opportunity, not a non-opportunity.
 *
 * @param {object} classification Phase 4 output from `classifyPost`.
 * @returns {boolean}
 */
export function isEligibleOpportunity(classification) {
  if (!classification || typeof classification !== 'object') {
    return false;
  }

  if (isJuniorRole(classification)) {
    return false;
  }

  return (
    classification.is_recruiting_post === true && classification.is_product_design_role === true
  );
}

/**
 * Derives the priority band from a score and the relevance threshold.
 *
 * A priority band is a label, not a filter: both bands are qualified and both
 * reach the digest, ordered by score.
 *
 * @param {number} score Deterministic relevance score.
 * @param {number} threshold High-priority threshold.
 * @returns {'high' | 'standard'}
 */
export function resolvePriority(score, threshold) {
  return score >= threshold ? PRIORITY_LEVELS.HIGH : PRIORITY_LEVELS.STANDARD;
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds the searchable corpus for a classified post.
 *
 * The hiring and domain signals read text, so post text is included alongside
 * the extracted title and company.
 *
 * @param {object} classification
 * @param {{ title?: string | null, snippet?: string | null }} [candidate]
 * @returns {string} Lowercased corpus.
 */
export function buildScoringCorpus(classification, candidate = {}) {
  const parts = [
    candidate.title,
    candidate.snippet,
    classification?.job_title,
    classification?.company_name,
  ];

  return normalizeText(parts.filter(Boolean).join(' '));
}

/**
 * Computes the deterministic relevance score for a classified post.
 *
 * @param {object} classification Phase 4 output from `classifyPost`.
 * @param {Object} [options]
 * @param {{ title?: string | null, snippet?: string | null }} [options.candidate] Original search result, for text signals.
 * @param {number} [options.minScore=60] High-priority threshold; labels priority, never qualifies.
 * @returns {{
 *   score: number,
 *   rawScore: number,
 *   eligible: boolean,
 *   status: 'qualified' | 'irrelevant',
 *   threshold: number,
 *   priority: 'high' | 'standard' | null,
 *   qualificationMethod: 'eligibility' | 'none',
 *   qualificationReason: string | null,
 *   breakdown: Array<{ signal: string, points: number, matched: unknown }>,
 *   explain: string[]
 * }}
 */
export function scorePost(classification, options = {}) {
  const minScore = Number.isFinite(options.minScore)
    ? options.minScore
    : DEFAULT_MIN_RELEVANCE_SCORE;

  if (!classification || typeof classification !== 'object') {
    throw new TypeError('scorePost requires a classification object');
  }

  // Rule 1: eligibility. A non-recruiting or non-product-design post is not an
  // opportunity at all, and scores 0 regardless of seniority, geography, or
  // domain. Seniority is a scoring signal, never a qualification gate.
  const eligible = isEligibleOpportunity(classification);

  if (!eligible) {
    const reason = !isJuniorRole(classification)
      ? classification.is_recruiting_post !== true
        ? 'not a recruiting post'
        : 'not a product design role'
      : 'junior product design role, excluded by the profile (§16)';

    return {
      score: 0,
      rawScore: 0,
      eligible: false,
      status: 'irrelevant',
      threshold: minScore,
      // No score was earned, so there is no priority band to report.
      priority: null,
      qualificationMethod: QUALIFICATION_METHODS.NONE,
      qualificationReason: null,
      breakdown: [],
      explain: [`Score 0: ${reason} (role gate, §14 rule 1).`],
    };
  }

  const corpus = buildScoringCorpus(classification, options.candidate);

  const breakdown = [
    scoreSeniority(classification.seniority),
    scoreHiringSignal(corpus),
    scoreRecruiter(classification.is_hiring_manager_or_recruiter),
    scoreLocation(classification),
    scoreDomain(corpus),
  ];

  const rawScore = breakdown.reduce((total, signal) => total + signal.points, 0);

  // Rule 7: deterministic clamping.
  const score = Math.min(MAX_SCORE, Math.max(0, rawScore));

  const explain = breakdown
    .filter((signal) => signal.points > 0)
    .map((signal) => {
      const matched = Array.isArray(signal.matched)
        ? signal.matched.join(', ')
        : typeof signal.matched === 'string'
          ? signal.matched
          : signal.matched;
      return `${signal.signal}: +${signal.points}${matched ? ` (${matched})` : ''}`;
    });

  if (rawScore !== score) {
    explain.unshift(`raw ${rawScore} clamped to ${score}`);
  }

  // Eligibility already passed, so this post is qualified. The score only
  // decides which priority band it lands in — it is neither a gate nor something
  // to adjust, and the score reported here is exactly what the signals earned.
  const priority = resolvePriority(score, minScore);

  const qualificationReason =
    `recruiting product design post; ${priority} priority: ` +
    `score ${score} ${priority === PRIORITY_LEVELS.HIGH ? '>=' : '<'} ${minScore}`;

  explain.push(`${QUALIFICATION_METHODS.ELIGIBILITY}: qualified (${qualificationReason})`);

  return {
    score,
    rawScore,
    eligible: true,
    // 'stale' and 'low_confidence' are assigned by the recency (§18) and
    // confidence (§11) steps respectively, not by scoring.
    status: 'qualified',
    threshold: minScore,
    priority,
    qualificationMethod: QUALIFICATION_METHODS.ELIGIBILITY,
    qualificationReason,
    breakdown,
    explain,
  };
}

/**
 * Scores a batch of classified posts.
 *
 * `scoreDistribution` describes the relevance spread across every scored post,
 * which is a reporting aid — not a record of which posts qualified.
 *
 * @param {Array<{ classification: object, candidate?: object }>} entries
 * @param {Object} [options] Passed through to scorePost.
 * @returns {{
 *   results: object[],
 *   eligible: number,
 *   ineligible: number,
 *   highPriority: number,
 *   standardPriority: number,
 *   scoreDistribution: object
 * }}
 */
export function scorePosts(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const results = [];
  const scoreDistribution = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };

  for (const entry of list) {
    const scored = scorePost(entry.classification, {
      ...options,
      candidate: entry.candidate ?? options.candidate,
    });
    results.push(scored);

    const bucket =
      scored.score >= 80
        ? '80-100'
        : scored.score >= 60
          ? '60-79'
          : scored.score >= 40
            ? '40-59'
            : scored.score >= 20
              ? '20-39'
              : '0-19';
    scoreDistribution[bucket]++;
  }

  return {
    results,
    eligible: results.filter((r) => r.eligible).length,
    ineligible: results.filter((r) => !r.eligible).length,
    highPriority: results.filter((r) => r.priority === PRIORITY_LEVELS.HIGH).length,
    standardPriority: results.filter((r) => r.priority === PRIORITY_LEVELS.STANDARD).length,
    scoreDistribution,
  };
}
