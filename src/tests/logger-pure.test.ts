/**
 * src/tests/logger-pure.test.ts
 *
 * Unit tests for pure functions in src/logger.ts:
 *   formatRunId, safeFileName
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRunId, safeFileName } from '../logger.js';

// ===========================================================================
// formatRunId
// ===========================================================================

describe('formatRunId()', () => {
  test('formats date as YYYYMMDD_HHMMSS', () => {
    const date = new Date(2026, 5, 8, 14, 30, 45); // June 8, 2026 14:30:45
    assert.equal(formatRunId(date), '20260608_143045');
  });

  test('pads single-digit month, day, hour, minute, second', () => {
    const date = new Date(2025, 0, 3, 5, 7, 9); // Jan 3, 2025 05:07:09
    assert.equal(formatRunId(date), '20250103_050709');
  });

  test('handles midnight', () => {
    const date = new Date(2026, 11, 31, 0, 0, 0); // Dec 31, 2026 00:00:00
    assert.equal(formatRunId(date), '20261231_000000');
  });

  test('handles end of day', () => {
    const date = new Date(2026, 11, 31, 23, 59, 59); // Dec 31, 2026 23:59:59
    assert.equal(formatRunId(date), '20261231_235959');
  });

  test('month is 1-indexed (getMonth returns 0-based)', () => {
    const date = new Date(2026, 0, 1, 0, 0, 0); // January = month index 0
    assert.equal(formatRunId(date), '20260101_000000');
  });
});

// ===========================================================================
// safeFileName
// ===========================================================================

describe('safeFileName()', () => {
  test('lowercases the name', () => {
    assert.equal(safeFileName('MyTest'), 'mytest');
  });

  test('replaces non-alphanumeric characters with hyphens', () => {
    assert.equal(safeFileName('create node (type A)'), 'create-node-type-a');
  });

  test('replaces multiple non-alphanumeric chars with single hyphens', () => {
    assert.equal(safeFileName('test   name'), 'test-name');
  });

  test('strips leading hyphens', () => {
    assert.equal(safeFileName('--test'), 'test');
  });

  test('strips trailing hyphens', () => {
    assert.equal(safeFileName('test--'), 'test');
  });

  test('strips both leading and trailing hyphens', () => {
    assert.equal(safeFileName('--test-name--'), 'test-name');
  });

  test('handles underscores as non-alphanumeric', () => {
    assert.equal(safeFileName('test_name'), 'test-name');
  });

  test('handles dots as non-alphanumeric', () => {
    assert.equal(safeFileName('test.name'), 'test-name');
  });

  test('handles empty string', () => {
    assert.equal(safeFileName(''), '');
  });

  test('handles string of only special characters', () => {
    assert.equal(safeFileName('---'), '');
  });
});
