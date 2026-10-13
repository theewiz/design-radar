/**
 * Tests for cheap keyword filter (Phase 3 — §10).
 *
 * Covers:
 * - Condition A: Product Design term + Hiring term
 * - Condition B: Seniority Title Bypass
 * - Rejection of irrelevant posts
 * - Missing/empty text handling
 * - Edge cases (partial matches, case insensitivity)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  passesKeywordFilter,
  filterCandidates,
  PRODUCT_DESIGN_TERMS,
  HIRING_TERMS,
  SENIORITY_BYPASS_TITLES,
} from '../src/search/filter.js';

describe('Keyword Filter — Condition A (Design Term + Hiring Term)', () => {
  it('passes a candidate with both a product design term and a hiring term', () => {
    const result = passesKeywordFilter({
      title: 'AcmePay on LinkedIn: Open Role',
      snippet: 'We are hiring a Product Designer to join our payments team.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'design_and_hiring');
  });

  it('passes when design term is in title and hiring term is in snippet', () => {
    const result = passesKeywordFilter({
      title: 'Product Design opportunity at FinCorp',
      snippet: 'Join our team as we grow our design practice.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'design_and_hiring');
  });

  it('passes with "UX/Product" design term', () => {
    const result = passesKeywordFilter({
      title: 'UX/Product role',
      snippet: 'We are hiring for this position.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'design_and_hiring');
  });

  it('passes with "design lead" term', () => {
    const result = passesKeywordFilter({
      title: 'Design Lead needed',
      snippet: 'Recruiting for our London office.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'design_and_hiring');
  });

  it('rejects a candidate with only a design term (no hiring term)', () => {
    const result = passesKeywordFilter({
      title: 'Product Designer portfolio showcase',
      snippet: 'Here is my latest work in fintech product design.',
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'missing_hiring_term');
  });

  it('rejects a candidate with only a hiring term (no design term)', () => {
    const result = passesKeywordFilter({
      title: 'We are hiring!',
      snippet: 'Looking for a backend engineer to join our platform team.',
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'missing_design_term');
  });
});

describe('Keyword Filter — Condition B (Seniority Title Bypass)', () => {
  it('passes "Senior Product Designer" even without explicit hiring language', () => {
    const result = passesKeywordFilter({
      title: 'Senior Product Designer opportunity',
      snippet: 'AcmePay is expanding its design team in Europe.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('passes "Lead Product Designer" bypass', () => {
    const result = passesKeywordFilter({
      title: 'Lead Product Designer at FinCorp',
      snippet: 'Remote-first company building compliance tools.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('passes "Staff Product Designer" bypass', () => {
    const result = passesKeywordFilter({
      title: null,
      snippet: 'Excited to announce our Staff Product Designer opening.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('passes "Principal Product Designer" bypass', () => {
    const result = passesKeywordFilter({
      title: 'Principal Product Designer',
      snippet: 'Building enterprise design tools.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('passes "Founding Product Designer" bypass', () => {
    const result = passesKeywordFilter({
      title: 'Our Founding Product Designer role',
      snippet: 'Series A AI startup.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('passes "Founding Designer" bypass', () => {
    const result = passesKeywordFilter({
      title: null,
      snippet: 'We need a Founding Designer to shape the product from scratch.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('passes "Head of Product Design" bypass', () => {
    const result = passesKeywordFilter({
      title: 'Head of Product Design at Scale',
      snippet: 'Join a $200M fintech.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('is case insensitive for seniority bypass', () => {
    const result = passesKeywordFilter({
      title: 'SENIOR PRODUCT DESIGNER at ACME',
      snippet: 'Remote position.',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });
});

describe('Keyword Filter — Irrelevant Posts', () => {
  it('rejects a purely irrelevant post about cooking', () => {
    const result = passesKeywordFilter({
      title: 'My grandmother\'s pasta recipe',
      snippet: 'Here is how to make the best carbonara in under 30 minutes.',
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'no_matching_terms');
  });

  it('rejects a backend engineering hiring post', () => {
    const result = passesKeywordFilter({
      title: 'We are hiring a Senior Backend Engineer',
      snippet: 'Looking for a Golang developer with distributed systems experience.',
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'missing_design_term');
  });

  it('rejects a graphic designer post without product design terms', () => {
    const result = passesKeywordFilter({
      title: 'Graphic Designer wanted',
      snippet: 'Hiring for brand and marketing materials.',
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'missing_design_term');
  });

  it('rejects a junior designer portfolio post (no hiring term)', () => {
    const result = passesKeywordFilter({
      title: 'My journey as a junior designer',
      snippet: 'Here are some thoughts on product design from a newcomer.',
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'missing_hiring_term');
  });
});

describe('Keyword Filter — Edge Cases', () => {
  it('handles null candidate', () => {
    const result = passesKeywordFilter(null);
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'null_candidate');
  });

  it('handles candidate with null title and null snippet', () => {
    const result = passesKeywordFilter({ title: null, snippet: null });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'empty_text');
  });

  it('handles candidate with empty string title and snippet', () => {
    const result = passesKeywordFilter({ title: '', snippet: '' });
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'empty_text');
  });

  it('handles candidate with only title (no snippet)', () => {
    const result = passesKeywordFilter({
      title: 'Senior Product Designer at AcmePay',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'seniority_bypass');
  });

  it('handles candidate with only snippet (no title)', () => {
    const result = passesKeywordFilter({
      snippet: 'Hiring a UX designer for our product team. Open role!',
    });
    assert.equal(result.passed, true);
    assert.equal(result.reason, 'design_and_hiring');
  });
});

describe('filterCandidates — Batch Filtering', () => {
  it('separates passed and rejected candidates', () => {
    const candidates = [
      {
        url: 'https://www.linkedin.com/posts/post-1',
        title: 'Senior Product Designer at FinCorp',
        snippet: 'We are hiring!',
      },
      {
        url: 'https://www.linkedin.com/posts/post-2',
        title: 'Backend Engineer opportunity',
        snippet: 'Join our engineering team.',
      },
      {
        url: 'https://www.linkedin.com/posts/post-3',
        title: 'Lead Product Designer — Remote',
        snippet: 'Exciting opportunity at a payments startup.',
      },
    ];

    const { passed, rejected } = filterCandidates(candidates);

    assert.equal(passed.length, 2);
    assert.equal(rejected.length, 1);
    assert.equal(passed[0].url, 'https://www.linkedin.com/posts/post-1');
    assert.equal(passed[1].url, 'https://www.linkedin.com/posts/post-3');
    assert.equal(rejected[0].reason, 'no_matching_terms');
  });

  it('returns empty arrays for empty input', () => {
    const { passed, rejected } = filterCandidates([]);
    assert.equal(passed.length, 0);
    assert.equal(rejected.length, 0);
  });

  it('returns empty arrays for non-array input', () => {
    const { passed, rejected } = filterCandidates(null);
    assert.equal(passed.length, 0);
    assert.equal(rejected.length, 0);
  });

  it('exports all expected keyword lists', () => {
    assert.ok(Array.isArray(PRODUCT_DESIGN_TERMS));
    assert.ok(Array.isArray(HIRING_TERMS));
    assert.ok(Array.isArray(SENIORITY_BYPASS_TITLES));
    assert.ok(PRODUCT_DESIGN_TERMS.length > 0);
    assert.ok(HIRING_TERMS.length > 0);
    assert.ok(SENIORITY_BYPASS_TITLES.length > 0);
  });
});
