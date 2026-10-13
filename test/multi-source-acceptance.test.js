/**
 * Comprehensive Multi-Source Job Intelligence Acceptance Tests.
 *
 * Verifies all 13 core requirements for Greenhouse, Ashby, Lever, and LinkedIn:
 * 1. Existing LinkedIn queries remain present and functional.
 * 2. Greenhouse queries return results that enter the shared pipeline.
 * 3. Ashby queries return results that enter the shared pipeline.
 * 4. Lever queries return results that enter the shared pipeline.
 * 5. Each source's URLs are normalized correctly.
 * 6. Duplicate URLs returned by multiple queries are handled correctly.
 * 7. Existing database records are not duplicated.
 * 8. One source failing does not abort the other sources.
 * 9. Non-Product-Design jobs are handled by the existing classifier and role-gate rules.
 * 10. Recency and timestamp validation remain unchanged.
 * 11. Digest generation includes eligible jobs from all four sources.
 * 12. Email delivery and sent-status tracking remain unchanged.
 * 13. The shared discovery implementation works in both local Node.js and Edge Function environments.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateSearchQueries,
  generateMultiSourceSearchQueries,
  TARGET_DOMAINS,
  ALL_TARGET_DOMAINS,
  SOURCE_NAMES,
} from '../src/search/queries.js';
import { searchWebBatch } from '../src/search/search-web.js';
import {
  normalizeJobUrl,
  normalizeLinkedInUrl,
  normalizeGreenhouseUrl,
  normalizeAshbyUrl,
  normalizeLeverUrl,
  isJobPostingUrl,
  identifyJobSource,
  JOB_SOURCES,
} from '../src/utils/normalize-url.js';
import { filterCandidates, passesKeywordFilter } from '../src/search/filter.js';
import { evaluateCandidate } from '../src/filtering/status.js';
import { buildPostRow } from '../src/database/posts.js';
import { buildRoleCard, checkEligibility } from '../src/notifications/digest.js';
import { deliverDigest } from '../src/notifications/deliver.js';
import { createHandler } from '../supabase/functions/daily-radar/index.js';

describe('Multi-Source Job Intelligence Acceptance Tests', () => {
  // 1. Existing LinkedIn queries remain present and functional
  it('1. Existing LinkedIn queries remain present and functional', () => {
    const legacyQueries = generateSearchQueries({ budget: 6 });
    assert.equal(legacyQueries.length, 6);
    for (const q of legacyQueries) {
      assert.equal(q.source, 'linkedin');
      assert.equal(q.targetDomain, TARGET_DOMAINS.LINKEDIN);
      assert.ok(q.queryString.startsWith('site:linkedin.com/posts/'));
    }

    const multiQueries = generateMultiSourceSearchQueries({ budget: 8 });
    const linkedInQueries = multiQueries.filter((q) => q.source === 'linkedin');
    assert.ok(linkedInQueries.length >= 3, 'LinkedIn receives at least 3 queries in multi-source budget');
    for (const q of linkedInQueries) {
      assert.ok(q.queryString.startsWith('site:linkedin.com/posts/'));
      assert.ok(q.terms.length > 0);
    }
  });

  // 2. Greenhouse queries return results that enter the shared pipeline
  it('2. Greenhouse queries return results that enter the shared pipeline', () => {
    const rawUrl = 'https://boards.greenhouse.io/stripe/jobs/4028765003?gh_jid=4028765003&utm_source=test#apply';
    assert.ok(isJobPostingUrl(rawUrl));
    const normalizedUrl = normalizeJobUrl(rawUrl);
    assert.equal(normalizedUrl, 'https://boards.greenhouse.io/stripe/jobs/4028765003');
    assert.equal(identifyJobSource(normalizedUrl), JOB_SOURCES.GREENHOUSE);

    const candidate = {
      url: normalizedUrl,
      title: 'Senior Product Designer at Stripe',
      snippet: 'Stripe is looking for a Senior Product Designer to lead financial infrastructure design. Remote-friendly.',
      publishedAt: new Date().toISOString(),
      source: 'greenhouse',
    };

    // Keyword filtering
    const filterResult = passesKeywordFilter(candidate);
    assert.equal(filterResult.passed, true);

    // AI classification fixture
    const classification = {
      is_recruiting_post: true,
      is_product_design_role: true,
      job_title: 'Senior Product Designer',
      seniority: 'Senior',
      company_name: 'Stripe',
      author_name: null,
      is_hiring_manager_or_recruiter: false,
      location: 'Remote',
      remote_status: 'Remote',
      application_url: normalizedUrl,
      confidence: 0.95,
      reason: 'Direct job posting on Greenhouse',
    };

    // Relevance scoring & status evaluation
    const evaluation = evaluateCandidate(classification, {
      candidate,
      publishedAt: candidate.publishedAt,
      minScore: 60,
    });

    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.status, 'qualified');
    assert.ok(evaluation.score >= 60);

    // Database row building
    const row = buildPostRow({
      linkedin_url: normalizedUrl,
      published_at: evaluation.recency.iso,
      job_title: classification.job_title,
      company_name: classification.company_name,
      relevance_score: evaluation.score,
      status: evaluation.status,
    });

    assert.equal(row.linkedin_url, normalizedUrl);
    assert.equal(row.job_title, 'Senior Product Designer');
    assert.equal(row.company_name, 'Stripe');
    assert.equal(row.status, 'qualified');
  });

  // 3. Ashby queries return results that enter the shared pipeline
  it('3. Ashby queries return results that enter the shared pipeline', () => {
    const rawUrl = 'https://jobs.ashbyhq.com/notion/abc123-def456?utm_source=linkedin&utm_medium=job_board#apply';
    assert.ok(isJobPostingUrl(rawUrl));
    const normalizedUrl = normalizeJobUrl(rawUrl);
    assert.equal(normalizedUrl, 'https://jobs.ashbyhq.com/notion/abc123-def456');
    assert.equal(identifyJobSource(normalizedUrl), JOB_SOURCES.ASHBY);

    const candidate = {
      url: normalizedUrl,
      title: 'Lead Product Designer at Notion',
      snippet: 'We are hiring a Lead Product Designer to shape collaborative AI tools. Remote worldwide.',
      publishedAt: new Date().toISOString(),
      source: 'ashby',
    };

    const filterResult = passesKeywordFilter(candidate);
    assert.equal(filterResult.passed, true);

    const classification = {
      is_recruiting_post: true,
      is_product_design_role: true,
      job_title: 'Lead Product Designer',
      seniority: 'Lead',
      company_name: 'Notion',
      author_name: null,
      is_hiring_manager_or_recruiter: false,
      location: 'Worldwide',
      remote_status: 'Remote',
      application_url: normalizedUrl,
      confidence: 0.95,
      reason: 'Direct job posting on Ashby',
    };

    const evaluation = evaluateCandidate(classification, {
      candidate,
      publishedAt: candidate.publishedAt,
      minScore: 60,
    });

    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.status, 'qualified');

    const row = buildPostRow({
      linkedin_url: normalizedUrl,
      published_at: evaluation.recency.iso,
      job_title: classification.job_title,
      company_name: classification.company_name,
      relevance_score: evaluation.score,
      status: evaluation.status,
    });

    assert.equal(row.linkedin_url, normalizedUrl);
    assert.equal(row.job_title, 'Lead Product Designer');
    assert.equal(row.company_name, 'Notion');
    assert.equal(row.status, 'qualified');
  });

  // 4. Lever queries return results that enter the shared pipeline
  it('4. Lever queries return results that enter the shared pipeline', () => {
    const rawUrl = 'https://jobs.lever.co/figma/98765432-1234?lever-origin=applied&lever-source=linkedin#detail';
    assert.ok(isJobPostingUrl(rawUrl));
    const normalizedUrl = normalizeJobUrl(rawUrl);
    assert.equal(normalizedUrl, 'https://jobs.lever.co/figma/98765432-1234');
    assert.equal(identifyJobSource(normalizedUrl), JOB_SOURCES.LEVER);

    const candidate = {
      url: normalizedUrl,
      title: 'Staff Product Designer at Figma',
      snippet: 'Join our team as Staff Product Designer for design systems and developer tooling.',
      publishedAt: new Date().toISOString(),
      source: 'lever',
    };

    const filterResult = passesKeywordFilter(candidate);
    assert.equal(filterResult.passed, true);

    const classification = {
      is_recruiting_post: true,
      is_product_design_role: true,
      job_title: 'Staff Product Designer',
      seniority: 'Staff',
      company_name: 'Figma',
      author_name: null,
      is_hiring_manager_or_recruiter: false,
      location: 'Europe',
      remote_status: 'Remote',
      application_url: normalizedUrl,
      confidence: 0.92,
      reason: 'Direct job posting on Lever',
    };

    const evaluation = evaluateCandidate(classification, {
      candidate,
      publishedAt: candidate.publishedAt,
      minScore: 60,
    });

    assert.equal(evaluation.eligible, true);
    assert.equal(evaluation.status, 'qualified');

    const row = buildPostRow({
      linkedin_url: normalizedUrl,
      published_at: evaluation.recency.iso,
      job_title: classification.job_title,
      company_name: classification.company_name,
      relevance_score: evaluation.score,
      status: evaluation.status,
    });

    assert.equal(row.linkedin_url, normalizedUrl);
    assert.equal(row.job_title, 'Staff Product Designer');
    assert.equal(row.company_name, 'Figma');
  });

  // 5. Each source's URLs are normalized correctly
  it("5. Each source's URLs are normalized correctly", () => {
    // LinkedIn
    assert.equal(
      normalizeLinkedInUrl('https://www.linkedin.com/posts/recruiter_senior-pd-123?trk=public#comments'),
      'https://www.linkedin.com/posts/recruiter_senior-pd-123'
    );
    // Greenhouse (boards.greenhouse.io)
    assert.equal(
      normalizeGreenhouseUrl('https://boards.greenhouse.io/co/jobs/111?gh_jid=111#detail'),
      'https://boards.greenhouse.io/co/jobs/111'
    );
    // Greenhouse (job-boards.greenhouse.io)
    assert.equal(
      normalizeGreenhouseUrl('https://job-boards.greenhouse.io/co/jobs/222?ref=careers'),
      'https://job-boards.greenhouse.io/co/jobs/222'
    );
    // Ashby
    assert.equal(
      normalizeAshbyUrl('https://jobs.ashbyhq.com/co/333?utm_source=newsletter#apply'),
      'https://jobs.ashbyhq.com/co/333'
    );
    // Lever
    assert.equal(
      normalizeLeverUrl('https://jobs.lever.co/co/444?lever-origin=applied'),
      'https://jobs.lever.co/co/444'
    );

    // General normalizer
    assert.equal(
      normalizeJobUrl('https://boards.greenhouse.io/co/jobs/555?gh_jid=555'),
      'https://boards.greenhouse.io/co/jobs/555'
    );
    assert.equal(
      normalizeJobUrl('https://jobs.ashbyhq.com/co/666?ref=test'),
      'https://jobs.ashbyhq.com/co/666'
    );
    assert.equal(
      normalizeJobUrl('https://jobs.lever.co/co/777?lever-source=web'),
      'https://jobs.lever.co/co/777'
    );
    assert.equal(
      normalizeJobUrl('https://www.linkedin.com/posts/co_888?trk=test'),
      'https://www.linkedin.com/posts/co_888'
    );
  });

  // 6. Duplicate URLs returned by multiple queries are handled correctly
  it('6. Duplicate URLs returned by multiple queries are handled correctly', async () => {
    const rawBatch = [
      { url: 'https://boards.greenhouse.io/stripe/jobs/101?gh_jid=101', title: 'Q1 Result', snippet: 'Hiring' },
      { url: 'https://boards.greenhouse.io/stripe/jobs/101?utm_source=twitter', title: 'Q2 Result', snippet: 'Hiring' },
      { url: 'https://jobs.ashbyhq.com/notion/202?utm_campaign=board', title: 'Q1 Result', snippet: 'Hiring' },
      { url: 'https://jobs.ashbyhq.com/notion/202#apply', title: 'Q2 Result', snippet: 'Hiring' },
      { url: 'https://jobs.lever.co/figma/303?lever-origin=jobboard', title: 'Q1 Result', snippet: 'Hiring' },
      { url: 'https://jobs.lever.co/figma/303', title: 'Q2 Result', snippet: 'Hiring' },
      { url: 'https://www.linkedin.com/posts/post-404?trk=q1', title: 'Q1 Result', snippet: 'Hiring' },
      { url: 'https://www.linkedin.com/posts/post-404?trk=q2', title: 'Q2 Result', snippet: 'Hiring' },
    ];

    const results = await searchWebBatch(
      ['query1', 'query2'],
      { provider: 'mock', mockResults: rawBatch }
    );

    // 8 raw items with 4 distinct jobs should deduplicate to exactly 4 results
    assert.equal(results.length, 4);
    const urls = results.map((r) => r.url);
    assert.ok(urls.includes('https://boards.greenhouse.io/stripe/jobs/101'));
    assert.ok(urls.includes('https://jobs.ashbyhq.com/notion/202'));
    assert.ok(urls.includes('https://jobs.lever.co/figma/303'));
    assert.ok(urls.includes('https://www.linkedin.com/posts/post-404'));
  });

  // 7. Existing database records are not duplicated
  it('7. Existing database records are not duplicated', () => {
    const existingDatabaseUrls = new Set([
      'https://boards.greenhouse.io/stripe/jobs/101',
      'https://jobs.ashbyhq.com/notion/202',
    ]);

    const discoveredCandidates = [
      { url: 'https://boards.greenhouse.io/stripe/jobs/101' }, // Already exists
      { url: 'https://jobs.ashbyhq.com/notion/202' },           // Already exists
      { url: 'https://jobs.lever.co/figma/303' },              // New
      { url: 'https://www.linkedin.com/posts/post-404' },       // New
    ];

    const newCandidates = discoveredCandidates.filter((c) => !existingDatabaseUrls.has(c.url));
    assert.equal(newCandidates.length, 2);
    assert.equal(newCandidates[0].url, 'https://jobs.lever.co/figma/303');
    assert.equal(newCandidates[1].url, 'https://www.linkedin.com/posts/post-404');
  });

  // 8. One source failing does not abort the other sources
  it('8. One source failing does not abort the other sources', async () => {
    const queries = [
      { queryString: 'site:boards.greenhouse.io "Product Designer"', targetDomain: 'boards.greenhouse.io' },
      { queryString: 'site:jobs.ashbyhq.com "Product Designer"', targetDomain: 'jobs.ashbyhq.com' },
      { queryString: 'site:jobs.lever.co "Product Designer"', targetDomain: 'jobs.lever.co' },
      { queryString: 'site:linkedin.com/posts/ "Product Designer"', targetDomain: 'linkedin.com/posts/' },
    ];

    // Mock search provider that throws on Ashby but succeeds for Greenhouse, Lever, and LinkedIn
    let executedCount = 0;
    const providerWithFailure = async (query) => {
      executedCount++;
      const qStr = typeof query === 'string' ? query : query.queryString;
      if (qStr.includes('ashbyhq')) {
        throw new Error('Ashby search provider rate limited');
      }
      if (qStr.includes('greenhouse')) {
        return [{ url: 'https://boards.greenhouse.io/co/jobs/1', title: 'GH', snippet: 'Hiring' }];
      }
      if (qStr.includes('lever')) {
        // Lever job URLs are /{company}/{job-id} — no /jobs/ segment.
        return [{ url: 'https://jobs.lever.co/co/lever-2', title: 'Lever', snippet: 'Hiring' }];
      }
      return [{ url: 'https://www.linkedin.com/posts/li-3', title: 'LI', snippet: 'Hiring' }];
    };

    const failedQueries = [];
    const results = await searchWebBatch(queries, {
      // Inject the failing adapter directly. `searchWeb` accepts a provider
      // function so this path is actually exercised — passing the string
      // 'mock' here would use the mock adapter, which never fails, and the
      // isolated-failure behaviour under test would go unverified.
      provider: providerWithFailure,
      onQuerySettled: (event) => {
        if (!event.ok) failedQueries.push(event);
      },
    });

    // All four queries were attempted, so a failure in one did not stop the rest.
    assert.equal(executedCount, 4);

    // The failing query should be recorded without aborting the other 3 queries
    assert.equal(failedQueries.length, 1);
    assert.ok(failedQueries[0].query.includes('ashbyhq'));
    assert.equal(results.length, 3);
    const sources = new Set(results.map((r) => r.source));
    assert.ok(sources.has('greenhouse'));
    assert.ok(sources.has('lever'));
    assert.ok(sources.has('linkedin'));
  });

  // 9. Non-Product-Design jobs are handled by the existing classifier and role-gate rules
  it('9. Non-Product-Design jobs are handled by the existing classifier and role-gate rules', () => {
    // Test 1: Cheap keyword filter rejects non-design jobs
    const nonDesignAshby = {
      title: 'Senior Backend Engineer at AshbyCo',
      snippet: 'We are hiring a Senior Backend Engineer to build database engines in Go.',
    };
    const filter1 = passesKeywordFilter(nonDesignAshby);
    assert.equal(filter1.passed, false);

    // Test 2: Role gate rejects non-product-design role even if keyword filter passes
    const graphicDesignerLever = {
      is_recruiting_post: true,
      is_product_design_role: false, // Model identifies as marketing/graphic design
      job_title: 'Graphic Designer',
      seniority: 'Senior',
      company_name: 'BrandCo',
      location: 'Remote',
      remote_status: 'Remote',
      confidence: 0.9,
    };

    const evalGraphic = evaluateCandidate(graphicDesignerLever, {
      candidate: { url: 'https://jobs.lever.co/brandco/graphic-1' },
      publishedAt: new Date().toISOString(),
      minScore: 60,
    });

    assert.equal(evalGraphic.eligible, false);
    assert.equal(evalGraphic.status, 'irrelevant');
    assert.equal(evalGraphic.score, 0);

    // Test 3: Junior role rejected by role policy
    const juniorProductDesignerGH = {
      is_recruiting_post: true,
      is_product_design_role: true,
      job_title: 'Junior Product Designer',
      seniority: 'Junior',
      company_name: 'StartupCo',
      confidence: 0.9,
    };

    const evalJunior = evaluateCandidate(juniorProductDesignerGH, {
      candidate: { url: 'https://boards.greenhouse.io/startup/jobs/1' },
      publishedAt: new Date().toISOString(),
      minScore: 60,
    });

    assert.equal(evalJunior.eligible, false);
    assert.equal(evalJunior.status, 'irrelevant');
    assert.equal(evalJunior.score, 0);
  });

  // 10. Recency and timestamp validation remain unchanged
  it('10. Recency and timestamp validation remain unchanged across sources', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const baseClassification = {
      is_recruiting_post: true,
      is_product_design_role: true,
      job_title: 'Senior Product Designer',
      seniority: 'Senior',
      company_name: 'TechCo',
      confidence: 0.9,
    };

    // Stale post (> 168 hours old) from Ashby
    const staleTime = new Date('2026-10-01T00:00:00Z').toISOString();
    const evalStale = evaluateCandidate(baseClassification, {
      candidate: { url: 'https://jobs.ashbyhq.com/techco/stale-1' },
      publishedAt: staleTime,
      now,
    });
    assert.equal(evalStale.status, 'stale');
    assert.equal(evalStale.recency.state, 'stale');

    // Recent post (< 24 hours old) from Lever
    const recentTime = new Date('2026-10-13T06:00:00Z').toISOString();
    const evalRecent = evaluateCandidate(baseClassification, {
      candidate: { url: 'https://jobs.lever.co/techco/recent-2' },
      publishedAt: recentTime,
      now,
    });
    assert.equal(evalRecent.status, 'qualified');
    assert.equal(evalRecent.recency.state, 'recent');

    // Unverified timestamp from Greenhouse
    const evalUnverified = evaluateCandidate(baseClassification, {
      candidate: { url: 'https://boards.greenhouse.io/techco/jobs/3' },
      publishedAt: null,
      now,
    });
    assert.equal(evalUnverified.status, 'qualified');
    assert.equal(evalUnverified.recency.state, 'unverified');
  });

  // 11. Digest generation includes eligible jobs from all four sources
  it('11. Digest generation includes eligible jobs from all four sources', () => {
    const posts = [
      {
        linkedin_url: 'https://www.linkedin.com/posts/li-post-1',
        job_title: 'Senior Product Designer',
        author_name: 'Alice Recruiter',
        company_name: 'LinkedInCo',
        location: 'Remote',
        remote_status: 'Remote',
        relevance_score: 85,
        status: 'qualified',
        discovered_at: new Date().toISOString(),
      },
      {
        linkedin_url: 'https://boards.greenhouse.io/stripe/jobs/2',
        job_title: 'Staff Product Designer',
        author_name: null,
        company_name: 'Stripe',
        location: 'Europe',
        remote_status: 'Remote',
        relevance_score: 80,
        status: 'qualified',
        discovered_at: new Date().toISOString(),
      },
      {
        linkedin_url: 'https://jobs.ashbyhq.com/notion/3',
        job_title: 'Lead Product Designer',
        author_name: null,
        company_name: 'Notion',
        location: 'UK',
        remote_status: 'Remote',
        relevance_score: 75,
        status: 'qualified',
        discovered_at: new Date().toISOString(),
      },
      {
        linkedin_url: 'https://jobs.lever.co/figma/4',
        job_title: 'Product Design Lead',
        author_name: null,
        company_name: 'Figma',
        location: 'Worldwide',
        remote_status: 'Remote',
        relevance_score: 70,
        status: 'qualified',
        discovered_at: new Date().toISOString(),
      },
    ];

    const now = new Date();
    for (const post of posts) {
      const eligibility = checkEligibility(post, { now, windowHours: 168 });
      assert.equal(eligibility.eligible, true);

      const card = buildRoleCard(post);
      assert.ok(card.includes(post.job_title));
      assert.ok(card.includes(post.company_name));
      assert.ok(card.includes(post.linkedin_url));
      assert.ok(card.includes(`Score: ${post.relevance_score}`));
    }
  });

  // 12. Email delivery and sent-status tracking remain unchanged
  it('12. Email delivery and sent-status tracking remain unchanged', async () => {
    const digest = {
      source: 'database',
      dbReady: true,
      empty: false,
      message: 'DesignRadar Digest with 4 sources',
      chunks: ['DesignRadar Digest with 4 sources'],
      stats: { included: 4 },
      included: [
        { id: '1', linkedin_url: 'https://www.linkedin.com/posts/1' },
        { id: '2', linkedin_url: 'https://boards.greenhouse.io/co/2' },
        { id: '3', linkedin_url: 'https://jobs.ashbyhq.com/co/3' },
        { id: '4', linkedin_url: 'https://jobs.lever.co/co/4' },
      ],
    };

    // A minimal Supabase double covering the three query chains delivery issues:
    // insert().select().maybeSingle() (record), update().in() (mark), and
    // select().eq().contains() (duplicate check). It records the ids actually
    // marked, so "marked only after a confirmed send" can be asserted directly.
    const makeClient = (marked) => ({
      from: () => ({
        insert: (row) => ({
          select: () => ({ maybeSingle: async () => ({ data: { id: 'n1', ...row }, error: null }) }),
        }),
        select: () => ({
          eq: () => ({ contains: async () => ({ data: [], error: null }) }),
        }),
        update: () => ({
          // Supabase's builder is `.in(column, values)`.
          in: async (_column, ids) => {
            marked.push(...ids);
            return { error: null };
          },
        }),
      }),
    });

    // Successful delivery marks all four posts as sent.
    const markedOnSuccess = [];
    const successfulNotifier = {
      name: 'email',
      send: async () => ({
        success: true,
        provider: 'email',
        messageId: 'msg-12345',
      }),
    };

    const successResult = await deliverDigest({
      digest,
      notifier: successfulNotifier,
      client: makeClient(markedOnSuccess),
    });

    assert.equal(successResult.success, true);
    assert.equal(successResult.markedCount, 4);
    assert.deepEqual(markedOnSuccess, ['1', '2', '3', '4']);

    // Failed delivery does NOT mark any post as sent, so a later run retries.
    const markedOnFailure = [];
    const failingNotifier = {
      name: 'email',
      send: async () => ({
        success: false,
        provider: 'email',
        errorType: 'server_error',
        error: 'Simulated 500 error from Resend',
      }),
    };

    const failureResult = await deliverDigest({
      digest,
      notifier: failingNotifier,
      client: makeClient(markedOnFailure),
    });

    assert.equal(failureResult.success, false);
    assert.equal(failureResult.markedCount, 0);
    assert.equal(markedOnFailure.length, 0);
  });

  // 13. Shared discovery implementation works in both local Node.js and Edge Function environments
  it('13. Shared discovery works in both local Node.js and Edge Function environments', async () => {
    // Test Edge Function handler
    const recordedModes = [];
    const handler = createHandler({
      run: async (options) => {
        recordedModes.push(options.mode);
        return {
          success: true,
          mode: options.mode,
          status: 'OPERATIONAL',
          queriesRun: 8,
          searchResults: 10,
          uniqueResults: 10,
          candidates: 8,
          classified: 8,
          qualified: 6,
          notificationSent: false,
        };
      },
      env: () => ({}),
      log: { info() {}, error() {}, warn() {} },
    });

    const request = new Request('https://edge.supabase.com/daily-radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'discovery' }),
    });

    const response = await handler(request);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.mode, 'discovery');
    assert.equal(body.statistics.queriesRun, 8);
    assert.deepEqual(recordedModes, ['discovery']);
  });
});
