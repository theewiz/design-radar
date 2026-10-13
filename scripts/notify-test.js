/**
 * Notification Provider Test (Phase 10).
 *
 * `npm run notify:test` — proves the configured notification provider works
 * before a real digest is ever built. It sends one short test message and
 * reports the normalized outcome.
 *
 * Three rules this script exists to uphold:
 *
 *   1. It never prints credentials. Not masked, not truncated — not at all.
 *      The only credential fact reported is whether one is configured.
 *   2. It never touches the database. No post is marked and no notification is
 *      recorded, so a failed configuration cannot consume the post queue.
 *   3. It tests the production provider as configured by NOTIFICATION_PROVIDER.
 *      The question asked is "does the configured provider work?".
 *
 * Production provider: email (Resend).
 */

import dotenv from 'dotenv';

import {
  resolveNotificationSettings,
  validateNotificationSettings,
  describeNotificationSettings,
} from '../src/notifications/config.js';
import { createEmailNotifier } from '../src/notifications/email.js';
import { createNtfyNotifier } from '../src/notifications/ntfy.js';
import { isRetryableNotificationError } from '../src/notifications/result.js';

dotenv.config();

const RULE = '─'.repeat(52);
const TEST_MESSAGE = [
  '🎨 DesignRadar — Notification Test',
  '',
  'This is a test message from `npm run notify:test`.',
  'If you received it, the notification provider is configured correctly.',
  '',
  'Provider: email (Resend)',
].join('\n');

/**
 * Prints the configuration header without exposing any secret values.
 *
 * @param {ReturnType<typeof resolveNotificationSettings>} settings
 * @param {ReturnType<typeof describeNotificationSettings>} described
 * @param {{ valid: boolean, errors: string[] }} validation
 */
function printHeader(settings, described, validation) {
  console.log(RULE);
  console.log('DesignRadar — Notification Provider Test');
  console.log(RULE);
  console.log('');
  console.log(`Provider:   ${settings.provider}`);

  if (settings.provider === 'email') {
    console.log(`API key:    ${described.email.apiKey}`);
    console.log(`From:       ${described.email.from}`);
    console.log(`To:         ${described.email.to}`);
    console.log(`Subject:    ${described.email.subject}`);
  } else if (settings.provider === 'ntfy') {
    console.log(`Server:     ${described.ntfy.baseUrl}`);
    console.log(`Topic:      ${described.ntfy.topic}`);
    console.log(`Token:      ${described.ntfy.token}`);
  } else {
    console.log(`Recipient:  ${described.recipient}`);
  }

  console.log('');

  if (!validation.valid) {
    console.log('Configuration is not usable:');
    for (const error of validation.errors) {
      console.log(`  ✗ ${error}`);
    }
    console.log('');

    if (settings.provider === 'email') {
      console.log('Set RESEND_API_KEY, DESIGN_RADAR_EMAIL_TO, and DESIGN_RADAR_EMAIL_FROM in .env.');
      console.log('The sender domain must be verified in the Resend dashboard.');
    } else if (settings.provider === 'ntfy') {
      console.log('Set NTFY_TOPIC in .env, subscribe to that topic in the ntfy app, then run this again.');
    }
  }
}

/**
 * Builds the appropriate notifier for the configured provider.
 *
 * @param {ReturnType<typeof resolveNotificationSettings>} settings
 * @returns {{ name: string, send: Function }}
 */
function buildNotifier(settings) {
  if (settings.provider === 'email') {
    return createEmailNotifier(settings);
  }

  if (settings.provider === 'ntfy') {
    return createNtfyNotifier(settings);
  }

  // Mock: import dynamically to avoid circular deps at the top level.
  return {
    name: 'mock',
    async send(message) {
      console.log('');
      console.log('[mock] Would deliver:');
      console.log(message);
      return { success: true, provider: 'mock', messageId: 'mock-test', errorType: null, error: null };
    },
  };
}

/**
 * Prints the delivery result.
 *
 * @param {{ success: boolean, messageId: string|null, errorType: string|null, error: string|null, status: number|null }} result
 */
function printResult(result) {
  if (result.success) {
    console.log('✓ Notification delivered successfully');
    if (result.messageId) {
      console.log(`  Provider Message ID: ${result.messageId}`);
    }
    console.log('');
    console.log('Next: run `npm run radar` to send the real digest.');
  } else {
    console.log('✗ Notification failed');
    console.log(`  Error type: ${result.errorType}`);
    console.log(`  Error: ${result.error}`);
    if (result.status !== null && result.status !== undefined) {
      console.log(`  HTTP status: ${result.status}`);
    }
    console.log('');

    if (isRetryableNotificationError(result.errorType)) {
      console.log('This looks transient — run the test again in a moment.');
    } else if (result.errorType === 'authentication') {
      console.log('Check RESEND_API_KEY in .env — the key was rejected by Resend.');
    } else if (result.errorType === 'permission_denied') {
      console.log('Check DESIGN_RADAR_EMAIL_FROM in .env — the sender domain must be verified in Resend.');
    } else {
      console.log('Check RESEND_API_KEY, DESIGN_RADAR_EMAIL_TO, and DESIGN_RADAR_EMAIL_FROM in .env.');
    }

    console.log('No post was marked as sent, so nothing was lost.');
  }
}

/**
 * Runs the notification provider test.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  // Use the configured production provider, defaulting to email.
  const env = { NOTIFICATION_PROVIDER: process.env.NOTIFICATION_PROVIDER || 'email', ...process.env };
  const settings = resolveNotificationSettings({}, env);
  const validation = validateNotificationSettings(settings);
  const described = describeNotificationSettings(settings);

  printHeader(settings, described, validation);

  if (!validation.valid) {
    console.log('✗ No notification attempted — configuration error.');
    return 1;
  }

  console.log('Sending test notification...');
  console.log('');

  const notifier = buildNotifier(settings);

  let result;
  try {
    result = await notifier.send(TEST_MESSAGE);
  } catch (err) {
    // Providers normalize their own faults; a throw means a defect worth seeing.
    console.log('✗ Notification failed: the provider threw instead of returning a result.');
    console.log(`  ${err.message}`);
    return 1;
  }

  console.log(RULE);
  console.log(`Provider:         ${result.provider ?? settings.provider}`);
  console.log(`Status:           ${result.success ? 'success' : 'failed'}`);
  if (result.messageId) {
    console.log(`Provider Message ID: ${result.messageId}`);
  }
  console.log(RULE);
  console.log('');

  printResult(result);

  return result.success ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('Fatal error running the notification test:', { error: err.message });
    process.exitCode = 1;
  });