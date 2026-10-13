/**
 * ntfy Notification Provider (Phase 7).
 *
 * One HTTPS request per digest chunk to the ntfy HTTP API:
 *
 *   POST <NTFY_BASE_URL>/<NTFY_TOPIC>
 *   Content-Type: text/plain; charset=utf-8
 *   Title: DesignRadar — Daily Digest
 *
 * Plain text rather than JSON on purpose: the Phase 6 digest is already the
 * message body, and `text/plain` keeps the request readable and the payload
 * byte-identical to what the formatter produced.
 *
 * ntfy needs no credentials for an open topic, so NTFY_TOKEN is only attached
 * when configured (a reserved topic, or a self-hosted server that requires it).
 * Every failure is normalized before it leaves this module for the same two
 * reasons the rest of the notification layer does: the pipeline decides
 * "retry later" from an error type rather than a provider payload, and an error
 * body is untrusted — it can echo the request headers back at us. The token is
 * therefore stripped from every message that reaches a log or the database.
 */

import { logger } from '../utils/logger.js';
import { assertNotificationSettings, resolveNotificationSettings } from './config.js';
import { buildNotificationResult, NOTIFICATION_ERRORS } from './result.js';

/** Longest error snippet kept for diagnosis. Matches the other adapters' bound. */
const MAX_ERROR_SNIPPET = 300;

/**
 * Maps an HTTP status to a normalized error code.
 *
 * @param {number} status
 * @returns {string}
 */
function errorTypeForStatus(status) {
  if (status === 401) return NOTIFICATION_ERRORS.AUTHENTICATION;
  if (status === 403) return NOTIFICATION_ERRORS.PERMISSION_DENIED;
  if (status === 429) return NOTIFICATION_ERRORS.RATE_LIMIT;
  if (status === 400) return NOTIFICATION_ERRORS.BAD_REQUEST;
  if (status === 404) return NOTIFICATION_ERRORS.NOT_FOUND;
  if (status === 409) return NOTIFICATION_ERRORS.CONFLICT;
  if (status === 413) return NOTIFICATION_ERRORS.MESSAGE_TOO_LARGE;
  if (status === 503) return NOTIFICATION_ERRORS.SERVICE_UNAVAILABLE;
  if (status === 504) return NOTIFICATION_ERRORS.TIMEOUT;
  if (status >= 500) return NOTIFICATION_ERRORS.SERVER_ERROR;

  return NOTIFICATION_ERRORS.UNKNOWN;
}

/**
 * Reduces an error body to a short, credential-free string.
 *
 * The body is untrusted: it can be JSON from ntfy, HTML from a reverse proxy,
 * an empty string, or a proxy transcript quoting the request. Any occurrence of
 * the token is replaced before the text is used anywhere.
 *
 * @param {string} body
 * @param {string} [token]
 * @returns {string}
 */
export function sanitizeErrorBody(body, token = '') {
  let text = typeof body === 'string' ? body : '';

  if (token) {
    text = text.split(token).join('[redacted]');
  }

  text = text.replace(/\s+/g, ' ').trim();

  return text.length > MAX_ERROR_SNIPPET ? `${text.slice(0, MAX_ERROR_SNIPPET)}…` : text;
}

/**
 * Builds the topic endpoint URL.
 *
 * The topic is percent-encoded rather than concatenated raw: an unencoded value
 * containing `/` or `..` would silently address a different endpoint, and a
 * configured topic should never be able to redirect the request elsewhere.
 *
 * @param {{ baseUrl: string, topic: string }} config
 * @returns {string}
 */
export function buildTopicUrl(config) {
  return `${config.baseUrl}/${encodeURIComponent(config.topic)}`;
}

/**
 * Makes a header value safe for `fetch`, without changing the bytes ntfy reads.
 *
 * Node's fetch only accepts ByteString header values, so the em dash in the
 * title ("DesignRadar — Daily Digest") throws a TypeError before a request is
 * even built. Widening the value to UTF-8 bytes and reading it back as latin1
 * puts the *same* bytes on the wire, which is what ntfy — a Go server that reads
 * header bytes without reinterpreting them — needs to render the title
 * correctly. ASCII input is returned untouched, so nothing is perturbed for the
 * common case.
 *
 * `Buffer` is deliberately avoided: this module also runs in the Supabase Edge
 * (Deno) runtime, where `Buffer` does not exist and referencing it throws
 * ReferenceError at send time.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeHeaderValue(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');

  // ByteString-clean already: leave it exactly as it is.
  if (!/[^\x00-\xff]/.test(text)) return text;

  const bytes = new TextEncoder().encode(text);
  let widened = '';

  // Chunked rather than String.fromCharCode(...bytes) so a long header cannot
  // exceed the call stack.
  for (let index = 0; index < bytes.length; index += 1) {
    widened += String.fromCharCode(bytes[index]);
  }

  return widened;
}

/**
 * Builds the request headers.
 *
 * Title, Priority and Tags are optional presentation hints — the digest is
 * readable without any of them — so they are only sent when configured, and an
 * old or minimal ntfy server that ignores them still receives the message.
 *
 * The token is only ever sent as an Authorization header, never as a query
 * parameter, so it cannot end up in a proxy log line.
 *
 * @param {{ title?: string, priority?: string, tags?: string, token?: string }} metadata
 * @returns {Record<string, string>}
 */
export function buildRequestHeaders(metadata = {}) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };

  if (metadata.title) headers.Title = encodeHeaderValue(metadata.title);
  if (metadata.priority) headers.Priority = encodeHeaderValue(metadata.priority);
  if (metadata.tags) headers.Tags = encodeHeaderValue(metadata.tags);
  if (metadata.token) headers.Authorization = `Bearer ${metadata.token}`;

  return headers;
}

/**
 * Extracts ntfy's own message id from a 2xx response, when the server sent one.
 *
 * Only used for the audit trail: unlike providers that confirm acceptance with
 * an id, ntfy confirms by accepting the publish, so a 2xx is the delivery
 * signal and a missing id never turns a real send into a failure. Nothing is
 * invented when the body is absent or unparseable.
 *
 * @param {string} body Raw response body.
 * @returns {string | null}
 */
export function readNtfyMessageId(body) {
  if (typeof body !== 'string' || body.trim() === '') return null;

  try {
    const payload = JSON.parse(body);
    const id = payload?.id;

    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  } catch {
    // Not JSON (or not the documented envelope): no id to record, still a 2xx.
    return null;
  }
}

/**
 * Creates the ntfy notifier.
 *
 * @param {ReturnType<import('./config.js').resolveNotificationSettings>} settings
 * @param {Object} [deps]
 * @param {typeof fetch} [deps.fetchFn] Injected HTTP client.
 * @param {object} [deps.logger] Injected logger.
 * @returns {{ name: 'ntfy', send: (message: string) => Promise<object> }}
 */
export function createNtfyNotifier(settings, deps = {}) {
  const log = deps.logger ?? logger;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const { ntfy, timeoutMs } = settings;

  return {
    name: 'ntfy',

    /**
     * Publishes one digest chunk to the configured ntfy topic.
     *
     * @param {string} message Digest text produced by Phase 6.
     * @returns {Promise<object>} Normalized notification result.
     */
    async send(message) {
      if (typeof message !== 'string' || message.trim() === '') {
        // Checked before the request so an empty chunk never reaches ntfy.
        return buildNotificationResult('ntfy', {
          success: false,
          errorType: NOTIFICATION_ERRORS.INVALID_MESSAGE,
          error: 'Message must be a non-empty string.',
        });
      }

      // Re-checked here as well: createNotifier validates config once, but a
      // caller can hold a notifier whose settings were mutated underneath it,
      // so the topic is read per send rather than captured at construction.
      if (!ntfy.topic) {
        return buildNotificationResult('ntfy', {
          success: false,
          errorType: NOTIFICATION_ERRORS.MISSING_CONFIGURATION,
          error: 'NTFY_TOPIC is not configured.',
        });
      }

      const url = buildTopicUrl(ntfy);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      log?.info('[Notification] Sending digest via ntfy', {
        baseUrl: ntfy.baseUrl,
        messageChars: message.length,
      });

      let response;
      let body = '';

      try {
        // The timer covers the body read as well as the headers: a server that
        // accepts the publish and then stalls mid-body would otherwise hang the run.
        response = await fetchFn(url, {
          method: 'POST',
          headers: buildRequestHeaders(ntfy),
          body: message,
          signal: controller.signal,
        });

        body = await response.text().catch(() => '');
      } catch (err) {
        // An abort is a timeout, not a network fault.
        const timedOut = err?.name === 'AbortError';
        const detail = sanitizeErrorBody(err?.message, ntfy.token);

        return buildNotificationResult('ntfy', {
          success: false,
          errorType: timedOut ? NOTIFICATION_ERRORS.TIMEOUT : NOTIFICATION_ERRORS.NETWORK,
          error: timedOut
            ? `ntfy notification failed: timeout after ${timeoutMs}ms`
            : `ntfy notification failed: network error${detail ? `: ${detail}` : ''}`,
          requested: true,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errorType = errorTypeForStatus(response.status);

        return buildNotificationResult('ntfy', {
          success: false,
          errorType,
          error:
            `ntfy notification failed: HTTP ${response.status}: ` +
            `${sanitizeErrorBody(body, ntfy.token) || response.statusText || 'no details'}`,
          status: response.status,
          requested: true,
        });
      }

      log?.info('[Notification] Delivery successful', {
        provider: 'ntfy',
        status: response.status,
      });

      return buildNotificationResult('ntfy', {
        success: true,
        // Whatever ntfy actually returned; null when the server sent no id.
        messageId: readNtfyMessageId(body),
        status: response.status,
        requested: true,
      });
    },
  };
}

/**
 * Convenience wrapper for one-off sends.
 *
 * Forces the ntfy provider regardless of NOTIFICATION_PROVIDER, so calling it
 * directly cannot accidentally print to the console. Resolves and validates
 * settings through config.js rather than the factory, which keeps this module
 * free of an import cycle with notifier.js.
 *
 * @param {string} message
 * @param {Object} [options] Notification settings plus provider dependencies.
 * @returns {Promise<object>} Normalized notification result.
 */
export async function sendNtfyMessage(message, options = {}) {
  const { fetchFn, logger: log, env, ...overrides } = options;
  const settings = resolveNotificationSettings({ provider: 'ntfy', ...overrides }, env);

  assertNotificationSettings(settings);

  return createNtfyNotifier(settings, { fetchFn, logger: log }).send(message);
}

export default createNtfyNotifier;