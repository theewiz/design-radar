/**
 * Runtime-agnostic environment access.
 *
 * The radar pipeline runs in two places: the Node CLI and the Supabase Edge
 * Function. Node exposes `process.env`; Deno exposes `Deno.env` and has no
 * `process` global at all. Reading `process.env` directly from shared modules
 * therefore throws a ReferenceError inside the Edge Function, not just a missing
 * value.
 *
 * Every shared module resolves configuration through `getEnv()` instead, so the
 * same modules serve both entry points:
 *
 *   Node CLI ──> runRadar() ──┐
 *                             ├──> existing modules (discovery, AI, digest)
 *   Edge Function ─> runRadar() ┘
 *
 * On Node this returns `process.env` itself, not a copy, so a caller that
 * mutates the environment mid-process still sees its own change. The Deno
 * snapshot is cached because secrets are fixed for the lifetime of one Edge
 * invocation.
 */

/** Stand-in used when neither runtime is detectable. */
const EMPTY_ENV = Object.freeze({});

let denoSnapshot = null;

/**
 * True when the host exposes a Node-style `process.env`.
 *
 * @returns {boolean}
 */
function hasProcessEnv() {
  try {
    return typeof process !== 'undefined' && Boolean(process?.env);
  } catch {
    return false;
  }
}

/**
 * True when the host exposes Deno's `Deno.env`.
 *
 * @returns {boolean}
 */
function hasDenoEnv() {
  try {
    return typeof Deno !== 'undefined' && Boolean(Deno?.env);
  } catch {
    return false;
  }
}

/**
 * Returns the environment for the current runtime.
 *
 * @returns {Record<string, string | undefined>} Live `process.env` on Node, a
 *   cached `Deno.env` snapshot in the Edge Function, or an empty object.
 */
export function getEnv() {
  if (hasProcessEnv()) {
    return process.env;
  }

  if (hasDenoEnv()) {
    if (denoSnapshot === null) {
      denoSnapshot = { ...Deno.env.toObject() };
    }
    return denoSnapshot;
  }

  return EMPTY_ENV;
}

/**
 * Reports whether a variable is present and non-empty, without ever returning
 * its value. Used by configuration reporting so a secret can be confirmed as
 * configured without being printed.
 *
 * @param {Record<string, string | undefined>} env Environment source.
 * @param {string} name Variable name.
 * @returns {boolean}
 */
export function isConfigured(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() !== '';
}