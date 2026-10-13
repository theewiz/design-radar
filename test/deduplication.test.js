import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLinkedInUrl } from '../src/utils/normalize-url.js';
import { createContentFingerprint } from '../src/utils/hash.js';

describe('Duplicate URL and Candidate Handling', () => {
  it('deduplicates URLs that differ only by query parameters and fragments', () => {
    const rawUrls = [
      'https://www.linkedin.com/posts/acme_senior-product-designer-remote-post-12345?trk=public_profile',
      'https://www.linkedin.com/posts/acme_senior-product-designer-remote-post-12345?utm_source=share#comments',
      'https://linkedin.com/posts/acme_senior-product-designer-remote-post-12345/',
      'https://www.linkedin.com/posts/different-company-lead-designer-67890',
    ];

    const seenNormalizedUrls = new Set();
    const uniqueNormalized = [];

    for (const raw of rawUrls) {
      const normalized = normalizeLinkedInUrl(raw);
      if (normalized && !seenNormalizedUrls.has(normalized)) {
        seenNormalizedUrls.add(normalized);
        uniqueNormalized.push(normalized);
      }
    }

    assert.equal(uniqueNormalized.length, 2);
    assert.deepEqual(uniqueNormalized, [
      'https://www.linkedin.com/posts/acme_senior-product-designer-remote-post-12345',
      'https://www.linkedin.com/posts/different-company-lead-designer-67890',
    ]);
  });

  it('deduplicates identical candidates using content fingerprinting across differing query variations', () => {
    const searchResults = [
      {
        url: 'https://www.linkedin.com/posts/jane-hiring-1?trk=feed',
        title: 'Jane Doe on LinkedIn: Senior Product Designer',
        snippet: 'We are hiring a Senior Product Designer at FinCorp. Fully remote, Europe or UK.',
      },
      {
        url: 'https://www.linkedin.com/posts/jane-hiring-1-repost?trk=public_profile',
        title: 'Jane Doe on LinkedIn: Senior Product Designer',
        snippet: 'We are hiring a Senior Product Designer at FinCorp. Fully remote, Europe or UK.',
      },
      {
        url: 'https://www.linkedin.com/posts/john-hiring-2',
        title: 'John Smith on LinkedIn: Founding Designer',
        snippet: 'Join our early-stage AI team as Founding Designer.',
      },
    ];

    const seenFingerprints = new Set();
    const candidatesToClassify = [];

    for (const item of searchResults) {
      const fp = createContentFingerprint(item.title, item.snippet);
      if (!seenFingerprints.has(fp)) {
        seenFingerprints.add(fp);
        candidatesToClassify.push(item);
      }
    }

    assert.equal(candidatesToClassify.length, 2);
    assert.equal(candidatesToClassify[0].url, 'https://www.linkedin.com/posts/jane-hiring-1?trk=feed');
    assert.equal(candidatesToClassify[1].url, 'https://www.linkedin.com/posts/john-hiring-2');
  });

  it('filters out invalid and malformed URLs before deduplication', () => {
    const mixedUrls = [
      'https://www.linkedin.com/posts/valid-post-1',
      'https://www.linkedin.com/in/some-profile',
      'invalid url string',
      null,
      'https://www.linkedin.com/posts/valid-post-1?trk=mobile',
      'https://google.com/search?q=designer',
    ];

    const validUrls = mixedUrls
      .map((url) => normalizeLinkedInUrl(url))
      .filter((url) => url !== null);

    const dedupedUrls = Array.from(new Set(validUrls));

    assert.equal(dedupedUrls.length, 1);
    assert.equal(dedupedUrls[0], 'https://www.linkedin.com/posts/valid-post-1');
  });
});
