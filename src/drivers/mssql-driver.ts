/**
 * src/drivers/mssql-driver.ts
 * v1 MSSQL driver implementation.
 *
 * Uses the `mssql` npm package (backed by `tedious`). Pure JavaScript, no
 * native dependencies. Lazy-loaded — only imported when SQL tests actually
 * run, so HTTP-only repos don't need the package installed.
 */

import type { SqlDriver, SqlExecResult, SqlResultSet, SqlDependency } from '../sql-driver.js';
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
  async getProcSource(
    connection: SqlConnectionConfig,
    proc: string,
    timeout: number,
  ): Promise<string | null> {
    const sql = await import('mssql');

    const poolConfig = sql.ConnectionPool.parseConnectionString(connection.connectionString);
    poolConfig.connectionTimeout = timeout * 1000;
    poolConfig.requestTimeout = timeout * 1000;

    const pool = new sql.ConnectionPool(poolConfig);
    await pool.connect();

    try {
      // Parse "schema.name" or bare "name" (assume dbo if no schema)
      const parts = proc.split('.');
      let schema = 'dbo';
      let name = proc;
      if (parts.length >= 2) {
        schema = parts[0]!;
        name = parts[1]!;
      }

      const request = pool.request();
      request.input('schema', sql.NVarChar, schema);
      request.input('procName', sql.NVarChar, name);
      const result = await request.query(`
        SELECT
          m.definition
        FROM sys.sql_modules m
        JOIN sys.objects o ON m.object_id = o.object_id
        JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE s.name = @schema
          AND o.name = @procName
          AND o.type IN ('P', 'PC')
      `);

      const rows = ((result.recordsets as unknown[]) ?? [result.recordset ?? []])[0] as Array<{ definition: string | null }>;
      return rows.length > 0 ? (rows[0]!.definition ?? null) : null;
    } finally {
      await pool.close();
    }
  }

  async getProcDependencies(
    connection: SqlConnectionConfig,
    proc: string,
    timeout: number,
  ): Promise<SqlDependency[]> {
    const sql = await import('mssql');

    const poolConfig = sql.ConnectionPool.parseConnectionString(connection.connectionString);
    poolConfig.connectionTimeout = timeout * 1000;
    poolConfig.requestTimeout = timeout * 1000;

    const pool = new sql.ConnectionPool(poolConfig);
    await pool.connect();

    try {
      // Parse "schema.name" or bare "name" (assume dbo if no schema)
      const parts = proc.split('.');
      let schema = 'dbo';
      let name = proc;
      if (parts.length >= 2) {
        schema = parts[0]!;
        name = parts[1]!;
      }

      const request = pool.request();
      request.input('schema', sql.NVarChar, schema);
      request.input('procName', sql.NVarChar, name);
      const result = await request.query(`
        SELECT
          CASE
            WHEN sed.referenced_database_name IS NOT NULL
              THEN sed.referenced_database_name + '.' + ISNULL(sed.referenced_schema_name, '') + '.' + sed.referenced_entity_name
            ELSE ISNULL(sed.referenced_schema_name, '') + '.' + sed.referenced_entity_name
          END AS qualified_name,
          ISNULL(sed.referenced_schema_name, '') AS ref_schema,
          sed.referenced_entity_name AS ref_name,
          sed.referenced_class_desc AS ref_type,
          sed.referenced_database_name AS ref_database,
          sed.is_schema_bound,
          CASE
            WHEN sed.referenced_class = 1 THEN 'TABLE_OR_VIEW'
            WHEN sed.referenced_class = 2 THEN 'TABLE_VALUED_FUNCTION'
            WHEN sed.referenced_class = 5 THEN 'PROCEDURE'
            WHEN sed.referenced_class = 6 THEN 'SCALAR_FUNCTION'
            WHEN sed.referenced_class = 7 THEN 'AGGREGATE_FUNCTION'
            WHEN sed.referenced_class = 12 THEN 'TYPE'
            WHEN sed.referenced_class = 15 THEN 'XML_SCHEMA_COLLECTION'
            ELSE sed.referenced_class_desc
          END AS object_type,
          sed.caller_column_name,
          sed.called_column_name,
          COALESCE(
            (SELECT TOP 1 o.type_desc
             FROM sys.objects o
             WHERE o.name = sed.referenced_entity_name
               AND o.schema_id = ISNULL(
                 (SELECT schema_id FROM sys.schemas WHERE name = sed.referenced_schema_name),
                 SCHEMA_ID('dbo')
               )
            ),
            sed.referenced_class_desc
          ) AS resolved_type
        FROM sys.sql_expression_dependencies sed
        JOIN sys.objects o ON sed.referencing_id = o.object_id
        JOIN sys.schemas s ON o.schema_id = s.schema_id
        WHERE s.name = @schema
          AND o.name = @procName
          AND o.type IN ('P', 'PC')
        ORDER BY sed.referenced_schema_name, sed.referenced_entity_name
      `);

      const rows = ((result.recordsets as unknown[]) ?? [result.recordset ?? []])[0] as Array<{
        qualified_name: string;
        ref_schema: string;
        ref_name: string;
        ref_type: string;
        ref_database: string | null;
        resolved_type: string | null;
      }>;

      const deps: SqlDependency[] = rows.map(row => ({
        schema: row.ref_schema || '',
        name: row.ref_name || '',
        qualifiedName: row.qualified_name || `${row.ref_schema}.${row.ref_name}`,
        type: (row.resolved_type ?? row.ref_type ?? 'UNKNOWN').replace(/_/g, ' '),
        referenceType: inferReferenceType(row.ref_type),
        isCrossDatabase: row.ref_database !== null,
        isUnresolved: row.resolved_type === null,
      }));

      return deps;
    } finally {
      await pool.close();
    }
  }
}

// Auto-register on import
SqlDriverRegistry.register('mssql', new MssqlDriver());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infer how a proc references an object based on the referenced_class_desc.
 * sys.sql_expression_dependencies doesn't directly store the DML type, but
 * the referenced class gives us a reasonable approximation.
 */
function inferReferenceType(refClassDesc: string): string {
  // referenced_class_desc values from sys.sql_expression_dependencies:
  //   TYPE, XML_SCHEMA_COLLECTION, TABLE_TYPE, AGGREGATE_FUNCTION,
  //   SCALAR_FUNCTION, TABLE_VALUED_FUNCTION, PROCEDURE, TABLE
  switch (refClassDesc) {
    case 'PROCEDURE':
      return 'EXECUTE';
    case 'TABLE':
      return 'SELECT';  // Could be INSERT/UPDATE/DELETE — sys.sql_expression_dependencies doesn't distinguish
    case 'TABLE_VALUED_FUNCTION':
    case 'SCALAR_FUNCTION':
    case 'AGGREGATE_FUNCTION':
      return 'CALL';
    default:
      return 'REFERENCE';
  }
}