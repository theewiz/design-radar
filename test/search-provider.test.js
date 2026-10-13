import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSearchProvider } from '../src/search/providers/index.js';
import { searchSerper } from '../src/search/providers/serper.js';
import { searchBrave } from '../src/search/providers/brave.js';
import { searchWeb, searchWebBatch } from '../src/search/search-web.js';

describe('Search Provider Abstraction & Adapters', () => {
  describe('Provider Registry', () => {
    it('returns requested provider functions', () => {
      assert.equal(typeof getSearchProvider('serper'), 'function');
      assert.equal(typeof getSearchProvider('brave'), 'function');
      assert.equal(typeof getSearchProvider('mock'), 'function');
    });

    it('throws when requesting an unsupported provider', () => {
      assert.throws(() => getSearchProvider('unsupported_engine'), /Unsupported search provider/);
    });
  });

  describe('Serper Provider Adapter', () => {
    it('throws error when SEARCH_API_KEY is missing', async () => {
      await assert.rejects(
        () => searchSerper('query', { apiKey: '' }),
        /SEARCH_API_KEY is not configured/
      );
    });

    it('formats request payload and parses Serper responses', async () => {
      let capturedUrl = '';
      let capturedHeaders = {};
      let capturedBody = {};

      const mockFetch = async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedBody = JSON.parse(opts.body);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            organic: [
              {
                title: 'Jane Doe on LinkedIn: Senior Product Designer',
                link: 'https://www.linkedin.com/posts/jane-123',
                snippet: 'We are hiring a Senior Product Designer.',
                date: '2 hours ago',
              },
            ],
          }),
        };
      };

      const results = await searchSerper('site:linkedin.com/posts/ "Senior Product Designer"', {
        apiKey: 'test-serper-key',
        limit: 10,
        timeRange: 'd',
        fetchFn: mockFetch,
      });

      assert.equal(capturedUrl, 'https://google.serper.dev/search');
      assert.equal(capturedHeaders['X-API-KEY'], 'test-serper-key');
      assert.equal(capturedBody.tbs, 'qdr:d');
      assert.equal(results.length, 1);
      assert.deepEqual(results[0], {
        url: 'https://www.linkedin.com/posts/jane-123',
        title: 'Jane Doe on LinkedIn: Senior Product Designer',
        snippet: 'We are hiring a Senior Product Designer.',
        publishedAt: '2 hours ago',
        source: 'serper',
      });
    });

    it('handles non-200 API responses gracefully', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Invalid API Key',
      });

      await assert.rejects(
        () => searchSerper('query', { apiKey: 'bad-key', fetchFn: mockFetch }),
        /Serper API HTTP 403: Invalid API Key/
      );
    });
  });

  describe('Brave Provider Adapter', () => {
    it('throws error when SEARCH_API_KEY is missing', async () => {
      await assert.rejects(
        () => searchBrave('query', { apiKey: '' }),
        /SEARCH_API_KEY is not configured/
      );
    });

    it('formats GET request and parses Brave web results', async () => {
      let capturedUrl = '';
      let capturedHeaders = {};

      const mockFetch = async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;

        return {
          ok: true,
          status: 200,
          json: async () => ({
            web: {
              results: [
                {
                  title: 'Acme on LinkedIn: Staff Product Designer',
                  url: 'https://www.linkedin.com/posts/acme-456',
                  description: 'Acme is looking for a Staff Product Designer in Fintech.',
                  page_age: '2026-10-01T08:00:00Z',
                },
              ],
            },
          }),
        };
      };

      const results = await searchBrave('Staff Product Designer', {
        apiKey: 'test-brave-key',
        limit: 10,
        timeRange: 'd',
        fetchFn: mockFetch,
      });

      assert.ok(capturedUrl.includes('freshness=pd'));
      assert.equal(capturedHeaders['X-Subscription-Token'], 'test-brave-key');
      assert.equal(results.length, 1);
      assert.deepEqual(results[0], {
        url: 'https://www.linkedin.com/posts/acme-456',
        title: 'Acme on LinkedIn: Staff Product Designer',
        snippet: 'Acme is looking for a Staff Product Designer in Fintech.',
        publishedAt: '2026-10-01T08:00:00Z',
        source: 'brave',
      });
    });
  });

  describe('searchWeb Abstraction (Filtering, Normalization, Deduplication)', () => {
    it('filters out non-LinkedIn URLs and non-post LinkedIn URLs', async () => {
      const mockRaw = [
        {
          url: 'https://www.linkedin.com/posts/valid-senior-post-1',
          title: 'Valid Post',
          snippet: 'Hiring product designer',
        },
        {
          url: 'https://example.com/job/senior-designer',
          title: 'External Site',
          snippet: 'Not a LinkedIn URL',
        },
        {
          url: 'https://www.linkedin.com/in/jane-doe',
          title: 'LinkedIn Profile',
          snippet: 'User profile, not a post',
        },
        {
          url: 'https://www.linkedin.com/jobs/view/999999',
          title: 'LinkedIn Job Board',
          snippet: 'Job board posting, not user post',
        },
      ];

      const results = await searchWeb('test query', {
        provider: 'mock',
        mockResults: mockRaw,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://www.linkedin.com/posts/valid-senior-post-1');
    });

    it('normalizes LinkedIn URLs to canonical form (strips params and fragments)', async () => {
      const mockRaw = [
        {
          url: 'https://linkedin.com/posts/candidate-post-987?trk=public_profile&utm_source=feed#comments',
          title: 'Post With Query Params',
          snippet: 'Snippet text',
        },
      ];

      const results = await searchWeb('test query', {
        provider: 'mock',
        mockResults: mockRaw,
      });

      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://www.linkedin.com/posts/candidate-post-987');
    });

    it('deduplicates duplicate URLs within the same search query', async () => {
      const mockRaw = [
        {
          url: 'https://www.linkedin.com/posts/lead-designer-post-100?trk=feed',
          title: 'First instance',
          snippet: 'Snippet 1',
        },
        {
          url: 'https://www.linkedin.com/posts/lead-designer-post-100?utm_source=share#comments',
          title: 'Duplicate with different params',
          snippet: 'Snippet 1',
        },
        {
          url: 'https://www.linkedin.com/posts/other-post-200',
          title: 'Distinct post',
          snippet: 'Snippet 2',
        },
      ];

      const results = await searchWeb('test query', {
        provider: 'mock',
        mockResults: mockRaw,
      });

      assert.equal(results.length, 2);
      assert.equal(results[0].url, 'https://www.linkedin.com/posts/lead-designer-post-100');
      assert.equal(results[1].url, 'https://www.linkedin.com/posts/other-post-200');
    });

    it('normalizes search result schema matching internal specification', async () => {
      const mockRaw = [
        {
          url: 'https://www.linkedin.com/posts/founding-designer-777',
          title: '  Founding Designer at Stealth AI  ',
          snippet: '  Join our founding team. Remote.  ',
          publishedAt: '2026-10-01T00:00:00Z',
          source: 'mock',
        },
      ];

      const [post] = await searchWeb('query', { provider: 'mock', mockResults: mockRaw });

      assert.ok('url' in post);
      assert.ok('title' in post);
      assert.ok('snippet' in post);
      assert.ok('publishedAt' in post);
      assert.ok('source' in post);

      assert.equal(post.url, 'https://www.linkedin.com/posts/founding-designer-777');
      assert.equal(post.title, 'Founding Designer at Stealth AI');
      assert.equal(post.snippet, 'Join our founding team. Remote.');
      assert.equal(post.publishedAt, '2026-10-01T00:00:00Z');
      // Source is now identified from the URL (linkedin), not the provider (mock)
      assert.equal(post.source, 'linkedin');
    });

    it('performs cross-query deduplication in searchWebBatch', async () => {
      const query1Results = [
        {
          url: 'https://www.linkedin.com/posts/shared-post-555?trk=q1',
          title: 'Shared Post',
          snippet: 'Hiring in query 1',
        },
      ];

      const query2Results = [
        {
          url: 'https://www.linkedin.com/posts/shared-post-555?trk=q2',
          title: 'Shared Post (Again)',
          snippet: 'Hiring in query 2',
        },
        {
          url: 'https://www.linkedin.com/posts/unique-query-2-post',
          title: 'Unique Post',
          snippet: 'Hiring in query 2 only',
        },
      ];

      // Custom mock provider that alternates results based on query
      const results = await searchWebBatch(
        ['query1', 'query2'],
        {
          provider: 'mock',
          mockResults: [...query1Results, ...query2Results],
        }
      );

      assert.equal(results.length, 2);
      assert.equal(results[0].url, 'https://www.linkedin.com/posts/shared-post-555');
      assert.equal(results[1].url, 'https://www.linkedin.com/posts/unique-query-2-post');
    });

    it('accepts a provider function injected via options.provider', async () => {
      const calls = [];
      const provider = async (query) => {
        calls.push(typeof query === 'string' ? query : query.queryString);
        return [{ url: 'https://jobs.lever.co/co/injected-1', title: 'Injected', snippet: 'Hiring' }];
      };

      const results = await searchWeb('injected query', { provider });

      assert.deepEqual(calls, ['injected query']);
      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://jobs.lever.co/co/injected-1');
      assert.equal(results[0].source, 'lever');
    });
  });
});
