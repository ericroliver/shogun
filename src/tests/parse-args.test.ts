/**
 * src/tests/parse-args.test.ts
 *
 * Unit tests for parseArgs() from index.ts — CLI argument parsing.
 *
 * Covers:
 *   - All flag types (--env, --collection, --suite, etc.)
 *   - Multi-value --collection (string → string[] accumulation)
 *   - --tags comma splitting
 *   - Unknown flag warning (consuming next token if it looks like a value)
 *   - Bare positional becomes specSource
 *   - Edge cases: missing values, empty args
 *
 * Run with:
 *   npx tsx --test src/tests/parse-args.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../index.js';

describe('parseArgs() — basic flags', () => {

  test('empty array returns empty object', () => {
    const result = parseArgs([]);
    assert.deepEqual(result, {});
  });

  test('--env sets env', () => {
    const result = parseArgs(['--env', 'QA']);
    assert.equal(result.env, 'QA');
  });

  test('--suite sets suite', () => {
    const result = parseArgs(['--suite', 'smoke']);
    assert.equal(result.suite, 'smoke');
  });

  test('--file sets file', () => {
    const result = parseArgs(['--file', 'tests/foo.yaml']);
    assert.equal(result.file, 'tests/foo.yaml');
  });

  test('--format sets format', () => {
    const result = parseArgs(['--format', 'json']);
    assert.equal(result.format, 'json');
  });

  test('--run sets run', () => {
    const result = parseArgs(['--run', '20260608_120000']);
    assert.equal(result.run, '20260608_120000');
  });

  test('--cwd sets cwd', () => {
    const result = parseArgs(['--cwd', '/tmp/repo']);
    assert.equal(result.cwd, '/tmp/repo');
  });

  test('--backend sets backend', () => {
    const result = parseArgs(['--backend', 'powershell']);
    assert.equal(result.backend, 'powershell');
  });
});

describe('parseArgs() — --collection multi-value', () => {

  test('single --collection returns string', () => {
    const result = parseArgs(['--collection', 'graph']);
    assert.equal(result.collection, 'graph');
    assert.ok(typeof result.collection === 'string', 'Single collection should be a string, not array');
  });

  test('two --collection returns array', () => {
    const result = parseArgs(['--collection', 'graph', '--collection', 'code']);
    assert.ok(Array.isArray(result.collection), 'Multiple collections should be an array');
    assert.deepEqual(result.collection, ['graph', 'code']);
  });

  test('three --collection accumulates all values', () => {
    const result = parseArgs([
      '--collection', 'graph',
      '--collection', 'code',
      '--collection', 'workspace',
    ]);
    assert.deepEqual(result.collection, ['graph', 'code', 'workspace']);
  });
});

describe('parseArgs() --tags comma splitting', () => {

  test('--tags splits on comma', () => {
    const result = parseArgs(['--tags', 'smoke,integration']);
    assert.deepEqual(result.tags, ['smoke', 'integration']);
  });

  test('--tags trims whitespace around items', () => {
    const result = parseArgs(['--tags', 'smoke, integration , e2e']);
    assert.deepEqual(result.tags, ['smoke', 'integration', 'e2e']);
  });

  test('--tags with single value produces one-element array', () => {
    const result = parseArgs(['--tags', 'smoke']);
    assert.deepEqual(result.tags, ['smoke']);
  });
});

describe('parseArgs() — spec flags', () => {

  test('--endpoint sets endpoint', () => {
    const result = parseArgs(['--endpoint', '/api/workspaces']);
    assert.equal(result.endpoint, '/api/workspaces');
  });

  test('--method sets method', () => {
    const result = parseArgs(['--method', 'GET']);
    assert.equal(result.method, 'GET');
  });

  test('--tag sets tag', () => {
    const result = parseArgs(['--tag', 'Agents']);
    assert.equal(result.tag, 'Agents');
  });

  test('--schema sets schema', () => {
    const result = parseArgs(['--schema', 'AgentDefinition']);
    assert.equal(result.schema, 'AgentDefinition');
  });

  test('--search sets search', () => {
    const result = parseArgs(['--search', 'checkpoint']);
    assert.equal(result.search, 'checkpoint');
  });

  test('--list sets list to true', () => {
    const result = parseArgs(['--list']);
    assert.equal(result.list, true);
  });

  test('--uncovered sets uncovered to true', () => {
    const result = parseArgs(['--uncovered']);
    assert.equal(result.uncovered, true);
  });
});

describe('parseArgs() — unknown flags', () => {

  test('unknown flag with a value token consumes the value and warns', () => {
    // --bogus foo → should skip "foo" as value and warn about --bogus
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    try {
      const result = parseArgs(['--bogus', 'foo']);
      assert.equal(result.specSource, undefined, 'Should NOT set specSource for unknown flag value');
      assert.ok(warnings.some(w => w.includes('--bogus')), 'Should warn about unrecognized flag');
    } finally {
      console.warn = origWarn;
    }
  });

  test('unknown flag without a value just warns', () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    try {
      const result = parseArgs(['--bogus', '--env', 'local']);
      assert.equal(result.env, 'local', 'Should still parse subsequent valid flags');
      assert.ok(warnings.some(w => w.includes('--bogus')), 'Should warn about unrecognized flag');
    } finally {
      console.warn = origWarn;
    }
  });

  test('unknown boolean flag followed by another flag does not consume it', () => {
    // --unknown --env local → --unknown is flag (no value), --env local parsed normally
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    try {
      const result = parseArgs(['--unknown', '--env', 'local']);
      assert.equal(result.env, 'local', 'Should parse --env even after unknown flag');
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('parseArgs() — positional specSource', () => {

  test('bare positional becomes specSource', () => {
    const result = parseArgs(['http://localhost:5000/swagger.json']);
    assert.equal(result.specSource, 'http://localhost:5000/swagger.json');
  });

  test('positional after flags becomes specSource', () => {
    const result = parseArgs(['--env', 'local', 'specs/api.json']);
    assert.equal(result.env, 'local');
    assert.equal(result.specSource, 'specs/api.json');
  });

  test('multiple positionals — last one wins', () => {
    const result = parseArgs(['first.json', 'second.json']);
    // The first positional sets specSource, the second overwrites it
    assert.equal(result.specSource, 'second.json');
  });
});

describe('parseArgs() — combined flags', () => {

  test('full command: run with env, collection, format', () => {
    const result = parseArgs(['--env', 'QA', '--collection', 'graph', '--format', 'json']);
    assert.equal(result.env, 'QA');
    assert.equal(result.collection, 'graph');
    assert.equal(result.format, 'json');
  });

  test('spec command with endpoint and method', () => {
    const result = parseArgs(['--endpoint', '/api/workspaces', '--method', 'GET', '--format', 'json']);
    assert.equal(result.endpoint, '/api/workspaces');
    assert.equal(result.method, 'GET');
    assert.equal(result.format, 'json');
  });
});
