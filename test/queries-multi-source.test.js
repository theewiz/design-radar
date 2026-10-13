import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSearchQueries,
  generateMultiSourceSearchQueries,
  generateSearchQueriesForSource,
  TARGET_DOMAINS,
  ALL_TARGET_DOMAINS,
  SOURCE_NAMES,
  buildBasicQuery,
  buildDomainQuery,
  buildRemoteQuery,
  BROAD_ROLE_TERM,
  ROLE_TERMS,
  DOMAIN_TERMS,
} from '../src/search/queries.js';

describe('Multi-Source Search Query Generation', () => {
  describe('Backward Compatibility: generateSearchQueries (LinkedIn only)', () => {
    it('generates only LinkedIn queries by default', () => {
      const queries = generateSearchQueries({ budget: 6 });
      assert.equal(queries.length, 6);
      for (const q of queries) {
        assert.equal(q.targetDomain, TARGET_DOMAINS.LINKEDIN);
        assert.equal(q.source, 'linkedin');
        assert.ok(q.queryString.startsWith('site:linkedin.com/posts/'));
      }
    });

    it('includes the unlevelled "Product Designer" query', () => {
      const queries = generateSearchQueries({ budget: 6 });
      const broad = queries.filter((q) => q.terms[0] === BROAD_ROLE_TERM);
      assert.equal(broad.length, 1);
      assert.equal(broad[0].queryString, 'site:linkedin.com/posts/ "Product Designer" hiring');
    });

    it('rotates domain queries when rotationIndex changes', () => {
      const run1 = generateSearchQueries({ budget: 6, rotationIndex: 0 });
      const run2 = generateSearchQueries({ budget: 6, rotationIndex: 3 });

      const domainsRun1 = run1.map((q) => q.terms.find((t) => DOMAIN_TERMS.includes(t))).filter(Boolean);
      const domainsRun2 = run2.map((q) => q.terms.find((t) => DOMAIN_TERMS.includes(t))).filter(Boolean);

      assert.notDeepEqual(domainsRun1, domainsRun2);
    });
  });

  describe('New: generateMultiSourceSearchQueries', () => {
    it('generates queries for all sources by default', () => {
      const queries = generateMultiSourceSearchQueries({ budget: 8 });
      assert.equal(queries.length, 8);

      const sources = new Set(queries.map((q) => q.source));
      assert.ok(sources.has('linkedin'));
      assert.ok(sources.has('greenhouse'));
      assert.ok(sources.has('ashby'));
      assert.ok(sources.has('lever'));
    });

    it('distributes budget with LinkedIn getting the largest share', () => {
      const queries = generateMultiSourceSearchQueries({ budget: 10 });
      const linkedInCount = queries.filter((q) => q.source === 'linkedin').length;
      const greenhouseCount = queries.filter((q) => q.source === 'greenhouse').length;
      const ashbyCount = queries.filter((q) => q.source === 'ashby').length;
      const leverCount = queries.filter((q) => q.source === 'lever').length;

      assert.ok(linkedInCount >= greenhouseCount);
      assert.ok(linkedInCount >= ashbyCount);
      assert.ok(linkedInCount >= leverCount);
      assert.ok(greenhouseCount >= 1);
      assert.ok(ashbyCount >= 1);
      assert.ok(leverCount >= 1);
    });

    it('handles small budgets by reserving 1 query for non-LinkedIn sources', () => {
      const queries = generateMultiSourceSearchQueries({ budget: 3 });
      assert.equal(queries.length, 3);

      const linkedInCount = queries.filter((q) => q.source === 'linkedin').length;
      const otherCount = queries.filter((q) => q.source !== 'linkedin').length;

      assert.equal(linkedInCount, 2);
      assert.equal(otherCount, 1);
    });

    it('generates valid query strings for each source', () => {
      const queries = generateMultiSourceSearchQueries({ budget: 8 });
      for (const q of queries) {
        assert.ok(q.queryString.startsWith('site:'));
        assert.ok(q.terms.length > 0);
        assert.ok(ALL_TARGET_DOMAINS.includes(q.targetDomain));
        assert.ok(['linkedin', 'greenhouse', 'ashby', 'lever'].includes(q.source));
      }
    });

    it('includes hiring signals in all queries', () => {
      const queries = generateMultiSourceSearchQueries({ budget: 8 });
      for (const q of queries) {
        const hasHiringSignal = q.terms.some((t) =>
          ['hiring', "we're hiring", 'we are hiring', 'looking for', 'open role', 'open position', 'join our team', 'my team is hiring', 'recruiting'].includes(t.toLowerCase())
        );
        assert.ok(hasHiringSignal, `Query missing hiring signal: ${q.queryString}`);
      }
    });

    it('includes role terms in all queries', () => {
      const queries = generateMultiSourceSearchQueries({ budget: 8 });
      for (const q of queries) {
        const hasRoleTerm = q.terms.some((t) => ROLE_TERMS.includes(t));
        assert.ok(hasRoleTerm, `Query missing role term: ${q.queryString}`);
      }
    });

    it('respects custom sources parameter', () => {
      const queries = generateMultiSourceSearchQueries({
        budget: 8,
        sources: [TARGET_DOMAINS.LINKEDIN, TARGET_DOMAINS.ASHBY],
      });

      const sources = new Set(queries.map((q) => q.source));
      assert.ok(sources.has('linkedin'));
      assert.ok(sources.has('ashby'));
      assert.ok(!sources.has('greenhouse'));
      assert.ok(!sources.has('lever'));
    });

    it('respects rotationIndex for domain rotation', () => {
      // Use budget=10 to ensure LinkedIn gets domain-specific queries (budget >= 5)
      const run1 = generateMultiSourceSearchQueries({ budget: 10, rotationIndex: 0 });
      const run2 = generateMultiSourceSearchQueries({ budget: 10, rotationIndex: 3 });

      // At least LinkedIn domain queries should rotate
      const linkedInDomainsRun1 = run1
        .filter((q) => q.source === 'linkedin')
        .map((q) => q.terms.find((t) => DOMAIN_TERMS.includes(t)))
        .filter(Boolean);
      const linkedInDomainsRun2 = run2
        .filter((q) => q.source === 'linkedin')
        .map((q) => q.terms.find((t) => DOMAIN_TERMS.includes(t)))
        .filter(Boolean);

      assert.notDeepEqual(linkedInDomainsRun1, linkedInDomainsRun2);
    });
  });

  describe('New: generateSearchQueriesForSource', () => {
    it('generates queries for Greenhouse only', () => {
      const queries = generateSearchQueriesForSource(TARGET_DOMAINS.GREENHOUSE_BOARDS, { budget: 4 });
      assert.equal(queries.length, 4);
      for (const q of queries) {
        assert.equal(q.targetDomain, TARGET_DOMAINS.GREENHOUSE_BOARDS);
        assert.equal(q.source, 'greenhouse');
        assert.ok(q.queryString.startsWith('site:boards.greenhouse.io'));
      }
    });

    it('generates queries for Ashby only', () => {
      const queries = generateSearchQueriesForSource(TARGET_DOMAINS.ASHBY, { budget: 4 });
      assert.equal(queries.length, 4);
      for (const q of queries) {
        assert.equal(q.targetDomain, TARGET_DOMAINS.ASHBY);
        assert.equal(q.source, 'ashby');
        assert.ok(q.queryString.startsWith('site:jobs.ashbyhq.com'));
      }
    });

    it('generates queries for Lever only', () => {
      const queries = generateSearchQueriesForSource(TARGET_DOMAINS.LEVER, { budget: 4 });
      assert.equal(queries.length, 4);
      for (const q of queries) {
        assert.equal(q.targetDomain, TARGET_DOMAINS.LEVER);
        assert.equal(q.source, 'lever');
        assert.ok(q.queryString.startsWith('site:jobs.lever.co'));
      }
    });

    it('throws for unknown target domain', () => {
      assert.throws(
        () => generateSearchQueriesForSource('unknown.domain.com', { budget: 4 }),
        /Unknown target domain/
      );
    });
  });

  describe('Query builders with targetDomain parameter', () => {
    it('buildBasicQuery works for Greenhouse', () => {
      const q = buildBasicQuery('Senior Product Designer', 'hiring', TARGET_DOMAINS.GREENHOUSE_BOARDS);
      assert.equal(q.queryString, 'site:boards.greenhouse.io "Senior Product Designer" hiring');
      assert.equal(q.source, 'greenhouse');
    });

    it('buildBasicQuery works for Ashby', () => {
      const q = buildBasicQuery('Lead Product Designer', "we're hiring", TARGET_DOMAINS.ASHBY);
      assert.equal(q.queryString, 'site:jobs.ashbyhq.com "Lead Product Designer" "we\'re hiring"');
      assert.equal(q.source, 'ashby');
    });

    it('buildBasicQuery works for Lever', () => {
      const q = buildBasicQuery('Staff Product Designer', 'open role', TARGET_DOMAINS.LEVER);
      assert.equal(q.queryString, 'site:jobs.lever.co "Staff Product Designer" "open role"');
      assert.equal(q.source, 'lever');
    });

    it('buildDomainQuery works for Greenhouse', () => {
      const q = buildDomainQuery('Senior Product Designer', 'fintech', 'hiring', TARGET_DOMAINS.GREENHOUSE_BOARDS);
      assert.equal(q.queryString, 'site:boards.greenhouse.io "Senior Product Designer" fintech hiring');
      assert.equal(q.source, 'greenhouse');
    });

    it('buildRemoteQuery works for Ashby', () => {
      const q = buildRemoteQuery('Founding Designer', 'hiring', TARGET_DOMAINS.ASHBY);
      assert.equal(q.queryString, 'site:jobs.ashbyhq.com "Founding Designer" remote hiring');
      assert.equal(q.source, 'ashby');
    });

    it('buildRemoteQuery works for Lever', () => {
      const q = buildRemoteQuery('Product Design Lead', 'recruiting', TARGET_DOMAINS.LEVER);
      assert.equal(q.queryString, 'site:jobs.lever.co "Product Design Lead" remote recruiting');
      assert.equal(q.source, 'lever');
    });
  });

  describe('Source constants', () => {
    it('exports all target domains', () => {
      assert.equal(TARGET_DOMAINS.LINKEDIN, 'linkedin.com/posts/');
      assert.equal(TARGET_DOMAINS.GREENHOUSE_BOARDS, 'boards.greenhouse.io');
      assert.equal(TARGET_DOMAINS.GREENHOUSE_JOB_BOARDS, 'job-boards.greenhouse.io');
      assert.equal(TARGET_DOMAINS.ASHBY, 'jobs.ashbyhq.com');
      assert.equal(TARGET_DOMAINS.LEVER, 'jobs.lever.co');
    });

    it('exports all target domains as array', () => {
      assert.deepEqual(ALL_TARGET_DOMAINS, [
        'linkedin.com/posts/',
        'boards.greenhouse.io',
        'job-boards.greenhouse.io',
        'jobs.ashbyhq.com',
        'jobs.lever.co',
      ]);
    });

    it('maps domains to source names', () => {
      assert.equal(SOURCE_NAMES[TARGET_DOMAINS.LINKEDIN], 'linkedin');
      assert.equal(SOURCE_NAMES[TARGET_DOMAINS.GREENHOUSE_BOARDS], 'greenhouse');
      assert.equal(SOURCE_NAMES[TARGET_DOMAINS.GREENHOUSE_JOB_BOARDS], 'greenhouse');
      assert.equal(SOURCE_NAMES[TARGET_DOMAINS.ASHBY], 'ashby');
      assert.equal(SOURCE_NAMES[TARGET_DOMAINS.LEVER], 'lever');
    });
  });
});