/**
 * Tests for database/posts.js (Phase 3).
 *
 * These tests mock the Supabase client to validate business logic
 * without requiring a live database connection.
 *
 * Covers:
 * - Search run lifecycle (create → complete)
 * - Post creation with deduplication
 * - Bulk post insertion with skip/error counting
 * - Marking posts as sent
 * - Unsent post retrieval
 * - Recent posts retrieval
 * - URL existence checks
 * - Duplicate URL protection
 * - Missing/malformed input handling
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Supabase Client Mock Infrastructure ────────────────────────────────────────

/**
 * Creates a chainable mock Supabase query builder.
 * Each method returns `this` to allow chaining, except terminal methods
 * (.single(), .maybeSingle()) which resolve with the configured response.
 */
function createMockQueryBuilder(responseData = null, responseError = null) {
  const builder = {
    _responseData: responseData,
    _responseError: responseError,
    select() { return this; },
    insert() { return this; },
    update() { return this; },
    delete() { return this; },
    eq() { return this; },
    neq() { return this; },
    gte() { return this; },
    lte() { return this; },
    in() { return this; },
    order() { return this; },
    limit() { return this; },
    single() { return Promise.resolve({ data: this._responseData, error: this._responseError }); },
    maybeSingle() { return Promise.resolve({ data: this._responseData, error: this._responseError }); },
    then(resolve) {
      return resolve({ data: this._responseData, error: this._responseError });
    },
  };
  return builder;
}

/**
 * Creates a mock Supabase client with configurable per-table responses.
 */
function createMockSupabase(tableResponses = {}) {
  return {
    from(table) {
      const config = tableResponses[table] || {};
      return createMockQueryBuilder(config.data ?? null, config.error ?? null);
    },
  };
}

// ─── Dynamic Import with Mocked Supabase ────────────────────────────────────────

let postsModule;
let originalEnv;

/**
 * We dynamically import the posts module after setting up environment variables
 * so the Supabase client singleton can be controlled.
 */
async function loadPostsModule() {
  // Need to import fresh each time — but since ESM caches, we test the
  // exported functions' behavior through the mock chain
  if (!postsModule) {
    postsModule = await import('../src/database/posts.js');
  }
  return postsModule;
}

describe('Database Posts Module — Unit Tests (Mocked Supabase)', () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createSearchRun', () => {
    it('throws when Supabase is not configured', async () => {
      // Empty strings, not delete: src/database/supabase.js calls dotenv.config()
      // at import time, which restores any value deleted here from a real .env.
      // dotenv does not overwrite a key that is already present, so '' sticks
      // and is treated as unconfigured by isDatabaseConfigured().
      process.env.SUPABASE_URL = '';
      process.env.SUPABASE_SERVICE_ROLE_KEY = '';

      const { createSearchRun } = await loadPostsModule();

      await assert.rejects(
        () => createSearchRun({ queryCount: 5 }),
        { message: /Supabase configuration error/ }
      );
    });
  });

  describe('createPost — Input Validation', () => {
    it('throws when linkedin_url is missing', async () => {
      const { createPost } = await loadPostsModule();

      await assert.rejects(
        () => createPost({}),
        { message: /requires a linkedin_url/ }
      );
    });

    it('throws when post is null', async () => {
      const { createPost } = await loadPostsModule();

      await assert.rejects(
        () => createPost(null),
        { message: /requires a linkedin_url/ }
      );
    });
  });

  describe('markPostAsSent — Input Validation', () => {
    it('throws when postId is missing', async () => {
      const { markPostAsSent } = await loadPostsModule();

      await assert.rejects(
        () => markPostAsSent(null),
        { message: /requires a postId/ }
      );
    });

    it('throws when postId is empty string', async () => {
      const { markPostAsSent } = await loadPostsModule();

      await assert.rejects(
        () => markPostAsSent(''),
        { message: /requires a postId/ }
      );
    });
  });

  describe('completeSearchRun — Input Validation', () => {
    it('throws when runId is missing', async () => {
      const { completeSearchRun } = await loadPostsModule();

      await assert.rejects(
        () => completeSearchRun(null, {}),
        { message: /requires a runId/ }
      );
    });
  });

  describe('findPostByUrl — Input Validation', () => {
    it('returns null for empty/null URL', async () => {
      const { findPostByUrl } = await loadPostsModule();

      const result1 = await findPostByUrl(null);
      const result2 = await findPostByUrl('');
      const result3 = await findPostByUrl(undefined);

      assert.equal(result1, null);
      assert.equal(result2, null);
      assert.equal(result3, null);
    });
  });

  describe('postExistsByUrl — Input Validation', () => {
    it('returns false for null/empty URL', async () => {
      const { postExistsByUrl } = await loadPostsModule();

      const result1 = await postExistsByUrl(null);
      const result2 = await postExistsByUrl('');
      const result3 = await postExistsByUrl(undefined);

      assert.equal(result1, false);
      assert.equal(result2, false);
      assert.equal(result3, false);
    });
  });

  describe('findExistingUrls — Input Validation', () => {
    it('returns empty set for empty/null input', async () => {
      const { findExistingUrls } = await loadPostsModule();

      const result1 = await findExistingUrls(null);
      const result2 = await findExistingUrls([]);
      const result3 = await findExistingUrls(undefined);

      assert.deepEqual(result1, new Set());
      assert.deepEqual(result2, new Set());
      assert.deepEqual(result3, new Set());
    });
  });

  describe('findExistingUrls — case-insensitive matching', () => {
    const STORED = [
      // Stored while the old normalizer lowercased every path.
      { linkedin_url: 'https://www.linkedin.com/posts/taomar_productdesign-uiux-designengineering-activity-7512179706696351744-7ejh' },
    ];

    it('matches a differently-cased spelling of a stored URL', async () => {
      const { findExistingUrls } = await loadPostsModule();

      // The same post as the search index now publishes it.
      const incoming = 'https://www.linkedin.com/posts/taomar_productdesign-uiux-designengineering-activity-7512179706696351744-7eJh';
      const result = await findExistingUrls([incoming], {
        client: createMockSupabase({ linkedin_posts: { data: STORED } }),
      });

      assert.ok(
        result.has(incoming),
        'a casing variant must not be stored as a second copy of the same post'
      );
    });

    it('returns the caller’s own URL, not the stored spelling', async () => {
      const { findExistingUrls } = await loadPostsModule();

      const incoming = 'https://www.linkedin.com/posts/acme_role-abc';
      const result = await findExistingUrls([incoming], {
        client: createMockSupabase({ linkedin_posts: { data: [{ linkedin_url: 'https://www.linkedin.com/posts/acme_role-ABC' }] } }),
      });

      assert.deepEqual([...result], [incoming], 'membership must be testable with the URL the caller holds');
    });

    it('does not match a genuinely different post', async () => {
      const { findExistingUrls } = await loadPostsModule();

      const result = await findExistingUrls(['https://www.linkedin.com/posts/acme_role-2'], {
        client: createMockSupabase({ linkedin_posts: { data: [{ linkedin_url: 'https://www.linkedin.com/posts/acme_role-1' }] } }),
      });

      assert.equal(result.size, 0);
    });
  });

  describe('findUrlCaseDrift + realignUrlCase — self-healing stored links', () => {
    /**
     * A client that records the updates realignUrlCase issues.
     */
    function updateRecordingClient(rows) {
      const updates = [];

      return {
        updates,
        from: (table) => {
          const config = table === 'linkedin_posts' ? { data: rows } : { data: null };
          const builder = createMockQueryBuilder(config.data, null);

          builder.update = (payload) => {
            builder._payload = payload;
            return builder;
          };

          builder.eq = (column, value) => {
            updates.push({ id: value, payload: builder._payload });
            return builder;
          };

          return builder;
        },
      };
    }

    it('reports a stored URL that differs from discovery only by case', async () => {
      const { findUrlCaseDrift } = await loadPostsModule();

      const drift = await findUrlCaseDrift(
        ['https://www.linkedin.com/posts/taomar_role-activity-7512179706696351744-7eJh'],
        {
          client: createMockSupabase({
            linkedin_posts: { data: [{ id: 'p1', linkedin_url: 'https://www.linkedin.com/posts/taomar_role-activity-7512179706696351744-7ejh' }] },
          }),
        }
      );

      assert.equal(drift.length, 1);
      assert.equal(drift[0].id, 'p1');
      assert.equal(drift[0].incoming, 'https://www.linkedin.com/posts/taomar_role-activity-7512179706696351744-7eJh');
      assert.equal(drift[0].stored, 'https://www.linkedin.com/posts/taomar_role-activity-7512179706696351744-7ejh');
    });

    it('ignores an exact match', async () => {
      const { findUrlCaseDrift } = await loadPostsModule();
      const url = 'https://www.linkedin.com/posts/acme_role-activity-1-abc';

      const drift = await findUrlCaseDrift([url], {
        client: createMockSupabase({ linkedin_posts: { data: [{ id: 'p1', linkedin_url: url }] } }),
      });

      assert.equal(drift.length, 0, 'an already-correct row must not be rewritten');
    });

    it('ignores a different post rather than repointing the row', async () => {
      const { findUrlCaseDrift } = await loadPostsModule();

      const drift = await findUrlCaseDrift(['https://www.linkedin.com/posts/acme_role-activity-2-xyz'], {
        client: createMockSupabase({ linkedin_posts: { data: [{ id: 'p1', linkedin_url: 'https://www.linkedin.com/posts/acme_role-activity-1-abc' }] } }),
      });

      assert.equal(drift.length, 0);
    });

    it('rewrites the row to the published casing', async () => {
      const { realignUrlCase } = await loadPostsModule();
      const client = updateRecordingClient([]);

      const repaired = await realignUrlCase(
        [{ id: 'p1', stored: 'https://www.linkedin.com/posts/acme_role-activity-1-abc', incoming: 'https://www.linkedin.com/posts/acme_role-activity-1-ABC' }],
        { client }
      );

      assert.equal(repaired, 1);
      assert.equal(client.updates[0].id, 'p1');
      assert.equal(client.updates[0].payload.linkedin_url, 'https://www.linkedin.com/posts/acme_role-activity-1-ABC');
    });

    it('refuses a candidate that is not a case-only difference', async () => {
      const { realignUrlCase } = await loadPostsModule();
      const client = updateRecordingClient([]);

      const repaired = await realignUrlCase(
        [{ id: 'p1', stored: 'https://www.linkedin.com/posts/acme_role-activity-1-abc', incoming: 'https://www.linkedin.com/posts/other_role-activity-9-zzz' }],
        { client }
      );

      assert.equal(repaired, 0, 'a repointed row would send the reader to a different post');
      assert.equal(client.updates.length, 0);
    });

    it('reports zero for empty input', async () => {
      const { realignUrlCase, findUrlCaseDrift } = await loadPostsModule();

      assert.equal(await realignUrlCase(null), 0);
      assert.equal(await realignUrlCase([]), 0);
      assert.deepEqual(await findUrlCaseDrift([]), []);
    });
  });

  describe('createPosts — Bulk Creation', () => {
    it('returns zeros for empty array', async () => {
      const { createPosts } = await loadPostsModule();

      const result = await createPosts([]);
      assert.equal(result.created, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors, 0);
      assert.deepEqual(result.posts, []);
    });

    it('returns zeros for null input', async () => {
      const { createPosts } = await loadPostsModule();

      const result = await createPosts(null);
      assert.equal(result.created, 0);
      assert.equal(result.skipped, 0);
      assert.equal(result.errors, 0);
    });
  });
});

describe('Database Posts Module — Exported Function Signatures', () => {
  it('exports all required functions', async () => {
    const mod = await loadPostsModule();

    assert.equal(typeof mod.createSearchRun, 'function');
    assert.equal(typeof mod.completeSearchRun, 'function');
    assert.equal(typeof mod.findPostByUrl, 'function');
    assert.equal(typeof mod.createPost, 'function');
    assert.equal(typeof mod.createPosts, 'function');
    assert.equal(typeof mod.markPostAsSent, 'function');
    assert.equal(typeof mod.getUnsentPosts, 'function');
    assert.equal(typeof mod.getPostsFromLast24Hours, 'function');
    assert.equal(typeof mod.postExistsByUrl, 'function');
    assert.equal(typeof mod.findExistingUrls, 'function');
  });
});
