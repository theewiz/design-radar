/**
 * Profile Role Policy Tests (PROJECT_SPEC §6, §11, §13, §14, §16).
 *
 * Covers the three rules the profile applies after classification:
 * seniority elevation for unlevelled and mid product design titles, the junior
 * exclusion, and the confidence-gate exemption.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProfileSeniority,
  isConfidenceExemptRole,
  isJuniorRole,
  matchUnlevelledTitle,
  PROFILE_SENIORITY,
  JUNIOR_SENIORITY,
  UNLEVELLED_PRODUCT_DESIGN_TITLES,
} from '../src/profile/role-policy.js';
import { meetsConfidenceThreshold } from '../src/ai/classify.js';
import { isEligibleOpportunity, scorePost } from '../src/ai/score.js';

/**
 * Builds a Phase 4 classification with sensible defaults.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function classification(overrides = {}) {
  return {
    is_recruiting_post: true,
    is_product_design_role: true,
    job_title: 'Product Designer',
    seniority: 'Unknown',
    company_name: 'AcmePay',
    author_name: null,
    is_hiring_manager_or_recruiter: true,
    location: 'Europe',
    remote_status: 'Remote',
    application_url: null,
    confidence: 0.68,
    reason: 'test',
    ...overrides,
  };
}

describe('Profile Role Policy — Title Matching', () => {
  it('matches every accepted unlevelled title, case-insensitively', () => {
    const titles = [
      'Product Designer',
      'product designer',
      'PRODUCT DESIGNER',
      'UX Designer',
      'ux designer',
      'UX/UI Designer',
      'Senior Product Designer',
      'Lead Product Designer',
    ];

    for (const title of titles) {
      assert.ok(matchUnlevelledTitle({ job_title: title }), title);
    }
  });

  it('does not match titles the profile does not accept', () => {
    for (const title of [
      'Product Design Intern',
      'Senior Product Manager',
      'Head of Product Design',
      'Founding Designer',
      'Graphic Designer',
      'Product Manager',
      'Design Lead',
    ]) {
      assert.equal(matchUnlevelledTitle({ job_title: title }), null, title);
    }
  });

  it('matches a levelled-but-not-junior title such as Associate', () => {
    // Phrase matching is deliberately not a seniority parser. "Associate Product
    // Designer" contains the accepted phrase, and the profile counts Mid roles
    // as senior-level anyway. Only an explicit Junior classification is excluded,
    // and that is handled by the Junior rule rather than by the title.
    assert.equal(matchUnlevelledTitle({ job_title: 'Associate Product Designer' }), 'product designer');
    assert.equal(
      resolveProfileSeniority(
        classification({ job_title: 'Associate Product Designer', seniority: 'Mid' })
      ).applied,
      true
    );
  });

  it('tolerates missing or malformed titles', () => {
    assert.equal(matchUnlevelledTitle(null), null);
    assert.equal(matchUnlevelledTitle({}), null);
    assert.equal(matchUnlevelledTitle({ job_title: null }), null);
    assert.equal(matchUnlevelledTitle({ job_title: 42 }), null);
  });

  it('keeps every phrase in the exported list lowercase', () => {
    for (const phrase of UNLEVELLED_PRODUCT_DESIGN_TITLES) {
      assert.equal(phrase, phrase.toLowerCase());
    }
  });
});

describe('Profile Role Policy — Seniority Elevation', () => {
  it('elevates an unlevelled product design title to Senior', () => {
    const result = resolveProfileSeniority(classification());

    assert.equal(result.applied, true);
    assert.equal(result.originalSeniority, 'Unknown');
    assert.equal(result.resolvedSeniority, PROFILE_SENIORITY);
    assert.equal(result.classification.seniority, 'Senior');
    assert.match(result.reason, /unlevelled title/i);
  });

  it('elevates every accepted unlevelled title', () => {
    for (const title of ['Product Designer', 'UX Designer', 'UX/UI Designer']) {
      const result = resolveProfileSeniority(classification({ job_title: title }));
      assert.equal(result.classification.seniority, 'Senior', title);
    }
  });

  it('elevates an explicit Mid product design role', () => {
    const result = resolveProfileSeniority(classification({ seniority: 'Mid' }));

    assert.equal(result.applied, true);
    assert.equal(result.originalSeniority, 'Mid');
    assert.equal(result.classification.seniority, 'Senior');
    assert.match(result.reason, /mid-level/i);
  });

  it('leaves an already-senior tier untouched', () => {
    for (const level of ['Senior', 'Lead', 'Staff', 'Principal', 'Founding', 'Head']) {
      const result = resolveProfileSeniority(classification({ seniority: level, job_title: 'Product Designer' }));

      assert.equal(result.applied, false, level);
      assert.equal(result.classification.seniority, level, level);
    }
  });

  it('never elevates a junior role', () => {
    const result = resolveProfileSeniority(
      classification({ seniority: JUNIOR_SENIORITY, job_title: 'Junior Product Designer' })
    );

    assert.equal(result.applied, false);
    assert.equal(result.classification.seniority, 'Junior');
    assert.match(result.reason, /junior/i);
    assert.equal(isJuniorRole(result.classification), true);
  });

  it('leaves Unknown seniority alone on a title it does not accept', () => {
    const result = resolveProfileSeniority(
      classification({ job_title: 'Head of Product Design' })
    );

    assert.equal(result.applied, false);
    assert.equal(result.classification.seniority, 'Unknown');
    assert.match(result.reason, /no accepted unlevelled title/);
  });

  it('leaves a rejected role alone, even at Mid', () => {
    const result = resolveProfileSeniority(
      classification({
        is_product_design_role: false,
        seniority: 'Mid',
        job_title: 'Product Designer',
      })
    );

    assert.equal(result.applied, false);
    assert.equal(result.classification.seniority, 'Mid');
    assert.match(result.reason, /not a product design role/);
  });

  it('does not mutate the input classification', () => {
    const input = classification();
    const before = { ...input };

    resolveProfileSeniority(input);

    assert.deepEqual(input, before);
  });

  it('preserves every other field when it elevates', () => {
    const input = classification({ confidence: 0.61, reason: 'thin snippet' });
    const result = resolveProfileSeniority(input);

    assert.equal(result.classification.company_name, input.company_name);
    assert.equal(result.classification.confidence, input.confidence);
    assert.equal(result.classification.reason, input.reason);
    assert.equal(result.classification.job_title, input.job_title);
  });

  it('tolerates missing or malformed input', () => {
    for (const value of [null, undefined, 'a classification', 42, []]) {
      const result = resolveProfileSeniority(value);
      assert.equal(result.applied, false);
    }

    const empty = resolveProfileSeniority({ is_product_design_role: true });
    assert.equal(empty.applied, false);
    assert.match(empty.reason, /no seniority reported/);
  });

  it('tolerates a seniority value outside the controlled vocabulary', () => {
    const result = resolveProfileSeniority(
      classification({ seniority: 'Grandmaster', job_title: 'Product Designer' })
    );

    assert.equal(result.applied, false);
    assert.equal(result.classification.seniority, 'Grandmaster');
  });
});

describe('Profile Role Policy — Junior Exclusion', () => {
  it('recognises a junior role', () => {
    assert.equal(isJuniorRole({ seniority: 'Junior' }), true);
    assert.equal(isJuniorRole({ seniority: 'Mid' }), false);
    assert.equal(isJuniorRole({ seniority: 'junior' }), false, 'comparison is exact');
    assert.equal(isJuniorRole(null), false);
  });

  it('fails the eligibility gate for a junior product design post', () => {
    assert.equal(
      isEligibleOpportunity(classification({ seniority: 'Junior', job_title: 'Junior Product Designer' })),
      false
    );
  });

  it('keeps a junior post at score 0 with no signals evaluated', () => {
    const result = scorePost(
      classification({
        seniority: 'Junior',
        job_title: 'Junior Product Designer',
        is_hiring_manager_or_recruiter: true,
        location: 'Worldwide',
        remote_status: 'Remote',
      }),
      { candidate: { title: 'Hiring a Junior Product Designer', snippet: 'Fintech remote payments.' } }
    );

    assert.equal(result.score, 0);
    assert.equal(result.eligible, false);
    assert.equal(result.status, 'irrelevant');
    assert.deepEqual(result.breakdown, []);
  });

  it('still admits every non-junior level through the gate', () => {
    for (const level of ['Mid', 'Unknown', 'Senior', 'Lead', 'Staff', 'Principal', 'Founding', 'Head']) {
      assert.equal(
        isEligibleOpportunity(classification({ seniority: level })),
        true,
        level
      );
    }
  });
});

describe('Profile Role Policy — Confidence Exemption', () => {
  it('exempts an unlevelled product design role below the gate', () => {
    const post = classification({ confidence: 0.5 });

    assert.equal(isConfidenceExemptRole(post), true);
    assert.equal(meetsConfidenceThreshold(post), true);
  });

  it('exempts senior-prefixed variants of the accepted titles', () => {
    for (const title of ['Senior Product Designer', 'Product Designer (Payments)', 'UX Designer']) {
      assert.equal(
        meetsConfidenceThreshold(classification({ job_title: title, confidence: 0.1 })),
        true,
        title
      );
    }
  });

  it('does not exempt other titles, even at the same confidence', () => {
    for (const title of ['Head of Product Design', 'Founding Designer', 'Design Lead', null]) {
      const post = classification({ job_title: title, confidence: 0.1 });
      assert.equal(isConfidenceExemptRole(post), false, String(title));
      assert.equal(meetsConfidenceThreshold(post), false, String(title));
    }
  });

  it('never exempts a post with no classification at all', () => {
    assert.equal(isConfidenceExemptRole(null), false);
    assert.equal(meetsConfidenceThreshold(null), false);
  });

  it('does not exempt a post that fails the eligibility gate', () => {
    // Exemption and eligibility are independent: a graphic design vacancy
    // advertised as "Product Designer" in the snippet is still rejected.
    const post = classification({
      confidence: 0.2,
      is_product_design_role: false,
      is_recruiting_post: false,
    });

    assert.equal(meetsConfidenceThreshold(post), true);
    assert.equal(isEligibleOpportunity(post), false);
  });
});

describe('Profile Role Policy — End-to-End Effect', () => {
  const candidate = {
    title: 'AcmePay is hiring a Product Designer',
    snippet: 'AcmePay is hiring a Product Designer for our payments platform. Remote in Europe.',
  };

  it('scores a resolved unlevelled post as a Senior opportunity', () => {
    const { classification: resolved } = resolveProfileSeniority(
      classification({ seniority: 'Unknown', confidence: 0.68 })
    );

    const result = scorePost(resolved, { candidate });

    // 30 seniority + 20 hiring + 10 recruiter + 25 location (remote + Europe) + 10 domain = 95.
    assert.equal(result.score, 95);
    assert.equal(result.eligible, true);
    assert.equal(result.priority, 'high');
    assert.equal(meetsConfidenceThreshold(resolved), true);
  });

  it('reports a mid-level post at the profile seniority without touching the original', () => {
    const input = classification({ seniority: 'Mid' });
    const { classification: resolved } = resolveProfileSeniority(input);

    assert.equal(input.seniority, 'Mid', 'the model answer is preserved for audit');
    assert.equal(resolved.seniority, 'Senior');
  });
});