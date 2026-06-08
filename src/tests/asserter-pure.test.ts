/**
 * src/tests/asserter-pure.test.ts
 *
 * Unit tests for pure functions in src/asserter.ts:
 *   assertStatus, assertionsAllPassed, getExpectedPathFromTest
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStatus, assertionsAllPassed, getExpectedPathFromTest } from '../asserter.js';
import type { AssertionResults, TestDefinition, ShogunConfig } from '../types.js';
import { join } from 'node:path';

// ===========================================================================
// assertStatus
// ===========================================================================

describe('assertStatus()', () => {
  test('returns true when actual equals expected', () => {
    assert.equal(assertStatus(200, 200), true);
    assert.equal(assertStatus(404, 404), true);
    assert.equal(assertStatus(500, 500), true);
  });

  test('returns false when actual differs from expected', () => {
    assert.equal(assertStatus(200, 201), false);
    assert.equal(assertStatus(404, 200), false);
    assert.equal(assertStatus(500, 200), false);
  });

  test('uses strict equality — number comparison', () => {
    assert.equal(assertStatus(200 as any, '200' as any), false);
  });
});

// ===========================================================================
// assertionsAllPassed
// ===========================================================================

describe('assertionsAllPassed()', () => {
  test('returns true for empty results (no assertions failed)', () => {
    assert.equal(assertionsAllPassed({}), true);
  });

  test('returns true when all assertions pass', () => {
    const results: AssertionResults = {
      status: true,
      shape: [{ expr: '.id', passed: true }],
      snapshot: true,
      postScript: true,
    };
    assert.equal(assertionsAllPassed(results), true);
  });

  test('returns false when status is false', () => {
    assert.equal(assertionsAllPassed({ status: false }), false);
  });

  test('returns false when any shape assertion failed', () => {
    const results: AssertionResults = {
      status: true,
      shape: [
        { expr: '.id', passed: true },
        { expr: '.name', passed: false, error: 'missing' },
      ],
    };
    assert.equal(assertionsAllPassed(results), false);
  });

  test('returns false when snapshot is false', () => {
    assert.equal(assertionsAllPassed({ status: true, snapshot: false }), false);
  });

  test('returns false when postScript is false', () => {
    assert.equal(assertionsAllPassed({ status: true, postScript: false }), false);
  });

  test('returns true when snapshot is true', () => {
    assert.equal(assertionsAllPassed({ status: true, snapshot: true }), true);
  });

  test('returns true when postScript is true', () => {
    assert.equal(assertionsAllPassed({ status: true, postScript: true }), true);
  });

  test('returns true when status is undefined (not checked)', () => {
    // status is only checked if it's explicitly false
    assert.equal(assertionsAllPassed({ status: undefined }), true);
  });

  test('returns true when shape is empty array', () => {
    assert.equal(assertionsAllPassed({ status: true, shape: [] }), true);
  });
});

// ===========================================================================
// getExpectedPathFromTest
// ===========================================================================

describe('getExpectedPathFromTest()', () => {
  const testDef: TestDefinition = {
    name: 'get-users',
    request: { method: 'GET', path: '/api/users' },
  };

  const config: ShogunConfig = { version: 1 };

  test('uses default expected directory when config.paths.expected not set', () => {
    const result = getExpectedPathFromTest(testDef, config, '/project');
    assert.equal(result, join('/project', 'expected', 'default', 'GET_api_users.json'));
  });

  test('uses collectionName when provided', () => {
    const result = getExpectedPathFromTest(testDef, config, '/project', 'my-collection');
    assert.equal(result, join('/project', 'expected', 'my-collection', 'GET_api_users.json'));
  });

  test('uses test.collection when collectionName not provided', () => {
    const testWithCollection: TestDefinition = {
      name: 'get-users',
      collection: 'graph',
      request: { method: 'GET', path: '/api/users' },
    };
    const result = getExpectedPathFromTest(testWithCollection, config, '/project');
    assert.equal(result, join('/project', 'expected', 'graph', 'GET_api_users.json'));
  });

  test('uses custom expected path from config', () => {
    const customConfig: ShogunConfig = {
      version: 1,
      paths: { expected: 'snapshots' },
    };
    const result = getExpectedPathFromTest(testDef, customConfig, '/project');
    assert.equal(result, join('/project', 'snapshots', 'default', 'GET_api_users.json'));
  });

  test('defaults cwd to process.cwd() when not provided', () => {
    const result = getExpectedPathFromTest(testDef, config);
    assert.ok(result.includes('expected'));
    assert.ok(result.endsWith('GET_api_users.json'));
  });
});
