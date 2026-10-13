#!/usr/bin/env node
/**
 * Copies the shared radar modules into the Edge Function bundle.
 *
 * Why this exists
 * ---------------
 * `supabase functions deploy` bundles each function directory independently and
 * follows relative imports from inside that directory. A function cannot reach
 * `../../../src/radar/run.js` in a deployed bundle — that path exists only in a
 * local checkout, so the import resolves during `supabase functions serve` and
 * then fails at deploy time.
 *
 * The documented Supabase layout for shared code is `supabase/functions/_shared/`.
 * This script mirrors `src/` there so the Edge Function and the Node CLI both
 * execute the *same* business logic, from one source of truth:
 *
 *   Node CLI        ──> src/radar/run.js
 *   Edge Function   ──> functions/_shared/src/radar/run.js   (copy of the above)
 *
 * The copy is generated, never edited by hand, and is git-ignored. Run
 * `npm run edge:sync` after changing anything under `src/`, and the deploy
 * command runs it automatically.
 *
 * Usage: node scripts/sync-edge-sources.js [--check]
 *   --check  Report whether the copy is up to date; exit 1 if it is stale.
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'src');
const TARGET_DIR = path.join(ROOT, 'supabase', 'functions', '_shared', 'src');

/**
 * Files that must not be copied into the Edge bundle, as paths relative to `src/`.
 *
 * Only the root `index.js` is excluded. Nested `index.js` files
 * (`radar/index.js`, `search/index.js`, …) are ordinary barrel modules that the
 * radar graph imports and must be copied.
 */
const EXCLUDED = new Set(['index.js']);

const BANNER = '// GENERATED FILE — do not edit. Source: src/. Run `npm run edge:sync`.\n';

async function collectFiles(dir, base = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path.join(dir, entry.name), relative)));
    } else if (entry.name.endsWith('.js')) {
      files.push(relative);
    }
  }

  return files;
}

/**
 * Copies one module, prefixing the generated-file banner.
 *
 * @param {string} relative Path relative to src/.
 * @returns {Promise<string>} The file's contents.
 */
async function buildCopy(relative) {
  const source = await readFile(path.join(SOURCE_DIR, relative), 'utf8');
  return source.startsWith('/**') ? `${BANNER}${source}` : `${BANNER}${source}`;
}

async function sync() {
  const allFiles = await collectFiles(SOURCE_DIR);
  const files = allFiles.filter((relative) => !EXCLUDED.has(relative));

  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });

  const copied = [];

  for (const relative of files) {
    const contents = await buildCopy(relative);
    const destination = path.join(TARGET_DIR, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, 'utf8');
    copied.push(relative);
  }

  return { copied: copied.sort(), skipped: [...EXCLUDED].sort() };
}

/**
 * Reports whether the generated copy matches src/ file for file.
 *
 * @returns {Promise<boolean>} True when the copy is current.
 */
async function isUpToDate() {
  if (!existsSync(TARGET_DIR)) {
    return false;
  }

  const files = (await collectFiles(SOURCE_DIR)).filter(
    (relative) => !EXCLUDED.has(relative)
  );

  for (const relative of files) {
    const destination = path.join(TARGET_DIR, relative);
    if (!existsSync(destination)) {
      return false;
    }
    const [expected, target] = await Promise.all([
      buildCopy(relative),
      readFile(destination, 'utf8'),
    ]);
    if (target !== expected) {
      return false;
    }
  }

  return true;
}

const isCheckOnly = process.argv.includes('--check');

if (isCheckOnly) {
  const current = await isUpToDate();
  if (current) {
    console.log('[edge:sync] Shared sources are up to date.');
  } else {
    console.error('[edge:sync] Shared sources are STALE. Run `npm run edge:sync`.');
    process.exitCode = 1;
  }
} else {
  const { copied, skipped } = await sync();
  console.log(`[edge:sync] Copied ${copied.length} module(s) into supabase/functions/_shared/src.`);
  if (skipped.length > 0) {
    console.log(`[edge:sync] Excluded (Node-only CLI entry): ${skipped.join(', ')}`);
  }
}