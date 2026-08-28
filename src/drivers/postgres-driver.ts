/**
 * src/drivers/postgres-driver.ts
 * PostgreSQL driver implementation.
 *
 * Uses the `pg` npm package (node-postgres). Pure JavaScript, no native
 * dependencies. Lazy-loaded — only imported when SQL tests with a
 * `postgres` driver actually run.
 *
 * PostgreSQL uses functions (and procedures in PG 11+). The catalog queries
 * use pg_catalog views that are stable across PG 10+.
 */

import type {
  SqlDriver,
  SqlExecResult,
  SqlResultSet,
  SqlDependency,
  SqlProcMetadata,
  SqlParamMetadata,
} from '../sql-driver.js';
import type { SqlConnectionConfig } from '../types.js';
import { SqlDriverRegistry } from '../sql-driver.js';

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

/**
 * Parse a PostgreSQL connection string into a pg.PoolConfig.
 * The `pg` library accepts connection strings directly via `Pool({ connectionString })`,
 * so we just pass it through and apply timeout overrides.
 */
function createPoolConfig(connection: SqlConnectionConfig, timeout: number) {
  return {
    connectionString: connection.connectionString,
    connectionTimeoutMillis: timeout * 1000,
    idleTimeoutMillis: timeout * 1000,
  };
}

// ---------------------------------------------------------------------------
// Driver implementation
// ---------------------------------------------------------------------------

export class PostgresDriver implements SqlDriver {
  readonly name = 'postgres';

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
    const { Pool } = await import('pg');
    const pool = new Pool(createPoolConfig(connection, timeout));
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const result = await this.executeWithPool(pool, proc, paramSets[i]);
        result.paramIndex = i;
        results.push(result);
      }
    } finally {
      await pool.end();
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
    const { Pool } = await import('pg');
    const pool = new Pool(createPoolConfig(connection, timeout));
    const results: SqlExecResult[] = [];

    try {
      for (let i = 0; i < paramSets.length; i++) {
        const result = await this.executeQueryWithPool(pool, query, paramSets[i]);
        result.paramIndex = i;
        results.push(result);
      }
    } finally {
      await pool.end();
    }

    return results;
  }

  /**
   * Map named params ({ key: value }) to positional ($1, $2, ...) and
   * return both the values array and a function to rewrite @paramName
   * in the query to $N.
   *
   * PostgreSQL uses $1, $2 positional parameters. We auto-map named params
   * so YAML test files can use @paramName consistently with MSSQL.
   */
  private mapNamedParams(
    params: Record<string, unknown>,
  ): { values: unknown[]; paramMap: Map<string, number> } {
    const keys = Object.keys(params);
    const values: unknown[] = [];
    const paramMap = new Map<string, number>();

    for (let i = 0; i < keys.length; i++) {
      paramMap.set(keys[i], i + 1); // PostgreSQL params are 1-based
      values.push(params[keys[i]]);
    }

    return { values, paramMap };
  }

  /**
   * Rewrite @paramName placeholders in a query to $N positional syntax.
   * Handles @param at word boundaries. Does not replace @@ (escaped).
   */
  private rewriteQueryPlaceholders(query: string, paramMap: Map<string, number>): string {
    return query.replace(/@(\w+)/g, (match, name: string) => {
      const pos = paramMap.get(name);
      if (pos !== undefined) {
        return `$${pos}`;
      }
      return match; // Leave unknown @names alone (could be MSSQL-style global vars)
    });
  }

  /**
   * Execute a PostgreSQL function or procedure.
   *
   * PostgreSQL has two kinds of callable routines:
   *  - FUNCTIONS: called as `SELECT * FROM schema.fn(p1, p2)` — return values
   *  - PROCEDURES (PG 11+): called as `CALL schema.proc(p1, p2)` — may have OUT params
   *
   * We don't know which kind the user is calling, so we try CALL first,
   * and if it fails with a syntax error, we fall back to SELECT.
   *
   * Parameters are passed positionally as $1, $2, etc.
   */
  private async executeWithPool(
    pool: import('pg').Pool,
    proc: string,
    params: Record<string, unknown>,
  ): Promise<SqlExecResult> {
    const { values, paramMap } = this.mapNamedParams(params);

    // Build the call: try CALL first (procedures), fall back to SELECT (functions)
    // We use parameterized query to pass values safely
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    // Determine if proc is qualified (schema.name) or bare
    const qualifiedProc = proc.includes('.') ? proc : `public.${proc}`;

    const startTime = Date.now();
    try {
      // Try CALL first (procedures in PG 11+)
      let result: import('pg').QueryResult;
      try {
        result = await pool.query(`CALL ${qualifiedProc}(${placeholders})`, values);
      } catch (callErr) {
        // If CALL fails with a syntax error or "not a procedure", try SELECT (function)
        const errMsg = String(callErr);
        if (
          errMsg.includes('syntax error') ||
          errMsg.includes('is not a procedure') ||
          errMsg.includes('does not exist') ||
          errMsg.includes('procedure')
        ) {
          result = await pool.query(`SELECT * FROM ${qualifiedProc}(${placeholders})`, values);
        } else {
          throw callErr;
        }
      }
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
    pool: import('pg').Pool,
    query: string,
    params: Record<string, unknown>,
  ): Promise<SqlExecResult> {
    const { values, paramMap } = this.mapNamedParams(params);
    const rewrittenQuery = this.rewriteQueryPlaceholders(query, paramMap);

    const startTime = Date.now();
    try {
      const result = await pool.query(rewrittenQuery, values);
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
   * Collect result sets from a pg QueryResult.
   * pg returns a single result set per query (unlike mssql which can have multiple).
   * For multiple result sets, the user would need to use multiple queries.
   */
  private collectResultSets(
    result: import('pg').QueryResult,
    params: Record<string, unknown>,
    durationMs: number,
  ): SqlExecResult {
    const resultSets: SqlResultSet[] = [];

    if (result.rows && result.rows.length > 0) {
      // Extract column names from the first row (pg returns objects keyed by column name)
      const columns = result.fields ? result.fields.map(f => f.name) : Object.keys(result.rows[0] ?? {});
      const rows = result.rows as Record<string, unknown>[];
      resultSets.push({ columns, rows });
    } else if (result.fields && result.fields.length > 0) {
      // Empty result set but with column metadata
      const columns = result.fields.map(f => f.name);
      resultSets.push({ columns, rows: [] });
    }

    // pg doesn't expose rowsAffected directly in all cases.
    // For INSERT/UPDATE/DELETE, rowCount reflects affected rows.
    const rowsAffected = result.rowCount !== null && result.rowCount !== undefined
      ? [result.rowCount]
      : [];

    return {
      paramIndex: -1, // set by caller
      params,
      resultSets,
      returnValue: null, // PostgreSQL doesn't have a numeric return code like MSSQL
      rowsAffected,
      durationMs,
    };
  }

  async checkDependencies(): Promise<{ name: string; found: boolean; optional: boolean }[]> {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      require.resolve('pg');
      return [{ name: 'pg', found: true, optional: false }];
    } catch {
      return [{ name: 'pg', found: false, optional: false }];
    }
  }

  /**
   * List all stored procedures and functions in the database.
   *
   * Queries pg_catalog.pg_proc joined with pg_namespace and pg_type.
   * Covers both FUNCTIONS (prokind='f') and PROCEDURES (prokind='p', PG 11+).
   * Excludes aggregate/window/trigger functions.
   *
   * For parameters, we use pg_get_function_arguments() to get a human-readable
   * representation, and pg_get_function_identity_arguments() for the canonical form.
   * We also parse the argument names from pg_proc.proallargs (or proargnames).
   */
  async listProcedures(
    connection: SqlConnectionConfig,
    timeout: number,
  ): Promise<SqlProcMetadata[]> {
    const { Pool } = await import('pg');
    const pool = new Pool(createPoolConfig(connection, timeout));

    try {
      const result = await pool.query(`
        SELECT
          n.nspname AS schema_name,
          p.proname AS proc_name,
          pg_get_function_identity_arguments(p.oid) AS args_str,
          pg_get_function_arguments(p.oid) AS full_args_str,
          l.lanname AS language,
          p.prokind,
          p.proretset AS returns_set,
          pg_get_function_result(p.oid) AS return_type_str,
          -- Parse argument names, types, and modes
          p.proargnames AS arg_names,
          p.proallargtypes AS arg_all_types,
          p.proargmodes AS arg_modes,
          -- Use pg_get_functiondef for source extraction (limited here)
          (
            SELECT array_agg(format('%I=%s', k, ord))
            FROM unnest(p.proargnames) WITH ORDINALITY AS t(k, ord)
          ) AS arg_defaults
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
        JOIN pg_catalog.pg_language l ON p.prolang = l.oid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND p.prokind IN ('f', 'p')  -- functions and procedures only
        ORDER BY n.nspname, p.proname
      `);

      const procMap = new Map<string, SqlProcMetadata>();

      for (const row of result.rows) {
        const schema = row.schema_name as string;
        const name = row.proc_name as string;
        const qualifiedName = `${schema}.${name}`;

        // Parse parameters from the catalog data
        const parameters = this.parseProcParameters(row);

        if (!procMap.has(qualifiedName)) {
          procMap.set(qualifiedName, {
            schema,
            name,
            qualifiedName,
            parameters,
            createDate: null, // pg_proc doesn't track creation date
            modifyDate: null,
          });
        }
      }

      return [...procMap.values()].sort((a, b) => {
        if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
        return a.name.localeCompare(b.name);
      });
    } finally {
      await pool.end();
    }
  }

  /**
   * Parse parameter metadata from pg_proc catalog columns.
   *
   * - proargnames: array of parameter names (null if no named params)
   * - proallargtypes: array of type OIDs (null if all IN params — uses proargtypes)
   * - proargmodes: array of mode chars: 'i' (IN), 'o' (OUT), 'b' (INOUT), 'v' (VARIADIC), 't' (TABLE)
   *
   * When proallargtypes/proargmodes are null, all params are IN params
   * and types come from proargtypes (which we resolve via pg_type).
   */
  private parseProcParameters(row: Record<string, unknown>): SqlParamMetadata[] {
    const argNames = row.arg_names as string[] | null;
    const argModes = row.arg_modes as string[] | null;
    const argsStr = row.args_str as string | null;
    const fullArgsStr = row.full_args_str as string | null;

    // If we have no arguments string, the function takes no params
    if (!argsStr || argsStr.trim() === '') {
      return [];
    }

    // Parse the args string: "param1 integer, param2 text, OUT param3 integer"
    // This is the most reliable way to get parameter info from pg
    const params: SqlParamMetadata[] = [];
    const argParts = this.splitArgs(fullArgsStr || argsStr);

    for (let i = 0; i < argParts.length; i++) {
      const part = argParts[i].trim();
      if (!part) continue;

      let mode = 'i'; // default IN
      let name: string;
      let dataType: string;
      let isOutput = false;

      // Check for mode prefix
      const modeMatch = part.match(/^(IN|OUT|INOUT|VARIADIC)\s+/i);
      if (modeMatch) {
        const modeStr = modeMatch[1].toUpperCase();
        mode = modeStr === 'IN' ? 'i' : modeStr === 'OUT' ? 'o' : modeStr === 'INOUT' ? 'b' : 'v';
        isOutput = mode === 'o' || mode === 'b';
      }

      // Parse "name type" or just "type"
      const withoutMode = part.replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, '').trim();
      const spaceIdx = withoutMode.indexOf(' ');

      if (argNames && argNames[i]) {
        // We have the name from proargnames
        name = argNames[i];
        dataType = spaceIdx > 0 ? withoutMode.substring(name.length + 1) : withoutMode;
      } else if (spaceIdx > 0) {
        // Try to split name and type
        name = withoutMode.substring(0, spaceIdx);
        dataType = withoutMode.substring(spaceIdx + 1);
      } else {
        name = `arg${i + 1}`;
        dataType = withoutMode;
      }

      // Determine if output
      if (argModes && argModes[i]) {
        const m = argModes[i] as string;
        isOutput = m === 'o' || m === 'b';
      }

      params.push({
        name,
        dataType,
        isOutput,
        hasDefault: false, // pg doesn't expose defaults easily in catalog
        defaultValue: null,
        ordinal: i + 1,
      });
    }

    return params;
  }

  /**
   * Split a function argument string into individual parameters,
   * respecting parentheses (e.g., "integer[], custom_type(x, y)").
   */
  private splitArgs(argsStr: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of argsStr) {
      if (ch === '(' ) depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);
    return parts;
  }

  async getProcSource(
    connection: SqlConnectionConfig,
    proc: string,
    timeout: number,
  ): Promise<string | null> {
    const { Pool } = await import('pg');
    const pool = new Pool(createPoolConfig(connection, timeout));

    try {
      // Parse "schema.name" or bare "name" (assume public if no schema)
      const parts = proc.split('.');
      let schema = 'public';
      let name = proc;
      if (parts.length >= 2) {
        schema = parts[0]!;
        name = parts[1]!;
      }

      const result = await pool.query(
        `SELECT pg_get_functiondef(p.oid) AS definition
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = $1 AND p.proname = $2
         ORDER BY p.oid`,
        [schema, name],
      );

      if (result.rows.length === 0) {
        // Try as a procedure (PG 11+) — pg_get_functiondef works for procedures too
        return null;
      }

      return (result.rows[0] as { definition: string }).definition ?? null;
    } finally {
      await pool.end();
    }
  }

  async getProcDependencies(
    connection: SqlConnectionConfig,
    proc: string,
    timeout: number,
  ): Promise<SqlDependency[]> {
    const { Pool } = await import('pg');
    const pool = new Pool(createPoolConfig(connection, timeout));

    try {
      // Parse "schema.name" or bare "name"
      const parts = proc.split('.');
      let schema = 'public';
      let name = proc;
      if (parts.length >= 2) {
        schema = parts[0]!;
        name = parts[1]!;
      }

      // PostgreSQL dependency tracking is through pg_depend + pg_rewrite.
      // We query for objects the function/procedure depends on (referenced objects).
      //
      // pg_depend links the function to objects it references via its plan.
      // We use pg_catalog.pg_depend with depender = the function's OID.
      //
      // Note: PostgreSQL's dependency tracking is less detailed than MSSQL's
      // sys.sql_expression_dependencies. We get the referenced object but
      // not the specific DML type (SELECT/INSERT/UPDATE/DELETE).
      const result = await pool.query(
        `WITH proc_oid AS (
           SELECT p.oid
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
           WHERE n.nspname = $1 AND p.proname = $2
           ORDER BY p.oid
           LIMIT 1
         )
         SELECT DISTINCT
           ref_n.nspname AS ref_schema,
           ref_o.relname AS ref_name,
           CASE
             WHEN ref_o.relname IS NOT NULL
               THEN ref_n.nspname || '.' || ref_o.relname
             WHEN ref_p.proname IS NOT NULL
               THEN ref_n2.nspname || '.' || ref_p.proname
             ELSE 'unknown'
           END AS qualified_name,
           CASE
             WHEN ref_o.relkind = 'r' THEN 'TABLE'
             WHEN ref_o.relkind = 'v' THEN 'VIEW'
             WHEN ref_o.relkind = 'm' THEN 'MATERIALIZED VIEW'
             WHEN ref_o.relkind = 'S' THEN 'SEQUENCE'
             WHEN ref_o.relkind = 'f' THEN 'FOREIGN TABLE'
             WHEN ref_p.proname IS NOT NULL THEN 'FUNCTION'
             ELSE 'UNKNOWN'
           END AS object_type,
           -- PostgreSQL doesn't store the specific DML type in pg_depend
           -- We infer based on the referenced object type
           CASE
             WHEN ref_o.relkind = 'r' THEN 'SELECT'
             WHEN ref_o.relkind = 'v' THEN 'SELECT'
             WHEN ref_p.proname IS NOT NULL THEN 'CALL'
             ELSE 'REFERENCE'
           END AS reference_type,
           CASE
             WHEN ref_o.relname IS NOT NULL AND ref_n.nspname NOT IN ($1)
               THEN true
             ELSE false
           END AS is_cross_database,
           false AS is_unresolved
         FROM proc_oid
         JOIN pg_catalog.pg_depend d ON d.objid = proc_oid.oid
         JOIN pg_catalog.pg_class ref_o ON d.refobjid = ref_o.oid
         LEFT JOIN pg_catalog.pg_namespace ref_n ON ref_o.relnamespace = ref_n.oid
         LEFT JOIN pg_catalog.pg_proc ref_p ON d.refobjid = ref_p.oid
         LEFT JOIN pg_catalog.pg_namespace ref_n2 ON ref_p.pronamespace = ref_n2.oid
         WHERE d.deptype IN ('n', 'a')  -- normal and auto dependencies
           AND d.classid = 'pg_catalog.pg_proc'::regclass
         ORDER BY ref_schema, ref_name`,
        [schema, name],
      );

      const deps: SqlDependency[] = result.rows.map((row: Record<string, unknown>) => ({
        schema: (row.ref_schema as string) || '',
        name: (row.ref_name as string) || '',
        qualifiedName: (row.qualified_name as string) || '',
        type: (row.object_type as string) || 'UNKNOWN',
        referenceType: (row.reference_type as string) || 'REFERENCE',
        isCrossDatabase: Boolean(row.is_cross_database),
        isUnresolved: Boolean(row.is_unresolved),
      }));

      return deps;
    } finally {
      await pool.end();
    }
  }
}

// Auto-register on import
SqlDriverRegistry.register('postgres', new PostgresDriver());