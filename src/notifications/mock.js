/**
 * Mock Notification Provider (Phase 7).
 *
 * Prints the digest locally and reports success, so the full Phase 6 → Phase 7
 * flow is runnable with no credentials and no network access.
 *
 * The message id is a content hash rather than a random string, so the same
 * digest always produces the same id. That makes a test assertion stable and
 * makes a repeated mock run visibly identical instead of looking like a new
 * delivery.
 *
 * This provider contacts nothing. Whether a mock send also updates post sent
 * state is decided by the caller (`NOTIFICATION_MARK_MOCK_SENT`), because
 * marking posts as notified from a print would drop them from the next real
 * delivery.
 */

import { sha256 } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { buildNotificationResult, NOTIFICATION_ERRORS } from './result.js';

const BAR = '----------------------------------------------------';

/**
 * Validates the message before anything is printed.
 *
 * @param {unknown} message
 * @returns {{ valid: boolean, error: string | null }}
 */
function validateMessage(message) {
  if (typeof message !== 'string') {
    return { valid: false, error: 'Message must be a string.' };
  }

  if (message.trim().length === 0) {
    return { valid: false, error: 'Message must be a non-empty string.' };
  }

  return { valid: true, error: null };
}

/**
 * Builds the deterministic mock message id.
 *
 * @param {string} message
 * @returns {string}
 */
export function buildMockMessageId(message) {
  return `mock-${sha256(message).slice(0, 12)}`;
}

/**
 * Renders the console output for a mock delivery.
 *
 * @param {string} message
 * @param {string} messageId
 * @returns {string}
 */
export function renderMockOutput(message, messageId) {
  return [
    BAR,
    '📲 MOCK NOTIFICATION',
    BAR,
    '',
    message,
    '',
    BAR,
    'Mock delivery successful',
    `Message ID: ${messageId}`,
    BAR,
  ].join('\n');
}

/**
 * Creates the mock notifier.
 *
 * @param {Object} [options]
 * @param {object} [options.logger] Injected logger.
 * @param {Console} [options.console] Injected console. Defaults to globalThis.console.
 * @returns {{ name: 'mock', send: (message: string) => Promise<object> }}
 */
export function createMockNotifier(options = {}) {
  // Defaults to the shared logger so a mock run is as observable as a real one;
  // an injected logger still wins.
  const log = options.logger ?? logger;
  const out = options.console ?? globalThis.console;

  return {
    name: 'mock',

    /**
     * Prints the message and reports a normalized success.
     *
     * Never throws: an invalid message comes back as a normalized failure so the
     * caller has one code path for every provider.
     *
     * @param {string} message Digest text produced by Phase 6.
     * @returns {Promise<object>} Normalized notification result.
     */
    async send(message) {
      const check = validateMessage(message);

      if (!check.valid) {
        log?.error('[Notification] Delivery failed', {
          provider: 'mock',
          errorType: NOTIFICATION_ERRORS.INVALID_MESSAGE,
          error: check.error,
        });

        return buildNotificationResult('mock', {
          success: false,
          errorType: NOTIFICATION_ERRORS.INVALID_MESSAGE,
          error: check.error,
        });
      }

      const messageId = buildMockMessageId(message);

      log?.info('[Notification] Sending digest...');
      out.log(renderMockOutput(message, messageId));
      log?.info('[Notification] Delivery successful', { provider: 'mock', messageId });

      return buildNotificationResult('mock', {
        success: true,
        messageId,
      });
    },
  };
}

/**
 * Convenience wrapper matching the provider function signature used by the
 * transport modules.
 *
 * @param {string} message
 * @param {Object} [options] Passed to createMockNotifier.
 * @returns {Promise<object>} Normalized notification result.
 */
export async function sendMockNotification(message, options = {}) {
  return createMockNotifier(options).send(message);
}

export default createMockNotifier;
