/**
 * src/sql-driver.ts
 * SQL driver interface + registry.
 *
 * Each SQL driver implements a common interface. The runner resolves the
 * driver from the connection config's `driver` field. v1 ships with the
 * `mssql` driver only, but the interface is designed so `postgres` and
 * `sqlite` drivers can be added without touching the runner or snapshot code.
 */

import type { SqlConnectionConfig } from './types.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Driver registry
// ---------------------------------------------------------------------------

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