/**
 * src/tests/sql-coverage.test.ts
 * Unit tests for SQL coverage collector, analyzer, and gap detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSqlTestEntries } from '../commands/coverage/sql-collector.js';
import {
  groupByProc,
  collectSqlGaps,
  buildSqlCoverageSummary,
  joinRunResultsToSqlTests,
} from '../commands/coverage/sql-analyzer.js';
import { renderSqlPretty } from '../commands/coverage/reporter/sql-pretty.js';
import { renderSqlJson } from '../commands/coverage/reporter/sql-json.js';
import { renderSqlMarkdown } from '../commands/coverage/reporter/sql-markdown.js';
import type { ShogunConfig, RunSummary, TestResult } from '../types.js';
import type { SqlTestEntry, SqlProcCoverage } from '../commands/coverage/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(cwd: string): ShogunConfig {
  return {
    version: 1,
    paths: {
      tests: 'tests',
      expected: 'expected',
      runs: 'runs',
    },
    connections: {
      'primary-db': {
        driver: 'mssql',
        connectionString: 'Server=localhost;Database=test;User Id=sa;Password=secret',
      },
    },
  };
}

function makeTmpRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'shogun-sql-cov-'));
  mkdirSync(join(cwd, 'tests', 'collections', 'db-procs'), { recursive: true });
  mkdirSync(join(cwd, 'expected', 'db-procs'), { recursive: true });
  mkdirSync(join(cwd, 'tests', 'collections', 'more-procs'), { recursive: true });
  mkdirSync(join(cwd, 'expected', 'more-procs'), { recursive: true });
  return cwd;
}

function writeSqlTest(
  cwd: string,
  collection: string,
  filename: string,
  proc: string,
  connection: string,
  options?: {
    params?: Record<string, unknown>[];
    paramFile?: string;
    pre?: string;
    post?: string;
    tags?: string[];
    ignoreFields?: string[];
    diffMode?: 'strict' | 'relaxed';
    outputFormat?: 'json' | 'csv' | 'both';
    writeBaseline?: boolean;
  },
): void {
  const sql: Record<string, unknown> = {
    connection,
    proc,
  };

  if (options?.params) {
    sql.parameters = { inline: options.params };
  } else if (options?.paramFile) {
    sql.parameters = { file: options.paramFile };
  } else {
    sql.parameters = { inline: [{ id: 1 }] };
  }

  if (options?.outputFormat) sql.outputFormat = options.outputFormat;

  const test: Record<string, unknown> = {
    name: filename.replace(/\.yaml$/, ''),
    type: 'sql',
    sql,
  };

  if (options?.pre) test.pre = options.pre;
  if (options?.post) test.post = options.post;
  if (options?.tags) test.tags = options.tags;

  const response: Record<string, unknown> = {};
  if (options?.ignoreFields) response.ignore_fields = options.ignoreFields;
  if (options?.diffMode) response.diff_mode = options.diffMode;
  if (Object.keys(response).length > 0) test.response = response;

  const testDir = join(cwd, 'tests', 'collections', collection);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, filename), yamlDump(test));

  // Write baseline if requested
  if (options?.writeBaseline) {
    const expectedDir = join(cwd, 'expected', collection);
    mkdirSync(expectedDir, { recursive: true });
    writeFileSync(
      join(expectedDir, `sql_${proc}.json`),
      JSON.stringify([{ paramIndex: 0, params: {}, resultSets: [], rowsAffected: [], durationMs: 100 }], null, 2),
    );
  }
}

/** Minimal YAML serializer for test fixtures (no external dep needed). */
function yamlDump(obj: unknown): string {
  return simpleYaml(obj, 0);
}

function simpleYaml(obj: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const inner = simpleYaml(item, indent + 1);
        return `${pad}- ${inner.trimStart()}`;
      }
      return `${pad}- ${simpleYaml(item, indent + 1)}`;
    }).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    return entries.map(([key, val]) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const nested = simpleYaml(val, indent + 1);
        return `${pad}${key}:\n${nested}`;
      }
      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${key}: []`;
        const items = val.map(item => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const inner = simpleYaml(item, indent + 2);
            return `${pad}  - ${inner.trimStart()}`;
          }
          return `${pad}  - ${simpleYaml(item, indent + 2)}`;
        }).join('\n');
        return `${pad}${key}:\n${items}`;
      }
      return `${pad}${key}: ${simpleYaml(val, indent + 1)}`;
    }).join('\n');
  }
  return String(obj);
}

function makeRunSummary(entries: SqlTestEntry[], status: 'passed' | 'failed' | 'needs_baseline'): RunSummary {
  return {
    runId: '20250808_001',
    env: 'test',
    suite: 'sql-suite',
    startedAt: '2025-08-08T00:00:00Z',
    finishedAt: '2025-08-08T00:01:00Z',
    durationMs: 60000,
    total: entries.length,
    passed: status === 'passed' ? entries.length : 0,
    failed: status === 'failed' ? entries.length : 0,
    needsBaseline: status === 'needs_baseline' ? entries.length : 0,
    dependencyFailed: 0,
    results: entries.map(e => ({
      name: e.name,
      file: e.file,
      status,
      durationMs: 100,
      assertions: { total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1 },
      sqlExecSummary: status !== 'passed' ? {
        totalParams: e.paramSetCount,
        executed: e.paramSetCount,
        errors: status === 'failed' ? 1 : 0,
        totalRows: 10,
      } : undefined,
    })) as TestResult[],
  };
}

// ---------------------------------------------------------------------------
// SqlCollector tests
// ---------------------------------------------------------------------------

describe('collectSqlTestEntries', () => {
  it('should collect type:sql tests and extract metadata', async () => {
    const cwd = makeTmpRepo();
    try {
      writeSqlTest(cwd, 'db-procs', 'sp_getuser.yaml', 'sp_GetUser', 'primary-db', {
        params: [{ userId: 1 }, { userId: 2 }],
        pre: 'console.log("setup")',
        post: 'assert(ctx.sql.results.length > 0)',
        tags: ['db', 'users'],
        writeBaseline: true,
      });

      const config = makeConfig(cwd);
      const entries = await collectSqlTestEntries(config, cwd);

      assert.equal(entries.length, 1);
      const e = entries[0]!;
      assert.equal(e.proc, 'sp_GetUser');
      assert.equal(e.connection, 'primary-db');
      assert.equal(e.driver, 'mssql');
      assert.equal(e.paramSetCount, 2);
      assert.deepEqual(e.paramKeys, ['userId']);
      assert.equal(e.baselineExists, true);
      assert.equal(e.hasPreScript, true);
      assert.equal(e.hasPostScript, true);
      assert.deepEqual(e.tags, ['db', 'users']);
      assert.equal(e.diffMode, 'strict');
      assert.equal(e.outputFormat, 'json');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('should skip non-SQL tests', async () => {
    const cwd = makeTmpRepo();
    try {
      // Write an HTTP test
      const testDir = join(cwd, 'tests', 'collections', 'db-procs');
      writeFileSync(join(testDir, 'get-user.yaml'), [
        'name: get-user',
        'request:',
        '  method: GET',
        '  path: /api/users/1',
      ].join('\n'));

      writeSqlTest(cwd, 'db-procs', 'sp_getuser.yaml', 'sp_GetUser', 'primary-db');

      const config = makeConfig(cwd);
      const entries = await collectSqlTestEntries(config, cwd);

      assert.equal(entries.length, 1); // only the SQL test
      assert.equal(entries[0]!.proc, 'sp_GetUser');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('should detect missing baseline', async () => {
    const cwd = makeTmpRepo();
    try {
      writeSqlTest(cwd, 'db-procs', 'sp_getuser.yaml', 'sp_GetUser', 'primary-db', {
        writeBaseline: false,
      });

      const config = makeConfig(cwd);
      const entries = await collectSqlTestEntries(config, cwd);

      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.baselineExists, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('should load parameter file references', async () => {
    const cwd = makeTmpRepo();
    try {
      // Write a parameter file
      const paramDir = join(cwd, 'tests', 'collections', 'db-procs');
      writeFileSync(join(paramDir, 'sp_getuser_params.yaml'), [
        'parameters:',
        '  - userId: 1',
        '  - userId: 2',
        '  - userId: null',
      ].join('\n'));

      writeSqlTest(cwd, 'db-procs', 'sp_getuser.yaml', 'sp_GetUser', 'primary-db', {
        paramFile: 'sp_getuser_params.yaml',
      });

      const config = makeConfig(cwd);
      const entries = await collectSqlTestEntries(config, cwd);

      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.paramSetCount, 3);
      assert.deepEqual(entries[0]!.paramKeys, ['userId']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('should collect tests from multiple collections', async () => {
    const cwd = makeTmpRepo();
    try {
      writeSqlTest(cwd, 'db-procs', 'sp_getuser.yaml', 'sp_GetUser', 'primary-db', {
        writeBaseline: true,
      });
      writeSqlTest(cwd, 'more-procs', 'sp_createorder.yaml', 'sp_CreateOrder', 'primary-db', {
        params: [{ orderId: 1 }, { orderId: 2 }],
        writeBaseline: true,
      });

      const config = makeConfig(cwd);
      const entries = await collectSqlTestEntries(config, cwd);

      assert.equal(entries.length, 2);
      const procs = entries.map(e => e.proc).sort();
      assert.deepEqual(procs, ['sp_CreateOrder', 'sp_GetUser']);
      const collections = entries.map(e => e.collection).sort();
      assert.deepEqual(collections, ['db-procs', 'more-procs']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('should extract diff_mode and ignore_fields from response', async () => {
    const cwd = makeTmpRepo();
    try {
      writeSqlTest(cwd, 'db-procs', 'sp_getuser.yaml', 'sp_GetUser', 'primary-db', {
        ignoreFields: ['executionTime', 'rowNumber'],
        diffMode: 'relaxed',
      });

      const config = makeConfig(cwd);
      const entries = await collectSqlTestEntries(config, cwd);

      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0]!.ignoreFields, ['executionTime', 'rowNumber']);
      assert.equal(entries[0]!.diffMode, 'relaxed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SqlAnalyzer — groupByProc tests
// ---------------------------------------------------------------------------

describe('groupByProc', () => {
  it('should group entries by proc+connection', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_GetUser', 'primary-db', 'db-procs', 2, true),
      makeEntry('sp_GetUser', 'primary-db', 'auth', 1, true),
      makeEntry('sp_CreateOrder', 'primary-db', 'db-procs', 3, false),
    ];

    const procs = groupByProc(entries);
    assert.equal(procs.length, 2);

    const getUser = procs.find(p => p.proc === 'sp_GetUser')!;
    assert.equal(getUser.testCount, 2);
    assert.equal(getUser.paramSetCount, 3); // 2 + 1
    assert.deepEqual(getUser.collections, ['auth', 'db-procs']);
    assert.equal(getUser.baselineExists, true);

    const createOrder = procs.find(p => p.proc === 'sp_CreateOrder')!;
    assert.equal(createOrder.testCount, 1);
    assert.equal(createOrder.baselineExists, false);
  });

  it('should separate same proc name on different connections', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_GetUser', 'primary-db', 'db-procs', 1, true),
      makeEntry('sp_GetUser', 'secondary-db', 'db-procs', 1, false),
    ];

    const procs = groupByProc(entries);
    assert.equal(procs.length, 2);
  });

  it('should sort baselined procs first', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_NoBaseline', 'primary-db', 'db-procs', 1, false),
      makeEntry('sp_WithBaseline', 'primary-db', 'db-procs', 1, true),
    ];

    const procs = groupByProc(entries);
    assert.equal(procs[0]!.proc, 'sp_WithBaseline');
    assert.equal(procs[1]!.proc, 'sp_NoBaseline');
  });

  it('should union param keys across tests', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_Proc', 'conn', 'coll', 1, true, ['userId', 'name']),
      makeEntry('sp_Proc', 'conn', 'coll2', 1, true, ['userId', 'email']),
    ];

    const procs = groupByProc(entries);
    assert.deepEqual(procs[0]!.paramKeys, ['email', 'name', 'userId']);
  });
});

// ---------------------------------------------------------------------------
// SqlAnalyzer — collectSqlGaps tests
// ---------------------------------------------------------------------------

describe('collectSqlGaps', () => {
  it('should report CRITICAL gap for missing baseline', () => {
    const procs: SqlProcCoverage[] = [
      makeProc('sp_NoBaseline', 'conn', 1, false),
    ];
    const gaps = collectSqlGaps(procs);
    const critical = gaps.find(g => g.severity === 'CRITICAL');
    assert.ok(critical);
    assert.equal(critical!.category, 'Missing baseline');
    assert.ok(critical!.detail.includes('sp_NoBaseline'));
  });

  it('should report HIGH gap for no parameter sets', () => {
    const procs: SqlProcCoverage[] = [
      makeProc('sp_NoParams', 'conn', 0, true),
    ];
    const gaps = collectSqlGaps(procs);
    const high = gaps.find(g => g.severity === 'HIGH');
    assert.ok(high);
    assert.equal(high!.category, 'No parameter sets');
  });

  it('should report MEDIUM gap for no scripts', () => {
    const procs: SqlProcCoverage[] = [
      makeProc('sp_NoScripts', 'conn', 1, true, false, false),
    ];
    const gaps = collectSqlGaps(procs);
    const medium = gaps.find(g => g.severity === 'MEDIUM' && g.category === 'No scripts');
    assert.ok(medium);
  });

  it('should report LOW gap for single collection', () => {
    const procs: SqlProcCoverage[] = [
      makeProc('sp_Single', 'conn', 1, true, true, true, ['only-one']),
    ];
    const gaps = collectSqlGaps(procs);
    const low = gaps.find(g => g.severity === 'LOW');
    assert.ok(low);
    assert.equal(low!.category, 'Single collection');
  });

  it('should not report gaps for well-covered proc', () => {
    const procs: SqlProcCoverage[] = [
      makeProc('sp_Good', 'conn', 2, true, true, true, ['coll-a', 'coll-b']),
    ];
    const gaps = collectSqlGaps(procs);
    // No baseline gap, no param gap, no script gap, no single-collection gap
    assert.equal(gaps.length, 0);
  });

  it('should sort gaps by severity (CRITICAL first)', () => {
    const procs: SqlProcCoverage[] = [
      makeProc('sp_A', 'conn', 0, false, false, false, ['only']),
      makeProc('sp_B', 'conn', 1, true, true, true, ['a', 'b']),
    ];
    const gaps = collectSqlGaps(procs);
    assert.ok(gaps.length > 0);
    // First gap should be CRITICAL
    assert.equal(gaps[0]!.severity, 'CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// SqlAnalyzer — buildSqlCoverageSummary tests
// ---------------------------------------------------------------------------

describe('buildSqlCoverageSummary', () => {
  it('should compute summary statistics', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn1', 'coll1', 2, true, [], true, true),
      makeEntry('sp_B', 'conn1', 'coll1', 1, false, [], false, false),
      makeEntry('sp_A', 'conn2', 'coll2', 3, true, [], true, false),
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);

    assert.equal(summary.totalProcs, 3); // sp_A/conn1, sp_B/conn1, sp_A/conn2
    assert.equal(summary.totalTests, 3);
    assert.equal(summary.totalParamSets, 6); // 2 + 1 + 3
    assert.equal(summary.baselinedProcs, 2);
    assert.equal(summary.needsBaselineCount, 1);
    assert.equal(summary.preScriptCount, 2);
    assert.equal(summary.postScriptCount, 1);
    assert.deepEqual(summary.connectionsUsed, ['conn1', 'conn2']);
  });

  it('should count driver types', () => {
    const entries: SqlTestEntry[] = [
      { ...makeEntry('sp_A', 'conn1', 'coll1', 1, true), driver: 'mssql' },
      { ...makeEntry('sp_B', 'conn1', 'coll1', 1, true), driver: 'mssql' },
      { ...makeEntry('sp_C', 'conn2', 'coll1', 1, true), driver: 'postgres' },
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);

    assert.equal(summary.driverCounts['mssql'], 2);
    assert.equal(summary.driverCounts['postgres'], 1);
  });

  it('should report hasRunData=false when no run results', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'coll', 1, true),
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);
    assert.equal(summary.hasRunData, false);
  });
});

// ---------------------------------------------------------------------------
// SqlAnalyzer — joinRunResultsToSqlTests tests
// ---------------------------------------------------------------------------

describe('joinRunResultsToSqlTests', () => {
  it('should join run results by collection/test-name', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'db-procs', 2, true),
    ];
    entries[0]!.name = 'sp_getuser';

    const runSummary = makeRunSummary(entries, 'failed');
    joinRunResultsToSqlTests(entries, runSummary);

    assert.ok(entries[0]!.runResult);
    assert.equal(entries[0]!.runResult!.status, 'failed');
    assert.equal(entries[0]!.runResult!.paramCount, 2);
    assert.equal(entries[0]!.runResult!.errors, 1);
  });

  it('should not set runResult for unmatched tests', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'db-procs', 1, true),
    ];
    entries[0]!.name = 'sp_getuser';

    const otherEntries: SqlTestEntry[] = [
      makeEntry('sp_B', 'conn', 'other', 1, true),
    ];
    otherEntries[0]!.name = 'sp_other';

    const runSummary = makeRunSummary(otherEntries, 'passed');
    joinRunResultsToSqlTests(entries, runSummary);

    assert.equal(entries[0]!.runResult, undefined);
  });
});

// ---------------------------------------------------------------------------
// Reporter tests
// ---------------------------------------------------------------------------

describe('renderSqlPretty', () => {
  it('should render a non-empty report string', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_GetUser', 'primary-db', 'db-procs', 2, true, ['userId'], true, true),
      makeEntry('sp_CreateOrder', 'primary-db', 'db-procs', 1, false),
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);

    const output = renderSqlPretty(summary, procs, false, null);
    assert.ok(output.length > 0);
    assert.ok(output.includes('SQL Stored Procedure Coverage Report'));
    assert.ok(output.includes('sp_GetUser'));
    assert.ok(output.includes('sp_CreateOrder'));
  });

  it('should include run status when run data is present', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'coll', 1, true),
    ];
    entries[0]!.runResult = {
      status: 'passed',
      durationMs: 100,
      paramCount: 1,
      executed: 1,
      errors: 0,
      totalRows: 5,
    };
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, true);

    const output = renderSqlPretty(summary, procs, false, null);
    assert.ok(output.includes('Last run:'));
    assert.ok(output.includes('Passed:'));
  });

  it('should include detail section when detail=true', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'coll', 1, true, ['userId']),
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);

    const output = renderSqlPretty(summary, procs, true, null);
    assert.ok(output.includes('Parameter Set Detail'));
    assert.ok(output.includes('{userId}'));
  });
});

describe('renderSqlJson', () => {
  it('should produce valid JSON', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'coll', 1, true),
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);

    const output = renderSqlJson(summary, procs);
    const parsed = JSON.parse(output);
    assert.ok(parsed.summary);
    assert.ok(parsed.procedures);
    assert.equal(parsed.procedures.length, 1);
    assert.equal(parsed.procedures[0].proc, 'sp_A');
  });
});

describe('renderSqlMarkdown', () => {
  it('should produce markdown with table headers', () => {
    const entries: SqlTestEntry[] = [
      makeEntry('sp_A', 'conn', 'coll', 1, true),
    ];
    const procs = groupByProc(entries);
    const summary = buildSqlCoverageSummary(entries, procs, false);

    const output = renderSqlMarkdown(summary, procs, false);
    assert.ok(output.includes('## SQL Stored Procedure Coverage Report'));
    assert.ok(output.includes('| Procedure |'));
    assert.ok(output.includes('sp_A'));
  });
});

// ---------------------------------------------------------------------------
// Test factory helpers
// ---------------------------------------------------------------------------

function makeEntry(
  proc: string,
  connection: string,
  collection: string,
  paramSetCount: number,
  baselineExists: boolean,
  paramKeys: string[] = ['id'],
  hasPreScript = false,
  hasPostScript = false,
): SqlTestEntry {
  return {
    name: `${proc.toLowerCase()}-test`,
    file: `tests/collections/${collection}/${proc.toLowerCase()}.yaml`,
    collection,
    proc,
    connection,
    driver: 'mssql',
    paramSetCount,
    paramKeys,
    baselineExists,
    baselinePath: `expected/${collection}/sql_${proc}.json`,
    hasPreScript,
    hasPostScript,
    ignoreFields: [],
    diffMode: 'strict',
    outputFormat: 'json',
    tags: [],
  };
}

function makeProc(
  proc: string,
  connection: string,
  paramSetCount: number,
  baselineExists: boolean,
  hasPreScript = true,
  hasPostScript = true,
  collections: string[] = ['coll-a', 'coll-b'],
): SqlProcCoverage {
  return {
    proc,
    connection,
    driver: 'mssql',
    tests: [makeEntry(proc, connection, collections[0] ?? 'coll', paramSetCount, baselineExists, ['id'], hasPreScript, hasPostScript)],
    testCount: 1,
    paramSetCount,
    paramKeys: ['id'],
    baselineExists,
    hasPreScript,
    hasPostScript,
    collections,
    passCount: 0,
    failCount: 0,
    needsBaselineCount: 0,
  };
}
