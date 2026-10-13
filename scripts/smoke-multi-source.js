/**
 * Isolated multi-source smoke test.
 *
 * Runs the REAL orchestrator (`runRadar`) in discovery mode end-to-end —
 * query generation → search → normalization → dedup → keyword filter →
 * classification → scoring/status → persistence — while every external
 * boundary is replaced with an in-process fake:
 *
 *   search provider  -> a function returning fixtures for all four sources
 *   AI classification -> a deterministic fake (validated by the real
 *                        `validateClassification`, so the shape is genuine)
 *   database          -> in-memory arrays
 *   notification      -> never reached (discovery mode never notifies)
 *
 * `globalThis.fetch` is replaced with a thrower for the duration of the run, so
 * if any stage attempted a live HTTP call the script would fail loudly. Nothing
 * here touches Serper, Gemini, Supabase, ntfy, Resend, or production data.
 *
 * Exit code is 0 when every check passes, 1 otherwise.
 *
 *   npm run smoke:multi-source
 */

import { runRadar } from '../src/radar/index.js';
import { runDiscovery } from '../src/discovery/index.js';
import { validateClassification } from '../src/ai/classify.js';
import { identifyJobSource } from '../src/utils/normalize-url.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now();
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

/**
 * A fixture set that exercises every supported source and several edge cases:
 * tracking-parameter duplicates, a stale post, a non-design hiring post, an
 * unlevelled ("Mid") product design title, and two non-job URLs that must never
 * reach the pipeline.
 */
const FIXTURES = [
  {
    url: 'https://www.linkedin.com/posts/acmepay_senior-product-designer-7182930491?trk=public_profile',
    title: 'AcmePay is hiring a Senior Product Designer',
    snippet: 'We are hiring a Senior Product Designer for our global payments infrastructure team. Fully remote in Europe or UK.',
    publishedAt: hoursAgo(3),
  },
  {
    url: 'https://boards.greenhouse.io/ledgerly/jobs/5512001?gh_jid=5512001&utm_source=linkedin',
    title: 'Senior Product Designer at Ledgerly',
    snippet: 'Ledgerly is looking for a Senior Product Designer to own our fintech compliance platform. Remote-first, global.',
    publishedAt: hoursAgo(10),
  },
  {
    url: 'https://job-boards.greenhouse.io/northwind/jobs/7783002',
    title: 'Principal Product Designer at Northwind',
    snippet: 'Northwind is hiring a Principal Product Designer for enterprise software and design systems. Remote.',
    publishedAt: hoursAgo(30),
  },
  {
    url: 'https://jobs.ashbyhq.com/quill/abc123-def456?utm_source=linkedin&utm_campaign=design',
    title: 'Founding Product Designer at Quill',
    snippet: 'Quill is hiring a Founding Product Designer to shape AI design tools for developers. Fully remote worldwide.',
    publishedAt: hoursAgo(5),
  },
  {
    url: 'https://jobs.lever.co/atlaspay/9f2c8a1e-0000?lever-source=LinkedIn&lever-origin=applied',
    title: 'Lead Product Designer at AtlasPay',
    snippet: 'AtlasPay is looking for a Lead Product Designer for cross-border payments and blockchain settlement. Remote EMEA.',
    publishedAt: hoursAgo(20),
  },
  {
    // Same LinkedIn post as above, different tracking params: must dedupe.
    url: 'https://www.linkedin.com/posts/acmepay_senior-product-designer-7182930491?utm_medium=desktop#comments',
    title: 'AcmePay is hiring a Senior Product Designer',
    snippet: 'We are hiring a Senior Product Designer for our global payments infrastructure team.',
    publishedAt: hoursAgo(3),
  },
  {
    // Older than the 168h window: persisted as stale, never delivered.
    url: 'https://jobs.lever.co/atlaspay/stale-0001',
    title: 'Senior Product Designer (closed)',
    snippet: 'AtlasPay was hiring a Senior Product Designer. Remote.',
    publishedAt: hoursAgo(24 * 30),
  },
  {
    // Hiring, but not a product design role: rejected by the keyword filter.
    url: 'https://jobs.ashbyhq.com/quill/eng-9000',
    title: 'Senior Software Engineer at Quill',
    snippet: 'Quill is hiring a Senior Software Engineer.',
    publishedAt: hoursAgo(2),
  },
  {
    // Unlevelled title: the profile role policy elevates Mid -> Senior.
    url: 'https://job-boards.greenhouse.io/pulse/jobs/9900112',
    title: 'Product Designer at Pulse',
    snippet: 'Pulse is hiring a Product Designer for a B2B SaaS analytics platform. Remote.',
    publishedAt: hoursAgo(8),
  },
  {
    // Not a job posting URL at all: dropped at the search layer.
    url: 'https://example.com/careers/senior-product-designer',
    title: 'Careers at Example',
    snippet: 'Senior Product Designer role.',
    publishedAt: hoursAgo(1),
  },
  {
    // LinkedIn profile, not a post: dropped at the search layer.
    url: 'https://www.linkedin.com/in/some-designer',
    title: 'Designer on LinkedIn',
    snippet: 'Senior Product Designer portfolio.',
    publishedAt: hoursAgo(1),
  },
];

// ─── Deterministic fake classifier ───────────────────────────────────────────

/**
 * Returns a raw classification for a normalized candidate URL. Values are
 * chosen so the real scoring/status logic produces a predictable outcome.
 */
function rawClassificationFor(url) {
  const base = {
    is_recruiting_post: true,
    is_product_design_role: true,
    job_title: 'Product Designer',
    seniority: 'Senior',
    company_name: null,
    author_name: null,
    is_hiring_manager_or_recruiter: false,
    location: 'Remote',
    remote_status: 'Remote',
    application_url: null,
    confidence: 0.92,
    reason: 'Smoke fixture: recruiting product design post.',
  };

  if (url.includes('ledgerly')) return { ...base, company_name: 'Ledgerly', location: 'Remote, global', is_hiring_manager_or_recruiter: true };
  if (url.includes('northwind')) return { ...base, company_name: 'Northwind', job_title: 'Principal Product Designer', seniority: 'Principal' };
  if (url.includes('abc123-def456')) return { ...base, company_name: 'Quill', job_title: 'Founding Product Designer', seniority: 'Founding', location: 'Worldwide' };
  if (url.includes('9f2c8a1e-0000')) return { ...base, company_name: 'AtlasPay', job_title: 'Lead Product Designer', seniority: 'Lead', location: 'Europe' };
  if (url.includes('stale-0001')) return { ...base, company_name: 'AtlasPay', job_title: 'Senior Product Designer' };
  if (url.includes('pulse')) return { ...base, company_name: 'Pulse', job_title: 'Product Designer', seniority: 'Mid' };
  if (url.includes('linkedin.com/posts')) return { ...base, company_name: 'AcmePay', job_title: 'Senior Product Designer', location: 'Remote, Europe, UK' };

  return base;
}

/**
 * Fake `classifyCandidates` with the same batch contract as the real one. Each
 * raw object is run through the real `validateClassification`, so the fixtures
 * must satisfy the same schema the model output does.
 */
async function fakeClassifyCandidates(candidates) {
  const results = candidates.map((candidate) => {
    const validation = validateClassification(rawClassificationFor(candidate.url));
    return {
      url: candidate.url,
      ok: validation.ok,
      classification: validation.classification,
      error: validation.ok ? null : 'validation_failed',
      attempts: 1,
    };
  });

  const failed = results.filter((r) => !r.ok).length;

  return {
    results,
    succeeded: results.length - failed,
    failed,
    totalUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    failureReasons: failed > 0 ? { validation_failed: failed } : {},
    infrastructureFailure: false,
  };
}

// ─── In-memory database ──────────────────────────────────────────────────────

const savedRows = [];
const searchRuns = [];

const fakeDatabase = {
  isDatabaseConfigured: () => true,
  createSearchRun: async (row) => {
    const created = { id: 'smoke-run-1', ...row };
    searchRuns.push({ kind: 'create', ...created });
    return created;
  },
  completeSearchRun: async (id, patch) => {
    searchRuns.push({ kind: 'complete', id, ...patch });
    return { id };
  },
  findExistingUrls: async () => new Set(),
  findUrlCaseDrift: async () => [],
  realignUrlCase: async () => 0,
  createPosts: async (rows) => {
    savedRows.push(...rows);
    return { created: rows.length, skipped: 0, errors: 0 };
  },
};

// ─── Checks ──────────────────────────────────────────────────────────────────

const checks = [];

function check(label, passed, detail = '') {
  checks.push({ label, passed: Boolean(passed), detail });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const results = { result: null, bySource: {}, savedUrls: [], staleUrls: [], error: null };
const originalFetch = globalThis.fetch;

try {
  // Prove isolation: any live HTTP call fails the run immediately.
  globalThis.fetch = async (url) => {
    throw new Error(`network access attempted during smoke test: ${url}`);
  };

  const result = await runRadar({
    mode: 'discovery', // never notifies
    env: {
      // Synthetic config only — no real credentials are read. The two key
      // values below are placeholders: `runRadar` only checks that they are
      // present, and every collaborator that would consume them is injected, so
      // they are never sent anywhere.
      SEARCH_PROVIDER: 'mock',
      SEARCH_API_KEY: 'smoke-placeholder-not-used',
      GEMINI_API_KEY: 'smoke-placeholder-not-used',
      QUERY_BUDGET: '12',
      MIN_RELEVANCE_SCORE: '60',
      NOTIFICATION_PROVIDER: 'mock',
      TIMEZONE: 'UTC',
    },
    deps: {
      ...fakeDatabase,
      // Real discovery/search/normalization, but the provider returns fixtures.
      runDiscovery: (options) => runDiscovery({ ...options, provider: async () => FIXTURES }),
      classifyCandidates: fakeClassifyCandidates,
    },
  });
  results.result = result;
} catch (err) {
  results.error = err;
} finally {
  globalThis.fetch = originalFetch;
}

// ─── Verify ──────────────────────────────────────────────────────────────────

if (results.error) {
  check('Pipeline ran without throwing', false, results.error.message);
} else {
  const { result } = results;

  const bySource = result.discovery.metrics.bySource;
  results.bySource = bySource;
  results.savedUrls = savedRows.map((r) => r.linkedin_url);
  results.staleUrls = savedRows.filter((r) => r.status === 'stale').map((r) => r.linkedin_url);

  check('Run succeeded', result.success === true, `status=${result.status}`);
  check('Ran in discovery mode', result.mode === 'discovery');
  check('Discovery mode never notified', result.notification === null);

  // Every source contributed candidates.
  for (const source of ['linkedin', 'greenhouse', 'ashby', 'lever']) {
    check(`Source "${source}" discovered`, (bySource[source] ?? 0) >= 1, `count=${bySource[source] ?? 0}`);
  }

  // 9 fixtures are recognized job URLs, minus 1 dedup duplicate = 8 candidates.
  check('Duplicate LinkedIn URL collapsed', result.discovery.candidates.length === 8, `candidates=${result.discovery.candidates.length}`);
  check('Non-job URLs dropped at search', !result.discovery.candidates.some((c) => c.url.includes('example.com') || c.url.includes('/in/')));
  check('Tracking params stripped', result.discovery.candidates.every((c) => !c.url.includes('?') && !c.url.includes('#')));

  // Keyword filter rejected the software engineer post.
  check('Keyword filter rejected non-design post', result.filtering.rejected === 1 && result.filtering.passed === 7, `passed=${result.filtering.passed} rejected=${result.filtering.rejected}`);

  // Classification ran for every surviving candidate.
  check('All candidates classified', result.classification.succeeded === 7 && result.classification.failed === 0, `succeeded=${result.classification.succeeded}`);

  // Scoring: the stale post is stored but never counted as eligible.
  check('Stale post counted as stale', result.scoring.stale === 1, `stale=${result.scoring.stale}`);
  check('Eligible posts qualified', result.scoring.eligible === 6, `eligible=${result.scoring.eligible}`);

  // Persistence: all scored posts (including the stale one) are stored.
  check('Posts persisted', savedRows.length === 7, `saved=${savedRows.length}`);

  // Stored URLs cover all four sources and are canonical.
  const storedSources = new Set(savedRows.map((r) => identifyJobSource(r.linkedin_url)));
  for (const source of ['linkedin', 'greenhouse', 'ashby', 'lever']) {
    check(`Stored a "${source}" row`, storedSources.has(source));
  }
  check('Stale row persisted with status "stale"', results.staleUrls.length === 1);
  check('Canonical URLs stored', savedRows.every((r) => r.linkedin_url && !r.linkedin_url.includes('?')));

  // Dedup held through persistence.
  const acme = savedRows.filter((r) => r.linkedin_url.includes('acmepay_senior-product-designer'));
  check('Duplicate stored exactly once', acme.length === 1, `count=${acme.length}`);

  // Role policy elevated the unlevelled "Product Designer" to Senior.
  const pulse = savedRows.find((r) => r.linkedin_url.includes('/pulse/jobs/'));
  check('Unlevelled title elevated to Senior', pulse?.seniority === 'Senior', `seniority=${pulse?.seniority}`);

  // Search-run bookkeeping.
  check('Search run recorded', searchRuns.some((r) => r.kind === 'complete'));
}

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('\n──────────────────────────────────────────────');
console.log('Multi-source smoke test (isolated)');
console.log('──────────────────────────────────────────────');

if (results.error) {
  console.log(`\n✗ Pipeline threw: ${results.error.message}`);
} else {
  console.log(`\nCandidates by source: ${JSON.stringify(results.bySource)}`);
  console.log(`Stored URLs (${results.savedUrls.length}):`);
  for (const url of results.savedUrls) console.log(`  • ${url}`);
}

console.log('');
let failed = 0;
for (const c of checks) {
  if (!c.passed) failed++;
  console.log(`${c.passed ? '✓' : '✗'} ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
}

console.log('──────────────────────────────────────────────');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
console.log('──────────────────────────────────────────────\n');

process.exit(failed === 0 ? 0 : 1);
