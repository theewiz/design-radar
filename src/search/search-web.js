/**
 * Unified Search Abstraction for DesignRadar.
 *
 * Exposes searchWeb(query, options) to the rest of the application.
 * Isolates provider details, filters for job posting URLs from supported sources,
 * normalizes URLs, and deduplicates results.
 */

import { getSearchProvider } from './providers/index.js';
import { getEnv } from '../utils/env.js';
import {
  isJobPostingUrl,
  normalizeJobUrl,
  identifyJobSource,
  JOB_SOURCES,
} from '../utils/normalize-url.js';
import { logger } from '../utils/logger.js';

/**
 * Searches the web for job postings using the configured search provider.
 *
 * Pipeline:
 * 1. Invokes active search provider.
 * 2. Filters for recognized job posting URLs (LinkedIn, Greenhouse, Ashby, Lever).
 * 3. Deterministically normalizes URLs using source-specific normalizers.
 * 4. Deduplicates URLs in memory.
 * 5. Returns normalized search result objects with source identification.
 *
 * @param {string | { queryString?: string, terms?: string[], targetDomain?: string }} query
 * @param {Object} [options]
 * @param {string} [options.provider] Override default provider ('serper', 'brave', 'mock').
 * @param {number} [options.limit=10] Max results per query.
 * @param {string} [options.timeRange='d'] Time filter ('d', 'w', 'm').
 * @param {Set<string>} [options.seenUrls] Optional set of already-seen URLs for cross-query dedup.
 * @returns {Promise<Array<{ url: string, title: string | null, snippet: string | null, publishedAt: string | null, source: string }>>}
 */
export async function searchWeb(query, options = {}) {
  // A provider may be injected as a function, which lets a caller (or a test)
  // supply a custom adapter without registering it in the provider registry.
  // Every other caller resolves the provider by name, so this is additive.
  const injectedProvider = typeof options.provider === 'function' ? options.provider : null;
  const providerName = injectedProvider
    ? injectedProvider.name || 'custom'
    : options.provider || getEnv().SEARCH_PROVIDER || 'serper';
  const queryLabel = typeof query === 'string'
    ? query
    : query.queryString || query.terms?.join(' ') || '';

  logger.info('Executing web search', {
    provider: providerName,
    query: queryLabel,
    targetDomain: typeof query === 'object' ? query.targetDomain : 'unknown',
  });

  const providerFn = injectedProvider || getSearchProvider(providerName);
  let rawResults = [];

  try {
    rawResults = await providerFn(query, options);
  } catch (err) {
    logger.error('Search provider query failed', {
      provider: providerName,
      query: queryLabel,
      error: err.message,
    });
    throw err;
  }

  const seenUrls = options.seenUrls || new Set();
  const normalizedResults = [];

  for (const raw of rawResults) {
    if (!raw.url) {
      continue;
    }

    // 1. Only accept recognized job posting URLs
    if (!isJobPostingUrl(raw.url)) {
      continue;
    }

    // 2. Normalize URL using source-specific normalizer
    const normalizedUrl = normalizeJobUrl(raw.url);
    if (!normalizedUrl) {
      continue;
    }

    // 3. Deduplicate
    if (seenUrls.has(normalizedUrl)) {
      continue;
    }
    seenUrls.add(normalizedUrl);

    // 4. Identify the source
    const source = identifyJobSource(raw.url) || (raw.source || providerName);

    // 5. Normalize to standardized internal structure
    normalizedResults.push({
      url: normalizedUrl,
      title: raw.title ? String(raw.title).trim() : null,
      snippet: raw.snippet ? String(raw.snippet).trim() : null,
      publishedAt: raw.publishedAt ? String(raw.publishedAt).trim() : null,
      source,
    });
  }

  logger.info('Web search completed', {
    provider: providerName,
    rawCount: rawResults.length,
    acceptedCount: normalizedResults.length,
    filteredOutCount: rawResults.length - normalizedResults.length,
  });

  return normalizedResults;
}

/**
 * Executes a batch of search queries sequentially or with bounded concurrency,
 * maintaining cross-query URL deduplication.
 *
 * Per-query failures are isolated here so a single bad query cannot abort the
 * batch. `options.onQuerySettled` lets a caller record which query failed without
 * reimplementing this loop: the observer fires once per query with its outcome,
 * and a throwing observer is ignored so reporting can never break a scan.
 *
 * @param {Array<string | object>} queries List of queries to execute.
 * @param {Object} [options] Options passed to searchWeb.
 * @param {(event: { query: string, ok: boolean, resultCount?: number, error?: string }) => void} [options.onQuerySettled]
 *   Optional per-query outcome observer.
 * @returns {Promise<Array<{ url: string, title: string | null, snippet: string | null, publishedAt: string | null, source: string }>>}
 */
export async function searchWebBatch(queries, options = {}) {
  const seenUrls = options.seenUrls || new Set();
  const aggregatedResults = [];
  let successCount = 0;
  let failCount = 0;
  const report = typeof options.onQuerySettled === 'function' ? options.onQuerySettled : null;

  /**
   * Reports one query outcome. Reporting is bookkeeping, so a fault in the
   * observer is logged and swallowed rather than allowed to abort a scan that has
   * already done the work.
   */
  const settle = (event) => {
    if (!report) return;

    try {
      report(event);
    } catch (err) {
      logger.error('Search query observer threw', {
        query: event.query,
        error: err.message,
      });
    }
  };

  logger.info('Starting search batch execution', {
    queryCount: queries.length,
    provider: options.provider || getEnv().SEARCH_PROVIDER || 'serper',
  });

  for (const q of queries) {
    const queryLabel = typeof q === 'string' ? q : q.queryString || q.terms?.join(' ') || '';

    try {
      const results = await searchWeb(q, { ...options, seenUrls });
      aggregatedResults.push(...results);
      successCount++;
      settle({ query: queryLabel, ok: true, resultCount: results.length });
    } catch (err) {
      failCount++;
      // A single failed query does not abort the entire batch
      logger.warn('Skipping failed query in batch', {
        query: queryLabel,
        error: err.message,
      });
      settle({ query: queryLabel, ok: false, error: err.message });
    }
  }

  logger.info('Search batch execution finished', {
    totalQueries: queries.length,
    successfulQueries: successCount,
    failedQueries: failCount,
    uniqueJobPosts: aggregatedResults.length,
  });

  return aggregatedResults;
}