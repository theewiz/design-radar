/**
 * Mock digest data for local preview.
 *
 * Used by `npm run digest` so the digest can be viewed without Supabase,
 * Gemini, or a search provider, and reused by test/digest.test.js.
 *
 * The rows deliberately include the awkward cases — missing recruiter, missing
 * company, missing location, missing remote status, no description, no
 * application URL, an over-long description, an already-sent post, a stale
 * post, and a post outside the lookback window — so the formatter is exercised
 * against real gaps rather than only clean rows. One row is published days ago
 * but discovered inside the lookback, which is the case a 24-hour window would
 * have silently dropped.
 *
 * Timestamps are generated relative to a supplied reference time so the
 * lookback window is always exercised honestly.
 */

/**
 * Builds the mock post rows.
 *
 * @param {Object} [options]
 * @param {Date} [options.now] Reference time for relative timestamps.
 * @returns {object[]}
 */
export function buildMockPosts(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

  return [
    // ── Verified: published inside the last 24 hours, highest score ──────────
    {
      id: 'mock-1',
      linkedin_url: 'https://www.linkedin.com/posts/example-pay_senior-product-designer-fintech-activity-7301',
      job_title: 'Senior Product Designer',
      author_name: 'Jane Doe',
      company_name: 'Example Pay',
      location: 'London, UK',
      remote_status: 'Remote',
      application_url: 'https://example.com/careers/senior-product-designer',
      relevance_score: 85,
      status: 'qualified',
      published_at: hoursAgo(3),
      discovered_at: hoursAgo(2),
      is_notified: false,
      sent_to_digest: false,
      post_text:
        'Fintech infrastructure startup hiring a Senior Product Designer to own our merchant dashboard ' +
        'and payments onboarding flows. You will work directly with the founding engineering team on ' +
        'complex data-heavy product surfaces.',
    },
    {
      id: 'mock-2',
      linkedin_url: 'https://www.linkedin.com/posts/example-ai_lead-product-designer-activity-7302',
      job_title: 'Lead Product Designer',
      author_name: 'John Smith',
      company_name: 'Example AI',
      location: 'Berlin, Germany',
      remote_status: 'Hybrid',
      application_url: null,
      relevance_score: 75,
      status: 'qualified',
      published_at: hoursAgo(8),
      discovered_at: hoursAgo(7),
      is_notified: false,
      sent_to_digest: false,
      post_text:
        'AI workflow tools startup hiring a Lead Product Designer. Fully remote-friendly across EMEA, ' +
        'with a strong design systems focus and close partnership with platform engineers.',
    },
    {
      id: 'mock-3',
      linkedin_url: 'https://www.linkedin.com/posts/regtech-co_staff-designer-compliance-platform-activity-7303',
      job_title: 'Staff Product Designer',
      // Recruiter unknown in the source.
      author_name: null,
      company_name: 'RegTech Co',
      location: 'Dublin, Ireland',
      remote_status: 'Remote',
      application_url: 'https://regtech.example/jobs/staff-designer',
      relevance_score: 70,
      status: 'qualified',
      published_at: hoursAgo(11),
      discovered_at: hoursAgo(10),
      is_notified: false,
      sent_to_digest: false,
      post_text:
        'Compliance and RegTech platform seeking a Staff Product Designer for our enterprise onboarding ' +
        'and risk tooling. Design systems experience essential.',
    },

    // ── Recent Discoveries: no verifiable published_at (§18 rule 3) ─────────
    {
      id: 'mock-4',
      linkedin_url: 'https://www.linkedin.com/posts/devtools-corp_founding-product-designer-activity-7304',
      job_title: 'Founding Product Designer',
      author_name: 'Priya Raman',
      company_name: 'DevTools Corp',
      location: null,
      remote_status: 'Remote',
      application_url: null,
      relevance_score: 68,
      status: 'qualified',
      published_at: null,
      discovered_at: hoursAgo(6),
      is_notified: false,
      sent_to_digest: false,
      post_text:
        'Developer tools startup looking for a founding product designer to shape our AI design tool for ' +
        'developers from zero to one.',
    },
    {
      id: 'mock-5',
      linkedin_url: 'https://www.linkedin.com/posts/payments-x_principal-designer-web3-activity-7305',
      job_title: 'Principal Product Designer',
      author_name: null,
      company_name: null,
      location: null,
      remote_status: null,
      application_url: null,
      relevance_score: 63,
      status: 'qualified',
      published_at: null,
      discovered_at: hoursAgo(14),
      is_notified: false,
      sent_to_digest: false,
      // No description available at all.
      post_text: null,
    },
    {
      id: 'mock-6',
      linkedin_url: 'https://www.linkedin.com/posts/web3-labs_head-of-product-design-activity-7306',
      job_title: 'Head of Product Design',
      author_name: 'Marcus Bell',
      company_name: 'Web3 Labs',
      location: 'Lisbon, Portugal',
      remote_status: 'Remote',
      application_url: 'https://web3.example/careers/head-of-design',
      relevance_score: 61,
      status: 'qualified',
      published_at: hoursAgo(20),
      discovered_at: hoursAgo(18),
      is_notified: false,
      sent_to_digest: false,
      // Deliberately long, to exercise truncation.
      post_text:
        'Global Web3 infrastructure company hiring a Head of Product Design to lead a team of four across ' +
        'product design and design systems. You will define the design vision for our digital asset ' +
        'platform, own our component library and design token infrastructure, and partner with compliance, ' +
        'engineering and product leadership on complex regulated workflows. Experience in enterprise ' +
        'software, developer-facing tools, or design tooling for AI is strongly preferred, and we are ' +
        'open to candidates worldwide provided you can overlap four hours with the European team.',
    },

    // ── Excluded: must never reach the digest ──────────────────────────────
    {
      id: 'mock-7',
      linkedin_url: 'https://www.linkedin.com/posts/example-pay_already-sent-role-activity-7307',
      job_title: 'Senior Product Designer',
      author_name: 'Jane Doe',
      company_name: 'Example Pay',
      location: 'London, UK',
      remote_status: 'Remote',
      application_url: null,
      relevance_score: 88,
      status: 'qualified',
      published_at: hoursAgo(4),
      discovered_at: hoursAgo(3),
      is_notified: true,
      sent_to_digest: true,
      post_text: 'Already delivered in a previous digest — must not be repeated.',
    },
    {
      id: 'mock-8',
      linkedin_url: 'https://www.linkedin.com/posts/old-co_principal-designer-activity-7308',
      job_title: 'Principal Product Designer',
      author_name: 'Sam Old',
      company_name: 'Old Co',
      location: 'Austin, TX',
      remote_status: 'Hybrid',
      application_url: null,
      relevance_score: 92,
      status: 'stale',
      published_at: hoursAgo(24 * 30),
      discovered_at: hoursAgo(5),
      is_notified: false,
      sent_to_digest: false,
      post_text: 'Posted a month ago — highest score in the set, but stale and therefore excluded.',
    },
    {
      id: 'mock-9',
      linkedin_url: 'https://www.linkedin.com/posts/yesterday-co_senior-designer-activity-7309',
      job_title: 'Senior Product Designer',
      author_name: 'Yesterday Person',
      company_name: 'Yesterday Co',
      location: 'Madrid, Spain',
      remote_status: 'Remote',
      application_url: null,
      relevance_score: 80,
      status: 'qualified',
      published_at: hoursAgo(40),
      // Discovered ten days ago, so it falls outside the 168-hour lookback.
      discovered_at: hoursAgo(24 * 10),
      is_notified: false,
      sent_to_digest: false,
      post_text: 'Discovered outside the 168-hour digest lookback — excluded.',
    },
    {
      id: 'mock-10',
      linkedin_url: 'https://www.linkedin.com/posts/enterprise-co_lead-designer-week-old-activity-7310',
      job_title: 'Lead Product Designer',
      author_name: 'Dana Okafor',
      company_name: 'Enterprise Co',
      location: 'EMEA',
      remote_status: 'Remote',
      application_url: 'https://enterprise.example/careers/lead-designer',
      relevance_score: 66,
      status: 'qualified',
      // Published three days ago: too old for "Verified", well inside the lookback.
      published_at: hoursAgo(72),
      discovered_at: hoursAgo(70),
      is_notified: false,
      sent_to_digest: false,
      post_text:
        'Enterprise compliance tooling hiring a Lead Product Designer. Remote-first across EMEA, ' +
        'owning a complex data-heavy admin platform and its design system.',
    },
  ];
}

export default buildMockPosts;