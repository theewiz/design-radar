/**
 * Structured logger for DesignRadar.
 * Outputs ISO timestamp, log level, message, and structured metadata.
 * Automatically redacts sensitive fields (API keys, tokens, secrets).
 */

import { getEnv } from './env.js';

const SENSITIVE_KEY_REGEX = /key|token|secret|password|auth|authorization/i;

/**
 * Recursively sanitizes metadata to avoid logging sensitive credentials.
 *
 * @param {any} data
 * @returns {any} Sanitized clone of data.
 */
function sanitize(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitize);
  }

  const clean = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEY_REGEX.test(k) && typeof v === 'string') {
      clean[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      clean[k] = sanitize(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

function formatLog(level, message, meta) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
    ...(meta ? { meta: sanitize(meta) } : {}),
  };

  return entry;
}

export const logger = {
  info(message, meta) {
    const entry = formatLog('INFO', message, meta);
    console.log(`[${entry.timestamp}] [INFO] ${message}`, meta ? JSON.stringify(entry.meta) : '');
  },

  warn(message, meta) {
    const entry = formatLog('WARN', message, meta);
    console.warn(`[${entry.timestamp}] [WARN] ${message}`, meta ? JSON.stringify(entry.meta) : '');
  },

  error(message, meta) {
    const entry = formatLog('ERROR', message, meta);
    console.error(`[${entry.timestamp}] [ERROR] ${message}`, meta ? JSON.stringify(entry.meta) : '');
  },

  debug(message, meta) {
    const env = getEnv();
    if (env.DEBUG || env.NODE_ENV === 'development') {
      const entry = formatLog('DEBUG', message, meta);
      console.debug(`[${entry.timestamp}] [DEBUG] ${message}`, meta ? JSON.stringify(entry.meta) : '');
    }
  },
};
