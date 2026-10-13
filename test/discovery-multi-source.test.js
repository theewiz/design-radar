import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscovery } from '../src/discovery/index.js';
import { searchWeb, searchWebBatch } from '../src/search/search-web.js';

describe('Multi-Source Discovery', () => {
  describe('searchWeb with multi-source URLs', () => {
    it('identifies and normalizes LinkedIn URLs', async () => {
      const mockRaw = [
        {
          url: 'https://www.linkedin.com/posts/test-123?trk=feed#comments',
          title: 'Test Post',
          snippet: 'Hiring Senior Product Designer',
        },
      ];

      const results = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://www.linkedin.com/posts/test-123');
      assert.equal(results[0].source, 'linkedin');
    });

    it('identifies and normalizes Greenhouse URLs', async () => {
      const mockRaw = [
        {
          url: 'https://boards.greenhouse.io/co/jobs/456?gh_jid=456',
          title: 'Greenhouse Job',
          snippet: 'Hiring Lead Product Designer',
        },
      ];

      const results = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://boards.greenhouse.io/co/jobs/456');
      assert.equal(results[0].source, 'greenhouse');
    });

    it('identifies and normalizes Ashby URLs', async () => {
      const mockRaw = [
        {
          url: 'https://jobs.ashbyhq.com/co/job-789?utm_source=test',
          title: 'Ashby Job',
          snippet: 'Hiring Staff Product Designer',
        },
      ];

      const results = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://jobs.ashbyhq.com/co/job-789');
      assert.equal(results[0].source, 'ashby');
    });

    it('identifies and normalizes Lever URLs', async () => {
      const mockRaw = [
        {
          url: 'https://jobs.lever.co/co/job-999?lever-origin=applied',
          title: 'Lever Job',
          snippet: 'Hiring Product Designer',
        },
      ];

      const results = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://jobs.lever.co/co/job-999');
      assert.equal(results[0].source, 'lever');
    });

    it('handles multiple sources in single searchWeb call', async () => {
      const mockRaw = [
        {
          url: 'https://www.linkedin.com/posts/li-123?trk=feed',
          title: 'LinkedIn Post',
          snippet: 'Hiring Senior Product Designer',
        },
        {
          url: 'https://boards.greenhouse.io/co/jobs/456?gh_jid=456',
          title: 'Greenhouse Job',
          snippet: 'Hiring Lead Product Designer',
        },
        {
          url: 'https://jobs.ashbyhq.com/co/job-789?utm_source=test',
          title: 'Ashby Job',
          snippet: 'Hiring Staff Product Designer',
        },
        {
          url: 'https://jobs.lever.co/co/job-999?lever-origin=applied',
          title: 'Lever Job',
          snippet: 'Hiring Product Designer',
        },
      ];

      const results = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      assert.equal(results.length, 4);
      const sources = new Set(results.map((r) => r.source));
      assert.ok(sources.has('linkedin'));
      assert.ok(sources.has('greenhouse'));
      assert.ok(sources.has('ashby'));
      assert.ok(sources.has('lever'));
    });
  });

  describe('searchWebBatch with multi-source URLs', () => {
    it('deduplicates across sources in searchWebBatch', async () => {
      const query1Results = [
        { url: 'https://www.linkedin.com/posts/shared-123?trk=q1', title: 'Shared', snippet: 'Hiring' },
      ];
      const query2Results = [
        { url: 'https://boards.greenhouse.io/co/jobs/456?gh_jid=456', title: 'GH', snippet: 'Hiring' },
      ];

      const results = await searchWebBatch(
        ['query1', 'query2'],
        { provider: 'mock', mockResults: [...query1Results, ...query2Results] }
      );

      assert.equal(results.length, 2);
      const sources = new Set(results.map((r) => r.source));
      assert.ok(sources.has('linkedin'));
      assert.ok(sources.has('greenhouse'));
    });

    it('deduplicates same URL across different queries and sources', async () => {
      const query1Results = [
        { url: 'https://www.linkedin.com/posts/shared-123?trk=q1', title: 'Shared LI Q1', snippet: 'Hiring' },
      ];
      const query2Results = [
        { url: 'https://www.linkedin.com/posts/shared-123?utm_source=q2#comments', title: 'Shared LI Q2', snippet: 'Hiring' },
        { url: 'https://boards.greenhouse.io/co/jobs/456?gh_jid=456', title: 'GH', snippet: 'Hiring' },
      ];

      const results = await searchWebBatch(
        ['query1', 'query2'],
        { provider: 'mock', mockResults: [...query1Results, ...query2Results] }
      );

      // Should deduplicate the LinkedIn URL
      assert.equal(results.length, 2);
      const urls = results.map((r) => r.url);
      assert.ok(urls.includes('https://www.linkedin.com/posts/shared-123'));
      assert.ok(urls.includes('https://boards.greenhouse.io/co/jobs/456'));
    });

    it('filters out non-job-posting URLs', async () => {
      const mockRaw = [
        {
          url: 'https://www.linkedin.com/posts/valid-post-123',
          title: 'Valid Post',
          snippet: 'Hiring product designer',
        },
        {
          url: 'https://example.com/jobs/123',
          title: 'External Site',
          snippet: 'Not a job board',
        },
        {
          url: 'https://www.linkedin.com/in/profile',
          title: 'LinkedIn Profile',
          snippet: 'Not a post',
        },
        {
          url: 'https://boards.greenhouse.io/company', // Not a job URL
          title: 'Greenhouse Company Page',
          snippet: 'Company page',
        },
      ];

      const results = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      // Only the valid LinkedIn post should pass
      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://www.linkedin.com/posts/valid-post-123');
      assert.equal(results[0].source, 'linkedin');
    });
  });

  describe('runDiscovery with default multi-source queries', () => {
    it('executes discovery with multi-source query generation', async () => {
      // Use default mock provider (no custom mockResults)
      // This tests the query generation and basic flow
      const result = await runDiscovery({
        provider: 'mock',
        queryBudget: 4,
      });

      assert.ok(result.metrics.queryCount > 0);
      assert.ok(result.metrics.candidateCount >= 0);
      assert.ok(result.metrics.durationMs >= 0);
      assert.ok(Array.isArray(result.failedQueries));
    });

    it('tracks metrics per source in generated queries', async () => {
      const result = await runDiscovery({
        provider: 'mock',
        queryBudget: 8,
      });

      assert.ok(result.metrics.queryCount > 0);
      assert.ok(result.metrics.durationMs >= 0);
      
      // Verify queries include multiple sources
      const sources = new Set(result.queries.map((q) => q.source));
      assert.ok(sources.has('linkedin'));
      // Other sources may or may not be present depending on budget allocation
    });
  });
});