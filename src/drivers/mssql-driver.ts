/**
 * src/drivers/mssql-driver.ts
 * v1 MSSQL driver implementation.
 *
 * Uses the `mssql` npm package (backed by `tedious`). Pure JavaScript, no
 * native dependencies. Lazy-loaded — only imported when SQL tests actually
 * run, so HTTP-only repos don't need the package installed.
 */

import type { SqlDriver, SqlExecResult, SqlResultSet } from '../sql-driver.js';
import type { SqlConnectionConfig } from '../types.js';
import { SqlDriverRegistry } from '../sql-driver.js';

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
    // Lazy-load mssql — only needed when SQL tests actually run
    const sql = await import('mssql');

    // Parse connection string and set timeouts
    const poolConfig = sql.ConnectionPool.parseConnectionString(connection.connectionString);
    poolConfig.connectionTimeout = timeout * 1000;
    poolConfig.requestTimeout = timeout * 1000;

    const pool = new sql.ConnectionPool(poolConfig);

    await pool.connect();
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const result = await this.executeWithPool(pool, sql, proc, paramSets[i]);
        result.paramIndex = i;
        results.push(result);
      }
    } finally {
      await pool.close();
    }

    return results;
  }

  private async executeWithPool(
    pool: import('mssql').ConnectionPool,
    sql: typeof import('mssql'),
    proc: string,
    params: Record<string, unknown>,
  ): Promise<SqlExecResult> {
    const request = pool.request();

    // Bind parameters with type inference
    for (const [name, value] of Object.entries(params)) {
      if (value === null || value === undefined) {
        // Pass null without a type — mssql handles it
        request.input(name, null);
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
      const recordsets = (result.recordsets ?? []) as any[];
      if (recordsets.length > 0) {
        for (const rs of recordsets) {
          const columns = rs.columns ? Object.keys(rs.columns) : [];
          const rows: Record<string, unknown>[] = [];
          for (const row of rs) {
            const obj: Record<string, unknown> = {};
            for (const col of columns) {
              obj[col] = (row as Record<string, unknown>)[col];
            }
            rows.push(obj);
          }
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
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      require.resolve('mssql');
      return [{ name: 'mssql', found: true, optional: false }];
    } catch {
      return [{ name: 'mssql', found: false, optional: false }];
    }
  }
}

// Auto-register on import
SqlDriverRegistry.register('mssql', new MssqlDriver());