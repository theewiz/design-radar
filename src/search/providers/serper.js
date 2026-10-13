/**
 * Serper Search Provider Adapter (https://google.serper.dev)
 * Executes Google web searches via Serper's REST API.
 */

import { getEnv } from '../../utils/env.js';

const SERPER_API_URL = 'https://google.serper.dev/search';

/**
 * Executes a search query using the Serper API.
 *
 * @param {string | { queryString?: string, terms?: string[], targetDomain?: string }} query
 * @param {Object} [options]
 * @param {string} [options.apiKey] Serper API key. Defaults to SEARCH_API_KEY from the environment.
 * @param {number} [options.limit=10] Max results to fetch (1-50).
 * @param {string} [options.timeRange='d'] Time filter: 'd' (day), 'w' (week), 'm' (month).
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch] Injectable fetch for testing.
 * @returns {Promise<Array<{ url: string, title: string | null, snippet: string | null, publishedAt: string | null, source: string }>>}
 */
export async function searchSerper(query, options = {}) {
  const apiKey = options.apiKey || getEnv().SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('Serper adapter error: SEARCH_API_KEY is not configured.');
  }

  const queryText = typeof query === 'string'
    ? query
    : query.queryString || query.terms?.join(' ') || '';

  if (!queryText.trim()) {
    return [];
  }

  const limit = Math.min(Math.max(options.limit || 10, 1), 50);
  const timeRange = options.timeRange || 'd';

  // Map timeRange to Google tbs parameter
  let tbs;
  if (timeRange === 'd') tbs = 'qdr:d';
  else if (timeRange === 'w') tbs = 'qdr:w';
  else if (timeRange === 'm') tbs = 'qdr:m';

  const payload = {
    q: queryText,
    num: limit,
    ...(tbs ? { tbs } : {}),
  };

  const fetchFn = options.fetchFn || globalThis.fetch;
  const response = await fetchFn(SERPER_API_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Serper API HTTP ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const organic = Array.isArray(data.organic) ? data.organic : [];

  return organic.map((item) => ({
    url: item.link || '',
    title: item.title || null,
    snippet: item.snippet || null,
    publishedAt: item.date || null,
    source: 'serper',
  }));
}
