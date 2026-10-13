/**
 * Profile Role Policy for DesignRadar.
 *
 * The targeting profile in USER_PROFILE.md is broader than the raw titles a
 * LinkedIn post uses. This module holds the rules that close that gap, in one
 * place, so the classifier, the eligibility gate, the confidence gate, and the
 * orchestrator cannot drift apart.
 *
 * Three rules, and why each exists:
 *
 *   1. SENIORITY ELEVATION
 *      A vacancy advertised as plain "Product Designer" — or "UX Designer" /
 *      "UX/UI Designer" — carries no level marker, so the model correctly
 *      reports `Mid` or `Unknown`. Companies in this profile's sectors
 *      (fintech, crypto, AI tooling) routinely use those flat titles for senior
 *      seats, so the level is applied here as a deterministic profile rule and
 *      the resolved value is what gets scored *and* stored.
 *
 *      This is deliberately not done in the prompt. The model still reports
 *      what the text says (`Mid`/`Unknown`); the elevation happens afterwards,
 *      is reproducible, and is testable without a network call. Rule 3 of
 *      PROJECT_SPEC §12 ("never infer seniority") describes the model's job and
 *      is unaffected.
 *
 *   2. JUNIOR EXCLUSION
 *      Junior is the one level the profile does not want, so it is never
 *      elevated, and a Junior product design post fails the eligibility gate
 *      (§14 rule 1) instead of being delivered as a weak match. This is
 *      PROJECT_SPEC §16 ("Junior Designer" excluded) finally being enforced in
 *      code rather than only in the prompt's role guidance.
 *
 *   3. CONFIDENCE EXEMPTION
 *      A flat-titled post is the case where the snippet is thinnest and
 *      classification confidence is lowest — often just under the §11 gate —
 *      even though the role is unambiguous. Those posts are exempt from the
 *      confidence gate so they actually reach a digest. Exemption never
 *      overrides the eligibility gate: a non-recruiting or non-product-design
 *      post is still rejected.
 *
 * The level of seniority a post actually carries is never invented for titles
 * the profile does not accept: "Product Design Intern" or "Senior Product
 * Manager" keep whatever the classifier reported, because they are not in the
 * accepted list. Title matching is a phrase test, not a seniority parser — it
 * deliberately does not read "Associate" or "Junior" out of a title. The single
 * level guard is the Junior rule above, which reads the classifier's own
 * seniority field instead.
 */

/** The level this profile treats an unlevelled or mid product design role as. */
export const PROFILE_SENIORITY = 'Senior';

/** The only level the profile excludes outright (§16). */
export const JUNIOR_SENIORITY = 'Junior';

/** Levels the model reports that this profile treats as senior-level. */
export const ELEVATED_SENIORITY_VALUES = Object.freeze(['Mid', 'Unknown']);

/**
 * Unlevelled product design titles this profile accepts as senior seats.
 *
 * Matching is substring-based and case-insensitive, so "Senior Product
 * Designer", "Lead Product Designer", and "Product Designer (Payments)" all
 * match the first entry. Short abbreviations are avoided deliberately: a phrase
 * like "pd" or a bare "designer" would match titles this profile does not want.
 */
export const UNLEVELLED_PRODUCT_DESIGN_TITLES = Object.freeze([
  'product designer',
  'ux designer',
  'ux/ui designer',
]);

/**
 * Lowercases a title for matching. Non-strings normalize to an empty string so
 * every caller gets a plain, falsy result rather than a thrown error.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTitle(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * Returns the accepted unlevelled title phrase present in the classification's
 * job title, or null.
 *
 * @param {{ job_title?: string | null } | null | undefined} classification
 * @returns {string | null}
 */
export function matchUnlevelledTitle(classification) {
  const title = normalizeTitle(classification?.job_title);
  if (!title) {
    return null;
  }

  return UNLEVELLED_PRODUCT_DESIGN_TITLES.find((phrase) => title.includes(phrase)) ?? null;
}

/**
 * Reports whether a post is exempt from the PROJECT_SPEC §11 confidence gate.
 *
 * @param {object} classification
 * @returns {boolean}
 */
export function isConfidenceExemptRole(classification) {
  return matchUnlevelledTitle(classification) !== null;
}

/**
 * Reports whether the post advertises a junior product design role, which the
 * profile excludes (§16).
 *
 * @param {object} classification
 * @returns {boolean}
 */
export function isJuniorRole(classification) {
  return classification?.seniority === JUNIOR_SENIORITY;
}

/**
 * Applies the profile seniority rule to a classification.
 *
 * The input is never mutated: the resolved classification is a new object, so a
 * caller can still compare against the model's original answer.
 *
 * @param {object} classification Phase 4 classification.
 * @returns {{
 *   classification: object,
 *   applied: boolean,
 *   originalSeniority: string | null,
 *   resolvedSeniority: string | null,
 *   matchedTitle: string | null,
 *   reason: string
 * }}
 */
export function resolveProfileSeniority(classification) {
  const unchanged = (reason) => ({
    classification,
    applied: false,
    originalSeniority: classification?.seniority ?? null,
    resolvedSeniority: classification?.seniority ?? null,
    matchedTitle: matchUnlevelledTitle(classification),
    reason,
  });

  if (!classification || typeof classification !== 'object') {
    return unchanged('no classification to resolve');
  }

  // A post the model rejected as a product design role is not this profile's
  // business. Leaving its seniority untouched keeps excluded roles honest.
  if (classification.is_product_design_role !== true) {
    return unchanged('not a product design role: seniority left as classified');
  }

  const level =
    typeof classification.seniority === 'string' ? classification.seniority.trim() : '';

  if (level === '') {
    return unchanged('no seniority reported: seniority left as classified');
  }

  if (level === JUNIOR_SENIORITY) {
    return unchanged('junior role: excluded by the profile, never elevated');
  }

  if (!ELEVATED_SENIORITY_VALUES.includes(level)) {
    // Already a senior tier (Senior, Lead, Staff, Principal, Founding, Head),
    // or a value outside the controlled vocabulary. Nothing to decide.
    return unchanged(`seniority already reported as ${level}`);
  }

  const matchedTitle = matchUnlevelledTitle(classification);

  if (level === 'Unknown' && matchedTitle === null) {
    return unchanged(
      `unknown seniority on "${classification.job_title ?? 'unknown title'}": no accepted unlevelled title, so seniority is left Unknown`
    );
  }

  const reason =
    level === 'Unknown'
      ? `unlevelled title "${classification.job_title}" treated as ${PROFILE_SENIORITY} by the profile role policy`
      : `mid-level product design role treated as ${PROFILE_SENIORITY} by the profile role policy`;

  return {
    classification: { ...classification, seniority: PROFILE_SENIORITY },
    applied: true,
    originalSeniority: level,
    resolvedSeniority: PROFILE_SENIORITY,
    matchedTitle,
    reason,
  };
}