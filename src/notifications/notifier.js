/**
 * Notification provider abstraction (Phase 7).
 *
 * The rest of the application only ever calls `notifier.send(message)` and reads
 * a normalized result. It never branches on the provider, so adding Telegram or
 * email later means adding a module here — not editing the pipeline.
 *
 * Two rules this module exists to enforce:
 *
 *   1. Configuration is resolved and validated here, in one place, so a missing
 *      credential fails before any request is attempted rather than after.
 *   2. Providers never throw at the caller. A delivery attempt returns a
 *      normalized failure result, because "the notification failed" is an
 *      expected outcome that the pipeline has to handle by leaving posts unsent.
 */

import { logger } from '../utils/logger.js';
import { resolveNotificationSettings, assertNotificationSettings } from './config.js';
import { createMockNotifier } from './mock.js';
import { createNtfyNotifier } from './ntfy.js';
import { createEmailNotifier } from './email.js';
import { getEnv } from '../utils/env.js';

// The result vocabulary lives in result.js so providers can import it without
// cycling back through this factory.
export {
  NOTIFICATION_ERRORS,
  buildNotificationResult,
  isRetryableNotificationError,
} from './result.js';

// ─── Configuration ───────────────────────────────────────────────────────────────

export {
  NOTIFICATION_PROVIDERS,
  DEFAULT_NOTIFICATION_PROVIDER,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  NTFY_DEFAULT_BASE_URL,
  NTFY_DIGEST_TITLE,
  resolveNotificationSettings,
  validateNotificationSettings,
  assertNotificationSettings,
  describeNotificationSettings,
} from './config.js';

// ─── Factory ─────────────────────────────────────────────────────────────────────

/**
 * Creates the notifier for the configured provider.
 *
 * The only place in the codebase that knows which providers exist.
 *
 * Settings always pass through `resolveNotificationSettings`, even when a
 * caller hands over an already-resolved object. Treating a `provider` key as
 * proof that everything else was resolved let partial settings through with
 * `timeoutMs: undefined`, which made every request abort instantly and be
 * reported as a timeout. Resolution is idempotent, so one path is simpler and
 * safer than distinguishing "partial" from "complete" settings.
 *
 * @param {Object|string} [configOrOptions] Per-call overrides, resolved against
 *   `env`. A bare string is treated as the provider name.
 * @param {Object} [deps]
 * @param {object} [deps.env] Environment source. Defaults to the current runtime environment.
 * @param {typeof fetch} [deps.fetchFn] Injected HTTP client.
 * @param {object} [deps.logger] Injected logger.
 * @param {object} [deps.console] Injected console for mock output.
 * @returns {{ name: string, send: (message: string) => Promise<object>, settings: object }}
 */
export function createNotifier(configOrOptions = {}, deps = {}) {
  const env = deps.env ?? getEnv();
  const overrides = typeof configOrOptions === 'string' ? { provider: configOrOptions } : configOrOptions;
  const settings = resolveNotificationSettings(overrides, env);

  assertNotificationSettings(settings);

  logger.info(`[Notification] Provider: ${settings.provider}`);

  const factory = {
    mock: () =>
      createMockNotifier({
        markAsSent: settings.markMockAsSent,
        logger: deps.logger,
        console: deps.console,
      }),
    ntfy: () => createNtfyNotifier(settings, deps),
    email: () => createEmailNotifier(settings, deps),
  }[settings.provider];

  const notifier = factory();

  return { name: notifier.name, settings, send: notifier.send };
}
