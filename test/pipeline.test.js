/**
 * Pipeline Integration Tests (Phase 3).
 *
 * Tests the combined flow: Discovery → Keyword Filter → Deduplication.
 * Uses mock data representing realistic scenarios from the search provider.
 *
 * Covers:
 * - Valid posts passing through filtering
 * - Irrelevant posts rejected
 * - Duplicate posts deduplicated
 * - Missing timestamps handled
 * - Missing recruiter/company names handled
 * - source_query tracking
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { passesKeywordFilter, filterCandidates } from '../src/search/filter.js';
import { normalizeLinkedInUrl } from '../src/utils/normalize-url.js';
import { createContentFingerprint } from '../src/utils/hash.js';

// ─── Realistic Mock Search Results ──────────────────────────────────────────────

const MOCK_SEARCH_RESULTS = [
  // Valid: Senior Product Designer + hiring signal
  {
    url: 'https://www.linkedin.com/posts/acmepay_senior-product-designer-payments-111?trk=public',
    title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
    snippet: 'AcmePay is looking for a Senior Product Designer to lead our payments infrastructure design. Fully remote in Europe or UK. Join our team!',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  // Valid: Lead Product Designer bypass
  {
    url: 'https://www.linkedin.com/posts/jane-recruiter_lead-product-designer-222',
    title: 'Jane Recruiter: Lead Product Designer at FinCorp',
    snippet: 'Exciting opportunity to shape our RegTech platform. Remote-first. Competitive compensation.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  // Valid: Founding Designer bypass
  {
    url: 'https://www.linkedin.com/posts/aicorp_founding-designer-333',
    title: 'AICorp: Founding Designer (AI & Developer Tools)',
    snippet: 'We are looking for our Founding Designer to shape 0 to 1 developer tools.',
    publishedAt: null, // missing timestamp
    source: 'mock',
  },
  // Irrelevant: Backend engineer
  {
    url: 'https://www.linkedin.com/posts/techco_backend-engineer-444',
    title: 'TechCo: Senior Backend Engineer',
    snippet: 'We are hiring a Senior Backend Engineer with Go and Kubernetes experience.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  // Irrelevant: Cooking post
  {
    url: 'https://www.linkedin.com/posts/chef_pasta-recipe-555',
    title: 'My amazing pasta recipe',
    snippet: 'Here is how to make the best carbonara in under 30 minutes.',
    publishedAt: null,
    source: 'mock',
  },
  // Duplicate URL (tracking variation of first result)
  {
    url: 'https://www.linkedin.com/posts/acmepay_senior-product-designer-payments-111?utm_source=share#comments',
    title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
    snippet: 'AcmePay is looking for a Senior Product Designer to lead our payments infrastructure design.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  // Valid but with missing recruiter info
  {
    url: 'https://www.linkedin.com/posts/unknown_product-design-lead-666',
    title: 'Product Design Lead — Remote Position',
    snippet: 'Open position for a Product Design Lead. Exciting B2B SaaS platform.',
    publishedAt: null,
    source: 'mock',
  },
  // Graphic Designer — should be rejected
  {
    url: 'https://www.linkedin.com/posts/designagency_graphic-designer-777',
    title: 'Hiring: Graphic Designer for Brand Work',
    snippet: 'We are looking for a Graphic Designer to create brand materials and marketing collateral.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
];

describe('Pipeline Integration — URL Normalization + Deduplication', () => {
  it('normalizes URLs and removes duplicate tracking variations', () => {
    const seenUrls = new Set();
    const uniqueCandidates = [];

    for (const result of MOCK_SEARCH_RESULTS) {
      const normalized = normalizeLinkedInUrl(result.url);
      if (!normalized || seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      uniqueCandidates.push({ ...result, url: normalized });
    }

    // 8 results → 7 unique URLs (one duplicate URL pair)
    assert.equal(uniqueCandidates.length, 7);

    // The duplicate should be collapsed
    const urls = uniqueCandidates.map((c) => c.url);
    const urlsWithPayments = urls.filter((u) => u.includes('payments-111'));
    assert.equal(urlsWithPayments.length, 1);
  });

  it('deduplicates via content fingerprint across different URLs with identical text', () => {
    const identicalTextResults = [
      {
        url: 'https://www.linkedin.com/posts/post-a',
        title: 'Senior Product Designer at AcmePay',
        snippet: 'We are hiring a Senior Product Designer for our payments team.',
      },
      {
        url: 'https://www.linkedin.com/posts/post-b',
        title: 'Senior Product Designer at AcmePay',
        snippet: 'We are hiring a Senior Product Designer for our payments team.',
      },
      {
        url: 'https://www.linkedin.com/posts/post-c',
        title: 'Different Role',
        snippet: 'Looking for a backend developer.',
      },
    ];

    const seenFingerprints = new Set();
    const unique = [];

    for (const item of identicalTextResults) {
      const fp = createContentFingerprint(item.title, item.snippet);
      if (!seenFingerprints.has(fp)) {
        seenFingerprints.add(fp);
        unique.push(item);
      }
    }

    assert.equal(unique.length, 2);
  });
});

describe('Pipeline Integration — Keyword Filtering on Realistic Data', () => {
  it('correctly filters the full set of mock results after dedup', () => {
    // First: normalize and deduplicate
    const seenUrls = new Set();
    const dedupedCandidates = [];

    for (const result of MOCK_SEARCH_RESULTS) {
      const normalized = normalizeLinkedInUrl(result.url);
      if (!normalized || seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      dedupedCandidates.push({ ...result, url: normalized });
    }

    // Then: filter
    const { passed, rejected } = filterCandidates(dedupedCandidates);

    // Expected passes:
    // 1. AcmePay Senior Product Designer (seniority bypass + design+hiring)
    // 2. Lead Product Designer at FinCorp (seniority bypass)
    // 3. Founding Designer at AICorp (seniority bypass)
    // 4. Product Design Lead - Remote (design lead + open position = Condition A)
    assert.equal(passed.length, 4);

    // Expected rejections:
    // 1. Backend Engineer (missing design term)
    // 2. Pasta recipe (no matching terms)
    // 3. Graphic Designer (missing design term — "graphic designer" != product designer)
    assert.equal(rejected.length, 3);

    // Verify rejection reasons
    const backendRejection = rejected.find((r) => r.candidate.url.includes('backend'));
    assert.ok(backendRejection);
    assert.equal(backendRejection.reason, 'missing_design_term');

    const cookingRejection = rejected.find((r) => r.candidate.url.includes('pasta'));
    assert.ok(cookingRejection);
    assert.equal(cookingRejection.reason, 'no_matching_terms');
  });
});

describe('Pipeline Integration — Missing Timestamps', () => {
  it('preserves candidates with null published_at through filtering', () => {
    const candidatesWithMissingTimestamps = [
      {
        url: 'https://www.linkedin.com/posts/post-null-ts-1',
        title: 'Senior Product Designer opportunity',
        snippet: 'We are hiring for this amazing role.',
        publishedAt: null,
      },
      {
        url: 'https://www.linkedin.com/posts/post-null-ts-2',
        title: 'Founding Product Designer at StartupX',
        snippet: 'Building something new.',
        publishedAt: null,
      },
    ];

    const { passed } = filterCandidates(candidatesWithMissingTimestamps);
    assert.equal(passed.length, 2);

    // Verify timestamps are preserved as-is (not fabricated)
    for (const candidate of passed) {
      assert.equal(candidate.publishedAt, null);
    }
  });
});

describe('Pipeline Integration — Missing Recruiter and Company Names', () => {
  it('passes candidates even when recruiter/company info is unknown', () => {
    const candidateWithoutAuthor = {
      url: 'https://www.linkedin.com/posts/anonymous-post-1',
      title: 'Senior Product Designer — Fully Remote',
      snippet: 'An exciting fintech company is looking for a product designer.',
      publishedAt: new Date().toISOString(),
      authorName: null,
      companyName: null,
    };

    const result = passesKeywordFilter(candidateWithoutAuthor);
    assert.equal(result.passed, true);
  });
});

describe('Pipeline Integration — Source Query Tracking', () => {
  it('preserves source_query throughout the pipeline', () => {
    const sourceQuery = 'site:linkedin.com/posts/ "Senior Product Designer" hiring';

    const candidates = [
      {
        url: 'https://www.linkedin.com/posts/post-sq-1',
        title: 'Senior Product Designer at FinCorp',
        snippet: 'We are hiring!',
        source_query: sourceQuery,
      },
    ];

    const { passed } = filterCandidates(candidates);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].source_query, sourceQuery);
  });
});

describe('Pipeline Integration — Database Insertion Safety', () => {
  it('the normalized URL is deterministic and can serve as dedup key', () => {
    const urlVariations = [
      'https://www.linkedin.com/posts/acme-job-123?trk=feed',
      'https://linkedin.com/posts/acme-job-123?utm_source=share#comments',
      'http://www.linkedin.com/posts/acme-job-123/',
      'https://m.linkedin.com/posts/acme-job-123?trk=mobile',
    ];

    const normalized = urlVariations.map(normalizeLinkedInUrl);

    // All should normalize to the same canonical URL
    const expected = 'https://www.linkedin.com/posts/acme-job-123';
    for (const url of normalized) {
      assert.equal(url, expected);
    }
  });
});
