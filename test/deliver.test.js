/**
 * Digest Delivery Tests (Phase 7).
 *
 * These tests exist to protect one invariant:
 *
 *   a post is marked as sent only after a provider confirmed delivery AND the
 *   notification was recorded.
 *
 * Every assertion below is a variation on "did anything get marked that should
 * not have been", because that is the failure that silently deletes a job lead.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { deliverDigest } from '../src/notifications/deliver.js';
import { NOTIFICATION_ERRORS } from '../src/notifications/result.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────────

/**
 * Ordered persistence calls, reset per test, so ordering can be asserted
 * directly rather than inferred from final state.
 */
let calls;

beforeEach(() => {
  calls = [];
});

const POST_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Builds a Phase 6 digest with the given post ids.
 *
 * @param {string[]} [ids]
 * @param {string[]} [chunks]
 * @returns {object}
 */
function digestFixture(ids = [POST_ID], chunks) {
  const message = 'DesignRadar\n2 new opportunities';

  return {
    empty: ids.length === 0,
    included: ids.map((id) => ({ id })),
    message,
    chunks: chunks ?? [message],
  };
}

/**
 * A notifier that returns a scripted result for every message.
 *
 * @param {Object} [script]
 * @param {object} [script.result] Result for a successful send.
 * @param {(message: string) => object} [script.resultFor] Per-message result.
 * @returns {object}
 */
function notifierFixture(script = {}) {
  return {
    name: script.name ?? 'ntfy',
    sent: [],
    async send(message) {
      this.sent.push(message);

      return script.resultFor
        ? script.resultFor(message)
        : script.result ?? { success: true, provider: 'ntfy', messageId: 'ntfy.ok', errorType: null, error: null };
    },
  };
}

/** The result a provider returns for HTTP 401. */
const AUTH_FAILURE = {
  success: false,
  provider: 'ntfy',
  messageId: null,
  errorType: NOTIFICATION_ERRORS.AUTHENTICATION,
  error: 'ntfy notification failed: HTTP 401: unauthorized',
  retryable: false,
  status: 401,
};

/**
 * A Supabase double matching the three query chains delivery actually issues:
 * `insert().select().maybeSingle()`, `update().in()`, and
 * `select().eq().contains()`.
 *
 * @param {Object} [behaviour]
 * @param {boolean} [behaviour.alreadyDelivered] A prior notification covers these posts.
 * @param {boolean} [behaviour.duplicateCheckFails]
 * @param {boolean} [behaviour.recordFails]
 * @returns {object}
 */
function fakeClient(behaviour = {}) {
  return {
    from: (table) => ({
      insert: (row) => {
        calls.push(`record:${table}`);

        return {
          select: () => ({
            maybeSingle: async () =>
              behaviour.recordFails
                ? { data: null, error: { message: 'connection refused' } }
                : { data: { id: 'n1', ...row }, error: null },
          }),
        };
      },

      select: (columns) => {
        if (columns === 'id' && table === 'notifications') {
          return {
            eq: () => ({
              contains: async () => {
                calls.push('duplicate-check');

                if (behaviour.duplicateCheckFails) {
                  return { data: null, error: { message: 'duplicate check unavailable' } };
                }

                return { data: behaviour.alreadyDelivered ? [{ id: 'n0' }] : [], error: null };
              },
            }),
          };
        }

        throw new Error(`unexpected select on ${table}`);
      },

      update: () => ({
        in: async () => {
          calls.push('mark');

          return { error: null };
        },
      }),
    }),
  };
}

// ─── Marking Gate ─────────────────────────────────────────────────────────────────

describe('posts are marked only after a confirmed delivery', () => {
  it('records, then marks, in that order', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: notifierFixture(),
      recipient: 'design-radar',
      client: fakeClient(),
    });

    assert.equal(result.success, true);
    assert.equal(result.notificationId, 'n1');
    assert.equal(result.markedCount, 1);
    assert.deepEqual(calls, ['duplicate-check', 'record:notifications', 'mark']);
  });

  it('marks nothing when the provider reports a failure', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: notifierFixture({ result: AUTH_FAILURE }),
      recipient: 'design-radar',
      client: fakeClient(),
    });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.AUTHENTICATION);
    assert.equal(result.markedCount, 0);
    assert.equal(result.notificationId, 'n1', 'the failure is still recorded');
    assert.ok(!calls.includes('mark'), 'a failed send must never mark posts');
  });

  it('marks nothing when the notification record cannot be written', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: notifierFixture(),
      recipient: 'design-radar',
      client: fakeClient({ recordFails: true }),
    });

    // The message really was delivered, so the outcome stays honest...
    assert.equal(result.success, true);
    assert.equal(result.recordFailed, true);
    assert.equal(result.persisted, false);
    // ...but no post is marked, honouring record-then-mark.
    assert.equal(result.markedCount, 0);
    assert.ok(!calls.includes('mark'));
  });

  it('treats a success flag carrying an error type as a failure', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: notifierFixture({
        result: { success: true, provider: 'ntfy', messageId: 'ntfy.ok', errorType: NOTIFICATION_ERRORS.SERVER_ERROR, error: 'boom' },
      }),
      client: fakeClient(),
    });

    assert.equal(result.success, false);
    assert.equal(result.markedCount, 0);
    assert.ok(!calls.includes('mark'));
  });
});

// ─── Skips ────────────────────────────────────────────────────────────────────────

describe('delivery is skipped rather than forced', () => {
  it('skips an empty digest', async () => {
    const notifier = notifierFixture();

    const result = await deliverDigest({ digest: digestFixture([]), notifier, client: fakeClient() });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'empty_digest');
    assert.equal(result.attempted, false);
    assert.deepEqual(notifier.sent, []);
  });

  it('skips a digest a previous notification already delivered', async () => {
    const notifier = notifierFixture();

    const result = await deliverDigest({
      digest: digestFixture(),
      notifier,
      client: fakeClient({ alreadyDelivered: true }),
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already_delivered');
    assert.deepEqual(notifier.sent, [], 'a duplicate send would deliver the same post twice');
  });

  it('refuses to send when the duplicate check itself fails', async () => {
    const notifier = notifierFixture();

    const result = await deliverDigest({
      digest: digestFixture(),
      notifier,
      client: fakeClient({ duplicateCheckFails: true }),
    });

    assert.equal(result.success, false);
    assert.match(result.error, /Duplicate check failed/);
    assert.deepEqual(notifier.sent, []);
  });

  it('rejects a digest with no message', async () => {
    for (const digest of [null, undefined, 'digest', {}, { message: '' }, { message: '   ' }]) {
      const result = await deliverDigest({ digest, notifier: notifierFixture() });

      assert.equal(result.attempted, false);
      assert.equal(result.errorType, 'invalid_message');
    }
  });

  it('requires a notifier with a send method', async () => {
    await assert.rejects(() => deliverDigest({ digest: digestFixture() }), TypeError);
    await assert.rejects(() => deliverDigest({ digest: digestFixture(), notifier: {} }), TypeError);
  });
});

// ─── Chunking ─────────────────────────────────────────────────────────────────────

describe('digest chunking', () => {
  it('sends each chunk separately so the per-message limit is respected', async () => {
    const notifier = notifierFixture();

    const result = await deliverDigest({
      digest: digestFixture([POST_ID, '22222222-2222-2222-2222-222222222222'], ['chunk one', 'chunk two', 'chunk three']),
      notifier,
      client: fakeClient(),
    });

    assert.deepEqual(notifier.sent, ['chunk one', 'chunk two', 'chunk three']);
    assert.equal(result.success, true);
    assert.equal(result.messageIds.length, 3);
  });

  it('falls back to the whole message when no chunks exist', async () => {
    const notifier = notifierFixture();
    const digest = digestFixture();

    delete digest.chunks;

    await deliverDigest({ digest, notifier, client: fakeClient() });

    assert.deepEqual(notifier.sent, [digest.message]);
  });

  it('stops at the first failed chunk and marks nothing', async () => {
    const notifier = notifierFixture({
      resultFor: (message) =>
        message === 'chunk two'
          ? { success: false, provider: 'ntfy', messageId: null, errorType: NOTIFICATION_ERRORS.RATE_LIMIT, error: 'slow down', retryable: true }
          : { success: true, provider: 'ntfy', messageId: 'ntfy.ok', errorType: null, error: null },
    });

    const result = await deliverDigest({
      digest: digestFixture([POST_ID], ['chunk one', 'chunk two', 'chunk three']),
      notifier,
      client: fakeClient(),
    });

    assert.equal(result.success, false);
    assert.equal(result.errorType, NOTIFICATION_ERRORS.RATE_LIMIT);
    assert.deepEqual(notifier.sent, ['chunk one', 'chunk two'], 'the third chunk must not be attempted');
    assert.equal(result.markedCount, 0);
    assert.ok(!calls.includes('mark'));
  });
});

// ─── Defensive Providers ──────────────────────────────────────────────────────────

describe('delivery survives a misbehaving provider', () => {
  it('normalizes a thrown error instead of crashing the run', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: {
        name: 'ntfy',
        async send() {
          throw new Error('socket hang up');
        },
      },
      client: fakeClient(),
    });

    assert.equal(result.success, false);
    assert.equal(result.attempted, true);
    assert.equal(result.markedCount, 0);
    assert.match(result.error, /socket hang up/);
    assert.ok(!calls.includes('mark'));
  });

  it('rejects a result with no success flag', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: { name: 'ntfy', async send() { return { provider: 'ntfy' }; } },
      client: fakeClient(),
    });

    assert.equal(result.success, false);
    assert.equal(result.markedCount, 0);
  });
});

// ─── Persistence Toggles ──────────────────────────────────────────────────────────

describe('persistence is opt-out', () => {
  it('writes nothing when persistence is disabled', async () => {
    const notifier = notifierFixture();

    const result = await deliverDigest({
      digest: digestFixture(),
      notifier,
      persist: false,
      client: fakeClient(),
    });

    assert.equal(result.success, true);
    assert.equal(result.persisted, false);
    assert.equal(result.markedCount, 0);
    assert.deepEqual(calls, []);
  });

  it('records but does not mark when only marking is disabled', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: notifierFixture(),
      markAsSent: false,
      client: fakeClient(),
    });

    assert.equal(result.success, true);
    assert.equal(result.notificationId, 'n1');
    assert.equal(result.markedCount, 0);
    assert.deepEqual(calls, ['duplicate-check', 'record:notifications']);
  });

  it('never marks when persistence is off, even if marking is requested', async () => {
    const result = await deliverDigest({
      digest: digestFixture(),
      notifier: notifierFixture(),
      persist: false,
      markAsSent: true,
      client: fakeClient(),
    });

    assert.equal(result.markedCount, 0);
    assert.deepEqual(calls, []);
  });
});
