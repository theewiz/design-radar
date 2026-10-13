/**
 * DesignRadar — scheduled Edge Function (Phase 9).
 *
 * This is a thin HTTP adapter. It does not implement any part of the radar
 * pipeline: it validates the requested mode, calls the existing `runRadar()`
 * orchestrator, and projects the run summary into the response contract. Both
 * entry points therefore execute identical business logic:
 *
 *   Node CLI        ──> runRadar() ──> src/**
 *   Edge Function   ──> runRadar() ──> _shared/src/**   (generated copy of src/**)
 *
 * Scheduled by Postgres cron — see `supabase/migrations/005_phase9_scheduling.sql`.
 * The two jobs, and their cron expressions, are:
 *
 *   discovery — every 4 hours on the hour, sending {"mode":"discovery"}
 *   digest    — daily at 07:00 UTC, sending {"mode":"digest"}
 *
 * (The literal cron expressions live in the migration and the README. They cannot
 * be written here: every 4-hour expression contains a star followed by a slash,
 * which would terminate this block comment.)
 *
 * Secrets are read from the Supabase Edge environment (`supabase secrets set …`)
 * through the shared `getEnv()` accessor and are never accepted from, logged by,
 * or returned in this function.
 */

import { runRadar, resolveRunMode, RADAR_MODES } from '../_shared/src/radar/index.js';
import { getEnv } from '../_shared/src/utils/env.js';
import { logger } from '../_shared/src/utils/logger.js';

/**
 * Mode used when the request omits one.
 *
 * 'discovery' is the safe default: it persists qualified posts and never
 * notifies. Defaulting to 'full' or 'digest' would mean an unqualified request —
 * a manual test hit, a misconfigured cron job, a health check — could deliver a
 * digest and consume the daily notification.
 */
const DEFAULT_MODE = RADAR_MODES.DISCOVERY;

const VALID_MODES = Object.values(RADAR_MODES);

/**
 * Names of variables whose values must never appear in a response or an error
 * string. Used to redact, not to configure.
 */
const SECRET_VARIABLE_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'SEARCH_API_KEY',
  'NTFY_TOKEN',
  'RESEND_API_KEY',
  'SUPABASE_DB_PASSWORD',
];

/**
 * Removes secret material from a string before it is returned to a caller.
 *
 * Two passes, because either alone is insufficient:
 *   1. Literal configured values, so a key echoed back by an upstream library is
 *      removed even if it does not look like a key.
 *   2. Long opaque tokens, which catch a secret that reached the message through
 *      a source this function cannot see.
 *
 * @param {unknown} value Message to sanitize.
 * @param {Record<string, string | undefined>} [env] Environment source holding
 *   the literal secret values to strip.
 * @returns {string} Redacted message.
 */
function redactSecrets(value, env = {}) {
  let text = typeof value === 'string' ? value : String(value ?? '');

  for (const name of SECRET_VARIABLE_NAMES) {
    const secret = env?.[name];
    if (typeof secret === 'string' && secret.length >= 8) {
      text = text.split(secret).join('[redacted]');
    }
  }

  // AIza… (Google), sk-… (OpenAI-style), ghp_/gho_ (GitHub), and long
  // base64url runs are treated as credentials regardless of origin.
  text = text.replace(
    /\b(?:AIza[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z]{16,}|[0-9A-Za-z_-]{40,})\b/g,
    '[redacted]'
  );

  return text;
}

/**
 * Projects a `runRadar()` summary into the Edge response contract.
 *
 * Every value is read from the run summary; nothing is defaulted or invented. A
 * statistic the orchestrator did not produce is reported as `null` rather than 0,
 * so a missing value is visible instead of looking like a real zero.
 *
 * @param {object} result The `runRadar()` return value.
 * @returns {object} Response body.
 */
function toResponseBody(result) {
  const stat = (value) => (typeof value === 'number' ? value : null);

  return {
    success: result.success === true,
    mode: result.mode ?? null,
    status: result.status ?? null,
    statistics: {
      queriesRun: stat(result.queriesRun),
      searchResults: stat(result.searchResults),
      uniqueResults: stat(result.uniqueResults),
      candidates: stat(result.candidates),
      classified: stat(result.classified),
      qualified: stat(result.qualified),
      notificationSent: result.notificationSent === true,
    },
  };
}

/**
 * Builds a request handler.
 *
 * A factory rather than a bare handler so the pipeline can be replaced with a
 * stub. The Edge Function itself injects nothing and therefore runs the real
 * `runRadar()`; tests inject a recorder and assert the request/response contract
 * without calling Serper, Gemini, Supabase, or ntfy.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.run] The radar orchestrator. Defaults to `runRadar`.
 * @param {Object} [deps.log] Logger. Defaults to the shared logger.
 * @param {Function} [deps.env] Environment source. Defaults to the shared accessor.
 * @returns {(request: Request) => Promise<Response>}
 */
export function createHandler(deps = {}) {
  const run = deps.run ?? runRadar;
  const log = deps.log ?? logger;
  const env = deps.env ?? getEnv;

  return async function handleRequest(request) {
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Method ${request.method} not allowed. Use POST.`,
        }),
        { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } }
      );
    }

    const body = await readRequestedMode(request);

    if (body.invalidJson) {
      return new Response(
        JSON.stringify({ success: false, error: 'Request body must be a JSON object.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const mode = body.mode ?? DEFAULT_MODE;

    if (!VALID_MODES.includes(mode)) {
      // Rejected at the boundary rather than allowed to reach runRadar: a mode
      // the orchestrator does not recognise must not fall back to a notifying
      // default.
      return new Response(
        JSON.stringify({
          success: false,
          error: `Unsupported mode "${redactSecrets(mode, env())}". Expected one of: ${VALID_MODES.join(', ')}.`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const startedAt = Date.now();

    try {
      // Fails fast on an unknown mode, before any provider call.
      resolveRunMode({ mode });

      const result = await run({ mode });

      const responseBody = toResponseBody(result);

      log.info('daily-radar completed', {
        mode,
        success: responseBody.success,
        durationMs: Date.now() - startedAt,
        ...responseBody.statistics,
      });

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      // The message is redacted; the stack is logged server-side and never
      // returned, because a stack can carry request headers or resolved config.
      log.error('daily-radar failed', {
        mode,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
      });

      return new Response(
        JSON.stringify({
          success: false,
          mode,
          error: redactSecrets(err?.message ?? 'Radar run failed', env()),
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  };
}

/**
 * Reads the requested mode from an optional JSON body.
 *
 * @param {Request} request Incoming request.
 * @returns {Promise<{ mode: string | null, empty?: boolean, invalidJson?: boolean }>}
 */
async function readRequestedMode(request) {
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { mode: null, empty: true };
  }

  if (!raw || raw.trim() === '') {
    return { mode: null, empty: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalidJson: true };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { invalidJson: true };
  }

  return { mode: parsed.mode ?? null };
}

/**
 * The live handler. `Deno.serve` supplies the request as its only argument, so no
 * second parameter is declared — that would receive Deno's `ServerRequestInfo`.
 */
export const handler = createHandler();

// Started only when a Deno server is available, so this module can be imported
// by a Node test without binding a port.
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(handler);
}