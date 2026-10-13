import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSupabaseClient, isDatabaseConfigured } from '../src/database/supabase.js';

describe('Supabase Database Helper', () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('detects unconfigured database state', () => {
    assert.equal(isDatabaseConfigured(), false);
  });

  it('returns null when required is false and unconfigured', () => {
    const client = getSupabaseClient({ required: false, forceNew: true });
    assert.equal(client, null);
  });

  it('throws descriptive error when required is true and unconfigured', () => {
    assert.throws(
      () => getSupabaseClient({ required: true, forceNew: true }),
      /Supabase configuration error/
    );
  });

  it('initializes client successfully when credentials are provided', () => {
    process.env.SUPABASE_URL = 'https://mock-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';

    assert.equal(isDatabaseConfigured(), true);
    const client = getSupabaseClient({ required: true, forceNew: true });
    assert.notEqual(client, null);
    assert.equal(typeof client.from, 'function');
  });

  // Restore env after tests
  it('cleans up environment after testing', () => {
    if (originalUrl) process.env.SUPABASE_URL = originalUrl;
    if (originalKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
});
