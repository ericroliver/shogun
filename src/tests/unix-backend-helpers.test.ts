/**
 * src/tests/unix-backend-helpers.test.ts
 *
 * Unit tests for pure helper functions from src/backends/unix-backend.ts:
 *   buildUrl, parseResponseHeaders, globToJqDel, formatSimpleDiff,
 *   getExpectedPathFromTest
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildUrl,
  parseResponseHeaders,
  globToJqDel,
  formatSimpleDiff,
  getExpectedPathFromTest,
} from '../backends/unix-backend.js';
import type { ShogunRequest, TestDefinition, ShogunConfig } from '../types.js';

// ===========================================================================
// buildUrl
// ===========================================================================

describe('buildUrl()', () => {
  test('returns URL as-is when no params', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test', path: '/test', headers: {}, params: {},
    };
    assert.equal(buildUrl(req), 'http://api.com/test');
  });

  test('returns URL as-is when params is empty object', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test', path: '/test', headers: {}, params: {},
    };
    assert.equal(buildUrl(req), 'http://api.com/test');
  });

  test('appends query string from params', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test', path: '/test', headers: {},
      params: { key: 'value' },
    };
    assert.equal(buildUrl(req), 'http://api.com/test?key=value');
  });

  test('appends with & when URL already has query string', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test?existing=1', path: '/test', headers: {},
      params: { new: '2' },
    };
    assert.equal(buildUrl(req), 'http://api.com/test?existing=1&new=2');
  });

  test('handles multiple params', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test', path: '/test', headers: {},
      params: { a: '1', b: '2' },
    };
    const result = buildUrl(req);
    assert.ok(result.includes('a=1'));
    assert.ok(result.includes('b=2'));
    assert.ok(result.startsWith('http://api.com/test?'));
  });

  test('converts param values to strings', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test', path: '/test', headers: {},
      params: { num: 42 as any, bool: true as any },
    };
    const result = buildUrl(req);
    assert.ok(result.includes('num=42'));
    assert.ok(result.includes('bool=true'));
  });

  test('handles undefined params gracefully', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com/test', path: '/test', headers: {},
      params: undefined as any,
    };
    assert.equal(buildUrl(req), 'http://api.com/test');
  });
});

// ===========================================================================
// parseResponseHeaders
// ===========================================================================

describe('parseResponseHeaders()', () => {
  test('parses simple header lines', () => {
    const input = 'Content-Type: application/json\nX-Custom: hello';
    const result = parseResponseHeaders(input);
    assert.equal(result['content-type'], 'application/json');
    assert.equal(result['x-custom'], 'hello');
  });

  test('lowercases header keys', () => {
    const input = 'Content-Type: text/html';
    const result = parseResponseHeaders(input);
    assert.ok('content-type' in result);
    assert.equal(result['content-type'], 'text/html');
  });

  test('trims header values', () => {
    const input = 'Content-Type:  application/json  ';
    const result = parseResponseHeaders(input);
    assert.equal(result['content-type'], 'application/json');
  });

  test('ignores non-header lines', () => {
    const input = 'some random text\nContent-Type: application/json\nmore noise';
    const result = parseResponseHeaders(input);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result['content-type'], 'application/json');
  });

  test('returns empty object for empty string', () => {
    const result = parseResponseHeaders('');
    assert.deepEqual(result, {});
  });

  test('handles header with dash in name', () => {
    const input = 'X-Request-Id: abc-123';
    const result = parseResponseHeaders(input);
    assert.equal(result['x-request-id'], 'abc-123');
  });

  test('handles header value with colon', () => {
    const input = 'Location: http://example.com/path?q=1';
    const result = parseResponseHeaders(input);
    assert.equal(result['location'], 'http://example.com/path?q=1');
  });
});

// ===========================================================================
// globToJqDel
// ===========================================================================

describe('globToJqDel()', () => {
  test('simple field name gets dot prefix', () => {
    assert.equal(globToJqDel('name'), 'del(.name)');
  });

  test('dot-prefixed field preserves the dot', () => {
    assert.equal(globToJqDel('.name'), 'del(.name)');
  });

  test('nested dot path preserves structure', () => {
    assert.equal(globToJqDel('.data.items'), 'del(.data.items)');
  });

  test('double-star prefix uses recursive descent', () => {
    assert.equal(globToJqDel('**.createdAt'), 'del(.. | objects | .createdAt?)');
  });

  test('double-star with nested path strips **. only', () => {
    assert.equal(globToJqDel('**.data.items'), 'del(.. | objects | .data.items?)');
  });

  test('bare field without dot gets dot prefix', () => {
    assert.equal(globToJqDel('id'), 'del(.id)');
  });
});

// ===========================================================================
// formatSimpleDiff
// ===========================================================================

describe('formatSimpleDiff()', () => {
  test('returns empty string for identical inputs', () => {
    assert.equal(formatSimpleDiff('hello', 'hello'), '');
  });

  test('shows diff with expected and actual markers', () => {
    const result = formatSimpleDiff('hello', 'world');
    assert.ok(result.includes('--- expected'));
    assert.ok(result.includes('+++ actual'));
    assert.ok(result.includes('- hello'));
    assert.ok(result.includes('+ world'));
  });

  test('shows context lines (unchanged)', () => {
    const result = formatSimpleDiff('line1\nline2\nline3', 'line1\nCHANGED\nline3');
    assert.ok(result.includes('  line1'));
    assert.ok(result.includes('- line2'));
    assert.ok(result.includes('+ CHANGED'));
    assert.ok(result.includes('  line3'));
  });

  test('handles actual longer than expected', () => {
    const result = formatSimpleDiff('line1', 'line1\nline2');
    assert.ok(result.includes('  line1'));
    assert.ok(result.includes('+ line2'));
  });

  test('handles expected longer than actual', () => {
    const result = formatSimpleDiff('line1\nline2', 'line1');
    assert.ok(result.includes('  line1'));
    assert.ok(result.includes('- line2'));
  });

  test('handles empty strings', () => {
    assert.equal(formatSimpleDiff('', ''), '');
  });

  test('handles one empty and one non-empty', () => {
    const result = formatSimpleDiff('', 'hello');
    assert.ok(result.includes('+ hello'));
  });

  test('handles expected empty with actual non-empty', () => {
    const result = formatSimpleDiff('hello', '');
    assert.ok(result.includes('- hello'));
  });

  test('multi-line diff with multiple changes', () => {
    const expected = 'a\nb\nc\nd';
    const actual = 'a\nX\nc\nY';
    const result = formatSimpleDiff(expected, actual);
    assert.ok(result.includes('  a'));
    assert.ok(result.includes('- b'));
    assert.ok(result.includes('+ X'));
    assert.ok(result.includes('  c'));
    assert.ok(result.includes('- d'));
    assert.ok(result.includes('+ Y'));
  });
});

// ===========================================================================
// getExpectedPathFromTest
// ===========================================================================

describe('getExpectedPathFromTest()', () => {
  const baseConfig: ShogunConfig = { version: 1 };

  test('uses default expected dir and collection', () => {
    const testDef: TestDefinition = {
      name: 'test',
      request: { method: 'GET', path: '/api/nodes' },
    };
    const result = getExpectedPathFromTest(testDef, baseConfig, '/cwd');
    assert.equal(result, join('/cwd', 'expected', 'default', 'GET_api_nodes.json'));
  });

  test('uses test collection when provided', () => {
    const testDef: TestDefinition = {
      name: 'test',
      collection: 'graph',
      request: { method: 'GET', path: '/api/nodes' },
    };
    const result = getExpectedPathFromTest(testDef, baseConfig, '/cwd');
    assert.equal(result, join('/cwd', 'expected', 'graph', 'GET_api_nodes.json'));
  });

  test('prefers collectionName argument over test.collection', () => {
    const testDef: TestDefinition = {
      name: 'test',
      collection: 'graph',
      request: { method: 'GET', path: '/api/nodes' },
    };
    const result = getExpectedPathFromTest(testDef, baseConfig, '/cwd', 'custom');
    assert.equal(result, join('/cwd', 'expected', 'custom', 'GET_api_nodes.json'));
  });

  test('uses config paths.expected when set', () => {
    const config: ShogunConfig = { version: 1, paths: { expected: 'snapshots' } };
    const testDef: TestDefinition = {
      name: 'test',
      request: { method: 'POST', path: '/api/items' },
    };
    const result = getExpectedPathFromTest(testDef, config, '/cwd');
    assert.equal(result, join('/cwd', 'snapshots', 'default', 'POST_api_items.json'));
  });

  test('uses default cwd when not provided', () => {
    const testDef: TestDefinition = {
      name: 'test',
      request: { method: 'GET', path: '/api/test' },
    };
    // Just verify it doesn't throw and returns a path containing 'expected'
    const result = getExpectedPathFromTest(testDef, baseConfig);
    assert.ok(result.includes('expected'));
    assert.ok(result.endsWith('GET_api_test.json'));
  });
});
