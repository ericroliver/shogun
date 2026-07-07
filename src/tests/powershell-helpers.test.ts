/**
 * src/tests/powershell-helpers.test.ts
 *
 * Unit tests for pure helper functions extracted from
 * src/backends/powershell-backend.ts:
 *   escapeForPowerShell, escapeForDoubleQuoted, escapeHereString,
 *   parsePowerShellResponse, parseCookies,
 *   buildPsUrl, buildPsHeaders, formatHeadersForPowerShell,
 *   buildBodyArg, convertIgnoreFieldToPowerShell, formatSimpleDiff
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeForPowerShell,
  escapeForDoubleQuoted,
  escapeHereString,
  parsePowerShellResponse,
  parseCookies,
  buildPsUrl,
  buildPsHeaders,
  formatHeadersForPowerShell,
  buildBodyArg,
  convertIgnoreFieldToPowerShell,
  formatSimpleDiff,
} from '../backends/powershell-backend.js';
import type { ShogunRequest } from '../types.js';

// ===========================================================================
// escapeForPowerShell (for single-quoted strings)
// ===========================================================================

describe('escapeForPowerShell()', () => {
  test('returns plain string unchanged', () => {
    assert.equal(escapeForPowerShell('hello'), 'hello');
  });

  test('doubles single quotes', () => {
    assert.equal(escapeForPowerShell("it's"), "it''s");
  });

  test('does NOT escape double quotes (correct for single-quoted strings)', () => {
    // In PowerShell single-quoted strings, " is a literal character.
    // No escaping needed.
    assert.equal(escapeForPowerShell('say "hi"'), 'say "hi"');
  });

  test('does NOT escape $ (correct for single-quoted strings)', () => {
    // In PowerShell single-quoted strings, $ is a literal character.
    // No escaping needed. This is the key fix from the previous bug.
    assert.equal(escapeForPowerShell('price is $100'), 'price is $100');
  });

  test('handles empty string', () => {
    assert.equal(escapeForPowerShell(''), '');
  });

  test('handles string with only single quotes', () => {
    assert.equal(escapeForPowerShell("''"), "''''");
  });
});

// ===========================================================================
// escapeForDoubleQuoted (for double-quoted strings)
// ===========================================================================

describe('escapeForDoubleQuoted()', () => {
  test('returns plain string unchanged', () => {
    assert.equal(escapeForDoubleQuoted('hello'), 'hello');
  });

  test('escapes double quotes with backtick', () => {
    assert.equal(escapeForDoubleQuoted('say "hi"'), 'say `"hi`"');
  });

  test('escapes $ with backtick to prevent injection', () => {
    // This is the fix for the security risk: $ in double-quoted strings
    // would be interpreted as variable interpolation.
    assert.equal(escapeForDoubleQuoted('price is $100'), 'price is `$100');
  });

  test('handles both double quotes and $', () => {
    assert.equal(
      escapeForDoubleQuoted('cost is "$100"'),
      'cost is `"`$100`"',
    );
  });

  test('does NOT escape single quotes (literal in double-quoted strings)', () => {
    assert.equal(escapeForDoubleQuoted("it's"), "it's");
  });

  test('handles empty string', () => {
    assert.equal(escapeForDoubleQuoted(''), '');
  });

  test('handles string with only $', () => {
    assert.equal(escapeForDoubleQuoted('$'), '`$');
  });

  test('handles multiple $ signs', () => {
    assert.equal(
      escapeForDoubleQuoted('$var and $other'),
      '`$var and `$other',
    );
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
  test('parses STATUS + B64BODY lines', () => {
    const body = '{"id":1}';
    const b64 = Buffer.from(body).toString('base64');
    const output = `STATUS:200\nB64BODY:${b64}\n`;
    const result = parsePowerShellResponse(output, 50);
    assert.equal(result.status, 200);
    assert.equal(result.raw, body);
    assert.deepEqual(result.body, { id: 1 });
    assert.equal(result.curlMs, 50);
  });

  test('parses STATUS + HEADERS + B64BODY', () => {
    const body = '{"ok":true}';
    const b64 = Buffer.from(body).toString('base64');
    const output = `STATUS:201\nHEADERS:{"Content-Type":"application/json"}\nB64BODY:${b64}\n`;
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
    const body = 'hello';
    const b64 = Buffer.from(body).toString('base64');
    const output = `B64BODY:${b64}\n`;
    const result = parsePowerShellResponse(output, 10);
    assert.equal(result.status, 0);
    assert.equal(result.raw, 'hello');
  });

  test('body stays as string when not valid JSON', () => {
    const body = 'not-json';
    const b64 = Buffer.from(body).toString('base64');
    const output = `STATUS:200\nB64BODY:${b64}\n`;
    const result = parsePowerShellResponse(output, 10);
    assert.equal(result.body, 'not-json');
  });

  test('parses JSON array body', () => {
    const body = '[1,2,3]';
    const b64 = Buffer.from(body).toString('base64');
    const output = `STATUS:200\nB64BODY:${b64}\n`;
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
    const body = '{}';
    const b64 = Buffer.from(body).toString('base64');
    const output = `STATUS:200\nHEADERS:{"X-Custom-Header":"value"}\nB64BODY:${b64}\n`;
    const result = parsePowerShellResponse(output, 10);
    assert.ok(result.headers['x-custom-header']);
    assert.equal(result.headers['x-custom-header'], 'value');
  });

  test('handles multi-line HTML body via base64', () => {
    const html = '<!DOCTYPE html>\n<html>\n<head><title>Test</title></head>\n<body>Hello</body>\n</html>';
    const b64 = Buffer.from(html).toString('base64');
    const output = `STATUS:200\nB64BODY:${b64}\n`;
    const result = parsePowerShellResponse(output, 30);
    assert.equal(result.status, 200);
    assert.equal(result.raw, html);
    assert.equal(result.body, html); // Not JSON, stays as string
  });

  test('handles array header values by joining with comma', () => {
    const body = '{}';
    const b64 = Buffer.from(body).toString('base64');
    const output = `STATUS:200\nHEADERS:{"Set-Cookie":["a=1","b=2"]}\nB64BODY:${b64}\n`;
    const result = parsePowerShellResponse(output, 10);
    assert.equal(result.headers['set-cookie'], 'a=1, b=2');
  });

  test('backward compat: parses legacy BODY: line', () => {
    const output = 'STATUS:200\nBODY:{"legacy":true}\n';
    const result = parsePowerShellResponse(output, 10);
    assert.equal(result.status, 200);
    assert.equal(result.raw, '{"legacy":true}');
    assert.deepEqual(result.body, { legacy: true });
  });
});

// ===========================================================================
// parseCookies
// ===========================================================================

describe('parseCookies()', () => {
  test('parses COOKIES line with array', () => {
    const cookies = [
      { name: '.ASPXAUTH', value: 'abc123', domain: 'localhost', path: '/' },
      { name: 'session', value: 'xyz', domain: 'localhost', path: '/' },
    ];
    const output = `STATUS:200\nCOOKIES:${JSON.stringify(cookies)}\n`;
    const result = parseCookies(output);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, '.ASPXAUTH');
    assert.equal(result[0].value, 'abc123');
    assert.equal(result[1].name, 'session');
  });

  test('parses COOKIES line with single cookie', () => {
    const cookies = [{ name: 'token', value: 'abc', domain: 'localhost', path: '/' }];
    const output = `STATUS:200\nCOOKIES:${JSON.stringify(cookies)}\n`;
    const result = parseCookies(output);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'token');
  });

  test('parses empty cookie array', () => {
    const output = 'STATUS:200\nCOOKIES:[]\n';
    const result = parseCookies(output);
    assert.equal(result.length, 0);
  });

  test('returns empty array when no COOKIES line', () => {
    const output = 'STATUS:200\nBODY:hello\n';
    const result = parseCookies(output);
    assert.equal(result.length, 0);
  });

  test('returns empty array on invalid JSON', () => {
    const output = 'STATUS:200\nCOOKIES:not-json\n';
    const result = parseCookies(output);
    assert.equal(result.length, 0);
  });

  test('returns empty array on empty output', () => {
    const result = parseCookies('');
    assert.equal(result.length, 0);
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

  test('skips auth injection when autoInjectAuth is false', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    const headers = buildPsHeaders(req, { AUTH_TOKEN: 'my-token' }, false);
    assert.equal(headers['Authorization'], undefined);
  });

  test('injects auth when autoInjectAuth is true (default)', () => {
    const req: ShogunRequest = {
      method: 'GET', url: 'http://api.com', path: '/', headers: {}, params: {},
    };
    const headers = buildPsHeaders(req, { AUTH_TOKEN: 'my-token' }, true);
    assert.equal(headers['Authorization'], 'Bearer my-token');
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

  test('escapes $ in header values to prevent injection', () => {
    const result = formatHeadersForPowerShell({ 'X-Price': 'cost is $100' });
    assert.ok(result.includes('`$100'), `Expected backtick-dollar in: ${result}`);
  });

  test('does NOT escape single quotes in header values', () => {
    const result = formatHeadersForPowerShell({ 'X-Name': "it's test" });
    // Single quotes are literal in double-quoted PS strings
    assert.ok(result.includes("it's test"));
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

  test('formats string body into $bodyStr assignment', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: '{"name":"test"}',
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes("$bodyStr = '"));
    // In single-quoted strings, " is literal — no backtick escaping
    assert.ok(result.includes('{"name":"test"}'));
  });

  test('does NOT escape double quotes in JSON body (single-quoted string)', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: '{"name":"test"}',
    };
    const result = buildBodyArg(req);
    // Should NOT contain backtick-escaped quotes
    assert.ok(!result.includes('{`"name`":`"test`"}'),
      'Double quotes should not be backtick-escaped in single-quoted strings');
  });

  test('JSON-stringifies object body', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: { name: 'test' },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('$bodyStr'));
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

  test('resolves inline body from RequestBody wrapper', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: { inline: { name: 'test', value: 123 } },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('$bodyStr'));
    assert.ok(result.includes('name'));
    assert.ok(result.includes('test'));
    assert.ok(result.includes('123'));
    // Should NOT contain the 'inline' wrapper key
    assert.ok(!result.includes('inline'));
  });

  test('handles form-encoded body as URL-encoded string', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {},
      body: { inline: { UserName: 'eoliver', Password: '3minepoint' } },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('$bodyStr'));
    assert.ok(result.includes('UserName=eoliver'));
    assert.ok(result.includes('Password=3minepoint'));
  });

  test('form-encoded body escapes single quotes in values', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {},
      body: { inline: { comment: "it's great" } },
    };
    const result = buildBodyArg(req);
    // encodeURIComponent doesn't encode ', so it stays as it's
    // escapeForPowerShell then doubles it to it''s for single-quoted PowerShell string
    assert.ok(result.includes("comment=it''s%20great"));
  });

  test('form-encoded body handles hyphenated keys', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {},
      body: { inline: { 'X-Requested-With': 'XMLHttpRequest' } },
    };
    const result = buildBodyArg(req);
    // URL-encoded key (hyphen doesn't need encoding, but let's verify it's there)
    assert.ok(result.includes('X-Requested-With=XMLHttpRequest'));
  });

  test('form-encoded body with direct object (no inline wrapper)', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {},
      body: { key: 'value', num: '42' },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('$bodyStr'));
    assert.ok(result.includes('key=value'));
    assert.ok(result.includes('num=42'));
  });

  test('JSON body used when Content-Type is not form-encoded', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/',
      headers: { 'Content-Type': 'application/json' },
      params: {},
      body: { inline: { name: 'test' } },
    };
    const result = buildBodyArg(req);
    // Should be single-quoted JSON, not hashtable
    assert.ok(result.includes("$bodyStr = '"));
    assert.ok(!result.includes('@{'));
  });

  test('returns empty string for empty body', () => {
    const req: ShogunRequest = {
      method: 'POST', url: 'http://api.com', path: '/', headers: {}, params: {},
      body: '',
    };
    assert.equal(buildBodyArg(req), '');
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
