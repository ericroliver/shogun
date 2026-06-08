/**
 * src/tests/lint-pure.test.ts
 *
 * Unit tests for pure static analysis functions from commands/lint.ts.
 *
 * Covers:
 *   - findDuplicateDeclarations() — brace-depth-aware duplicate variable detection
 *   - findUnsafePathEncoding() — unsafe encodeURIComponent on path variables
 *
 * Run with:
 *   npx tsx --test src/tests/lint-pure.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateDeclarations, findUnsafePathEncoding } from '../commands/lint.js';

// ---------------------------------------------------------------------------
// findDuplicateDeclarations
// ---------------------------------------------------------------------------

describe('findDuplicateDeclarations()', () => {

  test('no declarations returns empty', () => {
    const result = findDuplicateDeclarations('ctx.log("hello");');
    assert.deepEqual(result, []);
  });

  test('single const declaration — no duplicate', () => {
    const result = findDuplicateDeclarations('const x = 1;');
    assert.deepEqual(result, []);
  });

  test('same name declared twice at top level — flagged', () => {
    const source = `
const x = 1;
const x = 2;
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'x');
    assert.equal(result[0]!.lines.length, 2);
  });

  test('const then let with same name — flagged', () => {
    const source = `
const name = 'a';
let name = 'b';
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'name');
  });

  test('same name in separate blocks — NOT flagged (block-scoped)', () => {
    const source = `
if (true) {
  const x = 1;
}
if (true) {
  const x = 2;
}
`;
    const result = findDuplicateDeclarations(source);
    assert.deepEqual(result, [], 'Block-scoped re-declarations should not be flagged');
  });

  test('same name in nested block after top-level — NOT flagged', () => {
    const source = `
const x = 1;
if (true) {
  const x = 2;
}
`;
    const result = findDuplicateDeclarations(source);
    assert.deepEqual(result, [], 'Block-scoped inner re-declaration should not be flagged');
  });

  test('destructuring: duplicate binding names flagged', () => {
    const source = `
const { a, b } = obj;
const a = 1;
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'a');
  });

  test('array destructuring: duplicate binding names flagged', () => {
    const source = `
const [first, second] = arr;
const first = 'x';
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'first');
  });

  test('comment lines are skipped', () => {
    const source = `
// const x = 1;
const x = 1;
`;
    const result = findDuplicateDeclarations(source);
    assert.deepEqual(result, [], 'Commented-out declarations should be skipped');
  });

  test('multiple different names — no duplicates', () => {
    const source = `
const a = 1;
const b = 2;
const c = 3;
`;
    const result = findDuplicateDeclarations(source);
    assert.deepEqual(result, []);
  });

  test('var declaration tracked (not just const/let)', () => {
    const source = `
var x = 1;
var x = 2;
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'x');
  });

  test('destructuring with rename (colon syntax) tracks the binding name', () => {
    const source = `
const { original: renamed } = obj;
const renamed = 'dup';
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'renamed');
  });

  test('rest element in destructuring is tracked', () => {
    const source = `
const { a, ...rest } = obj;
const rest = 'dup';
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'rest');
  });

  test('triple declaration of same name reports 3 line numbers', () => {
    const source = `
const x = 1;
const x = 2;
const x = 3;
`;
    const result = findDuplicateDeclarations(source);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.lines.length, 3);
  });

  test('assignment (=) without declaration keyword is not tracked', () => {
    const source = `
const x = 1;
x = 2;
`;
    const result = findDuplicateDeclarations(source);
    assert.deepEqual(result, [], 'Plain reassignment without const/let/var should not be flagged');
  });
});

// ---------------------------------------------------------------------------
// findUnsafePathEncoding
// ---------------------------------------------------------------------------

describe('findUnsafePathEncoding()', () => {

  test('safe code returns empty', () => {
    const source = `ctx.request.path = '/api/nodes/' + name;`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, []);
  });

  test('encodeURIComponent on a path variable assigned to ctx.request.path — flagged', () => {
    const source = `ctx.request.path = '/api/nodes/' + encodeURIComponent(filePath);`;
    const result = findUnsafePathEncoding(source);
    assert.equal(result.length, 1);
    assert.match(result[0]!.line, /encodeURIComponent\(filePath\)/);
  });

  test('encodeURIComponent on a dir variable — flagged', () => {
    const source = `ctx.request.path = '/api/files/' + encodeURIComponent(dirPath);`;
    const result = findUnsafePathEncoding(source);
    assert.equal(result.length, 1);
  });

  test('encodeURIComponent on className — NOT flagged (not a path/dir variable)', () => {
    const source = `ctx.request.path = '/api/code/' + encodeURIComponent(className);`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, [], 'className does not contain "path" or "dir" — safe to encodeURIComponent');
  });

  test('encodeURIComponent on methodName — NOT flagged', () => {
    const source = `ctx.request.path = '/api/code/' + encodeURIComponent(methodName);`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, []);
  });

  test('encodeURIComponent on checkpointId — NOT flagged', () => {
    const source = `ctx.request.path = '/api/checkpoints/' + encodeURIComponent(checkpointId);`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, []);
  });

  test('encodeURIComponent without ctx.request.path — NOT flagged', () => {
    const source = `const encoded = encodeURIComponent(filePath);`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, [], 'encodeURIComponent alone without ctx.request.path assignment is not flagged');
  });

  test('ctx.request.path without encodeURIComponent — NOT flagged', () => {
    const source = `ctx.request.path = '/api/nodes/' + filePath;`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, [], 'Direct concatenation without encodeURIComponent is not flagged');
  });

  test('comment lines are skipped', () => {
    const source = `// ctx.request.path = '/api/nodes/' + encodeURIComponent(filePath);`;
    const result = findUnsafePathEncoding(source);
    assert.deepEqual(result, []);
  });

  test('PATH in uppercase variable name — flagged (contains "path")', () => {
    const source = `ctx.request.path = '/api/nodes/' + encodeURIComponent(FILE_PATH);`;
    const result = findUnsafePathEncoding(source);
    assert.equal(result.length, 1, 'FILE_PATH contains "PATH" — should be flagged');
  });

  test('multiple unsafe lines all flagged', () => {
    const source = `
ctx.request.path = '/api/nodes/' + encodeURIComponent(filePath);
ctx.request.path = '/api/files/' + encodeURIComponent(dirPath);
`;
    const result = findUnsafePathEncoding(source);
    assert.equal(result.length, 2);
  });
});
