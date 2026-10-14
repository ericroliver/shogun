/**
 * scripts/run-unit-tests.mjs
 *
 * Cross-platform unit test runner — the implementation behind
 * `npm run test:unit`.
 *
 * Discovers every `src/tests/*.test.ts` file and runs them through
 * `node --import tsx --test <files>`:
 *   - no hardcoded test paths that drift out of sync with the tree
 *   - no reliance on shell glob expansion (which does not exist on Windows)
 *   - works on any Node >= 20 (explicit file list; no --test glob support
 *     needed)
 *
 * Exits with the test runner's exit code: nonzero when any test fails.
 * If a test file needs an external service it must self-skip (t.skip) —
 * everything under src/tests/ is expected to be unit-level.
 */

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, '..', 'src', 'tests');

const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('src', 'tests', f));

if (testFiles.length === 0) {
  console.error('No test files found in src/tests/ — aborting.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} unit test files...\n`);

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  { stdio: 'inherit', cwd: join(__dirname, '..') },
);

child.on('close', (code) => {
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  console.error('Failed to start test runner:', err);
  process.exit(1);
});
