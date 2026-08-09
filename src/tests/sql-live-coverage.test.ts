/**
 * src/tests/sql-live-coverage.test.ts
 * Unit tests for SQL live coverage analyzer (Phase 2 — DB introspection).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareTestedVsDatabase,
  analyzeParamCoverage,
  buildParamCoverageRows,
  collectLiveGaps,
  buildParamCoverage,
} from '../commands/coverage/sql-live-analyzer.js';
import type {
  SqlProcCoverage,
  SqlTestEntry,
  SqlUntestedProc,
} from '../commands/coverage/types.js';
import type { SqlProcMetadata, SqlParamMetadata } from '../sql-driver.js';

// --- Helpers ---

function makeDbProc(
  schema: string,
  name: string,
  params: Array<Partial<SqlParamMetadata>> = [],
): SqlProcMetadata {
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    parameters: params.map((p, i) => ({
      name: p.name ?? `param${i}`,
      dataType: p.dataType ?? 'int',
      maxLength: p.maxLength ?? null,
      precision: p.precision ?? null,
      scale: p.scale ?? null,
      isOutput: p.isOutput ?? false,
      hasDefault: p.hasDefault ?? false,
      defaultValue: p.defaultValue ?? null,
      ordinal: p.ordinal ?? i + 1,
    })),
    createDate: null,
    modifyDate: null,
  };
}

function makeSqlProc(
  proc: string,
  connection: string,
  paramKeys: string[],
  paramSetCount: number = 1,
): SqlProcCoverage {
  return {
    proc,
    connection,
    tests: [],
    testCount: 1,
    paramSetCount,
    paramKeys,
    baselineExists: true,
    hasPreScript: false,
    hasPostScript: false,
    collections: ['test'],
    passCount: 0,
    failCount: 0,
    needsBaselineCount: 0,
  };
}

function makeSqlTestEntry(
  proc: string,
  collection: string,
  paramKeys: string[],
  paramSetCount: number = 1,
): SqlTestEntry {
  return {
    name: `test-${proc}`,
    file: `tests/collections/${collection}/${proc}.yaml`,
    collection,
    proc,
    connection: 'primary-db',
    paramSetCount,
    paramKeys,
    baselineExists: true,
    baselinePath: `expected/sql_${proc}.json`,
    hasPreScript: false,
    hasPostScript: false,
    ignoreFields: [],
    diffMode: 'strict',
    outputFormat: 'json',
    tags: [],
  };
}

// --- Tests ---

describe('compareTestedVsDatabase', () => {
  it('should match tested proc to DB proc by bare name', () => {
    const procs = [makeSqlProc('sp_GetUser', 'primary-db', ['userId'])];
    const dbProcs = [makeDbProc('dbo', 'sp_GetUser', [{ name: 'userId', dataType: 'int' }])];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    assert.equal(untested.length, 0);
    assert.equal(procs[0]!.inDatabase, true);
    assert.ok(procs[0]!.dbMetadata);
    assert.deepEqual(procs[0]!.exercisedParams, ['userid']);
    assert.deepEqual(procs[0]!.untestedParams, []);
    assert.deepEqual(procs[0]!.phantomParams, []);
  });

  it('should match tested proc by qualified name', () => {
    const procs = [makeSqlProc('dbo.sp_GetUser', 'primary-db', ['userId'])];
    const dbProcs = [makeDbProc('dbo', 'sp_GetUser', [{ name: 'userId', dataType: 'int' }])];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    assert.equal(untested.length, 0);
    assert.equal(procs[0]!.inDatabase, true);
  });

  it('should detect untested procs in DB', () => {
    const procs = [makeSqlProc('sp_GetUser', 'primary-db', ['userId'])];
    const dbProcs = [
      makeDbProc('dbo', 'sp_GetUser', [{ name: 'userId', dataType: 'int' }]),
      makeDbProc('dbo', 'sp_CreateOrder', [{ name: 'orderId', dataType: 'int' }, { name: 'amount', dataType: 'decimal' }]),
    ];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    assert.equal(untested.length, 1);
    assert.equal(untested[0]!.qualifiedName, 'dbo.sp_CreateOrder');
    assert.equal(untested[0]!.connection, 'primary-db');
    assert.equal(untested[0]!.parameters.length, 2);
  });

  it('should mark proc as not in database when DB has no match', () => {
    const procs = [makeSqlProc('sp_Deleted', 'primary-db', ['id'])];
    const dbProcs = [makeDbProc('dbo', 'sp_GetUser', [{ name: 'userId', dataType: 'int' }])];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    assert.equal(untested.length, 1); // sp_GetUser is untested
    assert.equal(procs[0]!.inDatabase, false);
  });

  it('should skip procs from other connections', () => {
    const procs = [makeSqlProc('sp_GetUser', 'secondary-db', ['userId'])];
    const dbProcs = [makeDbProc('dbo', 'sp_GetUser', [{ name: 'userId', dataType: 'int' }])];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    // proc is on secondary-db, introspection is for primary-db → not matched
    assert.equal(procs[0]!.inDatabase, undefined);
    assert.equal(untested.length, 1); // sp_GetUser is untested in primary-db
  });

  it('should handle proc with no parameters', () => {
    const procs = [makeSqlProc('sp_NoParams', 'primary-db', [])];
    const dbProcs = [makeDbProc('dbo', 'sp_NoParams', [])];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    assert.equal(untested.length, 0);
    assert.equal(procs[0]!.inDatabase, true);
    assert.deepEqual(procs[0]!.exercisedParams, []);
    assert.deepEqual(procs[0]!.untestedParams, []);
  });

  it('should prefer dbo schema on ambiguous bare name match', () => {
    const procs = [makeSqlProc('sp_Ambiguous', 'primary-db', ['id'])];
    const dbProcs = [
      makeDbProc('other', 'sp_Ambiguous', [{ name: 'id', dataType: 'int' }]),
      makeDbProc('dbo', 'sp_Ambiguous', [{ name: 'id', dataType: 'int' }]),
    ];

    const untested = compareTestedVsDatabase(procs, dbProcs, 'primary-db');

    assert.equal(untested.length, 1); // other.sp_Ambiguous is untested
    assert.equal(procs[0]!.dbMetadata?.schema, 'dbo');
  });
});

describe('analyzeParamCoverage', () => {
  it('should identify exercised, untested, and phantom params', () => {
    const proc = makeSqlProc('sp_GetUser', 'primary-db', ['userId', 'branch', 'nonexistent']);
    const dbProc = makeDbProc('dbo', 'sp_GetUser', [
      { name: 'userId', dataType: 'int' },
      { name: 'branch', dataType: 'nvarchar' },
      { name: 'isActive', dataType: 'bit' },
    ]);

    const result = analyzeParamCoverage(proc, dbProc);

    assert.deepEqual(result.exercisedParams, ['branch', 'userid']);
    assert.deepEqual(result.untestedParams, ['isactive']);
    assert.deepEqual(result.phantomParams, ['nonexistent']);
  });

  it('should exclude OUTPUT params from input param analysis', () => {
    const proc = makeSqlProc('sp_GetData', 'primary-db', ['inputId']);
    const dbProc = makeDbProc('dbo', 'sp_GetData', [
      { name: 'inputId', dataType: 'int' },
      { name: 'resultCode', dataType: 'int', isOutput: true },
    ]);

    const result = analyzeParamCoverage(proc, dbProc);

    // resultCode is output, not an input → not in untestedParams
    assert.deepEqual(result.exercisedParams, ['inputid']);
    assert.deepEqual(result.untestedParams, []);
  });

  it('should handle all params exercised', () => {
    const proc = makeSqlProc('sp_Perfect', 'primary-db', ['a', 'b']);
    const dbProc = makeDbProc('dbo', 'sp_Perfect', [
      { name: 'a', dataType: 'int' },
      { name: 'b', dataType: 'int' },
    ]);

    const result = analyzeParamCoverage(proc, dbProc);

    assert.deepEqual(result.exercisedParams, ['a', 'b']);
    assert.deepEqual(result.untestedParams, []);
    assert.deepEqual(result.phantomParams, []);
  });

  it('should handle case-insensitive param matching', () => {
    const proc = makeSqlProc('sp_GetUser', 'primary-db', ['UserID', 'BRANCH']);
    const dbProc = makeDbProc('dbo', 'sp_GetUser', [
      { name: 'userId', dataType: 'int' },
      { name: 'branch', dataType: 'nvarchar' },
    ]);

    const result = analyzeParamCoverage(proc, dbProc);

    assert.deepEqual(result.exercisedParams, ['branch', 'userid']);
    assert.deepEqual(result.untestedParams, []);
    assert.deepEqual(result.phantomParams, []);
  });
});

describe('buildParamCoverageRows', () => {
  it('should build per-param coverage rows', () => {
    const proc = makeSqlProc('sp_GetUser', 'primary-db', ['userId', 'branch'], 3);
    proc.tests = [
      makeSqlTestEntry('sp_GetUser', 'test-col', ['userId', 'branch'], 3),
    ];
    proc.dbMetadata = makeDbProc('dbo', 'sp_GetUser', [
      { name: 'userId', dataType: 'int' },
      { name: 'branch', dataType: 'nvarchar' },
      { name: 'isActive', dataType: 'bit' },
    ]);

    const rows = buildParamCoverageRows(proc);

    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.name, 'userId');
    assert.equal(rows[0]!.dataType, 'int');
    assert.equal(rows[0]!.exercisedCount, 3);
    assert.equal(rows[0]!.totalParamSets, 3);
    assert.equal(rows[0]!.fullyCovered, true);
    assert.equal(rows[0]!.neverExercised, false);

    assert.equal(rows[2]!.name, 'isActive');
    assert.equal(rows[2]!.exercisedCount, 0);
    assert.equal(rows[2]!.neverExercised, true);
    assert.equal(rows[2]!.fullyCovered, false);
  });

  it('should return empty array when no DB metadata', () => {
    const proc = makeSqlProc('sp_Test', 'primary-db', ['id']);
    const rows = buildParamCoverageRows(proc);
    assert.equal(rows.length, 0);
  });
});

describe('collectLiveGaps', () => {
  it('should create CRITICAL gap for untested procs', () => {
    const untested: SqlUntestedProc[] = [{
      schema: 'dbo',
      name: 'sp_Untested',
      qualifiedName: 'dbo.sp_Untested',
      connection: 'primary-db',
      parameters: [],
      createDate: null,
      modifyDate: null,
    }];

    const gaps = collectLiveGaps([], untested);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.severity, 'CRITICAL');
    assert.equal(gaps[0]!.category, 'Untested procedure');
    assert.equal(gaps[0]!.proc, 'dbo.sp_Untested');
  });

  it('should create MEDIUM gap for proc not in database', () => {
    const procs = [makeSqlProc('sp_Gone', 'primary-db', ['id'])];
    procs[0]!.inDatabase = false;

    const gaps = collectLiveGaps(procs, []);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.severity, 'MEDIUM');
    assert.equal(gaps[0]!.category, 'Not in database');
  });

  it('should create HIGH gap for untested params', () => {
    const procs = [makeSqlProc('sp_GetUser', 'primary-db', ['userId'])];
    procs[0]!.untestedParams = ['isActive', 'branch'];

    const gaps = collectLiveGaps(procs, []);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.severity, 'HIGH');
    assert.equal(gaps[0]!.category, 'Untested parameters');
    assert.ok(gaps[0]!.detail.includes('isActive'));
    assert.ok(gaps[0]!.detail.includes('branch'));
  });

  it('should create MEDIUM gap for phantom params', () => {
    const procs = [makeSqlProc('sp_GetUser', 'primary-db', ['userId', 'oldParam'])];
    procs[0]!.phantomParams = ['oldparam'];

    const gaps = collectLiveGaps(procs, []);

    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.severity, 'MEDIUM');
    assert.equal(gaps[0]!.category, 'Phantom parameters');
  });

  it('should sort gaps by severity (CRITICAL first)', () => {
    const untested: SqlUntestedProc[] = [{
      schema: 'dbo',
      name: 'sp_Untested',
      qualifiedName: 'dbo.sp_Untested',
      connection: 'primary-db',
      parameters: [],
      createDate: null,
      modifyDate: null,
    }];
    const procs = [
      makeSqlProc('sp_A', 'primary-db', []),
      makeSqlProc('sp_B', 'primary-db', []),
    ];
    procs[0]!.untestedParams = ['x'];
    procs[1]!.phantomParams = ['y'];

    const gaps = collectLiveGaps(procs, untested);

    assert.equal(gaps.length, 3);
    assert.equal(gaps[0]!.severity, 'CRITICAL');
    assert.equal(gaps[1]!.severity, 'HIGH');
    assert.equal(gaps[2]!.severity, 'MEDIUM');
  });

  it('should return no gaps when everything is covered', () => {
    const procs = [makeSqlProc('sp_Perfect', 'primary-db', ['a', 'b'])];
    procs[0]!.inDatabase = true;
    procs[0]!.untestedParams = [];
    procs[0]!.phantomParams = [];

    const gaps = collectLiveGaps(procs, []);

    assert.equal(gaps.length, 0);
  });
});

describe('buildParamCoverage', () => {
  it('should build param coverage for procs with DB metadata', () => {
    const proc = makeSqlProc('sp_GetUser', 'primary-db', ['userId'], 2);
    proc.tests = [makeSqlTestEntry('sp_GetUser', 'col', ['userId'], 2)];
    proc.dbMetadata = makeDbProc('dbo', 'sp_GetUser', [
      { name: 'userId', dataType: 'int' },
    ]);

    const result = buildParamCoverage([proc]);

    assert.equal(result.length, 1);
    assert.equal(result[0]!.proc, 'sp_GetUser');
    assert.equal(result[0]!.connection, 'primary-db');
    assert.equal(result[0]!.params.length, 1);
    assert.equal(result[0]!.params[0]!.name, 'userId');
    assert.equal(result[0]!.params[0]!.exercisedCount, 2);
    assert.equal(result[0]!.params[0]!.fullyCovered, true);
  });

  it('should skip procs without DB metadata', () => {
    const proc = makeSqlProc('sp_NoDb', 'primary-db', ['id']);
    // No dbMetadata set

    const result = buildParamCoverage([proc]);

    assert.equal(result.length, 0);
  });
});
