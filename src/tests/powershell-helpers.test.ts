/**
 * src/tests/powershell-helpers.test.ts
 *
 * Unit tests for pure helper functions extracted from
 * src/backends/powershell-backend.ts:
 *   escapeForPowerShell, escapeHereString, parsePowerShellResponse,
 *   buildPsUrl, buildPsHeaders, formatHeadersForPowerShell,
 *   buildBodyArg, convertIgnoreFieldToPowerShell, formatSimpleDiff
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeForPowerShell,
  escapeHereString,
  parsePowerShellResponse,
  buildPsUrl,
  buildPsHeaders,
  formatHeadersForPowerShell,
  buildBodyArg,
  convertIgnoreFieldToPowerShell,
  formatSimpleDiff,
} from '../backends/powershell-backend.js';
import type { ShogunRequest } from '../types.js';

// ===========================================================================
// escapeForPowerShell
// ===========================================================================

describe('escapeForPowerShell()', () => {
  test('returns plain string unchanged', () => {
    assert.equal(escapeForPowerShell('hello'), 'hello');
  });

  test('doubles single quotes', () => {
    assert.equal(escapeForPowerShell("it's"), "it''s");
  });

  test('escapes double quotes with backtick', () => {
    assert.equal(escapeForPowerShell('say "hi"'), 'say `"hi`"');
  });

  test('handles both single and double quotes', () => {
    assert.equal(escapeForPowerShell(`it's "nice"`), "it''s `\"nice`\"");
  });

  test('handles empty string', () => {
    assert.equal(escapeForPowerShell(''), '');
  });

  // ⚠️ POTENTIAL BUG: PowerShell uses $ for variable interpolation.
  // escapeForPowerShell does NOT escape $, which means strings containing
  // $var will be interpreted as PowerShell variables, potentially causing
  // injection or data corruption. This is a real risk when body content
  // or header values contain literal $ characters (e.g., JSON paths,
  // currency amounts, template strings).
  test('does NOT escape $ — POTENTIAL INJECTION RISK', () => {
    const input = 'price is $100';
    const result = escapeForPowerShell(input);
    assert.equal(result, 'price is $100');
    // If $ were escaped, we'd expect something like: 'price is `$100'
  });
});

// ===========================================================================
// escapeHereString
// ===========================================================================

describe('escapeHereString()', () => {
  test('returns plain string unchanged', () => {
    assert.equal(escapeHereString('hello'), 'hello');
  });

  test('doubles single quotes', () => {
    assert.equal(escapeHereString("it's"), "it''s");
  });

  test('does NOT escape double quotes', () => {
    assert.equal(escapeHereString('say "hi"'), 'say "hi"');
  });

  test('handles empty string', () => {
    assert.equal(escapeHereString(''), '');
  });
});

// ===========================================================================
// parsePowerShellResponse
// ===========================================================================

describe('parsePowerShellResponse()', () => {
  test('parses STATUS + BODY lines', () => {
    const output = 'STATUS:200\nBODY:{"id":1}\n';
    const result = parsePowerShellResponse(output, 50);
    assert.equal(result.status, 200);
    assert.equal(result.raw, '{"id":1}');
    assert.deepEqual(result.body, { id: 1 });
    assert.equal(result.curlMs, 50);
  });

  test('parses STATUS + HEADERS + BODY', () => {
    const output = 'STATUS:201\nHEADERS:{"Content-Type":"application/json"}\nBODY:{"ok":true}\n';
    const result = parsePowerShellResponse(output, 100);
    assert.equal(result.status, 201);
    assert.equal(result.headers['content-type'], 'application/json');
    assert.deepEqual(result.body, { ok: true });
  });

  test('parses ERROR line', () => {
    const output = 'STATUS:0\nERROR:Connection refused\n';
    const result = parsePowerShellResponse(output, 200);
    assert.equal(result.status, 0);
    assert.equal(result.raw, 'Connection refused');
    assert.equal(result.body, 'Connection refused');
  });

  test('defaults status to 0 when no STATUS line', () => {
    const output = 'BODY:hello\n';
    const result = parsePowerShellResponse(output, 10);
    assert.equal(result.status, 0);
    assert.equal(result.raw, 'hello');
  });

  test('body stays as string when not valid JSON', () => {
    const output = 'STATUS:200\nBODY:not-json\n';
    const result = parsePowerShellResponse(output, 10);
    assert.equal(result.body, 'not-json');
  });

  test('parses JSON array body', () => {
    const output = 'STATUS:200\nBODY:[1,2,3]\n';
    const result = parsePowerShellResponse(output, 10);
    assert.deepEqual(result.body, [1, 2, 3]);
  });

  test('handles empty output', () => {
    const result = parsePowerShellResponse('', 5);
    assert.equal(result.status, 0);
    assert.equal(result.raw, '');
    assert.equal(result.body, '');
  });

  test('lowercases header keys', () => {
    const output = 'STATUS:200\nHEADERS:{"X-Custom-Header":"value"}\nBODY:{}\n';
    const result = parsePowerShellResponse(output, 10);
    assert.ok(result.headers['x-custom-header']);
    assert.equal(result.headers['x-custom-header'], 'value');
  });
});

// ===========================================================================
// buildPsUrl
// ===========================================================================

describe('buildPsUrl()', () => {
  test('returns URL as-is when no params', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.example.com/users',
      path: '/users', headers: {}, params: {},
    };
    assert.equal(buildPsUrl(req), 'http://api.example.com/users');
  });

  test('appends query string from params', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.example.com/users',
      path: '/users', headers: {}, params: { page: '1' },
    };
    assert.equal(buildPsUrl(req), 'http://api.example.com/users?page=1');
  });

  test('appends with & when URL already has query string', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.example.com/users?sort=name',
      path: '/users', headers: {}, params: { page: '2' },
    };
    assert.equal(buildPsUrl(req), 'http://api.example.com/users?sort=name&page=2');
  });

  test('handles multiple params', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.example.com/items',
      path: '/items', headers: {}, params: { q: 'test', limit: '10' },
    };
    const result = buildPsUrl(req);
    assert.ok(result.includes('q=test'));
    assert.ok(result.includes('limit=10'));
  });
});

// ===========================================================================
// buildPsHeaders
// ===========================================================================

describe('buildPsHeaders()', () => {
  test('includes default Content-Type and Accept', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    const headers = buildPsHeaders(req, {});
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['Accept'], 'application/json');
  });

  test('merges request headers over defaults', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/',
      headers: { 'X-Custom': 'yes' }, params: {},
    };
    const headers = buildPsHeaders(req, {});
    assert.equal(headers['X-Custom'], 'yes');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  test('adds Authorization from env when not already set', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    const headers = buildPsHeaders(req, { AUTH_TOKEN: 'my-token' });
    assert.equal(headers['Authorization'], 'Bearer my-token');
  });

  test('adds Bearer prefix when token lacks it', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    const headers = buildPsHeaders(req, { AUTH_TOKEN: 'my-token' });
    assert.equal(headers['Authorization'], 'Bearer my-token');
  });

  test('does not double Bearer prefix', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    const headers = buildPsHeaders(req, { AUTH_TOKEN: 'Bearer my-token' });
    assert.equal(headers['Authorization'], 'Bearer my-token');
  });

  test('does not override existing Authorization header', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/',
      headers: { 'Authorization': 'Custom scheme' }, params: {},
    };
    const headers = buildPsHeaders(req, { AUTH_TOKEN: 'should-not-override' });
    assert.equal(headers['Authorization'], 'Custom scheme');
  });
});

// ===========================================================================
// formatHeadersForPowerShell
// ===========================================================================

describe('formatHeadersForPowerShell()', () => {
  test('formats single header', () => {
    const result = formatHeadersForPowerShell({ 'Accept': 'application/json' });
    assert.ok(result.includes('$headers["Accept"] = "application/json"'));
  });

  test('formats multiple headers on separate lines', () => {
    const result = formatHeadersForPowerShell({ 'Accept': 'json', 'X-Key': 'val' });
    assert.ok(result.includes('$headers["Accept"]'));
    assert.ok(result.includes('$headers["X-Key"]'));
  });

  test('escapes double quotes in header values', () => {
    const result = formatHeadersForPowerShell({ 'X-Special': 'say "hi"' });
    assert.ok(result.includes('`"hi`"'));
  });
});

// ===========================================================================
// buildBodyArg
// ===========================================================================

describe('buildBodyArg()', () => {
  test('returns empty string when body is undefined', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    assert.equal(buildBodyArg(req), '');
  });

  test('returns empty string when body is null', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: null,
    };
    assert.equal(buildBodyArg(req), '');
  });

  test('formats string body into $splat.Body assignment', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: '{"name":"test"}',
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes("$splat.Body = '"));
    // escapeForPowerShell escapes double quotes with backtick
    assert.ok(result.includes('{`"name`":`"test`"}'));
  });

  test('JSON-stringifies object body', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: { name: 'test' },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('$splat.Body'));
    assert.ok(result.includes('name'));
    assert.ok(result.includes('test'));
  });

  test('escapes single quotes in body', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: "it's a test",
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes("it''s a test"));
  });
});

// ===========================================================================
// convertIgnoreFieldToPowerShell
// ===========================================================================

describe('convertIgnoreFieldToPowerShell()', () => {
  test('strips leading dot from field name', () => {
    assert.equal(convertIgnoreFieldToPowerShell('.createdAt'), '$json.PSObject.Properties.Remove("createdAt")');
  });

  test('uses field name as-is when no leading dot', () => {
    assert.equal(convertIgnoreFieldToPowerShell('updatedAt'), '$json.PSObject.Properties.Remove("updatedAt")');
  });

  test('handles nested dot path — only strips first dot', () => {
    assert.equal(convertIgnoreFieldToPowerShell('.data.items'), '$json.PSObject.Properties.Remove("data.items")');
  });
});

// ===========================================================================
// formatSimpleDiff
// ===========================================================================

describe('formatSimpleDiff()', () => {
  test('returns empty string for identical inputs', () => {
    assert.equal(formatSimpleDiff('hello\nworld', 'hello\nworld'), '');
  });

  test('shows diff with expected and actual markers', () => {
    const result = formatSimpleDiff('line1\nline2', 'line1\nchanged');
    assert.ok(result.startsWith('--- expected'));
    assert.ok(result.includes('+++ actual'));
    assert.ok(result.includes('- line2'));
    assert.ok(result.includes('+ changed'));
  });

  test('shows context lines (unchanged)', () => {
    const result = formatSimpleDiff('same\ndifferent', 'same\nchanged');
    assert.ok(result.includes('  same'));
    assert.ok(result.includes('- different'));
    assert.ok(result.includes('+ changed'));
  });

  test('handles actual longer than expected', () => {
    const result = formatSimpleDiff('line1', 'line1\nextra');
    assert.ok(result.includes('+ extra'));
  });

  test('handles expected longer than actual', () => {
    const result = formatSimpleDiff('line1\nextra', 'line1');
    assert.ok(result.includes('- extra'));
  });

  test('handles empty strings', () => {
    const result = formatSimpleDiff('', '');
    assert.equal(result, '');
  });

  test('handles one empty and one non-empty', () => {
    const result = formatSimpleDiff('', 'content');
    assert.ok(result.includes('+ content'));
  });
});
