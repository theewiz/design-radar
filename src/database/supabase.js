import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../utils/env.js';

// `.env` loading deliberately does not happen here. `dotenv.config()` needs
// `node:fs` and a bare-specifier npm resolution that the Supabase Edge Function
// cannot provide, and the Edge Function receives its configuration from
// `Deno.env` instead. The Node CLI loads `.env` once in `src/index.js` before any
// run starts, which is the only place a local file needs to be read.

let clientInstance = null;

/**
 * Checks whether required Supabase credentials are configured in the environment.
 * @returns {boolean} True if both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present.
 */
export function isDatabaseConfigured() {
  const env = getEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && key && url.trim() !== '' && key.trim() !== '');
}

/**
 * Returns a configured Supabase client instance.
 * Reuses a singleton instance across calls unless options.forceNew is true.
 *
 * @param {Object} [options]
 * @param {boolean} [options.required=true] If true, throws when credentials are not configured.
 * @param {boolean} [options.forceNew=false] If true, creates a fresh client instance.
 * @returns {import('@supabase/supabase-js').SupabaseClient | null} Supabase client or null if not required and unconfigured.
 */
export function getSupabaseClient(options = {}) {
  const { required = true, forceNew = false } = options;

  if (clientInstance && !forceNew) {
    return clientInstance;
  }

  const env = getEnv();
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !supabaseKey) {
    if (required) {
      throw new Error(
        'Supabase configuration error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.'
      );
    }
    return null;
  }

  const client = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  if (!forceNew) {
    clientInstance = client;
  }

  return client;
}

/**
 * Verifies active database connection by executing a lightweight query.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function testDatabaseConnection() {
  try {
    const supabase = getSupabaseClient({ required: true });
    const { error } = await supabase.from('search_runs').select('id').limit(1);

    if (error) {
      return { ok: false, error: error.message };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
