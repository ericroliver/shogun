/**
 * src/tests/backend-factory.test.ts
 *
 * Unit tests for backend-factory.ts — createBackend() selection hierarchy
 * and getBackendSource() descriptive strings.
 *
 * Covers:
 *   - CLI flag takes highest priority
 *   - SHOGUN_BACKEND env var is second priority
 *   - OS detection is the fallback
 *   - Invalid --backend value throws
 *   - getBackendSource() returns correct descriptive string per layer
 *
 * Run with:
 *   npx tsx --test src/tests/backend-factory.test.ts
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, getBackendSource } from '../backend-factory.js';
import { UnixBackend } from '../backends/unix-backend.js';
import { PowerShellBackend } from '../backends/powershell-backend.js';

// ---------------------------------------------------------------------------
// Helpers — save/restore SHOGUN_BACKEND env
// ---------------------------------------------------------------------------

let savedEnv: string | undefined;

function saveEnv(): void {
  savedEnv = process.env.SHOGUN_BACKEND;
}

function restoreEnv(): void {
  if (savedEnv === undefined) {
    delete process.env.SHOGUN_BACKEND;
  } else {
    process.env.SHOGUN_BACKEND = savedEnv;
  }
}

function clearEnv(): void {
  delete process.env.SHOGUN_BACKEND;
}

function setEnv(value: string): void {
  process.env.SHOGUN_BACKEND = value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBackend() — CLI flag priority', () => {

  test('cliBackend="powershell" returns PowerShellBackend', () => {
    clearEnv();
    const backend = createBackend('powershell');
    assert.ok(backend instanceof PowerShellBackend);
    assert.equal(backend.name, 'powershell');
  });

  test('cliBackend="unix" returns UnixBackend', () => {
    clearEnv();
    const backend = createBackend('unix');
    assert.ok(backend instanceof UnixBackend);
    assert.equal(backend.name, 'unix');
  });

  test('cliBackend overrides SHOGUN_BACKEND env var', () => {
    setEnv('powershell');
    try {
      // CLI says unix, env says powershell — CLI wins
      const backend = createBackend('unix');
      assert.ok(backend instanceof UnixBackend);
    } finally {
      clearEnv();
    }
  });

  test('cliBackend="bogus" throws Error with valid values listed', () => {
    clearEnv();
    assert.throws(
      () => createBackend('bogus'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Invalid --backend value.*bogus/);
        assert.match(err.message, /unix.*powershell/);
        return true;
      },
    );
  });

  test('empty string cliBackend is treated as undefined (falls through)', () => {
    // Empty string is falsy — should NOT throw "Invalid --backend value"
    setEnv('unix');
    try {
      const backend = createBackend('');
      assert.ok(backend instanceof UnixBackend);
    } finally {
      clearEnv();
    }
  });
});

describe('createBackend() — SHOGUN_BACKEND env var priority', () => {

  test('SHOGUN_BACKEND=powershell (no CLI) returns PowerShellBackend', () => {
    setEnv('powershell');
    try {
      const backend = createBackend();
      assert.ok(backend instanceof PowerShellBackend);
    } finally {
      clearEnv();
    }
  });

  test('SHOGUN_BACKEND=unix (no CLI) returns UnixBackend', () => {
    setEnv('unix');
    try {
      const backend = createBackend();
      assert.ok(backend instanceof UnixBackend);
    } finally {
      clearEnv();
    }
  });

  test('SHOGUN_BACKEND is case-insensitive (PowerShell vs powershell)', () => {
    setEnv('PowerShell');
    try {
      const backend = createBackend();
      assert.ok(backend instanceof PowerShellBackend);
    } finally {
      clearEnv();
    }
  });

  test('SHOGUN_BACKEND with whitespace is trimmed', () => {
    setEnv('  unix  ');
    try {
      const backend = createBackend();
      assert.ok(backend instanceof UnixBackend);
    } finally {
      clearEnv();
    }
  });

  test('SHOGUN_BACKEND=invalid falls through to OS detection (does NOT throw)', () => {
    setEnv('bogus');
    try {
      // Invalid env value is silently ignored — falls through to OS detection
      const backend = createBackend();
      // Just verify it returns *some* backend — which one depends on OS
      assert.ok(backend instanceof UnixBackend || backend instanceof PowerShellBackend);
    } finally {
      clearEnv();
    }
  });
});

describe('createBackend() — OS detection fallback', () => {

  test('no CLI, no env → returns a valid backend based on platform', () => {
    clearEnv();
    const backend = createBackend();
    if (process.platform === 'win32') {
      assert.ok(backend instanceof PowerShellBackend, 'Windows default should be PowerShellBackend');
    } else {
      assert.ok(backend instanceof UnixBackend, 'Non-Windows default should be UnixBackend');
    }
  });

  test('each call returns a new instance (no shared state)', () => {
    clearEnv();
    const a = createBackend('unix');
    const b = createBackend('unix');
    assert.notStrictEqual(a, b, 'Each createBackend() call should return a new instance');
  });
});

describe('getBackendSource() — descriptive strings', () => {

  test('returns "--backend CLI flag" when cliBackend is provided', () => {
    assert.equal(getBackendSource('unix'), '--backend CLI flag');
    assert.equal(getBackendSource('powershell'), '--backend CLI flag');
  });

  test('returns "SHOGUN_BACKEND env var" when env is set (no CLI)', () => {
    setEnv('unix');
    try {
      assert.equal(getBackendSource(), 'SHOGUN_BACKEND env var');
    } finally {
      clearEnv();
    }
  });

  test('returns "OS detection" when no CLI and no env', () => {
    clearEnv();
    const source = getBackendSource();
    assert.match(source, /^OS detection/);
    assert.match(source, new RegExp(process.platform));
  });

  test('CLI flag takes priority over env var in source description', () => {
    setEnv('powershell');
    try {
      // CLI provided — should say CLI flag, not env var
      assert.equal(getBackendSource('unix'), '--backend CLI flag');
    } finally {
      clearEnv();
    }
  });
});
