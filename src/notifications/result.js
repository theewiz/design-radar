/**
 * Normalized notification results (Phase 7).
 *
 * Shared by every provider so a delivery outcome has one shape regardless of
 * transport. Kept in its own module because both the provider factory and the
 * providers themselves need it; defining it in either would create an import
 * cycle.
 */

/**
 * Normalized failure codes.
 *
 * Names are stable: they are written to notifications.error_type and are what a
 * later run reasons about. Mirrors the Gemini taxonomy in src/ai/classify.js so
 * both external dependencies classify their failures the same way.
 */
export const NOTIFICATION_ERRORS = Object.freeze({
  /** The provider name is not one this build supports. */
  INVALID_PROVIDER: 'invalid_provider',
  /** A required credential or identifier is missing. No request was attempted. */
  MISSING_CONFIGURATION: 'missing_configuration',
  /** The message was empty or not a string. No request was attempted. */
  INVALID_MESSAGE: 'invalid_message',
  /** 401 — bad or expired token. Never retried. */
  AUTHENTICATION: 'authentication',
  /** 403 — token valid but not permitted. Never retried. */
  PERMISSION_DENIED: 'permission_denied',
  /** 429 — transient. A later run retries because posts stay unsent. */
  RATE_LIMIT: 'rate_limit',
  /** 400 — the API rejected the request payload. */
  BAD_REQUEST: 'bad_request',
  /** 404 — unknown endpoint or topic. */
  NOT_FOUND: 'not_found',
  /** 409 — conflicting state. */
  CONFLICT: 'conflict',
  /** 413 — the message exceeds the provider's size limit. Resending it as-is
   *  would fail identically, so this is never retried. */
  MESSAGE_TOO_LARGE: 'message_too_large',
  /** 5xx other than 503. */
  SERVER_ERROR: 'server_error',
  /** 503 — provider temporarily unavailable. */
  SERVICE_UNAVAILABLE: 'service_unavailable',
  /** 504, or a request that exceeded the configured timeout. */
  TIMEOUT: 'timeout',
  /** The request never produced a response (DNS, TLS, socket). */
  NETWORK: 'network',
  /** 2xx whose body did not confirm a delivery confirmation. */
  MALFORMED_RESPONSE: 'malformed_response',
  /** Anything not classified above. */
  UNKNOWN: 'unknown',
});

/**
 * Failures worth retrying on a later run. Every one of them leaves posts unsent,
 * so the next run re-sends rather than dropping the opportunity.
 */
const RETRYABLE_ERRORS = new Set([
  NOTIFICATION_ERRORS.RATE_LIMIT,
  NOTIFICATION_ERRORS.SERVER_ERROR,
  NOTIFICATION_ERRORS.SERVICE_UNAVAILABLE,
  NOTIFICATION_ERRORS.TIMEOUT,
  NOTIFICATION_ERRORS.NETWORK,
]);

/**
 * @param {unknown} errorType
 * @returns {boolean} True when a later run could plausibly succeed.
 */
export function isRetryableNotificationError(errorType) {
  return RETRYABLE_ERRORS.has(errorType);
}

/**
 * Builds the normalized result every provider returns.
 *
 * @param {string} provider Provider name.
 * @param {Object} [fields]
 * @param {boolean} [fields.success]
 * @param {string} [fields.messageId]
 * @param {string} [fields.errorType]
 * @param {string} [fields.error]
 * @param {number|null} [fields.status] Provider HTTP status, when there was one.
 * @param {number|null} [fields.retryAfterMs]
 * @param {boolean} [fields.requested] Whether an HTTP request was attempted.
 * @returns {{ success: boolean, provider: string, messageId: string|null, errorType: string|null, error: string|null, status: number|null, retryAfterMs: number|null, retryable: boolean, requested: boolean }}
 */
export function buildNotificationResult(provider, fields = {}) {
  const success = fields.success === true;
  const errorType = success ? null : fields.errorType || NOTIFICATION_ERRORS.UNKNOWN;

  return {
    success,
    provider,
    messageId: fields.messageId ?? null,
    errorType,
    error: success ? null : fields.error || 'Notification delivery failed',
    status: fields.status ?? null,
    retryAfterMs: fields.retryAfterMs ?? null,
    retryable: success ? false : isRetryableNotificationError(errorType),
    requested: fields.requested === true,
  };
}
