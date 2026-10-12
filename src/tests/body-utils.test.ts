/**
 * src/tests/body-utils.test.ts
 * Unit tests for shared body resolution and form-encoding utilities.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestBody, isFormEncodedContentType, buildFormEncodedBody } from '../body-utils.js';

describe('resolveRequestBody', () => {
  test('unwraps { inline: ... } to the inline value', () => {
    const body = { inline: { name: 'test', value: 42 } };
    const result = resolveRequestBody(body);
    assert.deepStrictEqual(result, { name: 'test', value: 42 });
  });

  test('unwraps { inline: ... } when inline is an array', () => {
    const body = { inline: [1, 2, 3] };
    const result = resolveRequestBody(body);
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  test('unwraps { inline: ... } when inline is a string', () => {
    const body = { inline: 'raw-string-body' };
    const result = resolveRequestBody(body);
    assert.strictEqual(result, 'raw-string-body');
  });

  test('passes through a direct object (no inline/file wrapper)', () => {
    const body = { field1: 'value1', field2: 'value2' };
    const result = resolveRequestBody(body);
    assert.deepStrictEqual(result, { field1: 'value1', field2: 'value2' });
  });

  test('passes through a string', () => {
    const result = resolveRequestBody('plain-string');
    assert.strictEqual(result, 'plain-string');
  });

  test('passes through null', () => {
    const result = resolveRequestBody(null);
    assert.strictEqual(result, null);
  });

  test('passes through undefined', () => {
    const result = resolveRequestBody(undefined);
    assert.strictEqual(result, undefined);
  });

  test('passes through an array', () => {
    const body = [1, 2, 3];
    const result = resolveRequestBody(body);
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  test('passes through form_fields/form_files wrapper unchanged (multipart path handles it)', () => {
    const body = {
      form_fields: { field1: 'value1' },
      form_files: { file1: { path: '/tmp/test.txt' } },
    };
    const result = resolveRequestBody(body);
    assert.deepStrictEqual(result, body);
  });

  test('reads file contents when body has { file: "path" }', () => {
    // We can't easily test file reads without a temp file, but we can verify
    // that a non-existent file returns empty string (not a throw)
    const body = { file: '/nonexistent/path/that/does/not/exist.json' };
    const result = resolveRequestBody(body);
    assert.strictEqual(result, '');
  });
});

describe('isFormEncodedContentType', () => {
  test('matches standard form-encoded content type', () => {
    assert.ok(isFormEncodedContentType('application/x-www-form-urlencoded'));
  });

  test('matches with charset suffix', () => {
    assert.ok(isFormEncodedContentType('application/x-www-form-urlencoded; charset=UTF-8'));
  });

  test('case-insensitive', () => {
    assert.ok(isFormEncodedContentType('Application/X-WWW-Form-Urlencoded'));
  });

  test('does not match JSON', () => {
    assert.ok(!isFormEncodedContentType('application/json'));
  });

  test('does not match multipart', () => {
    assert.ok(!isFormEncodedContentType('multipart/form-data'));
  });

  test('does not match empty string', () => {
    assert.ok(!isFormEncodedContentType(''));
  });
});

describe('buildFormEncodedBody', () => {
  test('encodes simple key-value pairs', () => {
    const result = buildFormEncodedBody({ name: 'test', value: '42' });
    assert.strictEqual(result, 'name=test&value=42');
  });

  test('URL-encodes special characters in keys and values', () => {
    const result = buildFormEncodedBody({ 'key with spaces': 'val&special' });
    assert.strictEqual(result, 'key%20with%20spaces=val%26special');
  });

  test('omits null values', () => {
    const result = buildFormEncodedBody({ field1: 'value1', field2: null, field3: 'value3' });
    assert.strictEqual(result, 'field1=value1&field3=value3');
  });

  test('omits undefined values', () => {
    const result = buildFormEncodedBody({ field1: 'value1', field2: undefined, field3: 'value3' });
    assert.strictEqual(result, 'field1=value1&field3=value3');
  });

  test('omits both null and undefined values', () => {
    const result = buildFormEncodedBody({
      a: '1',
      b: null,
      c: '3',
      d: undefined,
      e: '5',
    });
    assert.strictEqual(result, 'a=1&c=3&e=5');
  });

  test('converts numbers to strings', () => {
    const result = buildFormEncodedBody({ count: 42, price: 9.99 });
    assert.strictEqual(result, 'count=42&price=9.99');
  });

  test('converts booleans to strings', () => {
    const result = buildFormEncodedBody({ active: true, deleted: false });
    assert.strictEqual(result, 'active=true&deleted=false');
  });

  test('returns empty string for empty object', () => {
    const result = buildFormEncodedBody({});
    assert.strictEqual(result, '');
  });

  test('returns empty string when all values are null/undefined', () => {
    const result = buildFormEncodedBody({ a: null, b: undefined });
    assert.strictEqual(result, '');
  });

  test('does NOT send literal "null" string for null values', () => {
    const result = buildFormEncodedBody({ field: null });
    assert.strictEqual(result, '');
    assert.ok(!result.includes('field=null'));
    assert.ok(!result.includes('null'));
  });

  test('handles hyphenated keys', () => {
    const result = buildFormEncodedBody({ 'X-Requested-With': 'XMLHttpRequest' });
    assert.strictEqual(result, 'X-Requested-With=XMLHttpRequest');
  });

  test('handles empty string values (includes them)', () => {
    const result = buildFormEncodedBody({ field: '' });
    assert.strictEqual(result, 'field=');
  });

  test('handles zero (number) as a valid value', () => {
    const result = buildFormEncodedBody({ count: 0 });
    assert.strictEqual(result, 'count=0');
  });
});
