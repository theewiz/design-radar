/**
 * Brave Search Provider Adapter (https://brave.com/search/api/)
 * Executes web searches via Brave's Web Search API.
 */

import { getEnv } from '../../utils/env.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Executes a search query using the Brave Search API.
 *
 * @param {string | { queryString?: string, terms?: string[], targetDomain?: string }} query
 * @param {Object} [options]
 * @param {string} [options.apiKey] Brave API key. Defaults to SEARCH_API_KEY from the environment.
 * @param {number} [options.limit=10] Max results to fetch (1-20).
 * @param {string} [options.timeRange='d'] Time filter: 'd' (day: pd), 'w' (week: pw), 'm' (month: pm).
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch] Injectable fetch for testing.
 * @returns {Promise<Array<{ url: string, title: string | null, snippet: string | null, publishedAt: string | null, source: string }>>}
 */
export async function searchBrave(query, options = {}) {
  const apiKey = options.apiKey || getEnv().SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('Brave adapter error: SEARCH_API_KEY is not configured.');
  }

  const queryText = typeof query === 'string'
    ? query
    : query.queryString || query.terms?.join(' ') || '';

  if (!queryText.trim()) {
    return [];
  }

  const limit = Math.min(Math.max(options.limit || 10, 1), 20);
  const timeRange = options.timeRange || 'd';

  let freshness;
  if (timeRange === 'd') freshness = 'pd';
  else if (timeRange === 'w') freshness = 'pw';
  else if (timeRange === 'm') freshness = 'pm';

  const params = new URLSearchParams({
    q: queryText,
    count: String(limit),
    ...(freshness ? { freshness } : {}),
  });

  const fetchFn = options.fetchFn || globalThis.fetch;
  const response = await fetchFn(`${BRAVE_API_URL}?${params.toString()}`, {
    method: 'GET',
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Brave Search API HTTP ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.web?.results) ? data.web.results : [];

  return results.map((item) => ({
    url: item.url || '',
    title: item.title || null,
    snippet: item.description || null,
    publishedAt: item.page_age || null,
    source: 'brave',
  }));
}
