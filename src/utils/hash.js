import { createHash } from 'node:crypto';

/**
 * Computes a deterministic SHA-256 hex digest of a given input string.
 *
 * @param {string} input String to hash.
 * @returns {string} Hex-encoded SHA-256 hash string.
 */
export function sha256(input) {
  if (typeof input !== 'string') {
    throw new TypeError(`sha256 expects a string input, received ${typeof input}`);
  }

  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Normalizes text by trimming, converting to lowercase, and collapsing multiple whitespaces.
 *
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Computes an in-memory content fingerprint for deduplicating identical search results
 * across multiple queries during a single radar run before calling AI.
 *
 * Pattern per PROJECT_SPEC.md §9:
 *   SHA-256( normalizeText(title + ' ' + snippet) )
 *
 * @param {string | null} title Search result title.
 * @param {string | null} snippet Search result snippet.
 * @returns {string} SHA-256 content fingerprint.
 */
export function createContentFingerprint(title = '', snippet = '') {
  const normalizedTitle = normalizeText(title);
  const normalizedSnippet = normalizeText(snippet);
  const combined = `${normalizedTitle} ${normalizedSnippet}`.trim();

  return sha256(combined);
}
