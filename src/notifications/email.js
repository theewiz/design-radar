/**
 * Resend Email Notification Provider (Phase 10).
 *
 * Sends digest notifications through the Resend HTTPS API:
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   Content-Type: application/json
 *
 * The digest text is preserved as the `text` body and an HTML envelope is
 * generated around it so the email renders cleanly in every client. No
 * third-party HTML templating library is introduced.
 *
 * Every failure is normalized before it leaves this module for the same two
 * reasons as the ntfy transport: the pipeline branches on error types, not
 * provider payloads, and an error body is untrusted — it can echo the API key
 * back through an upstream library. The key is therefore never logged.
 *
 * Uses only Web APIs (fetch, URL, TextEncoder) so the module runs in both
 * the Node.js runtime and the Supabase Edge (Deno) runtime without change.
 */

import { logger } from '../utils/logger.js';
import { assertNotificationSettings, resolveNotificationSettings } from './config.js';
import { buildNotificationResult, NOTIFICATION_ERRORS } from './result.js';

/** Resend v1 emails endpoint. */
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Longest error snippet kept in the normalized error string. */
const MAX_ERROR_SNIPPET = 300;

// ─── Response helpers ─────────────────────────────────────────────────────────

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
  if (status === 422) return NOTIFICATION_ERRORS.BAD_REQUEST; // Unprocessable entity
  if (status === 503) return NOTIFICATION_ERRORS.SERVICE_UNAVAILABLE;
  if (status >= 500) return NOTIFICATION_ERRORS.SERVER_ERROR;

  return NOTIFICATION_ERRORS.UNKNOWN;
}

/**
 * Reduces an error body to a short, credential-free string.
 *
 * The Resend API may echo back parts of the request in error details. Any
 * occurrence of the API key is replaced before the text is used anywhere.
 *
 * @param {string} body
 * @param {string} [apiKey]
 * @returns {string}
 */
export function sanitizeEmailErrorBody(body, apiKey = '') {
  let text = typeof body === 'string' ? body : '';

  if (apiKey) {
    text = text.split(apiKey).join('[redacted]');
  }

  text = text.replace(/\s+/g, ' ').trim();

  return text.length > MAX_ERROR_SNIPPET ? `${text.slice(0, MAX_ERROR_SNIPPET)}…` : text;
}

/**
 * Extracts the message id Resend returns from a successful send.
 *
 * Resend returns `{ "id": "<uuid>" }` on 200. Nothing is invented when the body
 * is absent or cannot be parsed — a 2xx is the delivery signal, not the id.
 *
 * @param {string} body Raw response body.
 * @returns {string | null}
 */
export function readResendMessageId(body) {
  if (typeof body !== 'string' || body.trim() === '') return null;

  try {
    const payload = JSON.parse(body);
    const id = payload?.id;

    return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
  } catch {
    return null;
  }
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

/**
 * Escapes a string for safe inclusion inside HTML text content.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converts the plain-text digest into a clean HTML email body.
 *
 * The digest already contains all formatting. This function wraps it in a
 * minimal, readable envelope without introducing a heavy template engine:
 *
 *   - System font stack, 16px base, dark-on-white.
 *   - Bold lines rendered for `*text*` markdown convention used in the digest.
 *   - URLs turned into anchor tags.
 *   - DesignRadar header block.
 *
 * @param {string} text Plain-text digest produced by Phase 6.
 * @param {{ subject?: string }} [options]
 * @returns {string} HTML email body.
 */
export function renderEmailHtml(text, options = {}) {
  const safeText = escapeHtml(text);

  // Convert *bold* markdown to <strong>.
  const withBold = safeText.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');

  // Convert bare URLs (http/https) to anchor tags.
  const withLinks = withBold.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" style="color:#5b6ef5;word-break:break-all;">$1</a>'
  );

  // Convert newlines to <br>.
  const withLineBreaks = withLinks.replace(/\n/g, '<br>\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(options.subject || 'DesignRadar — Daily Digest')}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:32px 40px;text-align:center;">
              <div style="font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">🎨 DesignRadar</div>
              <div style="font-size:13px;color:#8892b0;margin-top:6px;letter-spacing:1px;text-transform:uppercase;">Personal Job Intelligence</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;color:#2d3748;font-size:15px;line-height:1.7;">
              ${withLineBreaks}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fa;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#718096;">
                DesignRadar — delivered by
                <a href="https://resend.com" style="color:#5b6ef5;text-decoration:none;">Resend</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Notifier ─────────────────────────────────────────────────────────────────

/**
 * Creates the Resend email notifier.
 *
 * @param {ReturnType<import('./config.js').resolveNotificationSettings>} settings
 * @param {Object} [deps]
 * @param {typeof fetch} [deps.fetchFn] Injected HTTP client.
 * @param {object} [deps.logger] Injected logger.
 * @returns {{ name: 'email', send: (message: string) => Promise<object> }}
 */
export function createEmailNotifier(settings, deps = {}) {
  const log = deps.logger ?? logger;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const { email, timeoutMs } = settings;

  return {
    name: 'email',

    /**
     * Sends one digest message through Resend.
     *
     * @param {string} message Digest text produced by Phase 6.
     * @returns {Promise<object>} Normalized notification result.
     */
    async send(message) {
      if (typeof message !== 'string' || message.trim() === '') {
        return buildNotificationResult('email', {
          success: false,
          errorType: NOTIFICATION_ERRORS.INVALID_MESSAGE,
          error: 'Message must be a non-empty string.',
        });
      }

      // Guard against a notifier whose settings were mutated after construction.
      if (!email.apiKey) {
        return buildNotificationResult('email', {
          success: false,
          errorType: NOTIFICATION_ERRORS.MISSING_CONFIGURATION,
          error: 'RESEND_API_KEY is not configured.',
        });
      }

      if (!email.to) {
        return buildNotificationResult('email', {
          success: false,
          errorType: NOTIFICATION_ERRORS.MISSING_CONFIGURATION,
          error: 'DESIGN_RADAR_EMAIL_TO is not configured.',
        });
      }

      if (!email.from) {
        return buildNotificationResult('email', {
          success: false,
          errorType: NOTIFICATION_ERRORS.MISSING_CONFIGURATION,
          error: 'DESIGN_RADAR_EMAIL_FROM is not configured.',
        });
      }

      const subject = email.subject || 'DesignRadar — Daily Digest';

      const payload = {
        from: email.from,
        to: [email.to],
        subject,
        text: message,
        html: renderEmailHtml(message, { subject }),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      log?.info('[Notification] Sending digest via Resend email', {
        to: email.to,
        from: email.from,
        subject,
        messageChars: message.length,
      });

      let response;
      let body = '';

      try {
        response = await fetchFn(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${email.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        body = await response.text().catch(() => '');
      } catch (err) {
        const timedOut = err?.name === 'AbortError';
        const detail = sanitizeEmailErrorBody(err?.message, email.apiKey);

        return buildNotificationResult('email', {
          success: false,
          errorType: timedOut ? NOTIFICATION_ERRORS.TIMEOUT : NOTIFICATION_ERRORS.NETWORK,
          error: timedOut
            ? `Email notification failed: timeout after ${timeoutMs}ms`
            : `Email notification failed: network error${detail ? `: ${detail}` : ''}`,
          requested: true,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errorType = errorTypeForStatus(response.status);

        // Never include the API key in the error message.
        const snippet = sanitizeEmailErrorBody(body, email.apiKey) || response.statusText || 'no details';

        // Provide specific guidance for the most likely configuration errors.
        let errorMessage = `Email notification failed: HTTP ${response.status}: ${snippet}`;

        if (response.status === 401) {
          errorMessage = `Email notification failed: HTTP 401 — check RESEND_API_KEY`;
        } else if (response.status === 403) {
          errorMessage = `Email notification failed: HTTP 403 — check DESIGN_RADAR_EMAIL_FROM (sender domain must be verified in Resend)`;
        }

        log?.warn('[Notification] Resend API returned an error', {
          status: response.status,
          errorType,
        });

        return buildNotificationResult('email', {
          success: false,
          errorType,
          error: errorMessage,
          status: response.status,
          requested: true,
        });
      }

      const messageId = readResendMessageId(body);

      log?.info('[Notification] Delivery successful', {
        provider: 'email',
        status: response.status,
        messageId,
      });

      return buildNotificationResult('email', {
        success: true,
        messageId,
        status: response.status,
        requested: true,
      });
    },
  };
}

/**
 * Convenience wrapper for one-off sends.
 *
 * Forces the email provider regardless of NOTIFICATION_PROVIDER. Resolves and
 * validates settings through config.js to stay free of an import cycle with
 * notifier.js.
 *
 * @param {string} message
 * @param {Object} [options] Notification settings plus provider dependencies.
 * @returns {Promise<object>} Normalized notification result.
 */
export async function sendEmailMessage(message, options = {}) {
  const { fetchFn, logger: log, env, ...overrides } = options;
  const settings = resolveNotificationSettings({ provider: 'email', ...overrides }, env);

  assertNotificationSettings(settings);

  return createEmailNotifier(settings, { fetchFn, logger: log }).send(message);
}

export default createEmailNotifier;
