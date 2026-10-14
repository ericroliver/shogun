/**
 * src/tests/redact.test.ts
 *
 * Unit tests for src/redact.ts — credential/sensitive-data redaction.
 *
 * Regression tests for the security review finding that SHOGUN_DEBUG output
 * must never leak Authorization headers, cookies, API keys, or sensitive
 * query-string parameters.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactHeaderValue,
  redactUrl,
  redactCurlArgs,
  redactText,
} from '../redact.js';

// ---------------------------------------------------------------------------
// redactHeaderValue
// ---------------------------------------------------------------------------

describe('redactHeaderValue()', () => {
  test('redacts Authorization (any casing)', () => {
    assert.equal(redactHeaderValue('Authorization', 'Bearer abc123'), '[REDACTED]');
    assert.equal(redactHeaderValue('authorization', 'Bearer abc123'), '[REDACTED]');
    assert.equal(redactHeaderValue('AUTHORIZATION', 'Bearer abc123'), '[REDACTED]');
    assert.equal(redactHeaderValue('  aUtHoRiZaTiOn  ', 'Bearer abc123'), '[REDACTED]');
  });

  test('redacts cookies and proxy auth', () => {
    assert.equal(redactHeaderValue('Cookie', 'session=xyz'), '[REDACTED]');
    assert.equal(redactHeaderValue('set-cookie', 'session=xyz'), '[REDACTED]');
    assert.equal(redactHeaderValue('Proxy-Authorization', 'Basic dXNlcjpwYXNz'), '[REDACTED]');
  });

  test('redacts API key headers (common spellings)', () => {
    assert.equal(redactHeaderValue('X-API-Key', 'sk-12345'), '[REDACTED]');
    assert.equal(redactHeaderValue('api-key', 'sk-12345'), '[REDACTED]');
    assert.equal(redactHeaderValue('X-Auth-Token', 'tok'), '[REDACTED]');
    assert.equal(redactHeaderValue('Private-Token', 'tok'), '[REDACTED]');
  });

  test('keeps non-sensitive headers', () => {
    assert.equal(redactHeaderValue('Content-Type', 'application/json'), 'application/json');
    assert.equal(redactHeaderValue('Accept', '*/*'), '*/*');
    assert.equal(redactHeaderValue('X-Request-Id', 'abc'), 'abc');
  });
});

// ---------------------------------------------------------------------------
// redactUrl
// ---------------------------------------------------------------------------

describe('redactUrl()', () => {

  test('redacts token query parameter values', () => {
    assert.equal(
      redactUrl('https://api.example.com/v1/users?token=sekret&page=2'),
      'https://api.example.com/v1/users?token=%5BREDACTED%5D&page=2',
    );
  });

  test('redacts api_key, password, and secret params', () => {
    assert.equal(
      redactUrl('https://api.example.com/v1?api_key=abc&password=pw&secret=s'),
      'https://api.example.com/v1?api_key=%5BREDACTED%5D&password=%5BREDACTED%5D&secret=%5BREDACTED%5D',
    );
  });

  test('is case-insensitive on query param names', () => {
    assert.equal(
      redactUrl('https://api.example.com/v1?API_KEY=abc'),
      'https://api.example.com/v1?API_KEY=%5BREDACTED%5D',
    );
    assert.equal(
      redactUrl('https://api.example.com/v1?Access_Token=abc'),
      'https://api.example.com/v1?Access_Token=%5BREDACTED%5D',
    );
  });

  test('redacts userinfo credentials', () => {
    assert.equal(
      redactUrl('https://user:pass@api.example.com/v1'),
      'https://%5BREDACTED%5D@api.example.com/v1',
    );
  });

  test('keeps non-sensitive query params and path intact', () => {
    assert.equal(
      redactUrl('https://api.example.com/v1/users/42?include=posts&limit=10'),
      'https://api.example.com/v1/users/42?include=posts&limit=10',
    );
  });

  test('returns non-URL strings unchanged', () => {
    assert.equal(redactUrl('not a url'), 'not a url');
    assert.equal(redactUrl(''), '');
  });

  test('leaves fragment intact', () => {
    assert.equal(
      redactUrl('https://api.example.com/v1#section'),
      'https://api.example.com/v1#section',
    );
  });
});

// ---------------------------------------------------------------------------
// redactCurlArgs
// ---------------------------------------------------------------------------

describe('redactCurlArgs()', () => {
  test('redacts Authorization header values in -H args (any casing)', () => {
    const args = ['-s', '-H', 'Authorization: Bearer sekret', 'https://api.example.com/v1'];
    const redacted = redactCurlArgs(args);
    assert.deepEqual(redacted, ['-s', '-H', 'Authorization: [REDACTED]', 'https://api.example.com/v1']);
  });

  test('redacts authorization header with lowercase and mixed casing', () => {
    assert.deepEqual(
      redactCurlArgs(['-H', 'authorization: Bearer sekret']),
      ['-H', 'authorization: [REDACTED]'],
    );
    assert.deepEqual(
      redactCurlArgs(['-H', 'AUTHORIZATION: Bearer sekret']),
      ['-H', 'AUTHORIZATION: [REDACTED]'],
    );
  });

  test('redacts cookie headers', () => {
    assert.deepEqual(
      redactCurlArgs(['-H', 'Cookie: session=abc']),
      ['-H', 'Cookie: [REDACTED]'],
    );
  });

  test('keeps non-sensitive headers intact', () => {
    assert.deepEqual(
      redactCurlArgs(['-H', 'Content-Type: application/json', '-H', 'Accept: application/json']),
      ['-H', 'Content-Type: application/json', '-H', 'Accept: application/json'],
    );
  });

  test('redacts -u/--user credentials entirely', () => {
    assert.deepEqual(
      redactCurlArgs(['-u', 'user:pass', 'https://api.example.com']),
      ['-u', '[REDACTED]', 'https://api.example.com'],
    );
    assert.deepEqual(
      redactCurlArgs(['--user', 'user:pass']),
      ['--user', '[REDACTED]'],
    );
    assert.deepEqual(
      redactCurlArgs(['--proxy-user', 'user:pass']),
      ['--proxy-user', '[REDACTED]'],
    );
  });

  test('redacts sensitive query params in URL args', () => {
    assert.deepEqual(
      redactCurlArgs(['https://api.example.com/v1?token=sekret&page=2']),
      ['https://api.example.com/v1?token=%5BREDACTED%5D&page=2'],
    );
  });

  test('redacts malformed -H value (no colon) entirely', () => {
    assert.deepEqual(redactCurlArgs(['-H', 'weirdvalue']), ['-H', '[REDACTED]']);
  });

  test('preserves argument vector shape', () => {
    const args = ['-s', '-S', '--max-time', '10', '-X', 'POST',
      '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer x',
      '-o', '/tmp/body', 'https://api.example.com/v1'];
    const redacted = redactCurlArgs(args);
    assert.equal(redacted.length, args.length);
    assert.deepEqual(redacted.slice(0, 6), args.slice(0, 6));
    assert.equal(redacted[9], 'Authorization: [REDACTED]');
    assert.deepEqual(redacted.slice(10), ['-o', '/tmp/body', 'https://api.example.com/v1']);
  });
});

// ---------------------------------------------------------------------------
// redactText
// ---------------------------------------------------------------------------

describe('redactText()', () => {
  test('redacts inline Authorization headers in error text', () => {
    const text = 'request failed with Authorization: Bearer sekret header';
    // The value is masked through end-of-line
    assert.equal(redactText(text), 'request failed with Authorization: [REDACTED]');
    assert.ok(!redactText(text).includes('sekret'));
  });

  test('redacts URLs with sensitive query params embedded in text', () => {
    const text = 'curl: (6) Could not resolve host: https://api.example.com?token=sekret';
    const redacted = redactText(text);
    assert.ok(!redacted.includes('sekret'), `secret leaked: ${redacted}`);
    assert.ok(redacted.includes('api.example.com'));
  });

  test('returns plain text without secrets unchanged', () => {
    assert.equal(redactText('operation timed out after 10001 milliseconds'), 'operation timed out after 10001 milliseconds');
  });

  test('handles empty input', () => {
    assert.equal(redactText(''), '');
  });
});
