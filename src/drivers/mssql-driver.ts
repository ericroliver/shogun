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

  async executeQuery(
    connection: SqlConnectionConfig,
    query: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<SqlExecResult> {
    return this.executeQueryBatch(connection, query, [params], timeout).then(r => r[0]);
  }

  async executeQueryBatch(
    connection: SqlConnectionConfig,
    query: string,
    paramSets: Record<string, unknown>[],
    timeout: number,
  ): Promise<SqlExecResult[]> {
    const sql = await import('mssql');

    const poolConfig = sql.ConnectionPool.parseConnectionString(connection.connectionString);
    poolConfig.connectionTimeout = timeout * 1000;
    poolConfig.requestTimeout = timeout * 1000;

    const pool = new sql.ConnectionPool(poolConfig);
    await pool.connect();
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const result = await this.executeQueryWithPool(pool, sql, query, paramSets[i]);
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

      return this.collectResultSets(result, params, durationMs);
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

  private async executeQueryWithPool(
    pool: import('mssql').ConnectionPool,
    sql: typeof import('mssql'),
    query: string,
    params: Record<string, unknown>,
  ): Promise<SqlExecResult> {
    const request = pool.request();

    // Bind parameters with type inference (same as proc execution)
    for (const [name, value] of Object.entries(params)) {
      if (value === null || value === undefined) {
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
      const result = await request.query(query);
      const durationMs = Date.now() - startTime;

      return this.collectResultSets(result, params, durationMs);
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

  /**
   * Shared helper: collect result sets from a mssql result object.
   */
  private collectResultSets(
    result: any,
    params: Record<string, unknown>,
    durationMs: number,
  ): SqlExecResult {
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
      paramIndex: -1,  // set by caller (executeBatch / executeQueryBatch)
      params,
      resultSets,
      returnValue: result.returnValue ?? null,
      rowsAffected: result.rowsAffected ?? [],
      durationMs,
    };
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

  async listProcedures(
    connection: SqlConnectionConfig,
    timeout: number,
  ): Promise<import('../sql-driver.js').SqlProcMetadata[]> {
    const sql = await import('mssql');

    const poolConfig = sql.ConnectionPool.parseConnectionString(connection.connectionString);
    poolConfig.connectionTimeout = timeout * 1000;
    poolConfig.requestTimeout = timeout * 1000;

    const pool = new sql.ConnectionPool(poolConfig);
    await pool.connect();

    try {
      // Query all stored procedures with their parameters in one go
      // using sys.procedures + sys.parameters + sys.types catalog views
      const request = pool.request();
      const result = await request.query(`
        SELECT
          s.name  AS schema_name,
          p.name  AS proc_name,
          p.create_date,
          p.modify_date,
          prm.name AS param_name,
          TYPE_NAME(prm.user_type_id) AS type_name,
          prm.max_length,
          prm.precision,
          prm.scale,
          prm.is_output,
          prm.has_default_value,
          CAST(prm.default_value AS NVARCHAR(MAX)) AS default_value,
          prm.parameter_id AS ordinal
        FROM sys.procedures p
        JOIN sys.schemas s ON p.schema_id = s.schema_id
        LEFT JOIN sys.parameters prm ON prm.object_id = p.object_id
        LEFT JOIN sys.types t ON prm.user_type_id = t.user_type_id
        ORDER BY s.name, p.name, prm.parameter_id
      `);

      // Group rows into procs + their parameters
      const procMap = new Map<string, import('../sql-driver.js').SqlProcMetadata>();
      const rows = ((result.recordsets as any) ?? [result.recordset ?? []])[0] as any[];

      for (const row of rows) {
        const schema = row.schema_name as string;
        const name = row.proc_name as string;
        const qualifiedName = `${schema}.${name}`;
        const key = qualifiedName;

        if (!procMap.has(key)) {
          procMap.set(key, {
            schema,
            name,
            qualifiedName,
            parameters: [],
            createDate: row.create_date ? new Date(row.create_date).toISOString() : null,
            modifyDate: row.modify_date ? new Date(row.modify_date).toISOString() : null,
          });
        }

        // Add parameter if this proc has parameters (param_name will be null for procs with 0 params)
        if (row.param_name) {
          procMap.get(key)!.parameters.push({
            name: (row.param_name as string).replace(/^@/, ''),
            dataType: row.type_name as string,
            maxLength: row.max_length ?? null,
            precision: row.precision ?? null,
            scale: row.scale ?? null,
            isOutput: Boolean(row.is_output),
            hasDefault: Boolean(row.has_default_value),
            defaultValue: row.default_value ?? null,
            ordinal: row.ordinal as number,
          });
        }
      }

      return [...procMap.values()].sort((a, b) => {
        if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
        return a.name.localeCompare(b.name);
      });
    } finally {
      await pool.close();
    }
  }
}

// Auto-register on import
SqlDriverRegistry.register('mssql', new MssqlDriver());