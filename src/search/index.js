/**
 * Search module entry point for DesignRadar.
 */

export { searchWeb, searchWebBatch } from './search-web.js';
export {
  ROLE_TERMS,
  BROAD_ROLE_TERM,
  HIRING_SIGNALS,
  DOMAIN_TERMS,
  TARGET_DOMAIN,
  TARGET_DOMAINS,
  ALL_TARGET_DOMAINS,
  SOURCE_NAMES,
  buildBasicQuery,
  buildDomainQuery,
  buildRemoteQuery,
  generateSearchQueries,
  generateMultiSourceSearchQueries,
  generateSearchQueriesForSource,
  createQueryDescriptor,
} from './queries.js';
export { getSearchProvider } from './providers/index.js';
export {
  passesKeywordFilter,
  filterCandidates,
  PRODUCT_DESIGN_TERMS,
  HIRING_TERMS,
  SENIORITY_BYPASS_TITLES,
} from './filter.js';
