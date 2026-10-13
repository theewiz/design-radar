import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_TERMS,
  BROAD_ROLE_TERM,
  HIRING_SIGNALS,
  DOMAIN_TERMS,
  buildBasicQuery,
  buildDomainQuery,
  buildRemoteQuery,
  generateSearchQueries,
  createQueryDescriptor,
} from '../src/search/queries.js';

describe('Search Query Generation', () => {
  it('includes all required Senior+ Product Design role terms', () => {
    const requiredRoles = [
      'Senior Product Designer',
      'Lead Product Designer',
      'Staff Product Designer',
      'Principal Product Designer',
      'Senior UX Designer',
      'Product Design Lead',
      'Design Lead',
      'Founding Product Designer',
      'Founding Designer',
    ];

    for (const role of requiredRoles) {
      assert.ok(ROLE_TERMS.includes(role), `Missing role term: ${role}`);
    }
  });

  it('includes the unlevelled "Product Designer" role term', () => {
    assert.equal(BROAD_ROLE_TERM, 'Product Designer');
    assert.ok(ROLE_TERMS.includes('Product Designer'));
  });

  it('includes all required hiring signals', () => {
    const requiredHiring = [
      'hiring',
      "we're hiring",
      'we are hiring',
      'looking for',
      'open role',
      'open position',
      'join our team',
      'my team is hiring',
      'recruiting',
    ];

    for (const signal of requiredHiring) {
      assert.ok(HIRING_SIGNALS.includes(signal), `Missing hiring signal: ${signal}`);
    }
  });

  it('includes all required domain terms', () => {
    const requiredDomains = [
      'fintech',
      'AI',
      'payments',
      'financial infrastructure',
      'compliance',
      'RegTech',
      'Web3',
      'blockchain',
      'SaaS',
    ];

    for (const domain of requiredDomains) {
      assert.ok(DOMAIN_TERMS.includes(domain), `Missing domain term: ${domain}`);
    }
  });

  it('builds a basic query descriptor with role, hiring signal, and target domain', () => {
    const query = buildBasicQuery('Senior Product Designer', 'hiring');
    assert.deepEqual(query.terms, ['Senior Product Designer', 'hiring']);
    assert.equal(query.targetDomain, 'linkedin.com/posts/');
    assert.equal(query.queryString, 'site:linkedin.com/posts/ "Senior Product Designer" hiring');
  });

  it('builds a domain-specific query descriptor', () => {
    const query = buildDomainQuery('Lead Product Designer', 'fintech', "we're hiring");
    assert.deepEqual(query.terms, ['Lead Product Designer', 'fintech', "we're hiring"]);
    assert.equal(query.queryString, 'site:linkedin.com/posts/ "Lead Product Designer" fintech "we\'re hiring"');
  });

  it('builds a remote-specific query descriptor', () => {
    const query = buildRemoteQuery('Founding Designer', 'open role');
    assert.deepEqual(query.terms, ['Founding Designer', 'remote', 'open role']);
    assert.equal(query.queryString, 'site:linkedin.com/posts/ "Founding Designer" remote "open role"');
  });

  it('generates a budgeted list of search queries', () => {
    const queries = generateSearchQueries({ budget: 6 });
    assert.equal(queries.length, 6);

    for (const q of queries) {
      assert.ok(Array.isArray(q.terms));
      assert.ok(q.queryString.startsWith('site:linkedin.com/posts/'));
    }
  });

  it('rotates domain queries when rotationIndex changes', () => {
    const run1 = generateSearchQueries({ budget: 5, rotationIndex: 0 });
    const run2 = generateSearchQueries({ budget: 5, rotationIndex: 3 });

    // The domain-specific queries should reflect different domain terms
    const domainsRun1 = run1.map((q) => q.terms.find((t) => DOMAIN_TERMS.includes(t))).filter(Boolean);
    const domainsRun2 = run2.map((q) => q.terms.find((t) => DOMAIN_TERMS.includes(t))).filter(Boolean);

    assert.notDeepEqual(domainsRun1, domainsRun2);
  });

  it('queries the unlevelled "Product Designer" title on every run', () => {
    for (const budget of [5, 6, 8]) {
      const queries = generateSearchQueries({ budget });
      const broad = queries.filter((q) => q.terms[0] === BROAD_ROLE_TERM);

      assert.equal(broad.length, 1, `expected exactly one broad-title query at budget ${budget}`);
      assert.equal(broad[0].queryString, 'site:linkedin.com/posts/ "Product Designer" hiring');
    }
  });

  it('drops the broad-title query when broadRole is null', () => {
    const queries = generateSearchQueries({ budget: 6, broadRole: null });
    assert.equal(queries.length, 6);
    assert.ok(!queries.some((q) => q.terms.includes(BROAD_ROLE_TERM)));
  });

  it('does not duplicate the broad title when a core role already carries it', () => {
    const queries = generateSearchQueries({
      budget: 6,
      roles: ['Product Designer', 'Lead Product Designer'],
      broadRole: BROAD_ROLE_TERM,
    });
    const queryStrings = queries.map((q) => q.queryString);

    assert.equal(new Set(queryStrings).size, queryStrings.length, 'query strings must be unique');
  });
});
