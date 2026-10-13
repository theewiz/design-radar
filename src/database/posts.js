/**
 * Database operations for linkedin_posts, search_runs, and notifications
 * (Phases 3, 5, and 7).
 *
 * Implements PROJECT_SPEC §17 and §18.
 *
 * All functions use the Supabase client from src/database/supabase.js.
 * Duplicate protection relies on the UNIQUE constraint on linkedin_url.
 */

import { getSupabaseClient } from './supabase.js';
import { getEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';
// Imported for its lookback resolution only. digest.js imports this module
// lazily (inside generateDigest) precisely so Supabase stays out of digest-only
// tests, so a static import here creates no initialization cycle.
import { resolveLookbackHours } from '../notifications/digest.js';

// ─── Search Runs ────────────────────────────────────────────────────────────────

/**
 * Creates a new search_runs record at the start of a discovery execution.
 *
 * @param {Object} [params]
 * @param {number} [params.queryCount=0] Number of queries planned.
 * @returns {Promise<{ id: string, started_at: string }>}
 */
export async function createSearchRun(params = {}) {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('search_runs')
    .insert({
      query_count: params.queryCount ?? 0,
      status: 'running',
    })
    .select('id, started_at')
    .single();

  if (error) {
    logger.error('Failed to create search run', { error: error.message });
    throw new Error(`createSearchRun failed: ${error.message}`);
  }

  logger.info('Search run created', { runId: data.id });
  return data;
}

/**
 * Updates a search_runs record with completion metrics.
 *
 * @param {string} runId
 * @param {Object} metrics
 * @param {number} [metrics.resultCount]
 * @param {number} [metrics.newPostCount]
 * @param {number} [metrics.candidateCount]
 * @param {number} [metrics.matchedPostCount]
 * @param {string} [metrics.status='completed']
 * @param {string} [metrics.errorMessage]
 * @returns {Promise<void>}
 */
export async function completeSearchRun(runId, metrics = {}) {
  if (!runId) {
    throw new Error('completeSearchRun requires a runId');
  }

  const supabase = getSupabaseClient();

  const updatePayload = {
    finished_at: new Date().toISOString(),
    status: metrics.status ?? 'completed',
  };

  if (metrics.resultCount != null) updatePayload.result_count = metrics.resultCount;
  if (metrics.newPostCount != null) updatePayload.new_post_count = metrics.newPostCount;
  if (metrics.candidateCount != null) updatePayload.candidate_count = metrics.candidateCount;
  if (metrics.matchedPostCount != null) updatePayload.matched_post_count = metrics.matchedPostCount;
  if (metrics.errorMessage) updatePayload.error_message = metrics.errorMessage;

  const { error } = await supabase
    .from('search_runs')
    .update(updatePayload)
    .eq('id', runId);

  if (error) {
    logger.error('Failed to complete search run', { runId, error: error.message });
    throw new Error(`completeSearchRun failed: ${error.message}`);
  }

  logger.info('Search run completed', { runId, status: updatePayload.status });
}

// ─── LinkedIn Posts ─────────────────────────────────────────────────────────────

/**
 * Finds a linkedin_post by its normalized URL.
 * Returns the existing record or null if not found.
 *
 * @param {string} linkedinUrl Normalized LinkedIn post URL.
 * @returns {Promise<object | null>}
 */
export async function findPostByUrl(linkedinUrl) {
  if (!linkedinUrl) {
    return null;
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('*')
    .eq('linkedin_url', linkedinUrl)
    .maybeSingle();

  if (error) {
    logger.error('findPostByUrl query failed', { linkedinUrl, error: error.message });
    throw new Error(`findPostByUrl failed: ${error.message}`);
  }

  return data;
}

/**
 * Builds the linkedin_posts insert row from a post payload.
 *
 * Extracted from createPost so the column mapping can be tested without a
 * database. Nothing is inferred here: absent fields stay null, and status
 * defaults to 'irrelevant' because an unscored post must never reach a digest —
 * its stored URL deduplicates future runs (§9), so it would otherwise be
 * permanently skipped without ever having been scored.
 *
 * @param {Object} post Post payload from the pipeline.
 * @param {string} [post.linkedin_url] Normalized LinkedIn post URL.
 * @param {number} [post.relevance_score=0] Deterministic score from Phase 5 (§14).
 * @param {string} [post.status] Derived status (§17).
 * @param {string} [post.score_explain] Human-readable scoring rationale.
 * @param {Array} [post.score_breakdown] Structured scoring rationale.
 * @returns {Object} Row matching the linkedin_posts schema.
 */
export function buildPostRow(post) {
  return {
    linkedin_url: post.linkedin_url,
    search_run_id: post.search_run_id ?? null,
    source_provider: post.source_provider ?? null,
    source_query: post.source_query ?? null,
    post_text: post.post_text ?? null,
    published_at: post.published_at ?? null,
    discovered_at: new Date().toISOString(),
    // Phase 4 classification fields (§11). Nulls are stored as-is.
    author_name: post.author_name ?? null,
    company_name: post.company_name ?? null,
    job_title: post.job_title ?? null,
    seniority: post.seniority ?? null,
    location: post.location ?? null,
    remote_status: post.remote_status ?? null,
    application_url: post.application_url ?? null,
    is_hiring_manager_or_recruiter: post.is_hiring_manager_or_recruiter ?? null,
    is_recruiting_post: post.is_recruiting_post ?? false,
    is_product_design_role: post.is_product_design_role ?? false,
    confidence: post.confidence ?? null,
    classification_reason: post.classification_reason ?? null,
    // Phase 5 deterministic score and derived status (§14, §17).
    relevance_score: post.relevance_score ?? 0,
    status: post.status ?? 'irrelevant',
    // Phase 5 explainability (migration 002).
    score_explain: post.score_explain ?? null,
    score_breakdown: post.score_breakdown ?? null,
    is_notified: false,
  };
}

/**
 * Creates a single linkedin_post record.
 * Handles the UNIQUE constraint on linkedin_url gracefully — returns
 * { created: false, existing: <row> } if the URL already exists.
 *
 * @param {Object} post
 * @param {string} post.linkedin_url Normalized LinkedIn post URL (required).
 * @param {string} [post.search_run_id] Associated search run.
 * @param {string} [post.source_provider] Search provider used.
 * @param {string} [post.source_query] Query that discovered this post.
 * @param {string} [post.post_text] Snippet text from search result.
 * @param {string} [post.published_at] Parsed publication timestamp.
 * @returns {Promise<{ created: boolean, post: object, existing?: object }>}
 */
export async function createPost(post) {
  if (!post?.linkedin_url) {
    throw new Error('createPost requires a linkedin_url');
  }

  const supabase = getSupabaseClient();

  // Check for existing record first (primary deduplication per §9)
  const existing = await findPostByUrl(post.linkedin_url);
  if (existing) {
    logger.debug('Post already exists, skipping insert', { url: post.linkedin_url });
    return { created: false, post: existing, existing };
  }

  const row = buildPostRow(post);

  const { data, error } = await supabase
    .from('linkedin_posts')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    // Handle race condition: another concurrent run may have inserted between our check and insert
    if (error.code === '23505') {
      logger.debug('Post duplicate detected at DB level (race condition)', { url: post.linkedin_url });
      const existing = await findPostByUrl(post.linkedin_url);
      return { created: false, post: existing, existing };
    }

    logger.error('createPost failed', { url: post.linkedin_url, error: error.message });
    throw new Error(`createPost failed: ${error.message}`);
  }

  logger.info('Post created', { url: post.linkedin_url, id: data.id });
  return { created: true, post: data };
}

/**
 * Creates multiple linkedin_post records in bulk.
 * Skips duplicates gracefully and returns counts.
 *
 * @param {Array<Object>} posts Array of post objects (same shape as createPost input).
 * @returns {Promise<{ created: number, skipped: number, errors: number, posts: Array<object> }>}
 */
export async function createPosts(posts) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { created: 0, skipped: 0, errors: 0, posts: [] };
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;
  const results = [];

  for (const post of posts) {
    try {
      const result = await createPost(post);
      if (result.created) {
        created++;
      } else {
        skipped++;
      }
      results.push(result.post);
    } catch (err) {
      errors++;
      logger.error('createPosts individual insert failed', {
        url: post?.linkedin_url,
        error: err.message,
      });
    }
  }

  logger.info('Bulk post creation completed', { created, skipped, errors, total: posts.length });
  return { created, skipped, errors, posts: results };
}

/**
 * Marks a post as notified (delivered in a digest).
 *
 * @param {string} postId UUID of the linkedin_post.
 * @param {string} [channel='ntfy'] Notification provider used.
 * @returns {Promise<void>}
 */
export async function markPostAsSent(postId, channel = 'ntfy') {
  if (!postId) {
    throw new Error('markPostAsSent requires a postId');
  }

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('linkedin_posts')
    .update(sentPayload(channel))
    .eq('id', postId);

  if (error) {
    logger.error('markPostAsSent failed', { postId, error: error.message });
    throw new Error(`markPostAsSent failed: ${error.message}`);
  }

  logger.info('Post marked as sent', { postId, channel });
}

/**
 * Builds the sent-state columns written after a confirmed delivery.
 *
 * One definition for both marking functions so a single-row mark and a bulk mark
 * can never disagree. `sent_to_digest` and `sent_at` are provider-neutral
 * (migration 004 renamed the digest flag out of its original provider-specific
 * naming); the provider is recorded separately in `notification_channel`.
 *
 * @param {string} channel Notification provider used.
 * @param {string} sentAt ISO timestamp of the delivery.
 * @returns {object}
 */
function sentPayload(channel, sentAt = new Date().toISOString()) {
  return {
    is_notified: true,
    notified_at: sentAt,
    notification_channel: channel,
    sent_to_digest: true,
    sent_at: sentAt,
  };
}

/**
 * Marks several posts as notified in a single update.
 *
 * Callers must only invoke this after a notification has actually been
 * delivered (§22). One statement rather than N keeps the digest's post set and
 * its sent set consistent, so a mid-loop failure cannot mark a partial digest.
 *
 * @param {string[]} postIds UUIDs of the linkedin_posts rows that were sent.
 * @param {string} [channel='ntfy'] Notification provider used.
 * @param {Object} [options]
 * @param {object} [options.client] Supabase client override. Defaults to the shared client.
 * @returns {Promise<number>} Number of posts marked.
 */
export async function markPostsAsSent(postIds, channel = 'ntfy', options = {}) {
  const ids = Array.isArray(postIds) ? postIds.filter(Boolean) : [];

  if (ids.length === 0) {
    return 0;
  }

  const supabase = options.client ?? getSupabaseClient();

  const { error } = await supabase
    .from('linkedin_posts')
    .update(sentPayload(channel))
    .in('id', ids);

  if (error) {
    logger.error('markPostsAsSent failed', { postCount: ids.length, error: error.message });
    throw new Error(`markPostsAsSent failed: ${error.message}`);
  }

  logger.info('Posts marked as sent', { postCount: ids.length, channel });

  return ids.length;
}

/**
 * Records one digest notification in the notifications table.
 *
 * Written after a send attempt so Phase 7 delivery — and any later manual
 * investigation — has an audit trail of what was sent, when, to whom, and, on
 * failure, why. A failed send is recorded with status 'failed' and never marks
 * posts as sent.
 *
 * @param {Object} params
 * @param {string[]} [params.postIds=[]] UUIDs of the posts included in the digest.
 * @param {string} [params.recipient] Delivery target. Defaults to NTFY_TOPIC, so
 *   the audit trail names the topic without the caller having to pass it. For a
 *   mock send it records 'mock-preview'. Never a credential.
 * @param {string} [params.provider='mock'] Notification provider.
 * @param {string} [params.status='sent'] 'sent' or 'failed'.
 * @param {string} [params.providerMessageId] Provider's own delivery identifier.
 * @param {string} [params.errorType] Normalized error code, when status is 'failed'.
 * @param {string} [params.errorMessage] Failure detail, when status is 'failed'.
 * @param {object} [params.client] Supabase client override. Defaults to the shared client.
 * @returns {Promise<string | null>} The notification id, or null when nothing was recorded.
 */
export async function recordDigestNotification(params = {}) {
  const postIds = Array.isArray(params.postIds) ? params.postIds.filter(Boolean) : [];

  if (postIds.length === 0) {
    return null;
  }

  const supabase = params.client ?? getSupabaseClient();
  const recipient = params.recipient || getEnv().NTFY_TOPIC || 'mock-preview';
  const provider = params.provider || 'mock';
  const status = params.status || 'sent';

  const { data, error } = await supabase
    .from('notifications')
    .insert({
      notification_type: 'daily_digest',
      post_count: postIds.length,
      post_ids: postIds,
      recipient,
      provider,
      provider_message_id: params.providerMessageId ?? null,
      status,
      error_type: params.errorType ?? null,
      error_message: params.errorMessage ?? null,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    logger.error('recordDigestNotification failed', { provider, error: error.message });
    throw new Error(`recordDigestNotification failed: ${error.message}`);
  }

  logger.info('Digest notification recorded', { provider, status, postCount: postIds.length });

  return data?.id ?? null;
}

/**
 * Checks whether a successful notification already covers all of these posts.
 *
 * The candidate query already filters on `is_notified = false`, so this is the
 * second of two independent guards: post-level state prevents a re-send in the
 * normal path, and this catches the case where a notification was recorded but
 * marking the posts failed — which re-selects exactly the same id set.
 *
 * Deliberately an all-of match rather than any-of: a digest sharing one post
 * with an earlier digest still has posts the user has never seen, and skipping
 * it would leave those undelivered.
 *
 * @param {string[]} postIds
 * @param {Object} [options]
 * @param {object} [options.client] Supabase client override. Defaults to the shared client.
 * @returns {Promise<boolean>}
 */
export async function hasSentNotificationForPosts(postIds, options = {}) {
  const ids = Array.isArray(postIds) ? postIds.filter(Boolean) : [];

  if (ids.length === 0) {
    return false;
  }

  const supabase = options.client ?? getSupabaseClient();

  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('status', 'sent')
    .contains('post_ids', ids);

  if (error) {
    logger.error('hasSentNotificationForPosts failed', { postCount: ids.length, error: error.message });
    throw new Error(`hasSentNotificationForPosts failed: ${error.message}`);
  }

  return (data || []).length > 0;
}

/**
 * Retrieves all qualified posts that have not yet been sent to the user.
 * Used by the digest generator.
 *
 * `status = 'qualified'` is the only qualification filter. `relevance_score` is
 * deliberately *not* filtered on: eligibility is decided at write time (§14 rule
 * 1) and the score is a priority signal, so a qualified post scoring 45 is a
 * standard-priority match that must still be delivered. Ordering ranks by score
 * so the strongest matches lead the digest.
 *
 * @param {Object} [options]
 * @param {number} [options.limit=50] Maximum posts to return.
 * @returns {Promise<Array<object>>}
 */
export async function getUnsentPosts(options = {}) {
  const supabase = getSupabaseClient();
  const limit = options.limit ?? 50;

  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('*')
    .eq('status', 'qualified')
    .eq('is_notified', false)
    .order('relevance_score', { ascending: false })
    .order('discovered_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('getUnsentPosts query failed', { error: error.message });
    throw new Error(`getUnsentPosts failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Retrieves qualified posts discovered within the digest lookback window (§16, §18).
 *
 * The window is applied to `discovered_at`, not `published_at`: a post enters
 * the digest once, when it is first found. This also keeps posts whose
 * published_at could not be verified, which §18 rule 3 says should still be
 * reported under "Recent Discoveries".
 *
 * `getUnsentPosts` remains available for callers that need every qualified
 * post regardless of discovery time.
 *
 * As in `getUnsentPosts`, qualification is read from `status` alone; the score is
 * never filtered on, so a qualified post below MIN_RELEVANCE_SCORE is retained
 * and merely ordered lower.
 *
 * @param {Object} [options]
 * @param {number} [options.windowHours=168] Lookback window in hours.
 * @param {number} [options.limit=50] Maximum posts to return.
 * @returns {Promise<Array<object>>}
 */
export async function getDigestCandidates(options = {}) {
  const supabase = getSupabaseClient();
  const windowHours = resolveLookbackHours(options);
  const limit = options.limit ?? 50;
  const lowerBoundary = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('*')
    .eq('status', 'qualified')
    .eq('is_notified', false)
    .gte('discovered_at', lowerBoundary)
    .order('relevance_score', { ascending: false })
    .order('discovered_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('getDigestCandidates query failed', { error: error.message });
    throw new Error(`getDigestCandidates failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Retrieves every post discovered in the last 24 hours, regardless of status.
 *
 * The window is applied to `discovered_at` only — no filter is placed on
 * `published_at`, so this includes posts whose publication date could not be
 * verified (§18 rule 3) as well as posts whose `published_at` falls outside the
 * window. It is a raw discovery feed, not a digest source: use
 * `getDigestCandidates` when qualified, unread posts are what you need.
 *
 * @param {Object} [options]
 * @param {number} [options.windowHours=24] Discovery window in hours.
 * @param {number} [options.limit=100] Maximum posts to return.
 * @returns {Promise<Array<object>>}
 */
export async function getPostsFromLast24Hours(options = {}) {
  const supabase = getSupabaseClient();
  const windowHours = options.windowHours ?? 24;
  const limit = options.limit ?? 100;
  const lowerBoundary = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('*')
    .gte('discovered_at', lowerBoundary)
    .order('discovered_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('getPostsFromLast24Hours query failed', { error: error.message });
    throw new Error(`getPostsFromLast24Hours failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Checks whether a normalized LinkedIn URL already exists in the database.
 * Lightweight check for the primary deduplication path (§9).
 *
 * @param {string} linkedinUrl
 * @returns {Promise<boolean>}
 */
export async function postExistsByUrl(linkedinUrl) {
  if (!linkedinUrl) return false;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('id')
    .eq('linkedin_url', linkedinUrl)
    .maybeSingle();

  if (error) {
    logger.error('postExistsByUrl query failed', { linkedinUrl, error: error.message });
    throw new Error(`postExistsByUrl failed: ${error.message}`);
  }

  return data !== null;
}

/**
 * Batch-checks multiple URLs against the database and returns the set
 * of URLs that already exist. Used for efficient pre-AI deduplication.
 *
 * Matching is case-insensitive. A LinkedIn post slug ends in a case-sensitive
 * hash and search indexes publish it inconsistently — `...-7eJh` and `...-7ejh`
 * are both returned for the same post — so an exact comparison would store one
 * opportunity twice under two URLs. Casing is a dedup concern only: the stored
 * `linkedin_url` keeps the exact casing the index gave us, because that string is
 * the link the reader clicks and rewriting it breaks the link.
 *
 * @param {string[]} urls Array of normalized LinkedIn URLs.
 * @param {Object} [options]
 * @param {Object} [options.client] Supabase client override.
 * @returns {Promise<Set<string>>} The subset of `urls` that already exist.
 */
export async function findExistingUrls(urls, options = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return new Set();
  }

  const supabase = options.client ?? getSupabaseClient();

  // The URL column is read in full rather than matched with a per-URL `ilike`,
  // because LinkedIn slugs are full of underscores — a wildcard in ILIKE — so a
  // pattern built from a URL would over-match. One short string per post keeps
  // this read small. If the table ever outgrows it, the durable fix is a stored
  // LinkedIn activity id with a unique index, not a looser comparison.
  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('linkedin_url');

  if (error) {
    logger.error('findExistingUrls query failed', { error: error.message });
    throw new Error(`findExistingUrls failed: ${error.message}`);
  }

  const stored = new Set(
    (data || [])
      .map((row) => row.linkedin_url)
      .filter((url) => typeof url === 'string')
      .map((url) => url.toLowerCase())
  );

  // Returns the *input* URLs, not the stored spellings, so a caller can test
  // membership with the URL it already holds.
  return new Set(urls.filter((url) => stored.has(String(url).toLowerCase())));
}

/**
 * Finds stored rows whose `linkedin_url` differs from a freshly discovered URL by
 * letter case alone.
 *
 * Rows written before the normalizer stopped lowercasing paths hold a link that
 * was never published. Discovery cannot fix them on its own, because a case-only
 * match counts as a duplicate and the post is therefore never rewritten — so the
 * wrong casing would otherwise persist for the life of the row.
 *
 * @param {string[]} urls Normalized URLs just returned by search.
 * @param {Object} [options]
 * @param {Object} [options.client] Supabase client override.
 * @returns {Promise<Array<{ id: string, stored: string, incoming: string }>>}
 */
export async function findUrlCaseDrift(urls, options = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  const supabase = options.client ?? getSupabaseClient();

  const { data, error } = await supabase
    .from('linkedin_posts')
    .select('id, linkedin_url');

  if (error) {
    logger.error('findUrlCaseDrift query failed', { error: error.message });
    throw new Error(`findUrlCaseDrift failed: ${error.message}`);
  }

  const byLowercase = new Map();
  for (const row of data || []) {
    if (typeof row.linkedin_url === 'string') {
      byLowercase.set(row.linkedin_url.toLowerCase(), row);
    }
  }

  const drift = [];

  for (const incoming of urls) {
    const row = byLowercase.get(String(incoming).toLowerCase());

    // Only a pure case difference qualifies. Anything else means the search index
    // returned a different post, and rewriting it would corrupt the row.
    if (row && row.linkedin_url !== incoming) {
      drift.push({ id: row.id, stored: row.linkedin_url, incoming });
    }
  }

  return drift;
}

/**
 * Rewrites stored URLs to the casing the search index currently publishes.
 *
 * Each candidate is re-checked for a case-only difference immediately before the
 * write, so a stale or wrong candidate cannot repoint a row at a different post.
 * A failure is logged rather than thrown: a stale link is a cosmetic problem and
 * must not fail a scan whose rows are already saved.
 *
 * @param {Array<{ id: string, stored: string, incoming: string }>} drift
 * @param {Object} [options]
 * @param {Object} [options.client] Supabase client override.
 * @returns {Promise<number>} Rows actually rewritten.
 */
export async function realignUrlCase(drift, options = {}) {
  if (!Array.isArray(drift) || drift.length === 0) {
    return 0;
  }

  const supabase = options.client ?? getSupabaseClient();
  let repaired = 0;

  for (const { id, stored, incoming } of drift) {
    if (!id || !incoming || !stored || stored.toLowerCase() !== incoming.toLowerCase()) {
      continue;
    }

    try {
      const { error } = await supabase
        .from('linkedin_posts')
        .update({ linkedin_url: incoming })
        .eq('id', id);

      if (error) {
        logger.error('Failed to realign stored URL case', { id, error: error.message });
        continue;
      }

      repaired++;
      logger.info('Realigned stored URL casing', { id, from: stored, to: incoming });
    } catch (err) {
      logger.error('Failed to realign stored URL case', { id, error: err.message });
    }
  }

  return repaired;
}
