/**
 * Mock Search Provider Adapter.
 * Used for local development without paid credentials, unit tests, and CI.
 */

const DEFAULT_MOCK_RESULTS = [
  {
    url: 'https://www.linkedin.com/posts/acmepay_senior-product-designer-payments-7182930491?trk=public_profile',
    title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
    snippet: 'AcmePay is looking for a Senior Product Designer to lead design for our Global Payments Infrastructure team. Fully remote in Europe or UK. Join our team!',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  {
    url: 'https://www.linkedin.com/posts/jane-recruiter_lead-product-designer-fintech-8192837461?utm_source=share',
    title: 'Jane Recruiter on LinkedIn: Open Role - Lead Product Designer',
    snippet: 'My team is hiring a Lead Product Designer for a fast-growing Fintech and RegTech platform. Remote worldwide.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  {
    url: 'https://www.linkedin.com/posts/ai-corp_founding-product-designer-9182736452',
    title: 'AICorp on LinkedIn: Founding Product Designer (AI & Developer Tools)',
    snippet: 'We are hiring our Founding Product Designer to shape 0 to 1 developer tools and AI workflow systems. Remote-first.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  // Item with duplicate URL to test normalization and deduplication
  {
    url: 'https://www.linkedin.com/posts/acmepay_senior-product-designer-payments-7182930491?utm_medium=desktop#comments',
    title: 'AcmePay on LinkedIn: We are hiring a Senior Product Designer',
    snippet: 'AcmePay is looking for a Senior Product Designer to lead design for our Global Payments Infrastructure team.',
    publishedAt: new Date().toISOString(),
    source: 'mock',
  },
  // Non-post LinkedIn URL that should be filtered out
  {
    url: 'https://www.linkedin.com/in/some-candidate-profile',
    title: 'Some Profile on LinkedIn',
    snippet: 'Senior Product Designer portfolio and experience.',
    publishedAt: null,
    source: 'mock',
  },
  // External non-LinkedIn URL that should be filtered out
  {
    url: 'https://example.com/careers/senior-product-designer',
    title: 'Careers at Example',
    snippet: 'Job posting for designer.',
    publishedAt: null,
    source: 'mock',
  },
];

/**
 * Executes a mock search query.
 *
 * @param {string | { queryString?: string, terms?: string[] }} query
 * @param {Object} [options]
 * @param {Array} [options.mockResults] Custom mock results to return.
 * @returns {Promise<Array<{ url: string, title: string | null, snippet: string | null, publishedAt: string | null, source: string }>>}
 */
export async function searchMock(query, options = {}) {
  if (Array.isArray(options.mockResults)) {
    return options.mockResults.map((r) => ({
      url: r.url || '',
      title: r.title ?? null,
      snippet: r.snippet ?? null,
      publishedAt: r.publishedAt ?? null,
      source: r.source || 'mock',
    }));
  }

  const queryText = (typeof query === 'string' ? query : query.queryString || query.terms?.join(' ') || '').toLowerCase();

  // If query contains specific domain/role, filter mock results accordingly, or return default set
  if (queryText.includes('payments') || queryText.includes('fintech')) {
    return DEFAULT_MOCK_RESULTS.filter((r) => !r.snippet || r.snippet.toLowerCase().includes('payments') || r.snippet.toLowerCase().includes('fintech'));
  }

  return [...DEFAULT_MOCK_RESULTS];
}
