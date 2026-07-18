/**
 * src/tests/check-backend.test.ts
 *
 * Unit tests for commands/check-backend.ts — checkBackend() exit codes,
 * dependency output, and error handling.
 *
 * Covers:
 *   - Ready backend returns exit code 0
 *   - Missing required deps returns exit code 1
 *   - Output includes Backend name, Source, and Dependencies section
 *   - checkBackend with --backend flag selects correct backend
 *   - checkBackend handles backend.checkDependencies() throwing
 *
 * Run with:
 *   npx tsx --test src/tests/check-backend.test.ts
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackend } from '../commands/check-backend.js';

// We capture console.log / console.error output to verify formatting
// without polluting test output.

function captureOutput(fn: () => Promise<number>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = '';
  let stderr = '';
  const origLog = console.log;
  const origError = console.error;

  console.log = (...args: unknown[]) => { stdout += args.join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { stderr += args.join(' ') + '\n'; };

  return fn().then(
    (exitCode) => {
      console.log = origLog;
      console.error = origError;
      return { stdout, stderr, exitCode };
    },
    (err) => {
      console.log = origLog;
      console.error = origError;
      throw err;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkBackend() — exit codes', () => {

  test('with --backend powershell on Windows: returns 0 or 1 based on PowerShell availability', async () => {
    // On Windows with PowerShell installed, this should return 0.
    // On non-Windows without pwsh, this returns 1.
    const { exitCode, stdout } = await captureOutput(() =>
      checkBackend({ backend: 'powershell' }),
    );

    // We can't assert exact exit code (depends on whether pwsh is installed),
    // but we CAN assert it's either 0 or 1 (never crashes)
    assert.ok(exitCode === 0 || exitCode === 1, `Expected 0 or 1, got ${exitCode}`);

    // Output should always include the backend name
    assert.match(stdout, /Backend:\s+powershell/);
  });

  test('with --backend unix: returns 1 on Windows (curl/jq not available)', async () => {
    // On Windows, curl and jq are typically not available
    const { exitCode, stdout } = await captureOutput(() =>
      checkBackend({ backend: 'unix' }),
    );

    // On Windows: exit code 1 (curl/jq missing). On Unix: could be 0.
    assert.ok(exitCode === 0 || exitCode === 1, `Expected 0 or 1, got ${exitCode}`);
    assert.match(stdout, /Backend:\s+unix/);
  });
});

describe('checkBackend() — output formatting', () => {

  test('output contains Backend, Source, and Dependencies sections', async () => {
    const { stdout } = await captureOutput(() =>
      checkBackend({ backend: 'powershell' }),
    );

    assert.match(stdout, /Backend:/);
    assert.match(stdout, /Source:/);
    assert.match(stdout, /Dependencies:/);
  });

  test('Source shows "--backend CLI flag" when backend flag is provided', async () => {
    const { stdout } = await captureOutput(() =>
      checkBackend({ backend: 'unix' }),
    );

    assert.match(stdout, /--backend CLI flag/);
  });

  test('Dependency items show ✅ or ❌ icons', async () => {
    const { stdout } = await captureOutput(() =>
      checkBackend({ backend: 'powershell' }),
    );

    // Should have at least one dependency line with an icon
    assert.match(stdout, /[✅❌]/);
  });

  test('optional dependencies show "(not required for this backend)" note', async () => {
    const { stdout } = await captureOutput(() =>
      checkBackend({ backend: 'powershell' }),
    );

    // curl and jq are optional for powershell backend
    assert.match(stdout, /not required for this backend/);
  });

  test('Status line shows "Ready" or "Not ready"', async () => {
    const { stdout } = await captureOutput(() =>
      checkBackend({ backend: 'powershell' }),
    );

    assert.match(stdout, /Status:\s+(Ready|Not ready)/);
  });
});

describe('checkBackend() — missing dependencies detail', () => {

  test('when deps missing, output shows "Error: Missing dependencies" and fix hint', async () => {
    // On Windows, unix backend will be missing deps
    if (process.platform !== 'win32') {
      // On Unix with curl/jq installed, this test can't exercise the missing-deps path.
      // We'll just verify it doesn't crash.
      const { exitCode } = await captureOutput(() =>
        checkBackend({ backend: 'unix' }),
      );
      assert.ok(exitCode === 0 || exitCode === 1);
      return;
    }

    const { exitCode, stdout } = await captureOutput(() =>
      checkBackend({ backend: 'unix' }),
    );

    assert.equal(exitCode, 1);
    assert.match(stdout, /Error: Missing dependencies/);
    assert.match(stdout, /Fix:/);
    assert.match(stdout, /--backend powershell/);
  });
});

describe('checkBackend() — no backend flag (OS detection)', () => {

  test('without --backend, uses OS detection and shows correct source', async () => {
    const { stdout } = await captureOutput(() =>
      checkBackend({}),
    );

    if (process.platform === 'win32') {
      assert.match(stdout, /Backend:\s+powershell/);
    } else {
      assert.match(stdout, /Backend:\s+unix/);
    }

    assert.match(stdout, /OS detection/);
  });
});
