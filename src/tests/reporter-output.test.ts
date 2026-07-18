/**
 * src/tests/reporter-output.test.ts
 *
 * Unit tests for output-rendering functions in src/reporter.ts:
 *   printTestResult, printTap, printSummary
 *
 * These functions write to process.stdout / console.log, so we capture output
 * by temporarily redirecting stdout.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { printTestResult, printReport, printSummary } from '../reporter.js';
import type { RunSummary, TestResult, AssertionResults } from '../types.js';

// ---------------------------------------------------------------------------
// Helper: capture stdout writes
// ---------------------------------------------------------------------------

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: string) => { chunks.push(chunk); return true; };
  // Also capture console.log which writes to stdout
  const origLog = console.log;
  console.log = (...args: any[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  };
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'test-name',
    file: '/project/tests/test.yaml',
    status: 'passed',
    durationMs: 42,
    assertions: {},
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: '20260608_143000',
    env: 'local',
    startedAt: '2026-06-08T14:30:00Z',
    finishedAt: '2026-06-08T14:30:05Z',
    durationMs: 5000,
    total: 1,
    passed: 1,
    failed: 0,
    needsBaseline: 0,
    dependencyFailed: 0,
    results: [],
    ...overrides,
  };
}

// ===========================================================================
// printTestResult
// ===========================================================================

describe('printTestResult()', () => {
  test('prints OK for passed test', () => {
    const output = captureStdout(() => {
      printTestResult(makeTestResult({ status: 'passed', durationMs: 42 }));
    });
    assert.ok(output.includes('OK'));
    assert.ok(output.includes('42ms'));
  });

  test('prints FAIL for failed test', () => {
    const assertions: AssertionResults = { status: false };
    const output = captureStdout(() => {
      printTestResult(makeTestResult({
        status: 'failed',
        assertions,
        error: 'Status code mismatch',
      }));
    });
    assert.ok(output.includes('FAIL'));
    assert.ok(output.includes('Status code mismatch'));
  });

  test('prints NEEDS BASELINE for needs_baseline test', () => {
    const output = captureStdout(() => {
      printTestResult(makeTestResult({ status: 'needs_baseline' }));
    });
    assert.ok(output.includes('NEEDS BASELINE'));
  });

  test('prints SKIPPED for dependency_failed test', () => {
    const output = captureStdout(() => {
      printTestResult(makeTestResult({
        status: 'dependency_failed',
        failedDependency: 'other-coll/setup-test',
      }));
    });
    assert.ok(output.includes('SKIPPED'));
    assert.ok(output.includes('other-coll/setup-test'));
  });

  test('prints failure reasons for failed test', () => {
    const assertions: AssertionResults = {
      status: true,
      shape: [{ expr: '.id', passed: false, error: 'not found' }],
      snapshot: false,
    };
    const output = captureStdout(() => {
      printTestResult(makeTestResult({ status: 'failed', assertions }));
    });
    assert.ok(output.includes('Shape assertion failed'));
    assert.ok(output.includes('Snapshot mismatch'));
  });

  test('prints http status when available', () => {
    const output = captureStdout(() => {
      printTestResult(makeTestResult({
        status: 'passed',
        httpStatus: 200,
        durationMs: 10,
      }));
    });
    assert.ok(output.includes('200'));
  });
});

// ===========================================================================
// printTap
// ===========================================================================

describe('printReport(format="tap")', () => {
  test('outputs TAP version header', () => {
    const output = captureStdout(() => {
      printReport(makeRunSummary({ total: 1, results: [
        makeTestResult({ status: 'passed', name: 'my-test' }),
      ]}), 'tap');
    });
    assert.ok(output.includes('TAP version 14'));
  });

  test('outputs plan line 1..N', () => {
    const output = captureStdout(() => {
      printReport(makeRunSummary({ total: 2, results: [
        makeTestResult({ status: 'passed', name: 'test-1' }),
        makeTestResult({ status: 'passed', name: 'test-2' }),
      ]}), 'tap');
    });
    assert.ok(output.includes('1..2'));
  });

  test('outputs "ok" for passed tests', () => {
    const output = captureStdout(() => {
      printReport(makeRunSummary({ total: 1, results: [
        makeTestResult({ status: 'passed', name: 'my-test' }),
      ]}), 'tap');
    });
    assert.ok(output.includes('ok 1 - my-test'));
  });

  test('outputs "not ok" for failed tests', () => {
    const output = captureStdout(() => {
      printReport(makeRunSummary({ total: 1, results: [
        makeTestResult({ status: 'failed', name: 'bad-test', error: 'oops' }),
      ]}), 'tap');
    });
    assert.ok(output.includes('not ok 1 - bad-test'));
    assert.ok(output.includes('message:'));
  });

  test('outputs "not ok" with SKIP for dependency_failed', () => {
    const output = captureStdout(() => {
      printReport(makeRunSummary({ total: 1, results: [
        makeTestResult({
          status: 'dependency_failed',
          name: 'skipped-test',
          failedDependency: 'setup',
        }),
      ]}), 'tap');
    });
    assert.ok(output.includes('not ok 1 - skipped-test'));
    assert.ok(output.includes('SKIP'));
  });
});

// ===========================================================================
// printSummary
// ===========================================================================

describe('printSummary()', () => {
  test('prints all-passed summary when no failures', () => {
    const output = captureStdout(() => {
      printSummary(makeRunSummary({ total: 3, passed: 3 }));
    });
    assert.ok(output.includes('All 3 tests passed'));
  });

  test('prints failure count when there are failures', () => {
    const output = captureStdout(() => {
      printSummary(makeRunSummary({
        total: 3, passed: 1, failed: 2,
        results: [
          makeTestResult({ status: 'failed', name: 'f1' }),
          makeTestResult({ status: 'failed', name: 'f2' }),
        ],
      }));
    });
    assert.ok(output.includes('2 failed'));
    assert.ok(output.includes('1 passed'));
  });

  test('prints dependency_failed count', () => {
    const output = captureStdout(() => {
      printSummary(makeRunSummary({
        total: 3, passed: 1, dependencyFailed: 2,
        results: [
          makeTestResult({ status: 'dependency_failed', name: 'd1', failedDependency: 'setup' }),
          makeTestResult({ status: 'dependency_failed', name: 'd2', failedDependency: 'setup' }),
        ],
      }));
    });
    assert.ok(output.includes('2 skipped (dep failed)') || output.includes('2') && output.includes('dep'));
  });

  test('prints needs_baseline count', () => {
    const output = captureStdout(() => {
      printSummary(makeRunSummary({ total: 2, passed: 1, needsBaseline: 1 }));
    });
    assert.ok(output.includes('1 need baseline') || output.includes('needs baseline'));
  });

  test('includes run ID and env', () => {
    const output = captureStdout(() => {
      printSummary(makeRunSummary({ runId: '20260608_143000', env: 'staging' }));
    });
    assert.ok(output.includes('20260608_143000'));
    assert.ok(output.includes('staging'));
  });
});
