import { getEnv } from '../utils/env.js';

/**
 * Notification Configuration (Phase 7).
 *
 * Lives apart from the factory so providers can resolve and validate settings
 * without importing the factory that constructs them. notifier.js needs the
 * providers, and the providers need this module; keeping it here is what stops
 * that from becoming a cycle.
 *
 * Provider-neutral by design: `recipient`, `timeoutMs` and `markMockAsSent`
 * belong to the delivery contract, while everything transport-specific lives in
 * a `ntfy` sub-object. Adding a second provider must not require renaming a
 * shared field.
 *
 * Nothing here throws while resolving: an invalid provider name is reported by
 * `validateNotificationSettings`, so the config banner can still print what it
 * found before the run fails.
 */

/** Providers this build can deliver through. */
export const NOTIFICATION_PROVIDERS = Object.freeze(['mock', 'ntfy', 'email']);

/**
 * Used when NOTIFICATION_PROVIDER is unset.
 *
 * The shipped default in `.env.example` is `ntfy`, so a configured deployment
 * delivers for real. This code-level fallback stays `mock` so that an unset or
 * absent variable degrades to a local print instead of failing the run before
 * it starts — and so unit tests, which pass `env: {}`, never depend on ntfy.
 */
export const DEFAULT_NOTIFICATION_PROVIDER = 'mock';

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 15_000;

/**
 * Public ntfy server used when NTFY_BASE_URL is unset.
 *
 * Any self-hosted ntfy instance works by pointing NTFY_BASE_URL at it, which is
 * also how the tests point the real provider at a local HTTP server; the host is
 * never compiled into a per-message URL.
 */
export const NTFY_DEFAULT_BASE_URL = 'https://ntfy.sh';

/** Title attached to every digest notification. */
export const NTFY_DIGEST_TITLE = 'DesignRadar — Daily Digest';

export const EMAIL_DEFAULT_SUBJECT = 'DesignRadar — Daily Digest';

/**
 * Resolves notification settings from explicit options, then the environment.
 *
 * Never throws: an invalid provider name is reported by
 * `validateNotificationSettings`, so the config banner can still print what it
 * found before the run fails.
 *
 * @param {Object} [options] Per-call overrides (highest precedence).
 * @param {string} [options.provider]
 * @param {string} [options.recipient] Delivery target recorded with the notification.
 * @param {object} [options.ntfy]
 * @param {object} [options.email]
 * @param {boolean} [options.markMockAsSent] Persist sent state after a mock send.
 * @param {number} [options.timeoutMs]
 * @param {object} [env] Environment source. Defaults to the current runtime environment.
 * @returns {{
 *   provider: string,
 *   recipient: string,
 *   timeoutMs: number,
 *   markMockAsSent: boolean,
 *   ntfy: { baseUrl: string, topic: string, token: string, title: string, priority: string, tags: string },
 *   email: { apiKey: string, from: string, to: string, subject: string }
 * }}
 */
export function resolveNotificationSettings(options = {}, env = getEnv()) {
  const rawProvider = String(options.provider ?? env.NOTIFICATION_PROVIDER ?? DEFAULT_NOTIFICATION_PROVIDER)
    .trim()
    .toLowerCase();

  // Provider-neutral name first so a second transport does not need a new one.
  const rawTimeout = options.timeoutMs ?? env.NOTIFICATION_TIMEOUT_MS ?? env.NTFY_TIMEOUT_MS;
  const parsedTimeout = Number.parseInt(String(rawTimeout ?? '').trim(), 10);

  const topic = String(options.ntfy?.topic ?? options.recipient ?? env.NTFY_TOPIC ?? '').trim();

  const emailTo = String(
    options.email?.to ??
      options.recipient ??
      env.DESIGN_RADAR_EMAIL_TO ??
      env.EMAIL_TO ??
      env.NOTIFICATION_EMAIL_TO ??
      ''
  ).trim();
  const emailFrom = String(
    options.email?.from ?? env.DESIGN_RADAR_EMAIL_FROM ?? env.EMAIL_FROM ?? env.RESEND_FROM ?? ''
  ).trim();
  const emailSubject = String(options.email?.subject ?? env.DESIGN_RADAR_EMAIL_SUBJECT ?? env.EMAIL_SUBJECT ?? EMAIL_DEFAULT_SUBJECT).trim();

  return {
    provider: rawProvider,
    // For ntfy the recipient is the topic. For email it's the to address.
    recipient: String(options.recipient ?? (rawProvider === 'email' ? emailTo : topic) ?? '').trim(),
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_NOTIFICATION_TIMEOUT_MS,
    // A printed digest is not a delivery. Persisting it would mark posts as
    // notified and silently drop them from the next real digest, so this is
    // opt-in and documented in the README.
    markMockAsSent: readBoolean(options.markMockAsSent ?? env.NOTIFICATION_MARK_MOCK_SENT, false),
    ntfy: {
      baseUrl: String(options.ntfy?.baseUrl ?? env.NTFY_BASE_URL ?? NTFY_DEFAULT_BASE_URL)
        .trim()
        .replace(/\/+$/, ''),
      topic,
      // Optional: an open ntfy topic needs no authentication.
      token: String(options.ntfy?.token ?? env.NTFY_TOKEN ?? '').trim(),
      title: String(options.ntfy?.title ?? env.NTFY_TITLE ?? NTFY_DIGEST_TITLE).trim(),
      priority: String(options.ntfy?.priority ?? env.NTFY_PRIORITY ?? 'default').trim(),
      tags: String(options.ntfy?.tags ?? env.NTFY_TAGS ?? 'briefcase,mag').trim(),
    },
    email: {
      apiKey: String(
        options.email?.apiKey ??
          env.RESEND_API_KEY ??
          env.EMAIL_API_KEY ??
          env.DESIGN_RADAR_EMAIL_API_KEY ??
          ''
      ).trim(),
      from: emailFrom,
      to: emailTo,
      subject: emailSubject || EMAIL_DEFAULT_SUBJECT,
    },
  };
}

/**
 * Parses a boolean-ish environment value without treating "false" as truthy.
 *
 * @param {unknown} raw
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;

  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Validates resolved settings, reporting the variables that are missing without
 * ever echoing a credential value.
 *
 * @param {ReturnType<typeof resolveNotificationSettings>} settings
 * @returns {{ valid: boolean, errors: string[], missing: string[] }}
 */
export function validateNotificationSettings(settings) {
  const missing = [];
  const errors = [];

  if (!NOTIFICATION_PROVIDERS.includes(settings?.provider)) {
    errors.push(
      `NOTIFICATION_PROVIDER "${settings?.provider ?? ''}" is not supported. ` +
        `Use one of: ${NOTIFICATION_PROVIDERS.join(', ')}.`
    );

    // Nothing else can be validated meaningfully.
    return { valid: false, errors, missing };
  }

  if (settings.provider === 'ntfy') {
      // Only the topic is required. ntfy serves an open topic without credentials,
      // so requiring a token would block the common private-topic case for no gain.
      if (!settings.ntfy?.topic) {
        missing.push('NTFY_TOPIC');
        errors.push(
          'NOTIFICATION_PROVIDER=ntfy requires: NTFY_TOPIC. ' +
            'Set it in .env, or use NOTIFICATION_PROVIDER=mock for local development.'
        );
      }

      if (!settings.ntfy?.baseUrl) {
        errors.push('NTFY_BASE_URL must not be blank; leave it unset to use https://ntfy.sh.');
      }
    }

  if (settings.provider === 'email') {
    if (!settings.email?.apiKey) {
      missing.push('RESEND_API_KEY');
      errors.push('NOTIFICATION_PROVIDER=email requires: RESEND_API_KEY.');
    }
    if (!settings.email?.to) {
      missing.push('DESIGN_RADAR_EMAIL_TO');
      errors.push('NOTIFICATION_PROVIDER=email requires: DESIGN_RADAR_EMAIL_TO.');
    }
    if (!settings.email?.from) {
      missing.push('DESIGN_RADAR_EMAIL_FROM');
      errors.push('NOTIFICATION_PROVIDER=email requires: DESIGN_RADAR_EMAIL_FROM.');
    }
  }

  return { valid: errors.length === 0, errors, missing };
}

/**
 * Throws if settings are unusable.
 *
 * @param {ReturnType<typeof resolveNotificationSettings>} settings
 * @returns {ReturnType<typeof resolveNotificationSettings>}
 */
export function assertNotificationSettings(settings) {
  const { valid, errors } = validateNotificationSettings(settings);

  if (!valid) {
    throw new Error(`Notification configuration error: ${errors.join(' ')}`);
  }

  return settings;
}

/**
 * Builds a credential-free summary for the config banner.
 *
 * The token is reported as presence only — a diagnostic that printed a token,
 * even masked, would train everyone reading logs to expect tokens there. The
 * server and topic are printed verbatim because both are needed to tell "sent
 * to the wrong place" apart from "not sent at all".
 *
 * @param {ReturnType<typeof resolveNotificationSettings>} settings
 * @returns {{ provider: string, recipient: string, markMockAsSent: boolean, valid: boolean, ntfy: { baseUrl: string, topic: string, token: string }, email: { to: string, from: string, apiKey: string, subject: string } }}
 */
export function describeNotificationSettings(settings) {
  const { valid } = validateNotificationSettings(settings);

  return {
    provider: settings.provider,
    recipient: settings.recipient ? 'configured' : 'missing',
    markMockAsSent: settings.markMockAsSent,
    valid,
    ntfy: {
      baseUrl: settings.ntfy?.baseUrl || NTFY_DEFAULT_BASE_URL,
      topic: settings.ntfy?.topic || 'missing',
      token: settings.ntfy?.token ? 'configured' : 'missing (open topic)',
    },
    email: {
      to: settings.email?.to || 'missing',
      from: settings.email?.from || 'missing',
      apiKey: settings.email?.apiKey ? 'configured' : 'missing',
      subject: settings.email?.subject || EMAIL_DEFAULT_SUBJECT,
    },
  };
}
