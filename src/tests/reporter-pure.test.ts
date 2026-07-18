/**
 * src/tests/reporter-pure.test.ts
 *
 * Unit tests for pure functions from reporter.ts.
 *
 * Covers:
 *   - getFailureReasons() — assertion result → human-readable failure strings
 *   - formatTimings() — timing breakdown formatting
 *
 * Run with:
 *   npx tsx --test src/tests/reporter-pure.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getFailureReasons, formatTimings } from '../reporter.js';
import type { AssertionResults, TestResult } from '../types.js';

// ---------------------------------------------------------------------------
// getFailureReasons
// ---------------------------------------------------------------------------

describe('getFailureReasons()', () => {

  test('all-passing assertions returns empty array', () => {
    const assertions: AssertionResults = {
      status: true,
      shape: [{ expr: '.data | length > 0', passed: true }],
      snapshot: true,
      postScript: true,
    };
    const reasons = getFailureReasons(assertions);
    assert.deepEqual(reasons, []);
  });

  test('status mismatch produces "Status code mismatch"', () => {
    const assertions: AssertionResults = { status: false };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Status code mismatch/);
  });

  test('failed shape assertion includes expression', () => {
    const assertions: AssertionResults = {
      shape: [{ expr: '.id != null', passed: false, error: 'null result' }],
    };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Shape assertion failed/);
    assert.match(reasons[0]!, /\.id != null/);
    assert.match(reasons[0]!, /null result/);
  });

  test('failed shape assertion without error still includes expression', () => {
    const assertions: AssertionResults = {
      shape: [{ expr: '.items | length > 0', passed: false }],
    };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Shape assertion failed.*\.items \| length > 0/);
    assert.ok(!reasons[0]!.includes('—'), 'Should not include "—" separator when no error');
  });

  test('multiple failed shape assertions each produce a reason', () => {
    const assertions: AssertionResults = {
      shape: [
        { expr: '.id != null', passed: false },
        { expr: '.name | length > 0', passed: false, error: 'empty' },
      ],
    };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 2);
  });

  test('snapshot mismatch produces "Snapshot mismatch"', () => {
    const assertions: AssertionResults = { snapshot: false };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Snapshot mismatch/);
  });

  test('postScript failure includes error message', () => {
    const assertions: AssertionResults = {
      postScript: false,
      postScriptError: 'expected 200, got 404',
    };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Post-script/);
    assert.match(reasons[0]!, /expected 200, got 404/);
  });

  test('postScript failure without error uses default message', () => {
    const assertions: AssertionResults = { postScript: false };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Post-script.*assertion failed/);
  });

  test('multiple failures all appear in reasons', () => {
    const assertions: AssertionResults = {
      status: false,
      snapshot: false,
      postScript: false,
      postScriptError: 'boom',
    };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 3);
    assert.match(reasons[0]!, /Status code mismatch/);
    assert.match(reasons[1]!, /Snapshot mismatch/);
    assert.match(reasons[2]!, /Post-script/);
  });

  test('empty assertions object returns empty array', () => {
    const reasons = getFailureReasons({});
    assert.deepEqual(reasons, []);
  });

  test('status: undefined is NOT a failure (field not checked)', () => {
    // When a test has no expected status, status is undefined — that's not a failure
    const assertions: AssertionResults = {};
    const reasons = getFailureReasons(assertions);
    assert.deepEqual(reasons, []);
  });

  test('snapshot: undefined is NOT a failure', () => {
    const assertions: AssertionResults = {};
    const reasons = getFailureReasons(assertions);
    assert.deepEqual(reasons, []);
  });

  test('passing shape alongside failing snapshot only reports snapshot', () => {
    const assertions: AssertionResults = {
      shape: [{ expr: '.ok', passed: true }],
      snapshot: false,
    };
    const reasons = getFailureReasons(assertions);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Snapshot mismatch/);
  });
});

// ---------------------------------------------------------------------------
// formatTimings
// ---------------------------------------------------------------------------

describe('formatTimings()', () => {

  test('no timings returns empty string', () => {
    const result = makeTestResult({ timings: undefined });
    assert.equal(formatTimings(result), '');
  });

  test('curl timing always shown', () => {
    const result = makeTestResult({
      timings: { curlMs: 120, assertMs: 0, preMs: 0, postMs: 0, otherMs: 0 },
    });
    const formatted = formatTimings(result);
    assert.match(formatted, /curl:120ms/);
  });

  test('pre timing shown when > 0', () => {
    const result = makeTestResult({
      timings: { curlMs: 50, assertMs: 0, preMs: 30, postMs: 0, otherMs: 0 },
    });
    assert.match(formatTimings(result), /pre:30ms/);
  });

  test('pre timing hidden when 0', () => {
    const result = makeTestResult({
      timings: { curlMs: 50, assertMs: 0, preMs: 0, postMs: 0, otherMs: 0 },
    });
    assert.ok(!formatTimings(result).includes('pre:'), 'Zero preMs should not appear');
  });

  test('all timings shown when all > 0', () => {
    const result = makeTestResult({
      timings: { curlMs: 100, assertMs: 50, preMs: 30, postMs: 20, otherMs: 10 },
    });
    const formatted = formatTimings(result);
    assert.match(formatted, /curl:100ms/);
    assert.match(formatted, /assert:50ms/);
    assert.match(formatted, /pre:30ms/);
    assert.match(formatted, /post:20ms/);
    assert.match(formatted, /other:10ms/);
  });

  test('only assert and post shown (no pre, no other)', () => {
    const result = makeTestResult({
      timings: { curlMs: 80, assertMs: 40, preMs: 0, postMs: 15, otherMs: 0 },
    });
    const formatted = formatTimings(result);
    assert.match(formatted, /curl:80ms/);
    assert.match(formatted, /assert:40ms/);
    assert.match(formatted, /post:15ms/);
    assert.ok(!formatted.includes('pre:'), 'Zero preMs should not appear');
    assert.ok(!formatted.includes('other:'), 'Zero otherMs should not appear');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestResult(overrides: Partial<TestResult>): TestResult {
  return {
    name: 'test',
    file: 'test.yaml',
    status: 'passed',
    durationMs: 100,
    assertions: {},
    ...overrides,
  } as TestResult;
}
