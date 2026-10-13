/**
 * Digest Delivery (Phase 7).
 *
 * The only place that turns a successful send into persisted state, and the only
 * reason that ordering is safe:
 *
 *   Generate Digest → Send → Provider confirms → Record → Mark posts sent
 *
 * A failed send records the failure and marks nothing, so the posts stay in the
 * candidate query and the next run retries them. Marking posts before the
 * provider answers is the one mistake this module is built to prevent: it would
 * silently discard the very opportunities the digest exists to deliver.
 */

import { logger } from '../utils/logger.js';
import { markPostsAsSent, hasSentNotificationForPosts, recordDigestNotification } from '../database/posts.js';

// ─── Input Validation ─────────────────────────────────────────────────────────────

/**
 * Validates the digest handed in by Phase 6.
 *
 * @param {object} digest
 * @returns {{ valid: boolean, error: string | null, postIds: string[], chunks: string[] }}
 */
function inspectDigest(digest) {
  if (!digest || typeof digest !== 'object') {
    return { valid: false, error: 'A digest object is required.', postIds: [], chunks: [] };
  }

  if (typeof digest.message !== 'string' || digest.message.trim() === '') {
    return { valid: false, error: 'Digest message must be a non-empty string.', postIds: [], chunks: [] };
  }

  const included = Array.isArray(digest.included) ? digest.included : [];
  const postIds = included.map((p) => p?.id).filter((id) => typeof id === 'string' && id !== '');

  // Phase 6 already split the digest to fit a provider's per-message limit.
  // Delivering the joined message instead would silently exceed that limit, so
  // the chunks are sent individually and the limit stays meaningful.
  const chunks =
    Array.isArray(digest.chunks) && digest.chunks.length > 0
      ? digest.chunks.filter((chunk) => typeof chunk === 'string' && chunk.trim() !== '')
      : [digest.message];

  return { valid: true, error: null, postIds, chunks };
}

// ─── Outcome Builders ─────────────────────────────────────────────────────────────

/**
 * Builds the shape every exit from deliverDigest returns.
 *
 * @param {object} overrides
 * @returns {object}
 */
function outcome(overrides) {
  return {
    attempted: false,
    success: false,
    provider: null,
    messageId: null,
    errorType: null,
    error: null,
    notificationId: null,
    markedCount: 0,
    persisted: false,
    ...overrides,
  };
}

/**
 * Sends every chunk and stops at the first failure.
 *
 * Sequential on purpose: parallel publishes against one topic arrive out of
 * order, and the digest's newest-first ordering is most of its value.
 *
 * @param {{ send: Function }} notifier
 * @param {string[]} chunks
 * @returns {Promise<object>} Aggregated result with every provider message id.
 */
async function sendChunks(notifier, chunks) {
  const messageIds = [];

  for (const chunk of chunks) {
    let result;

    try {
      result = await notifier.send(chunk);
    } catch (err) {
      // Providers normalize their own faults, so a throw here means a defect in
      // the notifier. It must not abort the run and must not be treated as a
      // confirmed delivery.
      logger.error('[Notification] Provider threw instead of returning a result', {
        provider: notifier.name,
        error: err.message,
      });

      return outcome({
        attempted: true,
        provider: notifier.name,
        errorType: 'unknown',
        error: `Provider threw instead of returning a result: ${err.message}`,
        status: null,
        retryable: true,
        chunkIndex: messageIds.length,
        messageIds,
      });
    }

    if (!result || typeof result.success !== 'boolean') {
      return outcome({
        attempted: true,
        provider: notifier.name,
        errorType: 'unknown',
        error: 'Provider returned a result without a success flag.',
        chunkIndex: messageIds.length,
        messageIds,
      });
    }

    // `success: true` alongside an error type is contradictory, and marking posts
    // on contradictory data is exactly the failure this module prevents. Treated
    // as a failure so the posts stay in the next run's candidate query.
    if (!result.success || result.errorType) {
      return {
        ...result,
        success: false,
        attempted: true,
        chunkIndex: messageIds.length,
        messageIds,
      };
    }

    messageIds.push(result.messageId ?? null);
  }

  return {
    success: true,
    provider: notifier.name,
    messageId: messageIds[0] ?? null,
    messageIds,
    errorType: null,
    error: null,
  };
}

// ─── Delivery ─────────────────────────────────────────────────────────────────────

/**
 * Sends a digest through a notifier and, only on confirmed success, records the
 * notification and marks its posts as sent.
 *
 * @param {Object} params
 * @param {object} params.digest Phase 6 digest result.
 * @param {{ name: string, send: (message: string) => Promise<object> }} params.notifier
 * @param {object} [params.client] Supabase client override.
 * @param {boolean} [params.persist=true] Write the notification record and mark posts.
 *   False for mock previews that must not touch post state.
 * @param {boolean} [params.markAsSent] Mark posts after a confirmed send. Defaults to
 *   `persist`. Never true when `persist` is false: a mark without a record would
 *   drop posts with no audit trail.
 * @param {string} [params.recipient] Delivery target recorded with the notification.
 * @returns {Promise<object>} Delivery outcome, including whether posts were marked.
 */
export async function deliverDigest(params = {}) {
  const { digest, notifier } = params;
  const persist = params.persist !== false;
  const markAsSent = persist && params.markAsSent !== false;

  if (!notifier || typeof notifier.send !== 'function') {
    throw new TypeError('deliverDigest requires a notifier with a send() method.');
  }

  const check = inspectDigest(digest);

  if (!check.valid) {
    logger.error('[Notification] Delivery failed', {
      provider: notifier.name,
      error: check.error,
    });

    return outcome({
      provider: notifier.name,
      errorType: 'invalid_message',
      error: check.error,
    });
  }

  // An empty digest is a legitimate outcome, not a delivery. Sending "nothing
  // found" as a notification is noise, and there are no posts to mark either way.
  if (check.postIds.length === 0) {
    logger.info('[Notification] Skipped: digest contains no posts to deliver');

    return outcome({
      provider: notifier.name,
      skipped: true,
      reason: 'empty_digest',
    });
  }

  // Duplicate protection: if a previous successful notification already covers
  // these posts, re-sending would deliver the same opportunity twice. Scoped to
  // the whole id set on purpose — a digest that merely shares one post with an
  // earlier digest still has new posts the user has not seen.
  if (persist) {
    try {
      const alreadyDelivered = await hasSentNotificationForPosts(check.postIds, { client: params.client });

      if (alreadyDelivered) {
        logger.info('[Notification] Skipped: a previous notification already delivered these posts', {
          provider: notifier.name,
          postCount: check.postIds.length,
        });

        return outcome({
          provider: notifier.name,
          skipped: true,
          reason: 'already_delivered',
        });
      }
    } catch (err) {
      // A failure to check for duplicates must not silently convert into a
      // duplicate send. Better to fail the run than deliver twice.
      logger.error('[Notification] Duplicate check failed; refusing to send', {
        error: err.message,
      });

      return outcome({
        provider: notifier.name,
        errorType: 'unknown',
        error: `Duplicate check failed: ${err.message}`,
      });
    }
  }

  const result = await sendChunks(notifier, check.chunks);

  logger.info(`[Notification] Delivery ${result.success ? 'successful' : 'failed'}`, {
    provider: result.provider,
    messageId: result.messageId,
    chunkCount: check.chunks.length,
    errorType: result.errorType,
  });

  if (check.chunks.length > 1 && result.messageIds?.length > 1) {
    logger.info('[Notification] Digest sent as multiple messages', {
      provider: result.provider,
      messageIds: result.messageIds,
    });
  }

  if (!result.success) {
    logger.error('[Notification] Error type:', result.errorType);
    logger.warn('[Notification] Posts left unsent so a later run retries them', {
      postCount: check.postIds.length,
      retryable: result.retryable,
    });

    const notificationId = persist
      ? await safeRecord(params, {
          postIds: check.postIds,
          provider: result.provider,
          status: 'failed',
          errorType: result.errorType,
          errorMessage: result.error,
        })
      : null;

    return outcome({
      attempted: true,
      provider: result.provider,
      errorType: result.errorType,
      error: result.error,
      retryable: result.retryable,
      status: result.status,
      retryAfterMs: result.retryAfterMs,
      notificationId,
      persisted: notificationId !== null,
    });
  }

  // Success. Record first, then mark. If the record cannot be written the posts
  // are deliberately left unmarked, per the ordering contract: a mark with no
  // record would discard opportunities with no audit trail. The cost is that the
  // next run may re-send this digest, which is preferable to silently losing
  // posts on a database fault.
  const notificationId = persist
    ? await safeRecord(params, {
        postIds: check.postIds,
        provider: result.provider,
        status: 'sent',
        providerMessageId: result.messageId,
      })
    : null;

  if (persist && notificationId === null) {
    logger.error('[Notification] Delivery confirmed but not recorded; posts left unmarked', {
      provider: result.provider,
      postCount: check.postIds.length,
    });

    return outcome({
      attempted: true,
      success: true,
      provider: result.provider,
      messageId: result.messageId,
      messageIds: result.messageIds,
      recordFailed: true,
      error: 'Delivery confirmed by the provider but the notification record could not be written.',
    });
  }

  let markedCount = 0;

  if (markAsSent) {
    markedCount = await markPostsAsSent(check.postIds, result.provider, { client: params.client });
    logger.info(`[Notification] Marked ${markedCount} posts as sent`, { channel: result.provider });
  }

  return outcome({
    attempted: true,
    success: true,
    provider: result.provider,
    messageId: result.messageId,
    messageIds: result.messageIds,
    notificationId,
    markedCount,
    persisted: persist,
  });
}

/**
 * Records a notification without letting a persistence fault change the delivery
 * outcome.
 *
 * A record that cannot be written is worth knowing about, but the provider
 * already accepted the message; throwing here would invite a duplicate delivery
 * on the next run. The fault is logged and surfaced as a null id instead, which
 * the caller treats as "do not mark".
 *
 * @param {Object} params deliverDigest params.
 * @param {Object} record Record fields.
 * @returns {Promise<string | null>} Notification id, or null.
 */
async function safeRecord(params, record) {
  try {
    return await recordDigestNotification({
      ...record,
      recipient: params.recipient,
      client: params.client,
    });
  } catch (err) {
    logger.error('[Notification] Failed to record the notification', {
      provider: record.provider,
      status: record.status,
      error: err.message,
    });

    return null;
  }
}
