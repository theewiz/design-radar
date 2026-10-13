import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLinkedInPostUrl,
  normalizeLinkedInUrl,
  isGreenhouseJobUrl,
  normalizeGreenhouseUrl,
  isAshbyJobUrl,
  normalizeAshbyUrl,
  isLeverJobUrl,
  normalizeLeverUrl,
  isJobPostingUrl,
  normalizeJobUrl,
  identifyJobSource,
  JOB_SOURCES,
} from '../src/utils/normalize-url.js';

describe('Multi-Source URL Normalization', () => {
  describe('Greenhouse URLs', () => {
    it('identifies Greenhouse job URLs on boards.greenhouse.io', () => {
      assert.equal(isGreenhouseJobUrl('https://boards.greenhouse.io/exampleco/jobs/1234567'), true);
      assert.equal(isGreenhouseJobUrl('https://boards.greenhouse.io/exampleco/jobs/1234567?gh_jid=1234567'), true);
      assert.equal(isGreenhouseJobUrl('https://boards.greenhouse.io/exampleco/jobs/1234567#detail'), true);
    });

    it('identifies Greenhouse job URLs on job-boards.greenhouse.io', () => {
      assert.equal(isGreenhouseJobUrl('https://job-boards.greenhouse.io/exampleco/jobs/7654321'), true);
      assert.equal(isGreenhouseJobUrl('https://job-boards.greenhouse.io/exampleco/jobs/7654321?utm_source=linkedin'), true);
    });

    it('rejects non-job Greenhouse URLs', () => {
      assert.equal(isGreenhouseJobUrl('https://boards.greenhouse.io/exampleco'), false);
      assert.equal(isGreenhouseJobUrl('https://boards.greenhouse.io/'), false);
      assert.equal(isGreenhouseJobUrl('https://boards.greenhouse.io/exampleco/jobs'), false);
    });

    it('normalizes Greenhouse URLs by stripping query params and fragments', () => {
      const raw = 'https://boards.greenhouse.io/exampleco/jobs/1234567?gh_jid=1234567&utm_source=linkedin#detail';
      const expected = 'https://boards.greenhouse.io/exampleco/jobs/1234567';
      assert.equal(normalizeGreenhouseUrl(raw), expected);
    });

    it('preserves the company and job ID in the path', () => {
      const raw = 'https://boards.greenhouse.io/stripe/jobs/4028765003';
      const expected = 'https://boards.greenhouse.io/stripe/jobs/4028765003';
      assert.equal(normalizeGreenhouseUrl(raw), expected);
    });

    it('handles job-boards.greenhouse.io domain', () => {
      const raw = 'https://job-boards.greenhouse.io/airbnb/jobs/12345?ref=careers';
      const expected = 'https://job-boards.greenhouse.io/airbnb/jobs/12345';
      assert.equal(normalizeGreenhouseUrl(raw), expected);
    });

    it('returns null for invalid Greenhouse URLs', () => {
      assert.equal(normalizeGreenhouseUrl('https://boards.greenhouse.io/invalid'), null);
      assert.equal(normalizeGreenhouseUrl('https://example.com/jobs/123'), null);
      assert.equal(normalizeGreenhouseUrl(''), null);
    });
  });

  describe('Ashby URLs', () => {
    it('identifies Ashby job URLs', () => {
      assert.equal(isAshbyJobUrl('https://jobs.ashbyhq.com/exampleco/abc123-def456'), true);
      assert.equal(isAshbyJobUrl('https://jobs.ashbyhq.com/exampleco/abc123-def456?utm_source=linkedin'), true);
      assert.equal(isAshbyJobUrl('https://jobs.ashbyhq.com/stripe/eng-12345'), true);
    });

    it('rejects non-job Ashby URLs', () => {
      assert.equal(isAshbyJobUrl('https://jobs.ashbyhq.com/exampleco'), false);
      assert.equal(isAshbyJobUrl('https://jobs.ashbyhq.com/'), false);
    });

    it('normalizes Ashby URLs by stripping query params and fragments', () => {
      const raw = 'https://jobs.ashbyhq.com/exampleco/abc123-def456?utm_source=linkedin&utm_medium=email#apply';
      const expected = 'https://jobs.ashbyhq.com/exampleco/abc123-def456';
      assert.equal(normalizeAshbyUrl(raw), expected);
    });

    it('preserves the company and job ID in the path', () => {
      const raw = 'https://jobs.ashbyhq.com/notion/eng-backend-12345';
      const expected = 'https://jobs.ashbyhq.com/notion/eng-backend-12345';
      assert.equal(normalizeAshbyUrl(raw), expected);
    });

    it('returns null for invalid Ashby URLs', () => {
      assert.equal(normalizeAshbyUrl('https://jobs.ashbyhq.com/invalid'), null);
      assert.equal(normalizeAshbyUrl('https://ashbyhq.com/jobs/123'), null);
      assert.equal(normalizeAshbyUrl(''), null);
    });
  });

  describe('Lever URLs', () => {
    it('identifies Lever job URLs', () => {
      assert.equal(isLeverJobUrl('https://jobs.lever.co/exampleco/abc123-def456'), true);
      assert.equal(isLeverJobUrl('https://jobs.lever.co/exampleco/abc123-def456?lever-origin=applied'), true);
      assert.equal(isLeverJobUrl('https://jobs.lever.co/stripe/senior-product-designer-123'), true);
    });

    it('rejects non-job Lever URLs', () => {
      assert.equal(isLeverJobUrl('https://jobs.lever.co/exampleco'), false);
      assert.equal(isLeverJobUrl('https://jobs.lever.co/'), false);
    });

    it('normalizes Lever URLs by stripping query params and fragments', () => {
      const raw = 'https://jobs.lever.co/exampleco/abc123-def456?lever-origin=applied&lever-source=linkedin#apply';
      const expected = 'https://jobs.lever.co/exampleco/abc123-def456';
      assert.equal(normalizeLeverUrl(raw), expected);
    });

    it('preserves the company and job ID in the path', () => {
      const raw = 'https://jobs.lever.co/airbnb/senior-product-designer-789';
      const expected = 'https://jobs.lever.co/airbnb/senior-product-designer-789';
      assert.equal(normalizeLeverUrl(raw), expected);
    });

    it('returns null for invalid Lever URLs', () => {
      assert.equal(normalizeLeverUrl('https://jobs.lever.co/invalid'), null);
      assert.equal(normalizeLeverUrl('https://lever.co/jobs/123'), null);
      assert.equal(normalizeLeverUrl(''), null);
    });
  });

  describe('Unified Interface', () => {
    it('isJobPostingUrl returns true for all supported sources', () => {
      assert.equal(isJobPostingUrl('https://www.linkedin.com/posts/example-123'), true);
      assert.equal(isJobPostingUrl('https://boards.greenhouse.io/co/jobs/123'), true);
      assert.equal(isJobPostingUrl('https://jobs.ashbyhq.com/co/job-123'), true);
      assert.equal(isJobPostingUrl('https://jobs.lever.co/co/job-123'), true);
    });

    it('isJobPostingUrl returns false for unsupported URLs', () => {
      assert.equal(isJobPostingUrl('https://example.com/jobs/123'), false);
      assert.equal(isJobPostingUrl('https://www.linkedin.com/in/profile'), false);
      assert.equal(isJobPostingUrl(''), false);
    });

    it('identifyJobSource correctly identifies each source', () => {
      assert.equal(identifyJobSource('https://www.linkedin.com/posts/example-123'), JOB_SOURCES.LINKEDIN);
      assert.equal(identifyJobSource('https://boards.greenhouse.io/co/jobs/123'), JOB_SOURCES.GREENHOUSE);
      assert.equal(identifyJobSource('https://job-boards.greenhouse.io/co/jobs/123'), JOB_SOURCES.GREENHOUSE);
      assert.equal(identifyJobSource('https://jobs.ashbyhq.com/co/job-123'), JOB_SOURCES.ASHBY);
      assert.equal(identifyJobSource('https://jobs.lever.co/co/job-123'), JOB_SOURCES.LEVER);
      assert.equal(identifyJobSource('https://example.com/jobs/123'), null);
    });

    it('normalizeJobUrl routes to correct normalizer', () => {
      assert.equal(normalizeJobUrl('https://www.linkedin.com/posts/example-123?trk=feed'), 'https://www.linkedin.com/posts/example-123');
      assert.equal(normalizeJobUrl('https://boards.greenhouse.io/co/jobs/123?gh_jid=123'), 'https://boards.greenhouse.io/co/jobs/123');
      assert.equal(normalizeJobUrl('https://jobs.ashbyhq.com/co/job-123?utm_source=test'), 'https://jobs.ashbyhq.com/co/job-123');
      assert.equal(normalizeJobUrl('https://jobs.lever.co/co/job-123?lever-origin=applied'), 'https://jobs.lever.co/co/job-123');
      assert.equal(normalizeJobUrl('https://example.com/jobs/123'), null);
    });
  });
});