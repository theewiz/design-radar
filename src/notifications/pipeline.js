/**
 * Digest Pipeline Entry Points (Phases 6 + 7).
 *
 * `runDigest` renders the digest and `notifyDigest` hands it to a provider. They
 * live here rather than in `src/index.js` so the radar orchestrator can call them
 * without importing the CLI entry point, which imports the orchestrator back.
 */

import { isDatabaseConfigured } from '../database/supabase.js';
import { generateDigest, resolveLookbackHours } from './digest.js';
import { buildMockPosts } from './mock-posts.js';
import { createNotifier, deliverDigest, resolveNotificationSettings } from './index.js';
import { logger } from '../utils/logger.js';

/**
 * Runs the daily digest (Phase 6).
 *
 * Uses live rows when Supabase is configured, otherwise falls back to mock posts
 * so the digest can be previewed locally. Generating the message never marks a
 * post as notified — that happens only in Phase 7, after a provider confirms.
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.windowHours] Lookback window; defaults to DIGEST_LOOKBACK_HOURS or 168.
 * @param {boolean} [options.forceMock=false] Skip the database even if configured.
 * @param {boolean} [options.preview=true] Print the Phase 6 preview banner.
 * @returns {Promise<object>} Digest result.
 */
export async function runDigest(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const dbReady = isDatabaseConfigured();
  const useMock = options.forceMock === true || !dbReady;

  const windowHours = resolveLookbackHours(options);

  if (useMock) {
    logger.warn('Database not configured — generating digest from mock posts', {
      dbReady,
      hint: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use live posts.',
    });
  }

  // MIN_RELEVANCE_SCORE is deliberately not read here: the digest selects on
  // status and orders by relevance_score, so a threshold could only ever discard
  // posts that were legitimately qualified for storage.
  const result = await generateDigest({
    ...options,
    now,
    windowHours,
    posts: useMock ? buildMockPosts({ now }) : null,
  });

  return { ...result, dbReady, mock: useMock };
}

/**
 * Sends a digest through the configured provider (Phase 7).
 *
 * The pipeline never branches on the provider name: it hands the digest to the
 * notifier and reads a normalized result. Posts are marked as sent only when
 * that result reports a confirmed delivery.
 *
 * @param {Object} params
 * @param {object} params.digest Phase 6 digest result.
 * @param {object} [params.notificationSettings] Resolved by resolveNotificationSettings.
 * @param {object} [params.notifier] Pre-built notifier, mainly for tests.
 * @returns {Promise<object>} Delivery outcome.
 */
export async function notifyDigest(params = {}) {
  const { digest } = params;
  const settings = params.notificationSettings ?? resolveNotificationSettings();

  // Mock fixtures carry synthetic ids, so writing them would corrupt a real
  // notifications row.
  const fromDatabase = digest?.source === 'database' && digest?.dbReady !== false;

  // A printed digest is not a delivery. Without this opt-in, a local mock run
  // against the live database would mark posts as sent and silently remove them
  // from the next real digest.
  const persist = fromDatabase && (settings.provider !== 'mock' || settings.markMockAsSent);

  if (!fromDatabase) {
    logger.warn('[Notification] Preview digest from mock rows — nothing will be recorded or marked');
  } else if (!persist) {
    logger.warn('[Notification] Mock provider: not recording or marking posts', {
      hint: 'Set NOTIFICATION_MARK_MOCK_SENT=true only if you intend to consume the post queue.',
    });
  }

  const notifier = params.notifier ?? createNotifier(settings);

  const result = await deliverDigest({
    digest,
    notifier,
    recipient: settings.recipient,
    persist,
  });

  console.log('----------------------------------------------------');
  console.log(`Notification Provider: ${result.provider}`);

  if (result.skipped) {
    console.log(`Notification skipped: ${result.reason.replace(/_/g, ' ')}`);
  } else if (result.success) {
    console.log('Notification Status: DELIVERED');
    console.log(`Message ID: ${result.messageId}`);
    if (result.markedCount > 0) {
      console.log(`Posts marked as sent: ${result.markedCount}`);
    }
  } else {
    console.log('Notification Status: FAILED');
    console.log(`Error type: ${result.errorType}`);
    console.log(`Error: ${result.error}`);
    console.log('Posts left unsent — the next run will retry them.');
  }

  return result;
}

/**
 * Generates the daily digest and delivers it (Phases 6 + 7).
 *
 * The digest-only CLI mode, and the shape Phase 8's Edge Function will reuse.
 *
 * @param {Object} [options] Passed through to runDigest.
 * @returns {Promise<object>} The digest, with `delivery` attached.
 */
export async function runDigestAndNotify(options = {}) {
  // Preview suppressed: delivery prints the message itself, so rendering it
  // twice would look like two different digests.
  const digest = await runDigest({ ...options, preview: false });
  const delivery = await notifyDigest({ digest });

  return { ...digest, delivery };
}
