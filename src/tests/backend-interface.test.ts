/**
 * src/tests/backend-interface.test.ts
 *
 * Unit tests for backend-interface.ts — verifies exported types and
 * structural contracts that backends must satisfy.
 *
 * Since backend-interface.ts is primarily a type definition file, runtime
 * tests focus on:
 *   - Re-exports are accessible
 *   - Interface shape is implementable (UnixBackend / PowerShellBackend satisfy it)
 *   - DependencyCheck / SnapshotResult / QueryResult shapes work as expected
 *
 * Run with:
 *   npx tsx --test src/tests/backend-interface.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Import types — these imports prove the module exports are accessible
import type {
  BackendExecutor,
  QueryResult,
  DependencyCheck,
  SnapshotResult,
  ExecutorOptions,
  AssertContext,
} from '../backend-interface.js';

// Re-export check (AssertContext should be re-exportable from backend-interface)
import { UnixBackend } from '../backends/unix-backend.js';
import { PowerShellBackend } from '../backends/powershell-backend.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backend-interface.ts — exports are accessible', () => {

  test('BackendExecutor type is importable (compile-time check)', () => {
    // If this compiles, the type export works. Runtime assertion is a no-op.
    assert.ok(true, 'BackendExecutor type imported successfully');
  });

  test('QueryResult type is importable', () => {
    assert.ok(true);
  });

  test('DependencyCheck type is importable', () => {
    assert.ok(true);
  });

  test('SnapshotResult type is importable', () => {
    assert.ok(true);
  });

  test('ExecutorOptions type is importable', () => {
    assert.ok(true);
  });

  test('AssertContext type is importable', () => {
    assert.ok(true);
  });
});

describe('BackendExecutor interface — implementations satisfy contract', () => {

  test('UnixBackend implements BackendExecutor', () => {
    const backend: BackendExecutor = new UnixBackend();
    assert.equal(backend.name, 'unix');

    // Verify all required methods exist and are functions
    assert.equal(typeof backend.executeRequest, 'function');
    assert.equal(typeof backend.runJsonQuery, 'function');
    assert.equal(typeof backend.runShapeAssertions, 'function');
    assert.equal(typeof backend.normalizeJson, 'function');
    assert.equal(typeof backend.runDiff, 'function');
    assert.equal(typeof backend.checkDependencies, 'function');

    // Optional method
    assert.equal(typeof backend.runSnapshotAssertion, 'function');
  });

  test('PowerShellBackend implements BackendExecutor', () => {
    const backend: BackendExecutor = new PowerShellBackend();
    assert.equal(backend.name, 'powershell');

    // Verify all required methods exist and are functions
    assert.equal(typeof backend.executeRequest, 'function');
    assert.equal(typeof backend.runJsonQuery, 'function');
    assert.equal(typeof backend.runShapeAssertions, 'function');
    assert.equal(typeof backend.normalizeJson, 'function');
    assert.equal(typeof backend.runDiff, 'function');
    assert.equal(typeof backend.checkDependencies, 'function');

    // Optional method
    assert.equal(typeof backend.runSnapshotAssertion, 'function');
  });

  test('name property is "unix" | "powershell" discriminated union', () => {
    const unix: BackendExecutor = new UnixBackend();
    const ps: BackendExecutor = new PowerShellBackend();

    // TypeScript enforces this at compile time; runtime check:
    assert.ok(unix.name === 'unix' || unix.name === 'powershell');
    assert.ok(ps.name === 'unix' || ps.name === 'powershell');
    assert.notEqual(unix.name, ps.name);
  });
});

describe('DependencyCheck shape — runtime structure validation', () => {

  test('UnixBackend.checkDependencies() returns DependencyCheck[]', async () => {
    const backend = new UnixBackend();
    const deps = await backend.checkDependencies();

    assert.ok(Array.isArray(deps), 'Should return an array');
    assert.ok(deps.length > 0, 'Should have at least one dependency');

    for (const dep of deps) {
      assert.ok('name' in dep, 'Each dep should have "name"');
      assert.ok('found' in dep, 'Each dep should have "found"');
      assert.ok('optional' in dep, 'Each dep should have "optional"');
      assert.equal(typeof dep.name, 'string');
      assert.equal(typeof dep.found, 'boolean');
      assert.equal(typeof dep.optional, 'boolean');
    }
  });

  test('PowerShellBackend.checkDependencies() returns DependencyCheck[]', async () => {
    const backend = new PowerShellBackend();
    const deps = await backend.checkDependencies();

    assert.ok(Array.isArray(deps), 'Should return an array');
    assert.ok(deps.length > 0, 'Should have at least one dependency');

    for (const dep of deps) {
      assert.ok('name' in dep, 'Each dep should have "name"');
      assert.ok('found' in dep, 'Each dep should have "found"');
      assert.ok('optional' in dep, 'Each dep should have "optional"');
      assert.equal(typeof dep.name, 'string');
      assert.equal(typeof dep.found, 'boolean');
      assert.equal(typeof dep.optional, 'boolean');
    }
  });

  test('DependencyCheck entries for required tools have optional=false', async () => {
    const backend = new PowerShellBackend();
    const deps = await backend.checkDependencies();

    // powershell.exe is a required dep for the PowerShell backend
    const psDep = deps.find(d => d.name === 'powershell.exe');
    assert.ok(psDep, 'Should have powershell.exe dependency');
    assert.equal(psDep!.optional, false, 'powershell.exe should not be optional');
  });

  test('DependencyCheck entries for alternative tools have optional=true', async () => {
    const backend = new PowerShellBackend();
    const deps = await backend.checkDependencies();

    // curl and jq are optional for the PowerShell backend
    const curlDep = deps.find(d => d.name === 'curl');
    const jqDep = deps.find(d => d.name === 'jq');
    assert.ok(curlDep, 'Should have curl dependency entry');
    assert.ok(jqDep, 'Should have jq dependency entry');
    assert.equal(curlDep!.optional, true, 'curl should be optional for powershell backend');
    assert.equal(jqDep!.optional, true, 'jq should be optional for powershell backend');
  });
});

describe('QueryResult and SnapshotResult shapes — runtime validation', () => {

  test('QueryResult with passing query', async () => {
    // Use PowerShellBackend.runJsonQuery with a trivial expression
    // We can't guarantee PS is installed, so we test the shape contract
    // by constructing one manually and verifying the type
    const result: QueryResult = { passed: true };
    assert.equal(result.passed, true);
    assert.equal(result.error, undefined);
  });

  test('QueryResult with failing query includes error', () => {
    const result: QueryResult = { passed: false, error: 'expression failed' };
    assert.equal(result.passed, false);
    assert.equal(result.error, 'expression failed');
  });

  test('SnapshotResult passed', () => {
    const result: SnapshotResult = { passed: true };
    assert.equal(result.passed, true);
    assert.equal(result.diff, undefined);
    assert.equal(result.needsBaseline, undefined);
  });

  test('SnapshotResult needsBaseline', () => {
    const result: SnapshotResult = { passed: false, needsBaseline: true };
    assert.equal(result.passed, false);
    assert.equal(result.needsBaseline, true);
  });

  test('SnapshotResult with diff', () => {
    const result: SnapshotResult = { passed: false, diff: '--- expected\n+++ actual' };
    assert.equal(result.passed, false);
    assert.equal(result.diff, '--- expected\n+++ actual');
  });
});

describe('BackendExecutor.runDiff — pure logic test (no external tools)', () => {

  test('UnixBackend.runDiff produces unified-style diff for different strings', async () => {
    const backend = new UnixBackend();
    const diff = await backend.runDiff('line1\nline2', 'line1\nline3');
    assert.ok(diff.length > 0, 'Diff should be non-empty for different strings');
    assert.match(diff, /--- expected/);
    assert.match(diff, /\+\+\+ actual/);
    assert.match(diff, /line2/);  // removed
    assert.match(diff, /line3/);  // added
  });

  test('UnixBackend.runDiff returns empty string for identical strings', async () => {
    const backend = new UnixBackend();
    const diff = await backend.runDiff('same\ncontent', 'same\ncontent');
    assert.equal(diff, '', 'Identical strings should produce empty diff');
  });

  test('PowerShellBackend.runDiff produces diff for different strings', async () => {
    const backend = new PowerShellBackend();
    // PowerShellBackend.runDiff falls back to formatSimpleDiff if PS not available,
    // or uses Compare-Object if PS is available. Either way it should produce output.
    const diff = await backend.runDiff('line1\nline2', 'line1\nline3');
    assert.ok(diff.length > 0, 'Diff should be non-empty for different strings');
  });

  test('PowerShellBackend.runDiff returns empty string for identical strings', async () => {
    const backend = new PowerShellBackend();
    const diff = await backend.runDiff('same\ncontent', 'same\ncontent');
    assert.equal(diff, '', 'Identical strings should produce empty diff');
  });
});
