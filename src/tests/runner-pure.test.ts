/**
 * src/tests/runner-pure.test.ts
 *
 * Unit tests for pure helper functions in src/runner.ts:
 *   buildUrl, normalizeParams, mergeRequest, applyVarMutations,
 *   makeDummyRequest, makeFailedResult
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUrl,
  normalizeParams,
  mergeRequest,
  applyVarMutations,
  makeDummyRequest,
  makeFailedResult,
} from '../runner.js';
import type { ShogunRequest } from '../types.js';

// ===========================================================================
// buildUrl
// ===========================================================================

describe('buildUrl()', () => {
  test('concatenates base + path with slash', () => {
    assert.equal(buildUrl('http://api.example.com', '/users'), 'http://api.example.com/users');
  });

  test('strips trailing slash from baseUrl', () => {
    assert.equal(buildUrl('http://api.example.com/', '/users'), 'http://api.example.com/users');
  });

  test('adds leading slash to path if missing', () => {
    assert.equal(buildUrl('http://api.example.com', 'users'), 'http://api.example.com/users');
  });

  test('returns absolute path as-is when path starts with http', () => {
    assert.equal(buildUrl('http://api.example.com', 'http://other.com/thing'), 'http://other.com/thing');
  });

  test('returns absolute path as-is when path starts with https', () => {
    assert.equal(buildUrl('http://api.example.com', 'https://secure.com/api'), 'https://secure.com/api');
  });

  test('handles base without trailing slash and path with leading slash', () => {
    assert.equal(buildUrl('http://api.example.com', '/v1/data'), 'http://api.example.com/v1/data');
  });

  test('handles base with trailing slash and path without leading slash', () => {
    assert.equal(buildUrl('http://api.example.com/', 'v1/data'), 'http://api.example.com/v1/data');
  });

  test('handles deep paths', () => {
    assert.equal(buildUrl('http://api.example.com', '/api/v1/workspaces/my-ws/nodes'), 'http://api.example.com/api/v1/workspaces/my-ws/nodes');
  });
});

// ===========================================================================
// normalizeParams
// ===========================================================================

describe('normalizeParams()', () => {
  test('converts string values as-is', () => {
    assert.deepEqual(normalizeParams({ key: 'value' }), { key: 'value' });
  });

  test('converts number to string', () => {
    assert.deepEqual(normalizeParams({ page: 5 }), { page: '5' });
  });

  test('converts boolean true to string "true"', () => {
    assert.deepEqual(normalizeParams({ active: true }), { active: 'true' });
  });

  test('converts boolean false to string "false"', () => {
    assert.deepEqual(normalizeParams({ active: false }), { active: 'false' });
  });

  test('converts zero to string "0"', () => {
    assert.deepEqual(normalizeParams({ count: 0 }), { count: '0' });
  });

  test('handles mixed types', () => {
    assert.deepEqual(normalizeParams({ name: 'test', page: 1, verbose: true }), { name: 'test', page: '1', verbose: 'true' });
  });

  test('returns empty object for empty input', () => {
    assert.deepEqual(normalizeParams({}), {});
  });
});

// ===========================================================================
// mergeRequest
// ===========================================================================

describe('mergeRequest()', () => {
  const baseRequest: ShogunRequest = {
    method: 'GET',
    path: '/users',
    url: 'http://api.example.com/users',
    headers: { 'Accept': 'application/json' },
    params: {},
  };

  test('returns copy with mutations applied', () => {
    const result = mergeRequest(baseRequest, { method: 'POST' }, 'http://api.example.com');
    assert.equal(result.method, 'POST');
    assert.equal(result.path, '/users'); // unchanged
  });

  test('re-derives URL when path changes', () => {
    const result = mergeRequest(baseRequest, { path: '/items' }, 'http://api.example.com');
    assert.equal(result.path, '/items');
    assert.equal(result.url, 'http://api.example.com/items');
  });

  test('does NOT re-derive URL when path is unchanged', () => {
    const result = mergeRequest(baseRequest, { method: 'DELETE' }, 'http://api.example.com');
    assert.equal(result.url, 'http://api.example.com/users');
  });

  test('merges headers', () => {
    const result = mergeRequest(baseRequest, { headers: { 'Authorization': 'Bearer x' } }, 'http://api.example.com');
    assert.equal(result.headers['Authorization'], 'Bearer x');
    // Original headers are replaced (shallow merge), not merged
  });

  test('shallow-merges — mutations replace base keys', () => {
    const result = mergeRequest(baseRequest, { params: { page: '1' } }, 'http://api.example.com');
    assert.deepEqual(result.params, { page: '1' });
  });

  test('re-derives URL with correct slash handling', () => {
    const result = mergeRequest(baseRequest, { path: '/new-path' }, 'http://api.example.com/');
    assert.equal(result.url, 'http://api.example.com/new-path');
  });
});

// ===========================================================================
// applyVarMutations
// ===========================================================================

describe('applyVarMutations()', () => {
  test('applies mutations to vars object', () => {
    const vars: Record<string, unknown> = { a: 1 };
    applyVarMutations(vars, { b: 2, c: 3 });
    assert.deepEqual(vars, { a: 1, b: 2, c: 3 });
  });

  test('overwrites existing keys', () => {
    const vars: Record<string, unknown> = { a: 1 };
    applyVarMutations(vars, { a: 99 });
    assert.equal(vars.a, 99);
  });

  test('no-op when varMutations is undefined', () => {
    const vars: Record<string, unknown> = { a: 1 };
    applyVarMutations(vars, undefined);
    assert.deepEqual(vars, { a: 1 });
  });

  test('no-op when varMutations is empty', () => {
    const vars: Record<string, unknown> = { a: 1 };
    applyVarMutations(vars, {});
    assert.deepEqual(vars, { a: 1 });
  });

  test('applies null and undefined values', () => {
    const vars: Record<string, unknown> = { a: 1 };
    applyVarMutations(vars, { b: null, c: undefined });
    assert.equal(vars.b, null);
    assert.equal(vars.c, undefined);
  });

  test('applies complex values (objects, arrays)', () => {
    const vars: Record<string, unknown> = {};
    applyVarMutations(vars, { list: [1, 2, 3], obj: { nested: true } });
    assert.deepEqual(vars.list, [1, 2, 3]);
    assert.deepEqual(vars.obj, { nested: true });
  });
});

// ===========================================================================
// makeDummyRequest
// ===========================================================================

describe('makeDummyRequest()', () => {
  test('returns a GET request to base URL', () => {
    const req = makeDummyRequest('http://api.example.com');
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/');
    assert.equal(req.url, 'http://api.example.com');
    assert.deepEqual(req.headers, {});
    assert.deepEqual(req.params, {});
  });

  test('preserves the baseUrl as the url', () => {
    const req = makeDummyRequest('https://secure.api.com');
    assert.equal(req.url, 'https://secure.api.com');
  });
});

// ===========================================================================
// makeFailedResult
// ===========================================================================

describe('makeFailedResult()', () => {
  test('returns a failed TestResult', () => {
    const result = makeFailedResult('test-name', '/path/to/test.yaml', 1000, { status: false }, 'Status mismatch', []);
    assert.equal(result.name, 'test-name');
    assert.equal(result.file, '/path/to/test.yaml');
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Status mismatch');
    assert.deepEqual(result.assertions, { status: false });
  });

  test('durationMs is computed from current time minus startMs', () => {
    const startMs = Date.now() - 50;
    const result = makeFailedResult('test', 'file', startMs, {}, 'err', []);
    // Should be roughly 50ms but we allow some slack
    assert.ok(result.durationMs >= 0);
    assert.ok(result.durationMs < 200); // sanity upper bound
  });

  test('omits scriptOutput when empty array', () => {
    const result = makeFailedResult('test', 'file', Date.now(), {}, 'err', []);
    assert.equal(result.scriptOutput, undefined);
  });

  test('includes scriptOutput when non-empty', () => {
    const result = makeFailedResult('test', 'file', Date.now(), {}, 'err', ['line1', 'line2']);
    assert.deepEqual(result.scriptOutput, ['line1', 'line2']);
  });

  test('httpStatus is not set', () => {
    const result = makeFailedResult('test', 'file', Date.now(), {}, 'err', []);
    assert.equal(result.httpStatus, undefined);
  });
});
