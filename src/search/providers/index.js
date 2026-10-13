/**
 * Search Provider Registry and Factory.
 * Isolates all provider-specific implementations from the core radar application.
 */

import { searchSerper } from './serper.js';
import { searchBrave } from './brave.js';
import { searchMock } from './mock.js';
import { getEnv } from '../../utils/env.js';

const PROVIDERS = {
  serper: searchSerper,
  brave: searchBrave,
  mock: searchMock,
};

/**
 * Retrieves the search provider execution function.
 *
 * @param {string} [name] Provider name ('serper', 'brave', 'mock'). Defaults to SEARCH_PROVIDER from the environment, or 'serper'.
 * @returns {(query: string | object, options?: object) => Promise<Array>}
 */
export function getSearchProvider(name) {
  const providerKey = (name || getEnv().SEARCH_PROVIDER || 'serper').toLowerCase().trim();
  const provider = PROVIDERS[providerKey];

  if (!provider) {
    const supported = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unsupported search provider "${providerKey}". Supported providers: ${supported}.`);
  }

  return provider;
}

export {
  searchSerper,
  searchBrave,
  searchMock,
};
