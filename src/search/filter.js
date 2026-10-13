/**
 * Cheap Keyword Filter for DesignRadar (Phase 3).
 *
 * Implements PROJECT_SPEC §10: Candidate Filtering.
 *
 * A candidate passes if it meets Condition A OR Condition B:
 *
 * Condition A: At least one Product Design term AND at least one Hiring term.
 * Condition B: Seniority Title Bypass — explicit match on a target Senior+
 *              Product Design role title, even when no hiring verb is found
 *              (accounts for search-snippet truncation).
 *
 * This is a cost-control gate. AI classification remains the final classifier.
 */

// ─── Keyword Lists ─────────────────────────────────────────────────────────────

/**
 * Product Design terms for Condition A.
 * Case-insensitive matching against title + snippet.
 */
export const PRODUCT_DESIGN_TERMS = Object.freeze([
  'product designer',
  'product design',
  'ux designer',
  'ux/product',
  'design lead',
]);

/**
 * Hiring terms for Condition A.
 * Case-insensitive matching against title + snippet.
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
 * Seniority Title Bypass terms for Condition B.
 * If any of these appear in title or snippet, the candidate passes
 * even without an explicit hiring verb.
 */
export const SENIORITY_BYPASS_TITLES = Object.freeze([
  'senior product designer',
  'lead product designer',
  'staff product designer',
  'principal product designer',
  'founding product designer',
  'founding designer',
  'head of product design',
]);

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Combines title and snippet into a single lowercase search corpus.
 *
 * @param {string | null} title
 * @param {string | null} snippet
 * @returns {string}
 */
function buildCorpus(title, snippet) {
  const parts = [];
  if (title && typeof title === 'string') parts.push(title);
  if (snippet && typeof snippet === 'string') parts.push(snippet);
  return parts.join(' ').toLowerCase();
}

/**
 * Checks if the corpus contains at least one term from the given list.
 *
 * @param {string} corpus Lowercase text to search.
 * @param {readonly string[]} terms Terms to look for.
 * @returns {boolean}
 */
function containsAny(corpus, terms) {
  return terms.some((term) => corpus.includes(term));
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Tests whether a single candidate passes cheap keyword filtering.
 *
 * @param {{ title?: string | null, snippet?: string | null }} candidate
 * @returns {{ passed: boolean, reason: string }}
 */
export function passesKeywordFilter(candidate) {
  if (!candidate) {
    return { passed: false, reason: 'null_candidate' };
  }

  const corpus = buildCorpus(candidate.title, candidate.snippet);

  if (!corpus) {
    return { passed: false, reason: 'empty_text' };
  }

  // Condition B: Seniority Title Bypass (checked first — stronger signal)
  if (containsAny(corpus, SENIORITY_BYPASS_TITLES)) {
    return { passed: true, reason: 'seniority_bypass' };
  }

  // Condition A: Product Design term AND Hiring term
  const hasDesignTerm = containsAny(corpus, PRODUCT_DESIGN_TERMS);
  const hasHiringTerm = containsAny(corpus, HIRING_TERMS);

  if (hasDesignTerm && hasHiringTerm) {
    return { passed: true, reason: 'design_and_hiring' };
  }

  if (hasDesignTerm && !hasHiringTerm) {
    return { passed: false, reason: 'missing_hiring_term' };
  }

  if (!hasDesignTerm && hasHiringTerm) {
    return { passed: false, reason: 'missing_design_term' };
  }

  return { passed: false, reason: 'no_matching_terms' };
}

/**
 * Filters a list of candidates through cheap keyword filtering.
 * Returns only candidates that pass Condition A or Condition B.
 *
 * @param {Array<{ url: string, title?: string | null, snippet?: string | null }>} candidates
 * @returns {{ passed: Array<object>, rejected: Array<{ candidate: object, reason: string }> }}
 */
export function filterCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    return { passed: [], rejected: [] };
  }

  const passed = [];
  const rejected = [];

  for (const candidate of candidates) {
    const result = passesKeywordFilter(candidate);

    if (result.passed) {
      passed.push(candidate);
    } else {
      rejected.push({ candidate, reason: result.reason });
    }
  }

  return { passed, rejected };
}
