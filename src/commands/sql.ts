/**
 * src/commands/sql.ts
 * `shogun sql` — SQL stored procedure introspection subcommand.
 *
 * Mirrors the progressive-disclosure pattern of `shogun spec`:
 *   list → filter → drill in → deep detail
 *
 * Primitives:
 *   shogun sql                          List all procs (all connections)
 *   shogun sql --connection qa-db        Filter to one connection
 *   shogun sql --schema dbo              Filter by schema
 *   shogun sql --search "user"           Search proc names + param names
 *   shogun sql --proc dbo.sp_GetUser     Detail one proc (params, types, flags)
 *   shogun sql --source dbo.sp_GetUser   Retrieve proc source definition
 *   shogun sql --deps dbo.sp_GetUser     Show proc dependencies (tables, views, procs)
 *   shogun sql --format json|markdown    Output format (default: pretty)
 *   shogun sql --env QA                  Load env for connection string interpolation
 */

import { loadConfig, loadEnv, resolveSqlConnection } from '../loader.js';
import type { ShogunConfig, EnvVars } from '../types.js';
import type { SqlProcMetadata, SqlParamMetadata, SqlDependency } from '../sql-driver.js';

// ---------------------------------------------------------------------------
// Public args interface
// ---------------------------------------------------------------------------

export interface SqlArgs {
  /** --env: load env file for connection string interpolation */
  env?: string;
  /** --connection: scope to one named connection */
  connection?: string;
  /** --schema: filter by schema name */
  schema?: string;
  /** --search: full-text search across proc names + parameter names */
  search?: string;
  /** --proc: drill into one proc (show params, types, flags) */
  proc?: string;
  /** --source: retrieve the proc's source definition */
  source?: string;
  /** --deps: show objects the proc depends on */
  deps?: string;
  /** --format: pretty (default) | json | markdown */
  format?: 'pretty' | 'json' | 'markdown';
  /** cwd override */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function sql(args: SqlArgs): Promise<number> {
  const cwd = args.cwd ?? process.cwd();

  // Load config
  let config: ShogunConfig;
  try {
    config = loadConfig(cwd);
  } catch {
    console.error('Error: No shogun.config.yaml found in the current directory.');
    console.error('  Use `shogun init` to scaffold a new test repo, or run from the repo root.');
    return 1;
  }

  // Check for connections config
  if (!config.connections || Object.keys(config.connections).length === 0) {
    console.error('Error: No database connections defined in shogun.config.yaml.');
    console.error('  Add a `connections:` block with named connections to use `shogun sql`.');
    console.error('  See docs/technical/sql-proc-testing-design.md for configuration details.');
    return 1;
  }

  // Load env if requested (or fall back to config default env)
  let env: EnvVars = {};
  const envName = args.env ?? config.defaults?.env;
  if (envName) {
    try {
      env = loadEnv(envName, config, cwd);
    } catch {
      // If env load fails, we'll still try — connection strings might use
      // process.env instead of env files
    }
  }

  // Resolve which connections to query
  const connectionNames = args.connection
    ? [args.connection]
    : Object.keys(config.connections);

  // Validate requested connection exists
  if (args.connection && !config.connections[args.connection]) {
    console.error(`Error: Connection "${args.connection}" not found in shogun.config.yaml.`);
    console.error(`  Available connections: ${Object.keys(config.connections).join(', ')}`);
    return 1;
  }

  const format = args.format ?? 'pretty';

  // Lazy-load driver registry + all available drivers
  const { SqlDriverRegistry } = await import('../sql-driver.js');
  await import('../drivers/mssql-driver.js');
  await import('../drivers/postgres-driver.js');

  // Dispatch to the appropriate handler
  try {
    if (args.source) {
      return await handleSource(config, env, args.source, args.connection, format, SqlDriverRegistry);
    }
    if (args.deps) {
      return await handleDeps(config, env, args.deps, args.connection, format, SqlDriverRegistry);
    }
    if (args.proc) {
      return await handleProc(config, env, args.proc, args.connection, format, SqlDriverRegistry);
    }
    // Default: list procs (with optional filters)
    return await handleList(config, env, connectionNames, args.schema, args.search, format, SqlDriverRegistry);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

/**
 * Resolve a named connection and return the driver + config.
 * Throws if the connection string can't be resolved.
 */
async function resolveDriver(
  config: ShogunConfig,
  env: EnvVars,
  connectionName: string,
  registry: typeof import('../sql-driver.js').SqlDriverRegistry,
): Promise<{
  driver: import('../sql-driver.js').SqlDriver;
  connConfig: import('../types.js').SqlConnectionConfig;
  timeout: number;
}> {
  const connConfig = resolveSqlConnection(connectionName, config, env);
  if (!connConfig) {
    throw new Error(
      `Connection "${connectionName}" not found or has an unresolved connection string.\n` +
      `  Make sure the connection is defined in shogun.config.yaml and the ` +
      `env var referenced in the connection string is set.`
    );
  }
  const driver = registry.get(connConfig.driver);
  const timeout = connConfig.timeout ?? config.defaults?.timeout ?? 30;
  return { driver, connConfig, timeout };
}

// ---------------------------------------------------------------------------
// Query handlers
// ---------------------------------------------------------------------------

/**
 * List all procs across one or more connections, with optional filtering.
 */
async function handleList(
  config: ShogunConfig,
  env: EnvVars,
  connectionNames: string[],
  schemaFilter: string | undefined,
  searchKeyword: string | undefined,
  format: 'pretty' | 'json' | 'markdown',
  registry: typeof import('../sql-driver.js').SqlDriverRegistry,
): Promise<number> {
  type ProcRow = {
    connection: string;
    schema: string;
    name: string;
    qualifiedName: string;
    paramCount: number;
    outputParamCount: number;
    createDate: string | null;
    modifyDate: string | null;
  };

  const rows: ProcRow[] = [];

  for (const connName of connectionNames) {
    try {
      const { driver, connConfig, timeout } = await resolveDriver(config, env, connName, registry);
      const procs = await driver.listProcedures(connConfig, timeout);

      let filtered = procs;

      // Apply schema filter
      if (schemaFilter) {
        const sl = schemaFilter.toLowerCase();
        filtered = filtered.filter(p => p.schema.toLowerCase() === sl);
      }

      // Apply search filter
      if (searchKeyword) {
        const kw = searchKeyword.toLowerCase();
        filtered = filtered.filter(p => {
          // Search proc name + param names
          const haystack = [
            p.name,
            p.schema,
            p.qualifiedName,
            ...p.parameters.map(pr => pr.name),
          ].join(' ').toLowerCase();
          return haystack.includes(kw);
        });
      }

      for (const proc of filtered) {
        const outputParams = proc.parameters.filter(p => p.isOutput);
        rows.push({
          connection: connName,
          schema: proc.schema,
          name: proc.name,
          qualifiedName: proc.qualifiedName,
          paramCount: proc.parameters.length,
          outputParamCount: outputParams.length,
          createDate: proc.createDate ?? null,
          modifyDate: proc.modifyDate ?? null,
        });
      }
    } catch (err) {
      console.error(`Warning: connection "${connName}" — ${(err as Error).message}`);
    }
  }

  if (rows.length === 0) {
    const filterDesc = [
      schemaFilter ? `schema="${schemaFilter}"` : null,
      searchKeyword ? `search="${searchKeyword}"` : null,
    ].filter(Boolean).join(', ');
    console.error(`No stored procedures found${filterDesc ? ` matching: ${filterDesc}` : ''}.`);
    return 1;
  }

  // Output
  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`## Stored Procedures (${rows.length} total)\n`);
    console.log('| Connection | Schema | Procedure | Params | Outputs | Modified |');
    console.log('|------------|--------|-----------|--------|---------|----------|');
    for (const r of rows) {
      const modified = r.modifyDate ? r.modifyDate.split('T')[0] : '';
      console.log(`| ${r.connection} | ${r.schema} | ${r.qualifiedName} | ${r.paramCount} | ${r.outputParamCount} | ${modified} |`);
    }
    return 0;
  }

  // pretty
  const connLabel = connectionNames.length === 1 ? connectionNames[0] : 'all connections';
  console.log(`Stored Procedures (${rows.length} total, ${connLabel}):\n`);

  // Group by connection for readability
  const byConn = new Map<string, ProcRow[]>();
  for (const r of rows) {
    if (!byConn.has(r.connection)) byConn.set(r.connection, []);
    byConn.get(r.connection)!.push(r);
  }

  for (const [connName, connRows] of byConn) {
    if (byConn.size > 1) console.log(`[${connName}]`);
    for (const r of connRows) {
      const params = r.paramCount > 0 ? `${r.paramCount} params` : 'no params';
      const outputs = r.outputParamCount > 0 ? `, ${r.outputParamCount} OUTPUT` : '';
      const modified = r.modifyDate ? `  modified: ${r.modifyDate.split('T')[0]}` : '';
      console.log(`  ${r.qualifiedName.padEnd(45)} ${params}${outputs}${modified}`);
    }
    if (byConn.size > 1) console.log('');
  }

  console.log('\nUse --proc <name> for full parameter detail, --source <name> for source, --deps <name> for dependencies.');
  return 0;
}

/**
 * Show full detail for a single stored procedure: all parameters with types,
 * defaults, output flags, and metadata.
 */
async function handleProc(
  config: ShogunConfig,
  env: EnvVars,
  procName: string,
  connectionName: string | undefined,
  format: 'pretty' | 'json' | 'markdown',
  registry: typeof import('../sql-driver.js').SqlDriverRegistry,
): Promise<number> {
  // Determine which connections to search (config.connections is validated by caller)
  const connectionNames = connectionName
    ? [connectionName]
    : Object.keys(config.connections!);

  let found: { connection: string; proc: SqlProcMetadata } | null = null;

  for (const connName of connectionNames) {
    try {
      const { driver, connConfig, timeout } = await resolveDriver(config, env, connName, registry);
      const procs = await driver.listProcedures(connConfig, timeout);

      // Match by qualified name or bare name
      const match = findProc(procs, procName);
      if (match) {
        found = { connection: connName, proc: match };
        break;
      }
    } catch (err) {
      console.error(`Warning: connection "${connName}" — ${(err as Error).message}`);
    }
  }

  if (!found) {
    console.error(`Procedure not found: "${procName}"`);
    if (connectionName) {
      console.error(`  Searched connection: ${connectionName}`);
    } else {
      console.error(`  Searched all connections: ${connectionNames.join(', ')}`);
    }
    return 1;
  }

  const { connection, proc } = found;

  if (format === 'json') {
    console.log(JSON.stringify({
      connection,
      ...proc,
    }, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    renderProcMarkdown(connection, proc);
    return 0;
  }

  // pretty
  const DIVIDER = '─'.repeat(56);
  console.log(DIVIDER);
  renderProcPretty(connection, proc);
  console.log(DIVIDER);
  console.log('\nUse --source for the full definition, --deps for dependency analysis.');
  return 0;
}

/**
 * Retrieve and display the source definition of a stored procedure.
 */
async function handleSource(
  config: ShogunConfig,
  env: EnvVars,
  procName: string,
  connectionName: string | undefined,
  format: 'pretty' | 'json' | 'markdown',
  registry: typeof import('../sql-driver.js').SqlDriverRegistry,
): Promise<number> {
  const connectionNames = connectionName
    ? [connectionName]
    : Object.keys(config.connections!);

  let found: { connection: string; source: string } | null = null;

  for (const connName of connectionNames) {
    try {
      const { driver, connConfig, timeout } = await resolveDriver(config, env, connName, registry);

      // First verify the proc exists
      const procs = await driver.listProcedures(connConfig, timeout);
      const match = findProc(procs, procName);
      if (!match) continue;

      const source = await driver.getProcSource(connConfig, match.qualifiedName, timeout);
      if (source !== null) {
        found = { connection: connName, source };
        break;
      }
    } catch (err) {
      console.error(`Warning: connection "${connName}" — ${(err as Error).message}`);
    }
  }

  if (!found) {
    console.error(`Procedure source not found: "${procName}"`);
    return 1;
  }

  const { connection, source } = found;

  if (format === 'json') {
    console.log(JSON.stringify({
      connection,
      proc: procName,
      source,
    }, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`### Source: ${procName}\n`);
    console.log(`**Connection:** ${connection}  `);
    console.log(`**Length:** ${source.length} chars\n`);
    console.log('```sql');
    console.log(source);
    console.log('```');
    return 0;
  }

  // pretty
  console.log(`Source: ${procName} (connection: ${connection})`);
  console.log(`Length: ${source.length} chars\n`);
  console.log(source);
  return 0;
}

/**
 * Retrieve and display the dependencies of a stored procedure.
 */
async function handleDeps(
  config: ShogunConfig,
  env: EnvVars,
  procName: string,
  connectionName: string | undefined,
  format: 'pretty' | 'json' | 'markdown',
  registry: typeof import('../sql-driver.js').SqlDriverRegistry,
): Promise<number> {
  const connectionNames = connectionName
    ? [connectionName]
    : Object.keys(config.connections!);

  let found: { connection: string; deps: SqlDependency[] } | null = null;

  for (const connName of connectionNames) {
    try {
      const { driver, connConfig, timeout } = await resolveDriver(config, env, connName, registry);

      // First verify the proc exists
      const procs = await driver.listProcedures(connConfig, timeout);
      const match = findProc(procs, procName);
      if (!match) continue;

      const deps = await driver.getProcDependencies(connConfig, match.qualifiedName, timeout);
      found = { connection: connName, deps };
      break;
    } catch (err) {
      console.error(`Warning: connection "${connName}" — ${(err as Error).message}`);
    }
  }

  if (!found) {
    console.error(`Procedure not found or no dependencies: "${procName}"`);
    return 1;
  }

  const { connection, deps } = found;

  if (deps.length === 0) {
    const msg = `No dependencies found for "${procName}" (connection: ${connection}).`;
    if (format === 'json') {
      console.log(JSON.stringify({ connection, proc: procName, dependencies: [] }, null, 2));
    } else {
      console.log(msg);
    }
    return 0;
  }

  if (format === 'json') {
    console.log(JSON.stringify({
      connection,
      proc: procName,
      dependencies: deps,
    }, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`### Dependencies: ${procName}\n`);
    console.log(`**Connection:** ${connection}  `);
    console.log(`**Total:** ${deps.length}\n`);
    console.log('| Schema | Name | Type | Reference | Cross-DB | Unresolved |');
    console.log('|--------|------|------|-----------|----------|------------|');
    for (const d of deps) {
      const xdb = d.isCrossDatabase ? '✓' : '';
      const unresolved = d.isUnresolved ? '✓' : '';
      console.log(`| ${d.schema} | ${d.name} | ${d.type} | ${d.referenceType} | ${xdb} | ${unresolved} |`);
    }
    return 0;
  }

  // pretty
  console.log(`Dependencies: ${procName} (connection: ${connection})`);
  console.log(`Total: ${deps.length}\n`);

  // Group by type
  const byType = new Map<string, SqlDependency[]>();
  for (const d of deps) {
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type)!.push(d);
  }

  for (const [type, group] of byType) {
    console.log(`${type} (${group.length}):`);
    for (const d of group) {
      const ref = d.referenceType.padEnd(10);
      const flags = [
        d.isCrossDatabase ? 'cross-db' : null,
        d.isUnresolved ? 'unresolved' : null,
      ].filter(Boolean).join(', ');
      const flagStr = flags ? `  [${flags}]` : '';
      console.log(`  • ${ref} ${d.qualifiedName}${flagStr}`);
    }
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderProcPretty(connection: string, proc: SqlProcMetadata): void {
  console.log(`${proc.qualifiedName}  (connection: ${connection})`);
  console.log(`Schema:     ${proc.schema}`);
  console.log(`Name:       ${proc.name}`);
  if (proc.createDate) console.log(`Created:    ${proc.createDate.split('T')[0]}`);
  if (proc.modifyDate) console.log(`Modified:   ${proc.modifyDate.split('T')[0]}`);

  const inputParams = proc.parameters.filter(p => !p.isOutput);
  const outputParams = proc.parameters.filter(p => p.isOutput);

  if (proc.parameters.length === 0) {
    console.log('\nParameters: (none)');
  } else {
    console.log(`\nParameters (${proc.parameters.length} total, ${inputParams.length} input, ${outputParams.length} output):`);
    for (const p of proc.parameters) {
      renderParamPretty(p);
    }
  }
}

function renderParamPretty(p: SqlParamMetadata): void {
  const dir = p.isOutput ? 'OUT' : 'IN ';
  const type = formatDataType(p);
  const flags: string[] = [];
  if (p.hasDefault) flags.push('has-default');
  if (p.hasDefault && p.defaultValue) flags.push(`default=${p.defaultValue}`);
  const flagStr = flags.length > 0 ? `  ${flags.join(', ')}` : '';
  console.log(`  • ${dir}  ${(p.name).padEnd(28)} ${type.padEnd(20)}${flagStr}`);
}

function renderProcMarkdown(connection: string, proc: SqlProcMetadata): void {
  console.log(`### ${proc.qualifiedName}\n`);
  console.log(`**Connection:** ${connection}  `);
  console.log(`**Schema:** ${proc.schema}  `);
  if (proc.createDate) console.log(`**Created:** ${proc.createDate.split('T')[0]}  `);
  if (proc.modifyDate) console.log(`**Modified:** ${proc.modifyDate.split('T')[0]}  `);
  console.log('');

  if (proc.parameters.length === 0) {
    console.log('_No parameters._');
    return;
  }

  console.log('#### Parameters\n');
  console.log('| Direction | Name | Type | Has Default | Default Value |');
  console.log('|-----------|------|------|-------------|---------------|');
  for (const p of proc.parameters) {
    const dir = p.isOutput ? 'OUTPUT' : 'INPUT';
    const type = formatDataType(p);
    const hasDefault = p.hasDefault ? '✓' : '';
    const defaultValue = p.defaultValue ?? '';
    console.log(`| ${dir} | ${p.name} | ${type} | ${hasDefault} | ${defaultValue} |`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a proc by qualified name ("dbo.sp_Foo") or bare name ("sp_Foo").
 * If bare name matches multiple schemas, prefer "dbo" if present.
 */
function findProc(procs: SqlProcMetadata[], name: string): SqlProcMetadata | undefined {
  // Try exact qualified match
  const exact = procs.find(p => p.qualifiedName.toLowerCase() === name.toLowerCase());
  if (exact) return exact;

  // Try bare name match
  const bareMatches = procs.filter(p => p.name.toLowerCase() === name.toLowerCase());
  if (bareMatches.length === 1) return bareMatches[0];
  if (bareMatches.length > 1) {
    // Prefer dbo schema
    const dboMatch = bareMatches.find(p => p.schema.toLowerCase() === 'dbo');
    return dboMatch ?? bareMatches[0];
  }

  return undefined;
}

/**
 * Format a parameter's data type string from SqlParamMetadata.
 */
function formatDataType(p: SqlParamMetadata): string {
  let type = p.dataType;
  if (p.maxLength !== null && p.maxLength !== undefined && p.maxLength > 0) {
    // For nvarchar, max_length in sys.parameters is 2× the declared length (UTF-16)
    // -1 means MAX
    if (p.maxLength === -1) {
      type = `${p.dataType}(MAX)`;
    } else if (p.dataType.startsWith('n')) {
      type = `${p.dataType}(${p.maxLength / 2})`;
    } else {
      type = `${p.dataType}(${p.maxLength})`;
    }
  } else if (p.precision !== null && p.precision !== undefined && p.precision > 0) {
    type = `${p.dataType}(${p.precision},${p.scale ?? 0})`;
  }
  return type;
}
