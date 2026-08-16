# Shogun SQL Stored Procedure Testing — Design Document

> Status: Design Draft v0.2 — 2026-08-08
> Author: shogun-sword

---

## 1. Overview

Shogun currently tests HTTP APIs: YAML test definitions describe HTTP requests, curl executes them, and snapshot baselines are diffed. This document scopes a new test **type** — SQL stored procedure testing — that reuses shogun's existing collection, snapshot, and reporting infrastructure but introduces a parallel execution path.

### Goals

- Test stored procedures by calling them with parameterized inputs
- Run N parameter sets per proc under test, capturing all results
- Capture baselines and diff against them on future runs (same as HTTP tests)
- Fit naturally into existing collections, suites, and CLI commands
- Support multiple SQL database engines via a pluggable driver interface

### Non-Goals (for v1)

- Testing ad-hoc SQL queries (only stored procedures for now)
- Testing views, functions, or triggers
- Schema validation or migration testing
- Performance/load testing
- Multi-database distributed transactions
- OUTPUT parameter capture (result sets only for v1)

### Critical Constraint: Backward Compatibility

Several repos are already using shogun in production. The `type` field on test definitions **defaults to `'http'`**, so every existing test YAML file continues to work without any changes. No existing types, config fields, or runner behavior is modified — the SQL path is purely additive.

---

## 2. Architecture at a Glance

```
Existing HTTP path (unchanged):
  YAML test → pre-script → curl → jq asserts → snapshot diff → post-script → log

New SQL path (additive, parallel):
  YAML test (type: sql) → load param file → exec proc ×N via driver → capture results → snapshot diff → log
```

Both paths feed into the same:
- Collection structure (`_collection.yaml`, setup/teardown, order)
- Snapshot baseline system (`expected/` directory)
- Run logging (`runs/` directory, `summary.json`)
- Reporter (pretty/json/tap output)
- Suite system

---

## 3. Config Changes: Connection Strings

### 3.1 Security Model

Connection strings contain credentials. They belong in **env files** (gitignored), not in `shogun.config.yaml` (committed). The config file defines **named connections** that reference env var placeholders.

### 3.2 `shogun.config.yaml` additions

```yaml
version: 1

# ... existing fields unchanged ...

connections:
  qa-db:
    driver: mssql              # mssql (v1) | postgres | sqlite (future)
    connectionString: ${DB_QA_CONN_STRING}
    timeout: 30                # optional, per-connection override (seconds)
  prod-readonly:
    driver: mssql
    connectionString: ${DB_PROD_RO_CONN_STRING}
    timeout: 60
  # Future:
  # analytics-pg:
  #   driver: postgres
  #   connectionString: ${PG_ANALYTICS_CONN_STRING}
  # local-sqlite:
  #   driver: sqlite
  #   connectionString: ./data/test.db
```

### 3.3 Env file

```bash
# envs/QA.env
BASE_URL=https://qa-api.myapp.com
AUTH_TOKEN=Bearer eyJhbGc...
DB_QA_CONN_STRING=Server=qa-sql01;Database=MyApp;User Id=shogun;Password=secret;TrustServerCertificate=True;Encrypt=True
DB_PROD_RO_CONN_STRING=Server=prod-sql01;Database=MyApp;User Id=readonly;Password=secret;TrustServerCertificate=True;Encrypt=True
```

### 3.4 Type additions (`src/types.ts`)

```typescript
/**
 * Supported SQL driver types.
 * v1: mssql only.
 * Future: postgres (pg), sqlite (better-sqlite3).
 */
export type SqlDriverType = 'mssql' | 'postgres' | 'sqlite';

export interface SqlConnectionConfig {
  /** Database driver — determines which SqlDriver implementation is used */
  driver: SqlDriverType;
  /** Connection string with ${VAR} interpolation from env */
  connectionString: string;
  /** Query timeout in seconds (optional, defaults to config.defaults.timeout) */
  timeout?: number;
}

export interface ShogunConfig {
  // ... existing fields unchanged ...
  /** Named database connections for SQL tests. Optional — HTTP-only repos don't need this. */
  connections?: Record<string, SqlConnectionConfig>;
}
```

### 3.5 Why not just one connection string?

Multiple named connections let a single test repo target different databases (e.g., a read-replica for most tests, a warehouse DB for reporting procs) without changing env files. The env file provides the actual connection string value; the config maps a friendly name to it.

---

## 4. SQL Test Definition (YAML)

### 4.1 Test type discriminator

Add a `type` field to the test definition. It **defaults to `'http'`** so all existing YAML files continue to work unchanged:

```yaml
# Existing HTTP test (unchanged — type defaults to 'http')
name: Get All Agents
request:
  method: GET
  path: /api/agents
response:
  status: 200
  snapshot: true
```

```yaml
# New SQL test
name: Test spSomeBusinessLogic
type: sql
sql:
  connection: qa-db
  proc: spSomeBusinessLogic
  parameters:
    file: ./params/spSomeBusinessLogic-params.yaml
response:
  snapshot: true
  diff_mode: strict         # strict (default) | relaxed
  ignore_fields:
    - "**.executionTime"
    - "**.rowNumber"
```

### 4.2 Full SQL test definition shape

```yaml
name: Test spSomeBusinessLogic
description: >
  Validates spSomeBusinessLogic returns expected results across
  branch/customer combinations.
type: sql
collection: db-procedures
tags:
  - sql
  - business-logic

sql:
  # Named connection from shogun.config.yaml → connections
  connection: qa-db

  # Stored procedure name
  proc: spSomeBusinessLogic

  # Parameters — inline or file-backed
  parameters:
    # Option A: inline array
    inline:
      - branch: "001"
        customerid: 12345
        invoiceFilter: "active"
      - branch: "001"
        customerid: 12346
        # invoiceFilter omitted — optional proc parameter, passed as NULL
      - branch: "002"
        customerid: 99999
        invoiceFilter: "overdue"

    # Option B: external file (relative to YAML file location)
    # file: ./params/spSomeBusinessLogic-params.yaml

  # Optional: result capture format for output artifacts
  # (baseline is always JSON for diff-ability; this controls exported files)
  outputFormat: json    # json (default) | csv | both

  # Optional: timeout override (seconds)
  timeout: 30

  # Optional: pre/post scripts (same ctx as HTTP tests, plus ctx.sql)
  # pre runs before ANY parameter set executes
  # post runs after ALL parameter sets complete
  pre: |
    ctx.log(`Starting spSomeBusinessLogic tests with ${ctx.sql.paramCount} parameter sets`);

  post: |
    const results = ctx.sql.results;
    const errors = results.filter(r => r.error);
    ctx.assert(errors.length === 0, `${errors.length} parameter sets failed to execute`);

response:
  snapshot: true

  # Diff mode: strict (default) or relaxed
  # strict:   any difference in result shape OR data fails the test
  #           (column added/removed, row count change, value change — all fail)
  # relaxed:  only compares columns present in the baseline; extra columns in
  #           actual results are ignored. Row count and value changes still fail.
  diff_mode: strict

  ignore_fields:
    - "**.executionTime"
    - "**.rowNumber"     # if proc returns a row number column
```

### 4.3 Type additions

```typescript
export interface SqlTestConfig {
  /** Named connection from config.connections */
  connection: string;
  /** Stored procedure name */
  proc: string;
  /** Parameter sets — inline array or file reference */
  parameters:
    | { inline: Record<string, unknown>[] }
    | { file: string };
  /** Output artifact format. Baseline is always JSON. Default: json */
  outputFormat?: 'json' | 'csv' | 'both';
  /** Query timeout override (seconds) */
  timeout?: number;
  /** Pre-execution script (runs once before all parameter sets) */
  pre?: string;
  /** Post-execution script (runs once after all parameter sets) */
  post?: string;
}

export interface ResponseDef {
  /** Expected HTTP status code (HTTP tests only) */
  status?: number;
  /** Enable snapshot baseline diff */
  snapshot?: boolean;
  /** jq paths to strip before snapshot diff (merged with global config) */
  ignore_fields?: string[];
  /** Array of jq boolean expressions — each must evaluate truthy (HTTP tests only) */
  shape?: string[];
  /**
   * SQL diff mode: 'strict' (default) or 'relaxed'.
   * strict:  any schema or data difference fails the test.
   * relaxed: extra columns in actual results are ignored; only columns present
   *          in the baseline are compared. Row count and value changes still fail.
   * HTTP tests ignore this field.
   */
  diff_mode?: 'strict' | 'relaxed';
}

// TestDefinition gains optional type + sql fields.
// Existing fields are untouched — backward compatible.
export interface TestDefinition {
  name: string;
  description?: string;
  /** Test type: 'http' (default) or 'sql'. Existing YAML files omit this field. */
  type?: 'http' | 'sql';
  collection?: string;
  tags?: string[];
  dependsOn?: string[];
  env?: EnvVars;
  /** TypeScript source — runs before curl (HTTP) or before all params (SQL) */
  pre?: string;
  request: RequestDef;       // required for HTTP, ignored for SQL
  response?: ResponseDef;
  /** TypeScript source — runs after assertions (HTTP) or after all params (SQL) */
  post?: string;
  /** SQL test configuration. Used when type is 'sql'. */
  sql?: SqlTestConfig;
}
```

---

## 5. Parameter File Format

### 5.1 Structure

```yaml
# params/spSomeBusinessLogic-params.yaml
# An array of parameter sets. Each item becomes one proc call.
parameters:
  - branch: "001"
    customerid: 12345
    invoiceFilter: "active"

  - branch: "001"
    customerid: 12346
    # invoiceFilter omitted — passed as NULL to the proc

  - branch: "002"
    customerid: 99999
    invoiceFilter: "overdue"

  - branch: "003"
    customerid: 11111
    invoiceFilter: null    # explicit null

  # ... up to N parameter sets
```

### 5.2 Rules

- Each array element is one execution of the proc
- Keys map to proc parameter names
- Missing keys → `NULL` passed to the proc
- Explicit `null` → `NULL` passed to the proc
- Values are typed as-is from YAML (strings, numbers, booleans, null)
- `${VAR}` interpolation from env is supported in string values
- v1 uses YAML type inference — no explicit type annotations needed

### 5.3 File location

Parameter files live relative to the test YAML file (like fixture files):
```
tests/collections/db-procedures/
  _collection.yaml
  test-spSomeBusinessLogic.yaml     # references ./params/spSomeBusinessLogic-params.yaml
  test-spOtherProc.yaml
  params/
    spSomeBusinessLogic-params.yaml
    spOtherProc-params.yaml
```

Or in a shared directory:
```yaml
sql:
  parameters:
    file: ../../shared-params/business-logic-params.yaml
```

---

## 6. Pluggable Driver Architecture

### 6.1 Design Principle

Each SQL driver implements a common interface. The runner resolves the driver from the connection config's `driver` field. v1 ships with the `mssql` driver only, but the interface is designed so `postgres` and `sqlite` drivers can be added without touching the runner or snapshot code.

### 6.2 Driver Interface (`src/sql-driver.ts`)

```typescript
import type { SqlConnectionConfig } from './types.js';

/**
 * A single result set returned by a stored procedure.
 */
export interface SqlResultSet {
  /** Column names in order */
  columns: string[];
  /** Row data — each row is column name → value */
  rows: Record<string, unknown>[];
}

/**
 * Result of executing a stored procedure with one parameter set.
 */
export interface SqlExecResult {
  /** Which parameter set produced this result (set by caller) */
  paramIndex: number;
  /** The parameter values used for this execution */
  params: Record<string, unknown>;
  /** Result sets returned by the proc (most procs return 0–1) */
  resultSets: SqlResultSet[];
  /** Proc return value (OUTPUT params not supported in v1) */
  returnValue?: number | null;
  /** Rows affected per statement */
  rowsAffected: number[];
  /** Execution duration in ms */
  durationMs: number;
  /** Error if execution failed */
  error?: string;
}

/**
 * Interface that all SQL drivers must implement.
 * v1: MssqlDriver
 * Future: PostgresDriver, SqliteDriver
 */
export interface SqlDriver {
  /** Driver name for logging/debugging */
  readonly name: string;

  /**
   * Execute a stored procedure with the given parameters.
   * Opens a connection, executes, captures results, closes connection.
   * Called once per parameter set (or batched — see executeBatch).
   */
  executeProc(
    connection: SqlConnectionConfig,
    proc: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<SqlExecResult>;

  /**
   * Execute a proc across N parameter sets using a shared connection pool.
   * v1 implementation: open one pool, loop over param sets, close pool.
   * Each result's paramIndex is set to its position in the array.
   */
  executeBatch(
    connection: SqlConnectionConfig,
    proc: string,
    paramSets: Record<string, unknown>[],
    timeout: number,
  ): Promise<SqlExecResult[]>;

  /** Health check: verify driver dependencies are available */
  checkDependencies(): Promise<{ name: string; found: boolean; optional: boolean }[]>;
}

/**
 * Driver registry — maps driver type strings to driver implementations.
 * New drivers register themselves here at import time.
 */
export class SqlDriverRegistry {
  private static drivers = new Map<string, SqlDriver>();

  static register(driverType: string, driver: SqlDriver): void {
    SqlDriverRegistry.drivers.set(driverType, driver);
  }

  static get(driverType: string): SqlDriver {
    const driver = SqlDriverRegistry.drivers.get(driverType);
    if (!driver) {
      throw new Error(
        `Unknown SQL driver "${driverType}". ` +
        `Available: ${[...SqlDriverRegistry.drivers.keys()].join(', ')}. ` +
        `Make sure the driver package is installed.`
      );
    }
    return driver;
  }

  static available(): string[] {
    return [...SqlDriverRegistry.drivers.keys()];
  }
}
```

### 6.3 v1 Driver: MSSQL (`src/drivers/mssql-driver.ts`)

Uses the `mssql` npm package (backed by `tedious`). Pure JavaScript, no native dependencies.

```typescript
import sql from 'mssql';
import type { SqlDriver, SqlExecResult, SqlResultSet } from '../sql-driver.js';
import type { SqlConnectionConfig } from '../types.js';

export class MssqlDriver implements SqlDriver {
  readonly name = 'mssql';

  async executeProc(
    connection: SqlConnectionConfig,
    proc: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<SqlExecResult> {
    return this.executeBatch(connection, proc, [params], timeout).then(r => r[0]);
  }

  async executeBatch(
    connection: SqlConnectionConfig,
    proc: string,
    paramSets: Record<string, unknown>[],
    timeout: number,
  ): Promise<SqlExecResult[]> {
    const pool = new sql.ConnectionPool({
      connectionString: connection.connectionString,
      connectionTimeout: timeout * 1000,
      requestTimeout: timeout * 1000,
    });

    await pool.connect();
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const result = await this.executeWithPool(pool, proc, paramSets[i], timeout);
        result.paramIndex = i;
        results.push(result);
      }
    } finally {
      await pool.close();
    }

    return results;
  }

  private async executeWithPool(
    pool: sql.ConnectionPool,
    proc: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<SqlExecResult> {
    const request = new sql.Request(pool);
    request.timeout = timeout * 1000;

    // Bind parameters with type inference
    for (const [name, value] of Object.entries(params)) {
      if (value === null || value === undefined) {
        request.input(name, sql.Null, null);
      } else if (typeof value === 'number' && Number.isInteger(value)) {
        request.input(name, sql.Int, value);
      } else if (typeof value === 'number') {
        request.input(name, sql.Decimal(18, 4), value);
      } else if (typeof value === 'boolean') {
        request.input(name, sql.Bit, value);
      } else {
        request.input(name, sql.NVarChar, String(value));
      }
    }

    const startTime = Date.now();
    try {
      const result = await request.execute(proc);
      const durationMs = Date.now() - startTime;

      // Collect all result sets
      const resultSets: SqlResultSet[] = [];
      if (result.recordsets && result.recordsets.length > 0) {
        for (const rs of result.recordsets) {
          const columns = rs.columns ? Object.keys(rs.columns) : [];
          const rows = rs.map((row: any) => {
            const obj: Record<string, unknown> = {};
            for (const col of columns) {
              obj[col] = row[col];
            }
            return obj;
          });
          resultSets.push({ columns, rows });
        }
      }

      return {
        paramIndex: -1,  // set by executeBatch
        params,
        resultSets,
        returnValue: result.returnValue ?? null,
        rowsAffected: result.rowsAffected ?? [],
        durationMs,
      };
    } catch (err) {
      return {
        paramIndex: -1,
        params,
        resultSets: [],
        returnValue: null,
        rowsAffected: [],
        durationMs: Date.now() - startTime,
        error: String(err),
      };
    }
  }

  async checkDependencies(): Promise<{ name: string; found: boolean; optional: boolean }[]> {
    try {
      require.resolve('mssql');
      return [{ name: 'mssql', found: true, optional: false }];
    } catch {
      return [{ name: 'mssql', found: false, optional: false }];
    }
  }
}

// Auto-register on import
import { SqlDriverRegistry } from '../sql-driver.js';
SqlDriverRegistry.register('mssql', new MssqlDriver());
```

### 6.4 Future Driver: PostgreSQL (`src/drivers/postgres-driver.ts`)

```typescript
// Future — not implemented in v1, but interface is ready
import { Pool } from 'pg';
import type { SqlDriver, SqlExecResult, SqlResultSet } from '../sql-driver.js';
import type { SqlConnectionConfig } from '../types.js';

export class PostgresDriver implements SqlDriver {
  readonly name = 'postgres';

  async executeBatch(
    connection: SqlConnectionConfig,
    proc: string,
    paramSets: Record<string, unknown>[],
    timeout: number,
  ): Promise<SqlExecResult[]> {
    const pool = new Pool({ connectionString: connection.connectionString });
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const params = paramSets[i];
        // Build parameterized CALL: CALL procName($1, $2, ...)
        const paramKeys = Object.keys(params);
        const placeholders = paramKeys.map((_, idx) => `$${idx + 1}`).join(', ');
        const callSql = `CALL ${proc}(${placeholders})`;
        const values = paramKeys.map(k => params[k] ?? null);

        const startTime = Date.now();
        try {
          const result = await pool.query(callSql, values);
          const durationMs = Date.now() - startTime;

          // PostgreSQL can return multiple result sets via REFCURSOR
          // For simple CALLs, result.rows is the single result set
          const columns = result.fields ? result.fields.map(f => f.name) : [];
          const rows = result.rows ?? [];

          results.push({
            paramIndex: i,
            params,
            resultSets: [{ columns, rows }],
            returnValue: null,
            rowsAffected: [result.rowCount ?? 0],
            durationMs,
          });
        } catch (err) {
          results.push({
            paramIndex: i,
            params,
            resultSets: [],
            returnValue: null,
            rowsAffected: [],
            durationMs: Date.now() - startTime,
            error: String(err),
          });
        }
      }
    } finally {
      await pool.end();
    }

    return results;
  }

  // ... executeProc, checkDependencies similar
}
```

### 6.5 Future Driver: SQLite (`src/drivers/sqlite-driver.ts`)

```typescript
// Future — not implemented in v1, but interface is ready
// SQLite is useful for local/offline testing and CI pipelines
import Database from 'better-sqlite3';
import type { SqlDriver, SqlExecResult } from '../sql-driver.js';

export class SqliteDriver implements SqlDriver {
  readonly name = 'sqlite';

  async executeBatch(
    connection: SqlConnectionConfig,
    proc: string,
    paramSets: Record<string, unknown>[],
    timeout: number,
  ): Promise<SqlExecResult[]> {
    // SQLite connection string is a file path
    const db = new Database(connection.connectionString);
    db.pragma('busy_timeout=' + (timeout * 1000));
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const params = paramSets[i];
        const paramKeys = Object.keys(params);
        const placeholders = paramKeys.map(() => '?').join(', ');
        const callSql = `SELECT * FROM ${proc}(${placeholders})`;
        const values = paramKeys.map(k => params[k] ?? null);

        const startTime = Date.now();
        try {
          const stmt = db.prepare(callSql);
          const rows = stmt.all(...values);
          const columns = stmt.columns().map(c => c.name);
          const durationMs = Date.now() - startTime;

          results.push({
            paramIndex: i,
            params,
            resultSets: [{ columns, rows }],
            returnValue: null,
            rowsAffected: [rows.length],
            durationMs,
          });
        } catch (err) {
          results.push({
            paramIndex: i,
            params,
            resultSets: [],
            returnValue: null,
            rowsAffected: [],
            durationMs: Date.now() - startTime,
            error: String(err),
          });
        }
      }
    } finally {
      db.close();
    }

    return results;
  }

  // ...
}
```

### 6.6 Driver resolution at runtime

The runner resolves the driver from the connection config:

```typescript
import { SqlDriverRegistry } from './sql-driver.js';

function resolveDriver(connection: SqlConnectionConfig): SqlDriver {
  return SqlDriverRegistry.get(connection.driver);
}
```

If the driver type is registered but the npm package isn't installed (e.g., someone sets `driver: postgres` before adding `pg` to package.json), the driver's `checkDependencies()` catches it with a clear error message.

---

## 7. Result Capture & Baseline Format

### 7.1 Baseline file (always JSON)

One baseline file per SQL test, containing all N parameter set results:

```
expected/db-procedures/sql_spSomeBusinessLogic.json
```

```json
[
  {
    "paramIndex": 0,
    "params": {
      "branch": "001",
      "customerid": 12345,
      "invoiceFilter": "active"
    },
    "resultSets": [
      {
        "columns": ["invoiceId", "amount", "status"],
        "rows": [
          { "invoiceId": "INV-001", "amount": 150.00, "status": "paid" },
          { "invoiceId": "INV-002", "amount": 75.50, "status": "pending" }
        ]
      }
    ],
    "returnValue": 0,
    "rowsAffected": [2]
  },
  {
    "paramIndex": 1,
    "params": {
      "branch": "001",
      "customerid": 12346,
      "invoiceFilter": null
    },
    "resultSets": [
      {
        "columns": ["invoiceId", "amount", "status"],
        "rows": []
      }
    ],
    "returnValue": 0,
    "rowsAffected": [0]
  }
]
```

### 7.2 Baseline file naming

```
expected/{collection}/sql_{procName}.json
```

Example:
```
expected/db-procedures/sql_spSomeBusinessLogic.json
```

This avoids collision with HTTP snapshot files (`GET_api_agents.json`) since SQL baselines are prefixed with `sql_`.

### 7.3 Snapshot diff: strict vs relaxed modes

Two diff modes are supported, controlled by `response.diff_mode` in the test YAML:

#### Strict mode (default)

**Any difference in schema or data fails the test.** This includes:
- Column added or removed
- Row count change
- Any value change
- Result set count change (proc returns more/fewer result sets)

This is the production-safe default. If someone removes a field from a proc's result set, downstream code may break — strict mode catches that immediately.

#### Relaxed mode

**Extra columns in the actual results are ignored.** Only columns present in the baseline are compared. This is useful during active development when a proc is being extended with new columns that aren't yet part of the contract.

What still fails in relaxed mode:
- A baseline column is missing from actual results (column removed)
- Row count change
- Any value change for columns that ARE in the baseline

What does NOT fail in relaxed mode:
- A new column appears in actual results that wasn't in the baseline

#### Implementation

Both modes reuse the existing jq normalization pipeline:

```typescript
async function diffSqlBaseline(
  actualResults: SqlExecResult[],
  baselinePath: string,
  ignoreFields: string[],
  diffMode: 'strict' | 'relaxed',
  config: ShogunConfig,
): Promise<{ passed: boolean; diff?: string; needsBaseline?: boolean }> {
  // 1. Check baseline exists
  if (!existsSync(baselinePath)) {
    return { passed: false, needsBaseline: true };
  }

  // 2. Normalize actual and expected (strip ignore_fields via jq)
  const actualJson = JSON.stringify(actualResults);
  const expectedRaw = readFileSync(baselinePath, 'utf8');

  const normalizedActual = await normalizeJson(actualJson, ignoreFields);
  const normalizedExpected = await normalizeJson(expectedRaw, ignoreFields);

  // 3. Strict mode: direct comparison (same as HTTP snapshot diff)
  if (diffMode === 'strict') {
    if (normalizedActual === normalizedExpected) {
      return { passed: true };
    }
    const diff = await runDiff(normalizedExpected, normalizedActual);
    return { passed: false, diff };
  }

  // 4. Relaxed mode: project both baseline and actual onto baseline columns
  // For each result set, keep only columns that exist in the baseline.
  const expectedParsed = JSON.parse(normalizedExpected);
  const actualParsed = JSON.parse(normalizedActual);

  const projectedActual = projectOntoBaselineColumns(actualParsed, expectedParsed);
  const projectedActualJson = JSON.stringify(projectedActual);

  // Re-normalize the projected actual (sort keys for stable comparison)
  const reNormalizedActual = await normalizeJson(projectedActualJson, []);

  if (reNormalizedActual === normalizedExpected) {
    return { passed: true };
  }
  const diff = await runDiff(normalizedExpected, reNormalizedActual);
  return { passed: false, diff };
}

/**
 * For each param set's result sets, keep only the columns present in the
 * corresponding baseline result set. Extra columns in actual are dropped.
 */
function projectOntoBaselineColumns(
  actual: SqlExecResult[],
  baseline: SqlExecResult[],
): SqlExecResult[] {
  return actual.map((actResult, i) => {
    const baseResult = baseline[i];
    if (!baseResult) return actResult;  // no baseline for this index — keep as-is

    return {
      ...actResult,
      resultSets: actResult.resultSets.map((rs, rsIdx) => {
        const baseRs = baseResult.resultSets[rsIdx];
        if (!baseRs) return rs;

        const baseColumns = new Set(baseRs.columns);
        return {
          columns: rs.columns.filter(c => baseColumns.has(c)),
          rows: rs.rows.map(row => {
            const projected: Record<string, unknown> = {};
            for (const col of rs.columns) {
              if (baseColumns.has(col)) {
                projected[col] = row[col];
              }
            }
            return projected;
          }),
        };
      }),
    };
  });
}
```

### 7.4 CSV output (optional artifacts)

When `outputFormat: csv` or `both`, shogun also writes CSV files to the run directory:

```
runs/2026-08-08_20-00-00/
  db-procedures--sql_spSomeBusinessLogic.json     # full result (always)
  db-procedures--sql_spSomeBusinessLogic_0.csv     # param set 0, result set 0
  db-procedures--sql_spSomeBusinessLogic_1.csv     # param set 1, result set 0
```

CSV files are convenience artifacts for human inspection / Excel. They are **not** used for baseline comparison — JSON is the canonical diff format.

---

## 8. Runner Integration

### 8.1 Detection & routing

In `runner.ts`, after loading a test definition, check `type`. The key principle: **if `type` is absent or `'http'`, the existing code path runs unchanged.**

```typescript
async function runSingleTest(test: TestDefinition, file: string, opts: SingleTestOpts): Promise<TestResult> {
  const testType = test.type ?? 'http';

  if (testType === 'sql' && test.sql) {
    return runSqlTest(test, file, opts);
  }

  // Existing HTTP path — unchanged, not refactored
  return runHttpTest(test, file, opts);
}
```

The existing `runSingleTest` function body becomes `runHttpTest` — same code, just renamed. No behavior change.

### 8.2 SQL test execution flow

One test result per SQL test (not per parameter set). The test passes or fails as a whole. Individual parameter set results are shown in the reporter output but don't create separate entries in `summary.json`.

```typescript
async function runSqlTest(test: TestDefinition, file: string, opts: SingleTestOpts): Promise<TestResult> {
  const startMs = Date.now();
  const scriptOutput: string[] = [];

  // 1. Resolve connection config
  const connConfig = resolveSqlConnection(test.sql!.connection, opts.config, opts.env);
  if (!connConfig) {
    return makeFailedResult(test.name, file, startMs, {},
      `Connection "${test.sql!.connection}" not found in config.connections`, scriptOutput);
  }

  // 2. Resolve driver
  let driver: SqlDriver;
  try {
    driver = SqlDriverRegistry.get(connConfig.driver);
  } catch (err) {
    return makeFailedResult(test.name, file, startMs, {},
      `Driver error: ${err}`, scriptOutput);
  }

  // 3. Load parameter sets
  const paramSets = loadParameters(test.sql!.parameters, file, opts.env);
  if (paramSets.length === 0) {
    return makeFailedResult(test.name, file, startMs, {},
      `No parameter sets found`, scriptOutput);
  }

  // 4. Run pre-script (optional — has ctx.sql with paramCount, params, proc, connection)
  if (test.sql!.pre) {
    const preResult = await runScript(test.sql!.pre, {
      env: opts.env,
      vars: opts.vars,
      request: makeDummyRequest(opts.baseUrl),  // ctx.request is dummy for SQL tests
      scriptsDir: opts.scriptsDir,
      sqlContext: { paramCount: paramSets.length, params: paramSets, proc: test.sql!.proc, connection: test.sql!.connection },
      defaultContentType: opts.config.defaults?.content_type,
    });
    scriptOutput.push(...preResult.logs);
    if (!preResult.passed) {
      return makeFailedResult(test.name, file, startMs, {}, `Pre-script failed: ${preResult.error}`, scriptOutput);
    }
    applyVarMutations(opts.vars, preResult.varMutations);
  }

  // 5. Execute proc for each parameter set
  const timeout = test.sql!.timeout ?? connConfig.timeout ?? opts.config.defaults?.timeout ?? 30;
  const results = await driver.executeBatch(connConfig, test.sql!.proc, paramSets, timeout);

  // 6. Check for execution errors
  const execErrors = results.filter(r => r.error);
  if (execErrors.length > 0) {
    return makeFailedResult(test.name, file, startMs, {},
      `${execErrors.length} of ${results.length} parameter sets failed to execute: ${execErrors[0].error}`, scriptOutput);
  }

  // 7. Snapshot capture/diff
  const baselinePath = getSqlBaselinePath(test, opts.config, opts.collectionName);
  const ignoreFields = [
    ...(opts.config.ignore_fields_global ?? []),
    ...(test.response?.ignore_fields ?? []),
  ];
  const diffMode = test.response?.diff_mode ?? 'strict';

  if (opts.snapshotMode) {
    await writeSqlBaseline(results, baselinePath, ignoreFields);
    return {
      name: test.name, file, status: 'passed',
      durationMs: Date.now() - startMs,
      assertions: { snapshot: true },
      scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    };
  }

  const snapshotResult = await diffSqlBaseline(results, baselinePath, ignoreFields, diffMode, opts.config);
  if (snapshotResult.needsBaseline) {
    return {
      name: test.name, file, status: 'needs_baseline',
      durationMs: Date.now() - startMs,
      assertions: {},
      scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    };
  }

  // 8. Write CSV artifacts (if requested)
  if (test.sql!.outputFormat === 'csv' || test.sql!.outputFormat === 'both') {
    writeCsvArtifacts(results, test, opts.logger, opts.collectionName);
  }

  // 9. Run post-script (optional — has ctx.sql with results)
  if (test.sql!.post) {
    const postResult = await runScript(test.sql!.post, {
      env: opts.env,
      vars: opts.vars,
      request: makeDummyRequest(opts.baseUrl),
      scriptsDir: opts.scriptsDir,
      sqlContext: { paramCount: paramSets.length, params: paramSets, proc: test.sql!.proc, connection: test.sql!.connection, results },
      defaultContentType: opts.config.defaults?.content_type,
    });
    scriptOutput.push(...postResult.logs);
    applyVarMutations(opts.vars, postResult.varMutations);
  }

  // 10. Return result — one TestResult per SQL test
  return {
    name: test.name,
    file,
    status: snapshotResult.passed ? 'passed' : 'failed',
    durationMs: Date.now() - startMs,
    assertions: {
      snapshot: snapshotResult.passed,
      snapshotDiff: snapshotResult.diff ?? null,
    },
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    // On failure, attach SQL exec summary for diagnostics
    ...(snapshotResult.passed ? {} : {
      sqlExecSummary: {
        totalParams: results.length,
        executed: results.length,
        errors: execErrors.length,
        totalRows: results.reduce((sum, r) =>
          sum + r.resultSets.reduce((s, rs) => s + rs.rows.length, 0), 0),
      },
    }),
  };
}
```

### 8.3 ShogunContext additions for SQL tests

The pre/post scripts for SQL tests get a `ctx.sql` object:

```typescript
export interface SqlScriptContext {
  /** Number of parameter sets to be executed (available in pre-script) */
  paramCount: number;
  /** The parameter sets themselves (available in pre-script) */
  params: Record<string, unknown>[];
  /** Results after execution (available in post-script only, undefined in pre) */
  results?: SqlExecResult[];
  /** The proc name */
  proc: string;
  /** The connection name */
  connection: string;
}

export interface ShogunContext {
  // ... existing fields unchanged ...
  /** SQL test context — only populated for type: sql tests */
  sql?: SqlScriptContext;
}
```

---

## 9. CLI Integration

### 9.1 No new commands needed

SQL tests run through the same commands. This is critical for backward compatibility — existing CI pipelines, scripts, and muscle memory all work unchanged:

```bash
# Run all tests (mix of HTTP and SQL)
shogun run --env QA

# Run only the SQL test collection
shogun run --env QA --collection db-procedures

# Capture baselines for SQL tests
shogun snapshot --env QA --collection db-procedures

# Run a single SQL test file
shogun run --file tests/collections/db-procedures/test-spSomeBusinessLogic.yaml

# Lint SQL test YAML (validates structure, connection refs, param files)
shogun lint --collection db-procedures
```

### 9.2 Optional: type filter

```bash
# Run only SQL tests across all collections
shogun run --env QA --type sql

# Run only HTTP tests
shogun run --env QA --type http
```

This is a convenience flag. The runner skips tests that don't match the type filter. Omitting `--type` runs everything (default, backward compatible).

### 9.3 Reporter output

SQL tests show per-parameter-set details in the reporter, but produce one pass/fail result in the summary:

```
┌ Collection: db-procedures ─────────────────────────────────┐

  ▸ spSomeBusinessLogic (sql, 10 params)
    ✓ param  0: 2 rows returned                    142ms
    ✓ param  1: 0 rows returned                     89ms
    ✓ param  2: 5 rows returned                    203ms
    ...
    ✓ param  9: 1 row  returned                    101ms
    ✓ snapshot: match

  ▸ spOtherProc (sql, 3 params)
    ✓ param  0: 1 row  returned                     45ms
    ✗ param  1: execution error: timeout exceeded 30001ms
    ✓ param  2: 0 rows returned                     33ms
    ✗ snapshot: SKIPPED (execution error)

└──────────────────────────────────────────────────────────┘

  Total: 2    Passed: 1    Failed: 1    Baselines needed: 0
  Duration: 1.4s
```

---

## 10. File Layout (Test Repo)

```
my-test-repo/
├── shogun.config.yaml
├── envs/
│   ├── local.env           # DB_LOCAL_CONN_STRING=...
│   ├── QA.env              # DB_QA_CONN_STRING=...
│   └── staging.env         # DB_STAGING_CONN_STRING=...
├── tests/
│   ├── collections/
│   │   ├── agents/          # existing HTTP tests — unchanged
│   │   │   ├── _collection.yaml
│   │   │   └── get-agents.yaml
│   │   └── db-procedures/   # new SQL tests
│   │       ├── _collection.yaml
│   │       ├── test-spSomeBusinessLogic.yaml
│   │       ├── test-spOtherProc.yaml
│   │       └── params/
│   │           ├── spSomeBusinessLogic-params.yaml
│   │           └── spOtherProc-params.yaml
│   └── suites/
│       ├── smoke.yaml        # can mix HTTP + SQL collections
│       └── db-only.yaml
├── expected/
│   ├── agents/               # HTTP baselines — unchanged
│   │   └── GET_api_agents.json
│   └── db-procedures/        # SQL baselines
│       ├── sql_spSomeBusinessLogic.json
│       └── sql_spOtherProc.json
├── scripts/
│   ├── auth.ts
│   └── db-helpers.ts         # optional shared SQL helpers
└── runs/
    └── 2026-08-08_20-00-00/
        ├── summary.json
        ├── agents--GET_api_agents.log
        ├── db-procedures--sql_spSomeBusinessLogic.log
        ├── db-procedures--sql_spSomeBusinessLogic.json     # full results
        ├── db-procedures--sql_spSomeBusinessLogic_0.csv     # param 0 CSV
        └── db-procedures--sql_spSomeBusinessLogic_1.csv     # param 1 CSV
```

---

## 11. Collection Integration

### 11.1 Mixed collections

A collection can contain both HTTP and SQL tests. The `_collection.yaml` setup/teardown runs once, and each test routes based on its `type` field.

```yaml
# tests/collections/mixed/_collection.yaml
name: Mixed API + DB Tests
order:
  - get-customers          # HTTP test
  - test-spGetCustomerSummary  # SQL test
  - verify-summary          # HTTP test (reads what the proc wrote)

setup: |
  ctx.vars.testCustomerId = 12345;
```

### 11.2 SQL-only collection

```yaml
# tests/collections/db-procedures/_collection.yaml
name: Database Procedure Tests
description: Validates stored procedures against expected baselines
order:
  - test-spSomeBusinessLogic
  - test-spOtherProc
tags:
  - sql
  - db

setup: |
  ctx.log(`Starting SQL procedure tests`);
  # Could set up test data via ctx.http (API call to seed data)
```

### 11.3 Suite mixing

```yaml
# tests/suites/full-regression.yaml
name: Full Regression
collections:
  - agents           # HTTP
  - system           # HTTP
  - db-procedures    # SQL
tags:
  - smoke
  - sql
```

---

## 12. Backward Compatibility

### 12.1 What changes for existing repos

**Nothing.** This is the core constraint.

| Component | Change | Impact on existing repos |
|-----------|--------|--------------------------|
| `shogun.config.yaml` | New optional `connections:` block | None — absent = no SQL tests |
| Test YAML | New optional `type` field | None — absent = `'http'` (existing behavior) |
| Test YAML | New optional `sql:` block | None — absent = HTTP test |
| `ResponseDef` | New optional `diff_mode` field | None — absent = `'strict'` (unused for HTTP) |
| `ShogunConfig` type | New optional `connections` field | None — optional, not accessed by HTTP path |
| `TestDefinition` type | New optional `type`, `sql` fields | None — optional, ignored by HTTP path |
| `runner.ts` | Type check at top of `runSingleTest` | None — defaults to existing HTTP path |
| CLI | New optional `--type` flag | None — absent = run all types |
| Dependencies | `mssql` added to package.json | None — lazy-loaded, only when SQL tests run |

### 12.2 What does NOT change

- All existing HTTP test YAML files work without modification
- All existing `shogun.config.yaml` files work without modification
- All existing CLI commands work without modification
- All existing env files work without modification
- All existing snapshots, run logs, and summaries are unaffected
- The `request` field on `TestDefinition` remains required for HTTP tests

### 12.3 Zod validation approach

The loader's Zod schema is extended, not replaced. The `type` field is optional with a default. The `sql` block is optional. The `request` field becomes conditionally required:

```typescript
// In loader.ts — extended schema
const TestDefinitionSchema = z.object({
  name: z.string().min(1, 'name is required'),
  type: z.enum(['http', 'sql']).optional(),   // NEW — defaults to 'http'
  description: z.string().optional(),
  collection: z.string().optional(),
  tags: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  pre: z.string().optional(),
  request: RequestDefSchema.optional(),       // CHANGED — now optional (required for http)
  response: ResponseDefSchema.optional(),
  post: z.string().optional(),
  sql: SqlTestConfigSchema.optional(),        // NEW
}).refine(
  // request is required when type is 'http' or undefined
  (data) => data.type !== 'sql' && data.request !== undefined || data.type === 'sql',
  { message: 'request is required for HTTP tests' }
);
```

---

## 13. Implementation Plan

### Phase 1: Driver abstraction + MSSQL driver (v1 deliverable)

| Step | Description | Files | Status |
|------|-------------|-------|--------|
| 1 | Add `mssql` dependency to package.json | `package.json` | |
| 2 | Add SQL types to `types.ts` — `SqlConnectionConfig`, `SqlTestConfig`, `diff_mode` | `src/types.ts` | |
| 3 | Create driver interface + registry | `src/sql-driver.ts` (new) | |
| 4 | Implement MSSQL driver | `src/drivers/mssql-driver.ts` (new) | |
| 5 | Create SQL snapshot module (write/diff with strict + relaxed) | `src/sql-snapshot.ts` (new) | |
| 6 | Add connection config parsing to `loader.ts` + Zod schemas | `src/loader.ts` | |
| 7 | Add parameter file loader (inline + file) | `src/sql-executor.ts` (new) or `src/loader.ts` | |
| 8 | Add SQL test routing to `runner.ts` — extract `runHttpTest`, add `runSqlTest` | `src/runner.ts` | |
| 9 | Update reporter for SQL test output (per-param lines) | `src/reporter.ts` | |
| 10 | Update lint command for SQL tests | `src/commands/lint.ts` | |
| 11 | Add CSV export | `src/sql-snapshot.ts` | |
| 12 | Write unit tests | `src/tests/sql-*.test.ts` (new) | |

### Phase 2: Enhancements (post-v1)

| Feature | Description |
|---------|-------------|
| `--type sql` CLI filter | Filter to only SQL or HTTP tests |
| `ctx.sql` in scripts | Full script context for SQL tests |
| Connection pool reuse across tests | Configurable pool scope (per-test, per-collection, per-run) |
| Explicit parameter type annotations | Optional `_types` block in parameter files |
| OUTPUT parameter capture | Capture proc OUTPUT parameters in results |
| Per-param pre/post hooks | Optional per-parameter-set scripts |
| Row count comparison mode | Compare shape + count only, not every row (for large result sets) |

### Phase 3: Additional drivers

| Driver | Package | Notes |
|--------|---------|-------|
| PostgreSQL | `pg` | `CALL procName($1, $2, ...)` syntax, REFCURSOR for multiple result sets |
| SQLite | `better-sqlite3` | Local/offline testing, CI pipelines — `SELECT * FROM procName(?, ?)` |
| MySQL | `mysql2` | Future consideration |

Each driver is a new file in `src/drivers/` that implements the `SqlDriver` interface and registers itself. No changes to runner, snapshot, or types needed — just the driver file + package.json dependency.

---

## 14. Edge Cases & Considerations

### 14.1 Empty result sets

A proc that returns 0 rows is a valid result. The baseline captures `rows: []` and the diff matches on emptiness.

### 14.2 Multiple result sets

Procs can return multiple result sets. Each is captured as a separate entry in `resultSets[]`. The baseline diff compares all result sets.

### 14.3 Proc errors

If a proc throws (e.g., timeout, permission denied), the execution result has `error` set. This fails the test immediately — no snapshot diff occurs. The error message is included in the test result.

### 14.4 Non-deterministic columns

Some procs return columns like `executionTime`, `rowNumber`, or computed columns with volatile values. These are stripped via `ignore_fields` before snapshot diff, same as HTTP tests.

### 14.5 Parameter type mapping (v1: inference)

YAML values are mapped to SQL types via inference:
- `string` → `NVARCHAR`
- `number` (integer) → `INT`
- `number` (decimal) → `DECIMAL(18, 4)`
- `boolean` → `BIT`
- `null` / missing → `NULL`

Future versions may add explicit type annotations if inference proves insufficient.

### 14.6 Security

- Connection strings are in env files (gitignored), never in committed config
- The `${VAR}` interpolation in `shogun.config.yaml` resolves from env at load time
- Connection strings are redacted in run logs (show only server + database, not credentials)
- SQL injection is mitigated by using parameterized queries (driver handles escaping)

### 14.7 Connection failures

If the database is unreachable, the test fails fast with a clear error. The connection timeout is configurable per-connection and per-test.

### 14.8 Large result sets

For procs that return very large result sets, the baseline file could be large. Options:
- `ignore_fields` to strip volatile/large columns
- Future: row count comparison mode (Phase 2)
- Future: sampled comparison (compare first N rows + count)

### 14.9 Driver not installed

If a config references `driver: postgres` but `pg` is not in package.json, the driver registry throws a clear error at test execution time (not at config load time — we don't want to fail HTTP-only repos that happen to have a postgres connection defined but unused).

---

## 15. Decisions Summary

All open questions from v0.1 have been resolved:

| Question | Decision | Rationale |
|----------|----------|-----------|
| Driver choice | Pluggable interface, `mssql` for v1 | Need to support postgres + sqlite next; interface designed from day 1 |
| Parameter typing | YAML type inference | Keep it simple for v1; add explicit annotations later if needed |
| OUTPUT parameters | Result sets only for v1 | Covers the common case; OUTPUT params are less common |
| Per-param vs per-test result | One test result per SQL test | Simplest, least risk to existing repos, clean summary |
| Connection pool scope | Per-test for v1 | Simplest; designed for future configurability (per-collection, per-run) |
| Diff mode | Strict (default) + relaxed | Production needs strict (schema adds/removes should fail); relaxed for active dev |
| Backward compatibility | `type` defaults to `'http'` | Several repos in production; zero changes to existing YAML/config |

---

## 16. Example: Complete Test Repo Walkthrough

### Scenario

Test `spSomeBusinessLogic` which takes `@branch`, `@customerid`, and optional `@invoiceFilter`. We have 10 test cases.

### Step 1: Config

```yaml
# shogun.config.yaml
version: 1
defaults:
  env: local
  timeout: 30
paths:
  tests: ./tests
  envs: ./envs
  expected: ./expected
  runs: ./runs
  scripts: ./scripts
connections:
  qa-db:
    driver: mssql
    connectionString: ${DB_QA_CONN_STRING}
```

### Step 2: Env file

```bash
# envs/QA.env
BASE_URL=https://qa-api.myapp.com
DB_QA_CONN_STRING=Server=qa-sql01;Database=MyApp;User Id=shogun_test;Password=***;TrustServerCertificate=True;Encrypt=True
```

### Step 3: Parameter file

```yaml
# tests/collections/db-procedures/params/spSomeBusinessLogic-params.yaml
parameters:
  - branch: "001"
    customerid: 10001
    invoiceFilter: "active"
  - branch: "001"
    customerid: 10002
    invoiceFilter: "active"
  - branch: "001"
    customerid: 10003
  - branch: "002"
    customerid: 20001
    invoiceFilter: "overdue"
  - branch: "002"
    customerid: 20002
    invoiceFilter: "overdue"
  - branch: "002"
    customerid: 20003
    invoiceFilter: "active"
  - branch: "003"
    customerid: 30001
    invoiceFilter: "all"
  - branch: "003"
    customerid: 30002
  - branch: "003"
    customerid: 30003
    invoiceFilter: "active"
  - branch: "001"
    customerid: 10004
    invoiceFilter: "cancelled"
```

### Step 4: Test definition

```yaml
# tests/collections/db-procedures/test-spSomeBusinessLogic.yaml
name: Test spSomeBusinessLogic
description: >
  Validates spSomeBusinessLogic returns expected invoice data across
  10 branch/customer/filter combinations.
type: sql
collection: db-procedures
tags:
  - sql
  - business-logic

sql:
  connection: qa-db
  proc: spSomeBusinessLogic
  parameters:
    file: ./params/spSomeBusinessLogic-params.yaml
  outputFormat: both
  timeout: 30

response:
  snapshot: true
  diff_mode: strict
  ignore_fields:
    - "**.executionTime"
    - "**.rowNumber"
```

### Step 5: Collection

```yaml
# tests/collections/db-procedures/_collection.yaml
name: Database Procedure Tests
order:
  - test-spSomeBusinessLogic
tags:
  - sql
  - db
```

### Step 6: Capture baseline

```bash
shogun snapshot --env QA --collection db-procedures
```

Output:
```
  ✓ spSomeBusinessLogic: baseline captured (10 params, 47 total rows)
  → expected/db-procedures/sql_spSomeBusinessLogic.json
```

### Step 7: Run tests

```bash
shogun run --env QA --collection db-procedures
```

Output:
```
┌ Collection: db-procedures ─────────────────────────────────┐

  ▸ spSomeBusinessLogic (sql, 10 params)
    ✓ param  0: 5 rows   142ms
    ✓ param  1: 3 rows    89ms
    ✓ param  2: 0 rows    45ms
    ✓ param  3: 8 rows   203ms
    ✓ param  4: 2 rows    67ms
    ✓ param  5: 12 rows  310ms
    ✓ param  6: 7 rows   156ms
    ✓ param  7: 0 rows    34ms
    ✓ param  8: 4 rows   112ms
    ✓ param  9: 6 rows   178ms
    ✓ snapshot: match

└──────────────────────────────────────────────────────────┘

  Total: 1    Passed: 1    Failed: 0    Baselines needed: 0
  Duration: 1.4s
```

### Step 8: Future run with a change detected (strict mode)

```
  ▸ spSomeBusinessLogic (sql, 10 params)
    ✓ param  0: 5 rows   142ms
    ✓ param  1: 3 rows    89ms
    ✗ param  2: 1 row     45ms    ← was 0 rows
    ✓ param  3: 8 rows   203ms
    ...
    ✗ snapshot: MISMATCH (1 param set differs)

  --- expected (param 2)
  +++ actual (param 2)
    "params": { "branch": "001", "customerid": 10003, "invoiceFilter": null },
    "resultSets": [
      {
        "columns": ["invoiceId", "amount", "status"],
  -     "rows": []
  +     "rows": [
  +       { "invoiceId": "INV-999", "amount": 500.00, "status": "pending" }
  +     ]
      }
    ]
```

### Step 9: Future run with schema change detected (strict mode)

```
  ▸ spSomeBusinessLogic (sql, 10 params)
    ✓ param  0: 5 rows   142ms
    ...
    ✗ snapshot: MISMATCH — schema change detected

  --- expected (param 0, result set 0)
  +++ actual (param 0, result set 0)
    "columns": ["invoiceId", "amount", "status"],
  + "columns": ["invoiceId", "amount", "status", "discountAmount"],
    # New column "discountAmount" added to proc result — strict mode catches this
```

### Step 10: Same change with relaxed mode

```yaml
response:
  snapshot: true
  diff_mode: relaxed    # extra columns are OK during active development
```

```
  ▸ spSomeBusinessLogic (sql, 10 params)
    ✓ param  0: 5 rows   142ms
    ...
    ✓ snapshot: match (relaxed — 1 extra column ignored: discountAmount)
```

---

## 17. Summary

This design adds a parallel SQL test type to shogun that:

- **Reuses** the collection, snapshot, suite, logging, and reporting infrastructure
- **Adds** connection string config (env-backed for security), parameter files, and a pluggable SQL driver layer
- **Is backward compatible** — `type` defaults to `'http'`, existing repos need zero changes
- **Supports strict and relaxed diff modes** — strict catches schema changes in production, relaxed tolerates new columns during dev
- **Is extensible** — postgres and sqlite drivers can be added by implementing one interface and registering it
- **Is scoped** to stored procedures with result sets only for v1, with a clear path to enhancements

The core new components are:
1. `SqlConnectionConfig` in `shogun.config.yaml` + env files
2. `type: sql` test definition with `sql:` block
3. Parameter files (YAML arrays of parameter sets)
4. `src/sql-driver.ts` — driver interface + registry
5. `src/drivers/mssql-driver.ts` — v1 driver implementation
6. `src/sql-snapshot.ts` — baseline write/diff with strict + relaxed modes
7. Runner routing: `type === 'sql'` → SQL path, else → existing HTTP path (unchanged)
