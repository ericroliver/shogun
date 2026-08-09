/**
 * src/tests/sql-types.test.ts
 * Unit tests for SQL types, driver registry, and snapshot diff modes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqlDriverRegistry } from '../sql-driver.js';
import type { SqlExecResult } from '../sql-driver.js';
import {
  diffSqlBaseline,
  writeSqlBaseline,
  getSqlBaselinePath,
  writeCsvArtifacts,
} from '../sql-snapshot.js';
import type { ShogunConfig } from '../types.js';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Driver Registry tests
// ---------------------------------------------------------------------------

describe('SqlDriverRegistry', () => {
  it('should register and retrieve a driver', () => {
    const mockDriver = {
      name: 'mock-test-driver',
      executeProc: () => Promise.resolve({} as SqlExecResult),
      executeBatch: () => Promise.resolve([] as SqlExecResult[]),
      checkDependencies: () => Promise.resolve([]),
    };
    SqlDriverRegistry.register('mock-test', mockDriver);
    const retrieved = SqlDriverRegistry.get('mock-test');
    assert.equal(retrieved.name, 'mock-test-driver');
  });

  it('should list available drivers', () => {
    const available = SqlDriverRegistry.available();
    assert.ok(available.includes('mock-test'));
  });

  it('should throw on unknown driver', () => {
    assert.throws(
      () => SqlDriverRegistry.get('nonexistent-driver'),
      /Unknown SQL driver "nonexistent-driver"/,
    );
  });
});

// ---------------------------------------------------------------------------
// SQL Snapshot tests
// ---------------------------------------------------------------------------

function makeTestConfig(): ShogunConfig {
  return { version: 1, paths: { expected: './expected' } };
}

function makeTestResult(paramIndex: number, params: Record<string, unknown>, resultSets?: SqlExecResult['resultSets']): SqlExecResult {
  return {
    paramIndex,
    params,
    resultSets: resultSets ?? [{
      columns: ['id', 'name'],
      rows: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    }],
    returnValue: 0,
    rowsAffected: [2],
    durationMs: 100,
  };
}

describe('SQL Snapshot - strict mode', () => {
  let tmpDir: string;

  function setupBaseline(results: SqlExecResult[], ignoreFields: string[] = []): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'shogun-sql-test-'));
    const baselinePath = join(tmpDir, 'baseline.json');
    writeSqlBaseline(results, baselinePath, ignoreFields);
    return baselinePath;
  }

  it('should pass when actual matches baseline', () => {
    const results = [makeTestResult(0, { branch: '001' })];
    const baselinePath = setupBaseline(results);
    const result = diffSqlBaseline(results, baselinePath, [], 'strict');
    assert.equal(result.passed, true);
  });

  it('should fail when actual differs from baseline', () => {
    const baselineResults = [makeTestResult(0, { branch: '001' })];
    const baselinePath = setupBaseline(baselineResults);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name'],
      rows: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'CHANGED' },
      ],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, [], 'strict');
    assert.equal(result.passed, false);
    assert.ok(result.diff);
  });

  it('should detect column addition in strict mode', () => {
    const baselineResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }],
    }])];
    const baselinePath = setupBaseline(baselineResults);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name', 'email'],
      rows: [{ id: 1, name: 'Alice', email: 'alice@test.com' }],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, [], 'strict');
    assert.equal(result.passed, false);
    assert.ok(result.diff);
  });

  it('should detect row count change', () => {
    const baselineResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id'],
      rows: [{ id: 1 }, { id: 2 }],
    }])];
    const baselinePath = setupBaseline(baselineResults);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id'],
      rows: [{ id: 1 }],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, [], 'strict');
    assert.equal(result.passed, false);
  });
});

describe('SQL Snapshot - relaxed mode', () => {
  let tmpDir: string;

  function setupBaseline(results: SqlExecResult[], ignoreFields: string[] = []): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'shogun-sql-test-'));
    const baselinePath = join(tmpDir, 'baseline.json');
    writeSqlBaseline(results, baselinePath, ignoreFields);
    return baselinePath;
  }

  it('should pass when extra column added in relaxed mode', () => {
    const baselineResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }],
    }])];
    const baselinePath = setupBaseline(baselineResults);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name', 'email'],
      rows: [{ id: 1, name: 'Alice', email: 'alice@test.com' }],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, [], 'relaxed');
    assert.equal(result.passed, true);
    assert.ok(result.extraColumns?.includes('email'));
  });

  it('should fail when baseline column removed in relaxed mode', () => {
    const baselineResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }],
    }])];
    const baselinePath = setupBaseline(baselineResults);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id'],
      rows: [{ id: 1 }],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, [], 'relaxed');
    assert.equal(result.passed, false);
  });

  it('should fail on value change for baseline columns in relaxed mode', () => {
    const baselineResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }],
    }])];
    const baselinePath = setupBaseline(baselineResults);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name', 'email'],
      rows: [{ id: 1, name: 'CHANGED', email: 'alice@test.com' }],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, [], 'relaxed');
    assert.equal(result.passed, false);
  });
});

describe('SQL Snapshot - ignore_fields', () => {
  it('should strip ignored fields before comparison', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'shogun-sql-test-'));
    const baselinePath = join(tmpDir, 'baseline.json');

    const baselineResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name', 'executionTime'],
      rows: [
        { id: 1, name: 'Alice', executionTime: 42 },
      ],
    }])];
    writeSqlBaseline(baselineResults, baselinePath, ['executionTime']);

    const actualResults = [makeTestResult(0, { branch: '001' }, [{
      columns: ['id', 'name', 'executionTime'],
      rows: [
        { id: 1, name: 'Alice', executionTime: 99 },
      ],
    }])];

    const result = diffSqlBaseline(actualResults, baselinePath, ['executionTime'], 'strict');
    assert.equal(result.passed, true);
  });
});

describe('SQL Snapshot - needsBaseline', () => {
  it('should return needsBaseline when baseline file does not exist', () => {
    const results = [makeTestResult(0, { branch: '001' })];
    const result = diffSqlBaseline(results, '/nonexistent/path/baseline.json', [], 'strict');
    assert.equal(result.passed, false);
    assert.equal(result.needsBaseline, true);
  });
});

// ---------------------------------------------------------------------------
// CSV export tests
// ---------------------------------------------------------------------------

describe('CSV export', () => {
  it('should write CSV files for each param set and result set', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'shogun-csv-test-'));
    const results: SqlExecResult[] = [
      {
        paramIndex: 0,
        params: { branch: '001' },
        resultSets: [{
          columns: ['id', 'name'],
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        }],
        returnValue: 0,
        rowsAffected: [2],
        durationMs: 100,
      },
      {
        paramIndex: 1,
        params: { branch: '002' },
        resultSets: [{
          columns: ['id', 'name'],
          rows: [
            { id: 3, name: 'Charlie' },
          ],
        }],
        returnValue: 0,
        rowsAffected: [1],
        durationMs: 50,
      },
    ];

    const writtenFiles = writeCsvArtifacts(results, tmpDir, 'test-collection', 'spTestProc');
    assert.equal(writtenFiles.length, 2);

    // Check first CSV file
    const csv0 = readFileSync(writtenFiles[0], 'utf8');
    assert.ok(csv0.includes('id,name'));
    assert.ok(csv0.includes('1,Alice'));
    assert.ok(csv0.includes('2,Bob'));

    // Check second CSV file
    const csv1 = readFileSync(writtenFiles[1], 'utf8');
    assert.ok(csv1.includes('id,name'));
    assert.ok(csv1.includes('3,Charlie'));
  });

  it('should escape commas and quotes in CSV', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'shogun-csv-escape-'));
    const results: SqlExecResult[] = [{
      paramIndex: 0,
      params: {},
      resultSets: [{
        columns: ['name', 'desc'],
        rows: [
          { name: 'Alice, Jr.', desc: 'Says "hello"' },
        ],
      }],
      returnValue: 0,
      rowsAffected: [1],
      durationMs: 10,
    }];

    const writtenFiles = writeCsvArtifacts(results, tmpDir, 'test', 'spProc');
    const csv = readFileSync(writtenFiles[0], 'utf8');
    assert.ok(csv.includes('"Alice, Jr."'));
    assert.ok(csv.includes('"Says ""hello"""'));
  });
});

// ---------------------------------------------------------------------------
// Baseline path tests
// ---------------------------------------------------------------------------

describe('getSqlBaselinePath', () => {
  it('should generate correct path for SQL baseline', () => {
    const config = makeTestConfig();
    const path = getSqlBaselinePath('spSomeProc', config, '/test/cwd', 'my-collection');
    assert.ok(path.includes('expected'));
    assert.ok(path.includes('my-collection'));
    assert.ok(path.includes('sql_spSomeProc.json'));
  });

  it('should use default collection when not provided', () => {
    const config = makeTestConfig();
    const path = getSqlBaselinePath('spProc', config, '/test/cwd');
    assert.ok(path.includes('default'));
    assert.ok(path.includes('sql_spProc.json'));
  });
});