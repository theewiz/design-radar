/**
 * Search Query Strategy and Generator for DesignRadar.
 *
 * Generates provider-agnostic search query descriptors combining:
 * 1. Role Terms (Senior+ and unlevelled Product Design titles)
 * 2. Hiring Signals (Recruiting intent indicators)
 * 3. Domain Terms (Fintech, AI, Payments, Web3, SaaS, etc.)
 * 4. Location / Remote preferences
 *
 * Supports multiple job sources:
 * - LinkedIn: site:linkedin.com/posts/
 * - Greenhouse: site:boards.greenhouse.io, site:job-boards.greenhouse.io
 * - Ashby: site:jobs.ashbyhq.com
 * - Lever: site:jobs.lever.co
 */

// ─── Role Terms ────────────────────────────────────────────────────────────────

/**
 * The unlevelled role title, queried on every run alongside the Senior+ terms.
 *
 * Many companies that hire for DesignRadar's target profile publish the vacancy
 * under a flat title: at a fintech, crypto, or AI tooling company "Product
 * Designer" is routinely a senior individual-contributor seat, and the exact
 * phrase `"Senior Product Designer"` cannot retrieve those posts at all. This
 * term buys recall for that lane.
 *
 * It is a search term only — never a scoring change. Seniority is decided by
 * Phase 5 from the post text, so a genuinely mid-level "Product Designer" post
 * is classified as Mid or Unknown, scores 0 seniority points, and lands in the
 * standard priority band rather than being inflated.
 */
export const BROAD_ROLE_TERM = 'Product Designer';

export const ROLE_TERMS = Object.freeze([
  'Senior Product Designer',
  'Lead Product Designer',
  'Staff Product Designer',
  'Principal Product Designer',
  'Senior UX Designer',
  'Product Design Lead',
  'Design Lead',
  'Founding Product Designer',
  'Founding Designer',
  'Head of Product Design',
  BROAD_ROLE_TERM,
]);

export const HIRING_SIGNALS = Object.freeze([
  'hiring',
  "we're hiring",
  'we are hiring',
  'looking for',
  'open role',
  'open position',
  'join our team',
  'my team is hiring',
  'recruiting',
]);

export const DOMAIN_TERMS = Object.freeze([
  'fintech',
  'AI',
  'payments',
  'financial infrastructure',
  'compliance',
  'RegTech',
  'Web3',
  'blockchain',
  'SaaS',
]);

// ─── Target Domains (Sources) ──────────────────────────────────────────────────

/**
 * Target domains for each job source.
 * Each domain is used with the `site:` operator in search queries.
 */
export const TARGET_DOMAINS = Object.freeze({
  LINKEDIN: 'linkedin.com/posts/',
  GREENHOUSE_BOARDS: 'boards.greenhouse.io',
  GREENHOUSE_JOB_BOARDS: 'job-boards.greenhouse.io',
  ASHBY: 'jobs.ashbyhq.com',
  LEVER: 'jobs.lever.co',
});

/**
 * Human-readable source names for logging and tracking.
 */
export const SOURCE_NAMES = Object.freeze({
  [TARGET_DOMAINS.LINKEDIN]: 'linkedin',
  [TARGET_DOMAINS.GREENHOUSE_BOARDS]: 'greenhouse',
  [TARGET_DOMAINS.GREENHOUSE_JOB_BOARDS]: 'greenhouse',
  [TARGET_DOMAINS.ASHBY]: 'ashby',
  [TARGET_DOMAINS.LEVER]: 'lever',
});

/**
 * All target domains as an array for iteration.
 */
export const ALL_TARGET_DOMAINS = Object.freeze([
  TARGET_DOMAINS.LINKEDIN,
  TARGET_DOMAINS.GREENHOUSE_BOARDS,
  TARGET_DOMAINS.GREENHOUSE_JOB_BOARDS,
  TARGET_DOMAINS.ASHBY,
  TARGET_DOMAINS.LEVER,
]);

/**
 * Default target domain (LinkedIn) for backward compatibility.
 */
export const TARGET_DOMAIN = TARGET_DOMAINS.LINKEDIN;

// ─── Query Building ────────────────────────────────────────────────────────────

/**
 * Builds a query object representation.
 *
 * @param {string[]} terms
 * @param {string} [targetDomain=TARGET_DOMAIN]
 * @returns {{ terms: string[], targetDomain: string, queryString: string, source: string }}
 */
export function createQueryDescriptor(terms, targetDomain = TARGET_DOMAIN) {
  const cleanTerms = terms
    .filter(Boolean)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Default string representation for Google/Serper-compatible syntax
  const formattedTerms = cleanTerms.map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ');
  const queryString = targetDomain ? `site:${targetDomain} ${formattedTerms}` : formattedTerms;

  return {
    terms: cleanTerms,
    targetDomain,
    queryString,
    source: SOURCE_NAMES[targetDomain] || 'unknown',
  };
}

/**
 * Builds a basic role + hiring signal query for a specific target domain.
 *
 * Example:
 *   site:linkedin.com/posts/ "Senior Product Designer" "hiring"
 *   site:boards.greenhouse.io "Senior Product Designer" "hiring"
 *
 * @param {string} [role='Senior Product Designer']
 * @param {string} [hiringSignal='hiring']
 * @param {string} [targetDomain=TARGET_DOMAIN]
 * @returns {{ terms: string[], targetDomain: string, queryString: string, source: string }}
 */
export function buildBasicQuery(role = 'Senior Product Designer', hiringSignal = 'hiring', targetDomain = TARGET_DOMAIN) {
  return createQueryDescriptor([role, hiringSignal], targetDomain);
}

/**
 * Builds a domain-specific role + domain + hiring signal query for a target domain.
 *
 * Example:
 *   site:linkedin.com/posts/ "Senior Product Designer" fintech "hiring"
 *   site:jobs.ashbyhq.com "Senior Product Designer" fintech "hiring"
 *
 * @param {string} role
 * @param {string} domain
 * @param {string} [hiringSignal='hiring']
 * @param {string} [targetDomain=TARGET_DOMAIN]
 * @returns {{ terms: string[], targetDomain: string, queryString: string, source: string }}
 */
export function buildDomainQuery(role = 'Senior Product Designer', domain = 'fintech', hiringSignal = 'hiring', targetDomain = TARGET_DOMAIN) {
  return createQueryDescriptor([role, domain, hiringSignal], targetDomain);
}

/**
 * Builds a remote-specific role + remote + hiring signal query for a target domain.
 *
 * Example:
 *   site:linkedin.com/posts/ "Senior Product Designer" remote "hiring"
 *   site:jobs.lever.co "Senior Product Designer" remote "hiring"
 *
 * @param {string} role
 * @param {string} [hiringSignal='hiring']
 * @param {string} [targetDomain=TARGET_DOMAIN]
 * @returns {{ terms: string[], targetDomain: string, queryString: string, source: string }}
 */
export function buildRemoteQuery(role = 'Senior Product Designer', hiringSignal = 'hiring', targetDomain = TARGET_DOMAIN) {
  return createQueryDescriptor([role, 'remote', hiringSignal], targetDomain);
}

/**
 * Generates a budgeted, balanced batch of search queries for a single target domain.
 * This is the ORIGINAL LinkedIn-only generator, kept for backward compatibility.
 *
 * @param {Object} [options]
 * @param {number} [options.budget=6] Total number of queries to generate.
 * @param {number} [options.rotationIndex=0] Offset index to cycle through domains across runs.
 * @param {string[]} [options.domains] Custom domains list.
 * @param {string[]} [options.roles] Custom roles list.
 * @param {string | null} [options.broadRole=BROAD_ROLE_TERM] Unlevelled role title for the broad-title query.
 * @param {string} [options.targetDomain=TARGET_DOMAIN] Target domain to generate queries for.
 * @returns {Array<{ terms: string[], targetDomain: string, queryString: string, source: string }>}
 */
function generateSearchQueriesForDomain(options = {}) {
  const {
    budget = 6,
    rotationIndex = 0,
    domains = DOMAIN_TERMS,
    roles = ROLE_TERMS,
    broadRole = BROAD_ROLE_TERM,
    targetDomain = TARGET_DOMAIN,
  } = options;

  const queries = [];

  // 1. Core Seniority Queries (2 queries)
  const primaryRole = roles[0] || 'Senior Product Designer';
  const secondaryRole = roles[1] || 'Lead Product Designer';
  queries.push(buildBasicQuery(primaryRole, 'hiring', targetDomain));
  queries.push(buildBasicQuery(secondaryRole, "we're hiring", targetDomain));

  // 2. Remote-focused query (1 query)
  queries.push(buildRemoteQuery(primaryRole, 'hiring', targetDomain));

  // 3. Broad unlevelled title (1 query). Skipped when a core query already
  // carries it, so a custom role list cannot spend a query slot on a duplicate.
  const coreRoles = [primaryRole, secondaryRole];
  if (broadRole && !coreRoles.includes(broadRole)) {
    queries.push(buildBasicQuery(broadRole, 'hiring', targetDomain));
  }

  // 4. Domain-specific queries (remaining budget, rotating through domains)
  const remainingBudget = Math.max(1, budget - queries.length);
  for (let i = 0; i < remainingBudget; i++) {
    const domainIdx = (rotationIndex + i) % domains.length;
    const domain = domains[domainIdx];
    const roleForDomain = roles[i % Math.min(roles.length, 3)];
    queries.push(buildDomainQuery(roleForDomain, domain, 'hiring', targetDomain));
  }

  return queries.slice(0, budget);
}

/**
 * Generates a budgeted, balanced batch of search queries for LinkedIn ONLY.
 * This is the original function preserved for backward compatibility.
 * Existing tests and any code expecting LinkedIn-only queries should use this.
 *
 * @param {Object} [options]
 * @param {number} [options.budget=6] Total number of queries to generate (recommended: 5–8).
 * @param {number} [options.rotationIndex=0] Offset index to cycle through domains across runs.
 * @param {string[]} [options.domains] Custom domains list.
 * @param {string[]} [options.roles] Custom roles list.
 * @param {string | null} [options.broadRole=BROAD_ROLE_TERM] Unlevelled role title for the broad-title query.
 * @returns {Array<{ terms: string[], targetDomain: string, queryString: string, source: string }>}
 */
export function generateSearchQueries(options = {}) {
  const {
    budget = 6,
    rotationIndex = 0,
    domains = DOMAIN_TERMS,
    roles = ROLE_TERMS,
    broadRole = BROAD_ROLE_TERM,
  } = options;

  return generateSearchQueriesForDomain({
    budget,
    rotationIndex,
    domains,
    roles,
    broadRole,
    targetDomain: TARGET_DOMAINS.LINKEDIN,
  });
}

/**
 * Generates a budgeted, balanced batch of search queries across ALL job sources.
 * Distributes the query budget across sources to avoid combinatorial explosion.
 *
 * Strategy:
 * - LinkedIn gets the largest share (primary source, established)
 * - Greenhouse, Ashby, Lever share the remaining budget
 * - Each source gets at least 1 query if budget allows
 * - For small budgets (<=4), LinkedIn gets budget-1 and one other source gets 1
 *
 * @param {Object} [options]
 * @param {number} [options.budget=8] Total number of queries across ALL sources (recommended: 6–10).
 * @param {number} [options.rotationIndex=0] Offset index to cycle through domains across runs.
 * @param {string[]} [options.domains] Custom domains list.
 * @param {string[]} [options.roles] Custom roles list.
 * @param {string | null} [options.broadRole=BROAD_ROLE_TERM] Unlevelled role title.
 * @param {string[]} [options.sources] Sources to include. Defaults to all.
 * @returns {Array<{ terms: string[], targetDomain: string, queryString: string, source: string }>}
 */
export function generateMultiSourceSearchQueries(options = {}) {
  const {
    budget = 8,
    rotationIndex = 0,
    domains = DOMAIN_TERMS,
    roles = ROLE_TERMS,
    broadRole = BROAD_ROLE_TERM,
    sources = ALL_TARGET_DOMAINS,
  } = options;

  const otherSources = sources.filter((d) => d !== TARGET_DOMAINS.LINKEDIN);
  const hasLinkedIn = sources.includes(TARGET_DOMAINS.LINKEDIN);

  let linkedInBudget;
  let otherBudget;
  let perOtherSource;

  if (budget <= 4 && otherSources.length > 0) {
    // Small budget: reserve 1 query for non-LinkedIn sources, rest to LinkedIn
    linkedInBudget = hasLinkedIn ? budget - 1 : 0;
    otherBudget = hasLinkedIn ? 1 : budget;
    perOtherSource = otherSources.length > 0 ? 1 : 0;
  } else {
    // Larger budget: LinkedIn gets ~50%, others share the rest
    linkedInBudget = hasLinkedIn ? Math.max(3, Math.floor(budget * 0.5)) : 0;
    otherBudget = budget - linkedInBudget;
    perOtherSource = otherSources.length > 0
      ? Math.max(1, Math.floor(otherBudget / otherSources.length))
      : 0;
  }

  const queries = [];

  // LinkedIn queries (primary source)
  if (hasLinkedIn && linkedInBudget > 0) {
    queries.push(...generateSearchQueriesForDomain({
      budget: linkedInBudget,
      rotationIndex,
      domains,
      roles,
      broadRole,
      targetDomain: TARGET_DOMAINS.LINKEDIN,
    }));
  }

  // Other sources: distribute remaining budget with rotation across sources
  if (otherSources.length > 0 && otherBudget > 0) {
    const basePerSource = Math.floor(otherBudget / otherSources.length);
    const remainder = otherBudget % otherSources.length;

    for (let i = 0; i < otherSources.length; i++) {
      const sourceIdx = (rotationIndex + i) % otherSources.length;
      const targetDomain = otherSources[sourceIdx];
      const sourceBudget = basePerSource + (i < remainder ? 1 : 0);

      if (sourceBudget > 0) {
        queries.push(...generateSearchQueriesForDomain({
          budget: sourceBudget,
          rotationIndex: rotationIndex + i,
          domains,
          roles,
          broadRole,
          targetDomain,
        }));
      }
    }
  }

  // If we have leftover budget (due to rounding), add to LinkedIn
  const totalAllocated = queries.length;
  if (totalAllocated < budget && hasLinkedIn) {
    const extra = budget - totalAllocated;
    queries.push(...generateSearchQueriesForDomain({
      budget: extra,
      rotationIndex: rotationIndex + otherSources.length,
      domains,
      roles,
      broadRole,
      targetDomain: TARGET_DOMAINS.LINKEDIN,
    }));
  }

  return queries.slice(0, budget);
}

/**
 * Generates search queries for a specific source only.
 * Useful for testing or targeted runs.
 *
 * @param {string} targetDomain One of TARGET_DOMAINS values.
 * @param {Object} [options] Options passed to generateSearchQueriesForDomain.
 * @returns {Array<{ terms: string[], targetDomain: string, queryString: string, source: string }>}
 */
export function generateSearchQueriesForSource(targetDomain, options = {}) {
  if (!ALL_TARGET_DOMAINS.includes(targetDomain)) {
    throw new Error(`Unknown target domain: ${targetDomain}. Valid domains: ${ALL_TARGET_DOMAINS.join(', ')}`);
  }
  return generateSearchQueriesForDomain({ ...options, targetDomain });
}