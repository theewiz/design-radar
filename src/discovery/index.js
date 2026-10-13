/**
 * Discovery Engine for DesignRadar (Phase 2).
 * Orchestrates query generation and web search to discover publicly available
 * job postings advertising Senior+ Product Design roles from multiple sources:
 * LinkedIn, Greenhouse, Ashby, and Lever.
 */

import { generateMultiSourceSearchQueries } from '../search/queries.js';
import { searchWebBatch } from '../search/search-web.js';
import { logger } from '../utils/logger.js';

/**
 * Runs the discovery phase:
 * 1. Generates budgeted search queries across all configured sources.
 * 2. Searches public web index via configured provider adapter.
 * 3. Normalizes and deduplicates job posting candidates.
 *
 * @param {Object} [options]
 * @param {number} [options.queryBudget=8] Number of queries to execute across all sources.
 * @param {number} [options.rotationIndex=0] Domain rotation index.
 * @param {string} [options.provider] Search provider override ('serper', 'brave', 'mock').
 * @param {number} [options.limitPerQuery=10] Max results per query.
 * @param {string} [options.timeRange='d'] Freshness window ('d', 'w', 'm').
 * @param {string[]} [options.sources] Sources to include. Defaults to all.
 * @returns {Promise<{ queries: Array<object>, candidates: Array<object>, failedQueries: Array<{ query: string, error: string }>, metrics: object }>}
 */
export async function runDiscovery(options = {}) {
  const startTime = Date.now();
  logger.info('Discovery phase started');

  const queries = generateMultiSourceSearchQueries({
    budget: options.queryBudget || 8,
    rotationIndex: options.rotationIndex || 0,
    sources: options.sources,
  });

  // Collected here rather than in the caller so the batch loop keeps ownership of
  // failure isolation: discovery reports which queries failed, it does not decide
  // what to do about them.
  const failedQueries = [];

  const candidates = await searchWebBatch(queries, {
    provider: options.provider,
    limit: options.limitPerQuery || 10,
    timeRange: options.timeRange || 'd',
    mockResults: options.mockResults,
    onQuerySettled: (event) => {
      if (event.ok) return;
      failedQueries.push({ query: event.query, error: event.error });
    },
  });

  const durationMs = Date.now() - startTime;
  const bySource = {};
  for (const c of candidates) {
    const s = c.source || 'unknown';
    bySource[s] = (bySource[s] || 0) + 1;
  }

  const metrics = {
    queryCount: queries.length,
    // Attempted queries minus failures. Reported explicitly so a partially failed
    // batch is visible in the run summary instead of being hidden by the total.
    successfulQueries: queries.length - failedQueries.length,
    failedQueryCount: failedQueries.length,
    candidateCount: candidates.length,
    bySource,
    durationMs,
  };

  logger.info('Discovery phase completed', metrics);

  return {
    queries,
    candidates,
    failedQueries,
    metrics,
  };
}