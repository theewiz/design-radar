/**
 * Daily Digest Generation (PROJECT_SPEC §16, §22).
 *
 * Builds the daily digest message from qualified posts discovered inside the
 * lookback window (168 hours by default). This module formats and selects
 * content only — it does not deliver anything. Notification delivery is a
 * separate concern (Phase 7), so posts are never marked as notified here; §22
 * requires that flag to be set only after a confirmed send.
 *
 * Content rules (§16):
 *   - selection is `status = 'qualified'` only. `relevance_score` is never used
 *     as a filter here; it is the ordering signal, so a qualified post at any
 *     score is retained and simply ranks below the stronger matches.
 *   - prioritize the highest relevance scores
 *   - show the job title, recruiter/author, company, location, remote status
 *   - include a short factual description
 *   - include the LinkedIn post URL, plus an application URL when available
 *   - never fabricate missing information
 *
 * Formatting rules:
 *   - `*asterisks*` for emphasis, the convention ntfy renders as markdown bold.
 *     Underscores are avoided because LinkedIn post slugs routinely contain them
 *     and would render as unintended italics.
 *   - one short field per line so the message stays readable on a phone.
 *   - §22 chunking: cards are never split across messages.
 */

import { logger } from '../utils/logger.js';
import { resolveNotificationSettings } from './config.js';
import { getEnv } from '../utils/env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How far back the digest looks for qualified posts, in hours (PROJECT_SPEC §16).
 *
 * A post is retrieved once and can then sit unsent for up to a week, which is
 * what makes the daily digest reliable: nothing qualified is silently dropped
 * because it was found on an inconvenient day. Overridable with
 * DIGEST_LOOKBACK_HOURS.
 */
export const DEFAULT_DIGEST_LOOKBACK_HOURS = 168;

/**
 * Publication window that earns a post the "Verified" heading (§18 rule 1).
 *
 * Separate from the lookback above: a post may be up to 168h old and still be
 * legitimately reported, but only one published within 24h is treated as
 * confirmed-current.
 */
export const VERIFIED_PUBLICATION_WINDOW_HOURS = 24;

/**
 * Resolves the digest lookback window from an explicit option, then
 * DIGEST_LOOKBACK_HOURS, then the 168h default.
 *
 * @param {Object} [options]
 * @param {number} [options.windowHours]
 * @param {object} [env] Environment source. Defaults to the current runtime environment.
 * @returns {number} Lookback window in hours.
 */
export function resolveLookbackHours(options = {}, env = getEnv()) {
  if (Number.isFinite(options.windowHours)) return options.windowHours;

  const fromEnv = Number.parseInt(String(env.DIGEST_LOOKBACK_HOURS ?? '').trim(), 10);

  // A malformed value must not collapse the window to zero and empty the digest.
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_DIGEST_LOOKBACK_HOURS;
}

/** Displayed in place of any field the source did not provide. */
export const UNKNOWN_FIELD = 'Not specified';

/** Shown when a post has no stored relevance score. */
export const UNKNOWN_SCORE = 'n/a';

/** §22: chunk limit, comfortably under the ~4,096 character ntfy message cap. */
export const MAX_CHUNK_CHARS = 3500;

/** Description length cap, keeping each card readable on mobile. */
export const MAX_DESCRIPTION_CHARS = 160;

/** Upper bound on roles per digest, so one run cannot flood the channel. */
export const DEFAULT_MAX_ROLES = 25;

const SEPARATOR = '━━━━━━━━━━━━━━';
const SHORT_SEPARATOR = '━━━━━━━';

const EMOJI = Object.freeze({
  brand: '🎨',
  verified: '⚡',
  recent: '✨',
  role: '🔥',
  recruiter: '👤',
  company: '🏢',
  location: '📍',
  remote: '🌐',
  link: '🔗',
  apply: '📝',
});

/** §16 section headings. */
export const DIGEST_SECTIONS = Object.freeze({
  VERIFIED: 'VERIFIED (LAST 24 HOURS)',
  RECENT: 'RECENT DISCOVERIES',
});

// ─── Text Utilities ───────────────────────────────────────────────────────────

/**
 * Collapses whitespace so multi-line post text cannot break the layout.
 *
 * @param {unknown} value
 * @returns {string} Single-line text, or '' when nothing usable was provided.
 */
function collapseWhitespace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Truncates text to a maximum length on a word boundary.
 *
 * The text is only ever shortened, never rewritten or completed — a digest line
 * is a factual extract of the post, not a summary the system composed.
 *
 * @param {unknown} value Source text.
 * @param {number} [maxChars=MAX_DESCRIPTION_CHARS]
 * @returns {string} Possibly truncated single-line text, or ''.
 */
export function summarizeText(value, maxChars = MAX_DESCRIPTION_CHARS) {
  const text = collapseWhitespace(value);
  if (!text || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const clipped = text.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');

  // Only break on a word boundary when it does not gut the excerpt.
  const truncated = lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped;

  return `${truncated.replace(/[\s,;:.!?-]+$/, '')}…`;
}

/**
 * Formats a date as "1 Oct 2026".
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDigestDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * Renders a field value, falling back to the placeholder when absent.
 *
 * @param {unknown} value
 * @returns {string}
 */
function field(value) {
  const text = collapseWhitespace(value);
  return text || UNKNOWN_FIELD;
}

/**
 * Renders a relevance score, tolerating a missing value.
 *
 * @param {unknown} score
 * @returns {string}
 */
function scoreLabel(score) {
  return typeof score === 'number' && Number.isFinite(score) ? String(score) : UNKNOWN_SCORE;
}

/**
 * Renders a window in hours for display, e.g. "168 hours".
 *
 * @param {number} hours
 * @returns {string}
 */
function formatWindowHours(hours) {
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Parses a timestamp, returning null when it is absent or unparseable.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
function parseTime(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Explains why a post is or is not eligible for the digest.
 *
 * Applied in a fixed order so the reported reason is the most fundamental one.
 *
 * @param {object} post
 * @param {Date} now
 * @param {number} windowHours
 * @returns {{ eligible: boolean, reason: string | null }}
 */
export function checkEligibility(post, { now, windowHours }) {
  if (!post || typeof post !== 'object') {
    return { eligible: false, reason: 'invalid' };
  }

  // Already-sent check comes first: re-sending is the costliest mistake.
  // Both flags are consulted because they are written together but can drift if
  // a delivery was recorded and the mark then failed.
  if (post.is_notified === true || post.sent_to_digest === true) {
    return { eligible: false, reason: 'already_sent' };
  }

  // `status = 'qualified'` is the authoritative qualification decision (§14 rule
  // 1) and is the *only* qualification filter here. `relevance_score` is never
  // compared against MIN_RELEVANCE_SCORE: the score expresses priority, and a
  // qualified post that scored 45 is a standard-priority match that belongs in
  // the digest, ranked below the higher scorers rather than dropped.
  //
  // Anything else is excluded, including a row with no status at all: the column
  // is NOT NULL in the schema, so a missing value is a malformed row and not
  // evidence of a qualification decision.
  if (post.status !== 'qualified') {
    return { eligible: false, reason: 'not_qualified' };
  }

  const discoveredAt = parseTime(post.discovered_at);
  if (!discoveredAt) {
    return { eligible: false, reason: 'missing_discovered_at' };
  }

  if (now.getTime() - discoveredAt.getTime() > windowHours * 60 * 60 * 1000) {
    return { eligible: false, reason: 'out_of_window' };
  }

  if (!post.linkedin_url) {
    return { eligible: false, reason: 'missing_url' };
  }

  return { eligible: true, reason: null };
}

// ─── Card Rendering ───────────────────────────────────────────────────────────

/**
 * Renders one opportunity card.
 *
 * Every structured field gets its own line so the reader can see at a glance
 * that a value was not extracted. The description line is omitted when there is
 * no text, and the application URL is omitted when absent, as §16 requires it
 * only "when available".
 *
 * @param {object} post Qualified post row.
 * @param {Object} [options]
 * @param {number} [options.maxDescriptionChars=MAX_DESCRIPTION_CHARS]
 * @returns {string}
 */
export function buildRoleCard(post, options = {}) {
  const maxDescriptionChars = options.maxDescriptionChars ?? MAX_DESCRIPTION_CHARS;

  const lines = [
    `${EMOJI.role} *${field(post.job_title)}* (Score: ${scoreLabel(post.relevance_score)})`,
    '',
    `${EMOJI.recruiter} ${field(post.author_name)}`,
    `${EMOJI.company} ${field(post.company_name)}`,
    `${EMOJI.location} ${field(post.location)}`,
    `${EMOJI.remote} ${field(post.remote_status)}`,
  ];

  const description = summarizeText(post.post_text, maxDescriptionChars);
  if (description) {
    lines.push('', description);
  }

  lines.push('', `${EMOJI.link} ${field(post.linkedin_url)}`);

  const applicationUrl = collapseWhitespace(post.application_url);
  if (applicationUrl) {
    lines.push(`${EMOJI.apply} Apply: ${applicationUrl}`);
  }

  return lines.join('\n');
}

// ─── Digest Assembly ──────────────────────────────────────────────────────────

/**
 * Sorts posts by relevance descending, breaking ties deterministically.
 *
 * @param {object[]} posts
 * @returns {object[]}
 */
function sortByRelevance(posts) {
  return [...posts].sort((a, b) => {
    const scoreDiff = (b.relevance_score ?? -1) - (a.relevance_score ?? -1);
    if (scoreDiff !== 0) return scoreDiff;

    // Newer posts win a tie, with the URL as a final stable tiebreaker.
    const aTime = parseTime(a.discovered_at)?.getTime() ?? 0;
    const bTime = parseTime(b.discovered_at)?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime;

    return String(a.linkedin_url).localeCompare(String(b.linkedin_url));
  });
}

/**
 * Partitions a message into §22-compliant chunks.
 *
 * Blocks are atomic, so an opportunity card is never split across messages. A
 * section heading is attached to the first card beneath it, which prevents a
 * heading from being stranded at the end of a chunk.
 *
 * @param {string[]} blocks Atomic content blocks.
 * @param {Object} [options]
 * @param {number} [options.maxChars=MAX_CHUNK_CHARS]
 * @returns {string[]}
 */
export function chunkDigest(blocks, options = {}) {
  const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;
  const chunks = [];
  let current = [];

  for (const block of blocks) {
    const candidate = [...current, block].join('\n\n');

    if (current.length > 0 && candidate.length > maxChars) {
      chunks.push(current.join('\n\n'));
      current = [block];
    } else {
      current.push(block);
    }
  }

  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}

/**
 * Builds the daily digest from qualified posts.
 *
 * Pure and synchronous: it takes rows and returns a message, so formatting can
 * be tested without a database or a notification provider.
 *
 * @param {object[]} posts Rows from linkedin_posts.
 * @param {Object} [options]
 * @param {Date} [options.now] Reference time for the window check.
 * @param {number} [options.windowHours=168] Lookback window in hours.
 * @param {number} [options.maxRoles=25] Cap on included roles.
 * @param {number} [options.maxChunkChars=3500] Chunk limit.
 * @param {number} [options.maxDescriptionChars=160] Description cap.
 * @returns {{
 *   message: string,
 *   chunks: string[],
 *   stats: object,
 *   included: object[],
 *   omitted: object[],
 *   sections: { verified: object[], recent: object[] },
 *   empty: boolean
 * }}
 */
export function buildDigest(posts, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const windowHours = resolveLookbackHours(options, options.env ?? getEnv());
  const maxRoles = Number.isFinite(options.maxRoles) ? options.maxRoles : DEFAULT_MAX_ROLES;
  const maxChunkChars = Number.isFinite(options.maxChunkChars) ? options.maxChunkChars : MAX_CHUNK_CHARS;

  const rows = Array.isArray(posts) ? posts : [];
  const skipped = {
    already_sent: 0,
    not_qualified: 0,
    out_of_window: 0,
    missing_url: 0,
    missing_discovered_at: 0,
    duplicate_url: 0,
    invalid: 0,
  };

  const eligible = [];
  const seenUrls = new Set();

  for (const post of rows) {
    const check = checkEligibility(post, { now, windowHours });

    if (!check.eligible) {
      if (check.reason in skipped) {
        skipped[check.reason]++;
      } else {
        skipped.invalid++;
      }
      continue;
    }

    // Defensive: linkedin_url is unique in the schema, so a repeat would mean a
    // malformed result set. Emitting the same card twice is worse than dropping it.
    if (seenUrls.has(post.linkedin_url)) {
      skipped.duplicate_url++;
      continue;
    }
    seenUrls.add(post.linkedin_url);
    eligible.push(post);
  }

  const ordered = sortByRelevance(eligible);

  // §18 rule 1 vs rule 3: a verified publication inside 24h heads the digest;
  // everything else discovered recently follows.
  const sections = { verified: [], recent: [] };

  for (const post of ordered) {
    const publishedAt = parseTime(post.published_at);
    const isVerified =
      publishedAt !== null &&
      now.getTime() - publishedAt.getTime() <= VERIFIED_PUBLICATION_WINDOW_HOURS * 60 * 60 * 1000;

    (isVerified ? sections.verified : sections.recent).push(post);
  }

  const included = ordered.slice(0, Math.max(0, maxRoles));
  const omitted = ordered.slice(Math.max(0, maxRoles));
  const includedUrls = new Set(included.map((p) => p.linkedin_url));

  const stats = {
    scanned: rows.length,
    qualified: eligible.length,
    included: included.length,
    omitted: omitted.length,
    window_hours: windowHours,
    chunks: 0,
    skipped,
  };

  const found = included.length;
  const header = [
    `${EMOJI.brand} *DESIGNRADAR*`,
    'Senior Product Design opportunities',
    `Daily Digest — ${formatDigestDate(now)}`,
    '',
    found === 0
      ? `No relevant opportunities in the last ${formatWindowHours(stats.window_hours)}.`
      : `Found ${found} relevant opportunit${found === 1 ? 'y' : 'ies'}.`,
  ].join('\n');

  const summary = [
    `Scanned: ${stats.scanned} posts`,
    `Qualified: ${stats.qualified}`,
    `Included: ${stats.included}`,
  ].join('\n');

  // §8: an empty digest is still a digest. Reporting zero explicitly is far more
  // useful than sending nothing, which the reader cannot tell apart from a
  // failed run.
  if (found === 0) {
    const emptyBlocks = [header, [SHORT_SEPARATOR, summary, SHORT_SEPARATOR].join('\n')];
    const emptyChunks = chunkDigest(emptyBlocks, { maxChars: maxChunkChars });
    stats.chunks = emptyChunks.length;

    return {
      message: emptyChunks.join('\n\n'),
      chunks: emptyChunks,
      stats,
      included,
      omitted,
      sections: { verified: [], recent: [] },
      empty: true,
    };
  }

  const blocks = [header];

  const renderSection = (heading, posts) => {
    if (posts.length === 0) return;

    const sectionHeader = [SEPARATOR, `${heading}`, SEPARATOR].join('\n');
    const cards = posts
      .filter((post) => includedUrls.has(post.linkedin_url))
      .map((post) => buildRoleCard(post, options));

    // The heading is bound to its first card so it cannot end a chunk alone.
    blocks.push([sectionHeader, cards[0]].join('\n\n'));
    for (const card of cards.slice(1)) {
      blocks.push(card);
    }
  };

  renderSection(`${EMOJI.verified} ${DIGEST_SECTIONS.VERIFIED}`, sections.verified);
  renderSection(`${EMOJI.recent} ${DIGEST_SECTIONS.RECENT}`, sections.recent);

  if (omitted.length > 0) {
    blocks.push(
      [
        SEPARATOR,
        summary,
        `+ ${omitted.length} more qualified not shown`,
        SEPARATOR,
      ].join('\n')
    );
  } else {
    blocks.push([SHORT_SEPARATOR, summary, SHORT_SEPARATOR].join('\n'));
  }

  const chunks = chunkDigest(blocks, { maxChars: maxChunkChars });
  stats.chunks = chunks.length;

  return {
    message: chunks.join('\n\n'),
    chunks,
    stats,
    included,
    omitted,
    sections,
    empty: false,
  };
}

// ─── Mock Notification Output ──────────────────────────────────────────────────

/**
 * Renders a digest to the console without contacting any provider.
 *
 * This is the local preview used by `npm run digest`. No network call is made
 * and no post is marked as notified.
 *
 * @param {{ chunks: string[], stats: object, empty?: boolean }} digest
 * @param {Object} [options]
 * @param {string} [options.label='MOCK']
 * @returns {string} The console output that was printed.
 */
export function renderDigestPreview(digest, options = {}) {
  const label = options.label || 'MOCK';
  const { stats, chunks, empty } = digest;

  const bar = '─'.repeat(52);
  const lines = [
    '',
    bar,
    ` ${label} NOTIFICATION PREVIEW — not delivered to any provider`,
    bar,
    '',
  ];

  if (empty || chunks.length === 0) {
    lines.push(
      `No relevant opportunities in the last ${formatWindowHours(stats.window_hours)}.`,
      '',
      `Scanned: ${stats.scanned} posts`,
      `Qualified: ${stats.qualified}`,
      `Included: ${stats.included}`,
      ''
    );
  } else {
    for (const [index, chunk] of chunks.entries()) {
      if (chunks.length > 1) {
        lines.push(`— chunk ${index + 1} of ${chunks.length} (${chunk.length} chars) —`);
      }
      lines.push(chunk, '');
    }
  }

  lines.push(bar);
  lines.push(
    ` Scanned: ${stats.scanned} | Qualified: ${stats.qualified} | Included: ${stats.included} | Chunks: ${stats.chunks}`
  );
  lines.push(
    ` Skipped: already_sent=${stats.skipped.already_sent} not_qualified=${stats.skipped.not_qualified} ` +
      `out_of_window=${stats.skipped.out_of_window}`
  );
  lines.push(bar);
  lines.push('');

  const output = lines.join('\n');
  console.log(output);

  return output;
}

/**
 * Retrieves qualified posts, builds the digest, and previews it locally.
 *
 * No provider is contacted. Posts are deliberately left unnotified so a later
 * delivery phase can send exactly this content without re-querying or risking a
 * double send — §22 requires that flag to be set only after a confirmed send,
 * and a printed preview is not a send.
 *
 * @param {Object} [options]
 * @param {string} [options.source='database'] 'database' or 'mock'.
 * @param {object[]} [options.posts] Rows to use when source is 'mock'.
 * @param {(opts: object) => Promise<object[]>} [options.fetchPosts] Custom loader.
 * @param {Date} [options.now]
 * @param {number} [options.windowHours] Lookback window; defaults to DIGEST_LOOKBACK_HOURS or 168.
 * @param {number} [options.maxRoles]
 * @param {boolean} [options.preview=true] Print the digest to the console.
 * @param {string} [options.provider] Overrides NOTIFICATION_PROVIDER for the reported provider.
 * @param {object} [options.env] Environment source for the window and provider. Defaults to the current runtime environment.
 * @returns {Promise<object>} Digest result including stats and chunks.
 */
export async function generateDigest(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const source = options.source || (options.posts ? 'mock' : 'database');
  // Resolved once so the loader and the formatter cannot disagree about the window.
  const windowHours = resolveLookbackHours(options, options.env ?? getEnv());
  // The configured provider, resolved through the same function `createNotifier`
  // uses, so this log and `[Notification] Provider:` cannot disagree. Reporting
  // it here says which provider will carry this digest; `delivered` stays false
  // because delivery is Phase 7 and has not happened yet.
  const provider = resolveNotificationSettings(
    { provider: options.provider },
    options.env ?? getEnv()
  ).provider;

  logger.info('Digest generation started', { source, windowHours });

  let rows = Array.isArray(options.posts) ? options.posts : null;

  if (!rows) {
    if (typeof options.fetchPosts === 'function') {
      rows = await options.fetchPosts({ now, windowHours });
    } else {
      // Imported lazily so the module can be used with mock data in tests
      // without requiring Supabase configuration.
      const { getDigestCandidates } = await import('../database/posts.js');
      // No score filter here or downstream: selection is status + is_notified +
      // the lookback window, and `relevance_score` only orders the result.
      rows = await getDigestCandidates({
        windowHours,
        limit: options.limit,
      });
    }
  }

  const digest = buildDigest(rows, { ...options, now, windowHours });

  if (options.preview !== false) {
    renderDigestPreview(digest);
  }

  logger.info('Digest generation complete', {
    scanned: digest.stats.scanned,
    qualified: digest.stats.qualified,
    included: digest.stats.included,
    chunks: digest.stats.chunks,
    provider,
    delivered: false,
  });

  return {
    ...digest,
    source,
    provider,
    delivered: false,
    // Phase 7 consumes these to send, then mark each chunk's posts as notified.
    notified: false,
  };
}