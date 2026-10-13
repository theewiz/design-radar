/**
 * One source file, two runtimes.
 *
 * `src/database/supabase.js` imports `@supabase/supabase-js`, which is correct
 * for Node (resolved from `node_modules`) and wrong for the Edge bundler, which
 * rejects bare specifiers. A `npm:` import in `src/` would break the opposite
 * way — Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME before any test runs.
 *
 * The resolution therefore lives at the edge, not in the source:
 * `supabase/functions/import_map.json` translates the bare specifier to the
 * `npm:` form for `supabase functions deploy` / `serve` only. These tests fail
 * if either side drifts: a `npm:` anywhere under `src/` or `_shared/` breaks
 * Node, and a missing or unmapped import map breaks every deploy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

describe('Edge source mirror — dual-runtime imports', () => {
  it('reports the copy as up to date', () => {
    const result = spawnSync('node', ['scripts/sync-edge-sources.js', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('keeps Node-resolvable imports in src/ and the copy alike', async () => {
    const [source, shared] = await Promise.all([
      read('src/database/supabase.js'),
      read('supabase/functions/_shared/src/database/supabase.js'),
    ]);

    for (const [label, contents] of [['src', source], ['_shared', shared]]) {
      assert.match(contents, /from '@supabase\/supabase-js'/, `${label} must import the bare specifier`);
      assert.doesNotMatch(contents, /from 'npm:/, `${label} must not use the npm: scheme — Node cannot load it`);
    }
  });

  it('translates the bare specifier for the Edge bundle through an import map', async () => {
    const map = JSON.parse(await read('supabase/functions/import_map.json'));

    assert.equal(
      map.imports['@supabase/supabase-js'],
      'npm:@supabase/supabase-js',
      'the Edge bundler needs the npm: form, mapped here rather than in src/'
    );
  });
});
