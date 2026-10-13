/**
 * Notification layer (Phase 6 digest + Phase 7 delivery).
 *
 * Public surface for the rest of the application:
 *
 *   createNotifier(config).send(message)  →  normalized delivery result
 *   deliverDigest({ digest, notifier })   →  send, record, then mark posts sent
 *
 * Provider selection happens once, in createNotifier. No caller branches on the
 * provider name.
 */

export {
  DEFAULT_NOTIFICATION_PROVIDER,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  NTFY_DEFAULT_BASE_URL,
  NTFY_DIGEST_TITLE,
  NOTIFICATION_PROVIDERS,
  assertNotificationSettings,
  createNotifier,
  describeNotificationSettings,
  resolveNotificationSettings,
  validateNotificationSettings,
} from './notifier.js';

export {
  NOTIFICATION_ERRORS,
  buildNotificationResult,
  isRetryableNotificationError,
} from './result.js';

export { buildMockMessageId, createMockNotifier, renderMockOutput, sendMockNotification } from './mock.js';

export {
  buildRequestHeaders,
  buildTopicUrl,
  createNtfyNotifier,
  encodeHeaderValue,
  readNtfyMessageId,
  sanitizeErrorBody,
  sendNtfyMessage,
} from './ntfy.js';

export { deliverDigest } from './deliver.js';

export {
  createEmailNotifier,
  renderEmailHtml,
  readResendMessageId,
  sanitizeEmailErrorBody,
  sendEmailMessage,
  RESEND_ENDPOINT,
} from './email.js';