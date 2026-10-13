/**
 * Syntax check for every JavaScript file in the project.
 *
 * Exists because the previous one-liner (`node --check` with shell-expanded
 * globs) silently passed: it only ever inspected the first file it was given,
 * and a POSIX shell expands a double star to a single level, so files such as
 * `src/index.js` were never parsed. A deliberately broken file left that script
 * exiting 0.
 *
 * Checks each file individually and reports every failure in one run.
 *
 * @returns {number} Process exit code: 0 when clean, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['src', 'test', 'scripts', 'supabase/functions'];
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'coverage']);

// `_shared` is the generated mirror of `src/` for the Edge Function bundle
// (see scripts/sync-edge-sources.js). Checking it would only re-parse code that
// `src` already covers, and its files carry a generated banner.
const GENERATED_DIRECTORIES = new Set(['_shared']);

/**
 * Recursively collects .js files under a directory.
 *
 * @param {string} directory Absolute path to walk.
 * @returns {string[]} Absolute file paths.
 */
function collectJavaScriptFiles(directory) {
  let entries;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !GENERATED_DIRECTORIES.has(entry.name)) {
        files.push(...collectJavaScriptFiles(entryPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }

  return files;
}

const files = roots
  .flatMap((root) => collectJavaScriptFiles(join(projectRoot, root)))
  .sort();

if (files.length === 0) {
  console.error('[lint] No JavaScript files found — refusing to report success.');
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });

  if (result.status !== 0) {
    const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
    failures.push({ file: relative(projectRoot, file), output });
  }
}

for (const failure of failures) {
  console.error(`\n[lint] ${failure.file}`);
  console.error(failure.output);
}

const fileLabel = files.length === 1 ? 'file' : 'files';
const errorLabel = failures.length === 1 ? 'error' : 'errors';

console.log(
  `[lint] ${failures.length === 0 ? 'OK' : 'FAILED'} — ${files.length} ${fileLabel} checked, ${failures.length} with syntax ${errorLabel}`
);

process.exit(failures.length === 0 ? 0 : 1);