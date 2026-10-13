/**
 * Normalizes and validates job posting URLs for deterministic deduplication and storage.
 *
 * Supported sources:
 * 1. LinkedIn posts (existing)
 * 2. Greenhouse job boards (boards.greenhouse.io, job-boards.greenhouse.io)
 * 3. Ashby job boards (jobs.ashbyhq.com)
 * 4. Lever job boards (jobs.lever.co)
 *
 * Rules for all sources:
 * 1. Must be a valid job posting URL for the source.
 * 2. Removes all query parameters (e.g., ?utm_source=..., ?gh_jid=...).
 * 3. Removes URL hash fragments (e.g., #content).
 * 4. Strips unnecessary trailing slashes.
 * 5. Normalizes protocol to https:// and hostname to canonical form.
 * 6. Returns null if the URL is not a recognized job posting URL.
 */

const LINKEDIN_POST_PATH_PATTERNS = [
  /^\/posts\/[^/]+(?:\/)?$/i,
  /^\/feed\/update\/urn:li:(?:activity|share):[0-9]+(?:\/)?$/i,
  /^\/pulse\/[^/]+(?:\/)?$/i,
];

/**
 * Checks if a given URL is a LinkedIn post URL.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isLinkedInPostUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }

  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;

    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase().replace(/^m\./, 'www.');

    if (hostname !== 'www.linkedin.com' && hostname !== 'linkedin.com') {
      return false;
    }

    const pathname = parsed.pathname;
    return LINKEDIN_POST_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

/**
 * Deterministically normalizes a LinkedIn post URL.
 *
 * Example input:
 *   "https://www.linkedin.com/posts/example-123?trk=public_profile#comments"
 *
 * Normalized output:
 *   "https://www.linkedin.com/posts/example-123"
 *
 * @param {string} rawUrl
 * @returns {string | null} Normalized URL string, or null if invalid or not a LinkedIn post.
 */
export function normalizeLinkedInUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase().replace(/^m\./, 'www.');

    if (hostname !== 'www.linkedin.com' && hostname !== 'linkedin.com') {
      return null;
    }

    let cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath.startsWith('/')) {
      cleanPath = `/${cleanPath}`;
    }

    if (/^\/feed\/update\/urn:li:(?:activity|share):[0-9]+$/i.test(cleanPath)) {
      cleanPath = cleanPath.toLowerCase();
    }

    const isPost = LINKEDIN_POST_PATH_PATTERNS.some((pattern) => pattern.test(cleanPath));
    if (!isPost) {
      return null;
    }

    return `https://www.linkedin.com${cleanPath}`;
  } catch {
    return null;
  }
}

// ─── Greenhouse ────────────────────────────────────────────────────────────────

const GREENHOUSE_HOSTNAMES = ['boards.greenhouse.io', 'job-boards.greenhouse.io'];
// Greenhouse job URLs follow the pattern: /{company}/{jobs|embed}/job/{id} or /{company}/jobs/{id}
const GREENHOUSE_JOB_PATH_PATTERN = /^\/[^/]+\/jobs\/[^/]+(?:\/)?$/i;

/**
 * Checks if a given URL is a Greenhouse job posting URL.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isGreenhouseJobUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }

  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;

    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase();

    if (!GREENHOUSE_HOSTNAMES.includes(hostname)) {
      return false;
    }

    const pathname = parsed.pathname;
    return GREENHOUSE_JOB_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Deterministically normalizes a Greenhouse job posting URL.
 *
 * Example input:
 *   "https://boards.greenhouse.io/exampleco/jobs/1234567?gh_jid=1234567#detail"
 *
 * Normalized output:
 *   "https://boards.greenhouse.io/exampleco/jobs/1234567"
 *
 * @param {string} rawUrl
 * @returns {string | null} Normalized URL string, or null if invalid.
 */
export function normalizeGreenhouseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase();

    if (!GREENHOUSE_HOSTNAMES.includes(hostname)) {
      return null;
    }

    let cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath.startsWith('/')) {
      cleanPath = `/${cleanPath}`;
    }

    if (!GREENHOUSE_JOB_PATH_PATTERN.test(cleanPath)) {
      return null;
    }

    return `https://${hostname}${cleanPath}`;
  } catch {
    return null;
  }
}

// ─── Ashby ──────────────────────────────────────────────────────────────────────

const ASHBY_HOSTNAME = 'jobs.ashbyhq.com';
const ASHBY_JOB_PATH_PATTERN = /^\/[^/]+\/[^/]+(?:\/)?$/i;

/**
 * Checks if a given URL is an Ashby job posting URL.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isAshbyJobUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }

  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;

    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== ASHBY_HOSTNAME) {
      return false;
    }

    const pathname = parsed.pathname;
    return ASHBY_JOB_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Deterministically normalizes an Ashby job posting URL.
 *
 * Example input:
 *   "https://jobs.ashbyhq.com/exampleco/abc123-def456?utm_source=linkedin"
 *
 * Normalized output:
 *   "https://jobs.ashbyhq.com/exampleco/abc123-def456"
 *
 * @param {string} rawUrl
 * @returns {string | null} Normalized URL string, or null if invalid.
 */
export function normalizeAshbyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== ASHBY_HOSTNAME) {
      return null;
    }

    let cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath.startsWith('/')) {
      cleanPath = `/${cleanPath}`;
    }

    if (!ASHBY_JOB_PATH_PATTERN.test(cleanPath)) {
      return null;
    }

    return `https://${hostname}${cleanPath}`;
  } catch {
    return null;
  }
}

// ─── Lever ──────────────────────────────────────────────────────────────────────

const LEVER_HOSTNAME = 'jobs.lever.co';
const LEVER_JOB_PATH_PATTERN = /^\/[^/]+\/[^/]+(?:\/)?$/i;

/**
 * Checks if a given URL is a Lever job posting URL.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isLeverJobUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }

  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return false;

    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== LEVER_HOSTNAME) {
      return false;
    }

    const pathname = parsed.pathname;
    return LEVER_JOB_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Deterministically normalizes a Lever job posting URL.
 *
 * Example input:
 *   "https://jobs.lever.co/exampleco/abc123-def456?lever-origin=applied&lever-source=linkedin"
 *
 * Normalized output:
 *   "https://jobs.lever.co/exampleco/abc123-def456"
 *
 * @param {string} rawUrl
 * @returns {string | null} Normalized URL string, or null if invalid.
 */
export function normalizeLeverUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== LEVER_HOSTNAME) {
      return null;
    }

    let cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath.startsWith('/')) {
      cleanPath = `/${cleanPath}`;
    }

    if (!LEVER_JOB_PATH_PATTERN.test(cleanPath)) {
      return null;
    }

    return `https://${hostname}${cleanPath}`;
  } catch {
    return null;
  }
}

// ─── Unified Interface ──────────────────────────────────────────────────────────

/**
 * Source identifiers for job posting sources.
 */
export const JOB_SOURCES = Object.freeze({
  LINKEDIN: 'linkedin',
  GREENHOUSE: 'greenhouse',
  ASHBY: 'ashby',
  LEVER: 'lever',
});

/**
 * Checks if a given URL is a recognized job posting URL from any supported source.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isJobPostingUrl(rawUrl) {
  return (
    isLinkedInPostUrl(rawUrl) ||
    isGreenhouseJobUrl(rawUrl) ||
    isAshbyJobUrl(rawUrl) ||
    isLeverJobUrl(rawUrl)
  );
}

/**
 * Identifies the source of a job posting URL.
 *
 * @param {string} rawUrl
 * @returns {string | null} Source identifier or null if not recognized.
 */
export function identifyJobSource(rawUrl) {
  if (isLinkedInPostUrl(rawUrl)) return JOB_SOURCES.LINKEDIN;
  if (isGreenhouseJobUrl(rawUrl)) return JOB_SOURCES.GREENHOUSE;
  if (isAshbyJobUrl(rawUrl)) return JOB_SOURCES.ASHBY;
  if (isLeverJobUrl(rawUrl)) return JOB_SOURCES.LEVER;
  return null;
}

/**
 * Normalizes a job posting URL using the appropriate source-specific normalizer.
 *
 * @param {string} rawUrl
 * @returns {string | null} Normalized URL string, or null if not a recognized job posting URL.
 */
export function normalizeJobUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  if (isLinkedInPostUrl(rawUrl)) return normalizeLinkedInUrl(rawUrl);
  if (isGreenhouseJobUrl(rawUrl)) return normalizeGreenhouseUrl(rawUrl);
  if (isAshbyJobUrl(rawUrl)) return normalizeAshbyUrl(rawUrl);
  if (isLeverJobUrl(rawUrl)) return normalizeLeverUrl(rawUrl);

  return null;
}