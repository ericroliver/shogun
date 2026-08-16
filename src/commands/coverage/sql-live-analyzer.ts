/**
 * src/commands/coverage/sql-live-analyzer.ts
 * Phase 2 — Live database introspection analysis.
 *
 * Compares test-side data (from YAML files) against database catalog data
 * (from live introspection) to compute:
 *   - Untested procs (exist in DB, no test files)
 *   - Parameter coverage (which params are exercised vs. which exist in DB)
 *   - Phantom params (params in tests that don't exist in DB proc definition)
 *   - Live gaps (untested procs, untested params, param type mismatches)
 */

import type {
  SqlProcCoverage,
  SqlUntestedProc,
  SqlParamCoverageRow,
  SqlCoverageGap,
  SqlTestEntry,
} from './types.js';
import type { SqlProcMetadata, SqlParamMetadata } from '../../sql-driver.js';

/**
 * Compare tested procs against database-discovered procs.
 *
 * Returns:
 *   - untestedProcs: procs in DB with no test files
 *   - Updates each SqlProcCoverage with inDatabase, dbMetadata, param coverage data
 */
export function compareTestedVsDatabase(
  procs: SqlProcCoverage[],
  dbProcs: SqlProcMetadata[],
  connection: string,
): SqlUntestedProc[] {
  // Build lookup of DB procs by qualified name AND by bare name
  const dbByQualifiedName = new Map<string, SqlProcMetadata>();
  const dbByBareName = new Map<string, SqlProcMetadata[]>();

  for (const dbProc of dbProcs) {
    dbByQualifiedName.set(dbProc.qualifiedName, dbProc);
    const bare = dbProc.name;
    if (!dbByBareName.has(bare)) dbByBareName.set(bare, []);
    dbByBareName.get(bare)!.push(dbProc);
  }

  // Track which DB procs are matched by qualified name
  const matchedQualifiedNames = new Set<string>();

  // Match tested procs to DB procs
  for (const proc of procs) {
    if (proc.connection !== connection) continue;

    // Try qualified name first (e.g., "dbo.sp_GetUser")
    let dbMatch = dbByQualifiedName.get(proc.proc);

    // Fall back to bare name match (e.g., "sp_GetUser" → find in dbo)
    if (!dbMatch) {
      const candidates = dbByBareName.get(proc.proc);
      if (candidates && candidates.length === 1) {
        dbMatch = candidates[0];
      } else if (candidates && candidates.length > 1) {
        // Ambiguous — prefer "dbo." prefix if exists
        dbMatch = candidates.find(c => c.schema === 'dbo') ?? candidates[0];
      }
    }

    if (dbMatch) {
      matchedQualifiedNames.add(dbMatch.qualifiedName);
      proc.inDatabase = true;
      proc.dbMetadata = dbMatch;

      // Compute parameter coverage
      const paramCov = analyzeParamCoverage(proc, dbMatch);
      proc.exercisedParams = paramCov.exercisedParams;
      proc.untestedParams = paramCov.untestedParams;
      proc.phantomParams = paramCov.phantomParams;
    } else {
      proc.inDatabase = false;
    }
  }

  // Find untested procs (in DB, not matched to any test)
  const untestedProcs: SqlUntestedProc[] = [];
  for (const dbProc of dbProcs) {
    if (!matchedQualifiedNames.has(dbProc.qualifiedName)) {
      untestedProcs.push({
        schema: dbProc.schema,
        name: dbProc.name,
        qualifiedName: dbProc.qualifiedName,
        connection,
        parameters: dbProc.parameters,
        createDate: dbProc.createDate,
        modifyDate: dbProc.modifyDate,
      });
    }
  }

  return untestedProcs;
}

/**
 * Analyze parameter coverage for a tested proc against its DB definition.
 *
 * Returns:
 *   - exercisedParams: DB input params that appear in at least one param set
 *   - untestedParams: DB input params that never appear in any param set
 *   - phantomParams: params in test YAML that don't exist in the DB proc
 */
export function analyzeParamCoverage(
  proc: SqlProcCoverage,
  dbProc: SqlProcMetadata,
): {
  exercisedParams: string[];
  untestedParams: string[];
  phantomParams: string[];
} {
  // Get DB input parameters (non-OUTPUT params are inputs)
  const dbInputParams = new Set(
    dbProc.parameters
      .filter(p => !p.isOutput)
      .map(p => p.name.toLowerCase()),
  );

  const dbParamNames = new Set(
    dbProc.parameters.map(p => p.name.toLowerCase()),
  );

  // Get tested params (lowercased for comparison)
  const testedParams = new Set(
    proc.paramKeys.map(k => k.toLowerCase()),
  );

  // Exercised: in both DB input params and tested params
  const exercisedParams = [...dbInputParams].filter(p => testedParams.has(p));

  // Untested: in DB input params but not in any param set
  const untestedParams = [...dbInputParams].filter(p => !testedParams.has(p));

  // Phantom: in test YAML but not in DB proc definition
  const phantomParams = [...testedParams].filter(p => !dbParamNames.has(p));

  return {
    exercisedParams: exercisedParams.sort(),
    untestedParams: untestedParams.sort(),
    phantomParams: phantomParams.sort(),
  };
}

/**
 * Build per-parameter coverage rows for a single tested proc.
 * Used for detailed parameter coverage matrix display.
 */
export function buildParamCoverageRows(
  proc: SqlProcCoverage,
): SqlParamCoverageRow[] {
  if (!proc.dbMetadata) return [];

  const rows: SqlParamCoverageRow[] = [];
  const testedParamLower = new Set(proc.paramKeys.map(k => k.toLowerCase()));

  for (const param of proc.dbMetadata.parameters) {
    const exercisedCount = proc.tests.reduce((count, test) => {
      // Count param sets in this test that include this parameter
      const paramLower = param.name.toLowerCase();
      const hasParam = test.paramKeys.some(k => k.toLowerCase() === paramLower);
      return count + (hasParam ? test.paramSetCount : 0);
    }, 0);

    rows.push({
      name: param.name,
      dataType: param.dataType,
      isOutput: param.isOutput,
      hasDefault: param.hasDefault,
      exercisedCount,
      totalParamSets: proc.paramSetCount,
      fullyCovered: exercisedCount === proc.paramSetCount && proc.paramSetCount > 0,
      neverExercised: exercisedCount === 0,
    });
  }

  return rows;
}

/**
 * Collect all live coverage gaps from the proc coverage matrix + untested procs.
 *
 * Live gap categories:
 *   CRITICAL: Untested proc (exists in DB, no test files)
 *   HIGH:     Untested input params (params in DB definition never exercised)
 *   MEDIUM:   Phantom params (params in test YAML that don't exist in DB)
 *   MEDIUM:   Tested proc not found in database
 */
export function collectLiveGaps(
  procs: SqlProcCoverage[],
  untestedProcs: SqlUntestedProc[],
): SqlCoverageGap[] {
  const gaps: SqlCoverageGap[] = [];

  // CRITICAL: Untested procs (in DB but no tests)
  for (const untested of untestedProcs) {
    gaps.push({
      severity: 'CRITICAL',
      category: 'Untested procedure',
      proc: untested.qualifiedName,
      detail: `Proc "${untested.qualifiedName}" exists in database (connection: ${untested.connection}) but has no test files. Add a test with type: sql and proc: ${untested.name}.`,
    });
  }

  for (const proc of procs) {
    // MEDIUM: Tested proc not found in database
    if (proc.inDatabase === false) {
      gaps.push({
        severity: 'MEDIUM',
        category: 'Not in database',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" (connection: ${proc.connection}) has ${proc.testCount} test(s) but was not found in the database. The proc may have been dropped or renamed.`,
        file: proc.tests[0]?.file,
      });
    }

    // HIGH: Untested input parameters
    if (proc.untestedParams && proc.untestedParams.length > 0) {
      gaps.push({
        severity: 'HIGH',
        category: 'Untested parameters',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" has ${proc.untestedParams.length} input parameter(s) never exercised: ${proc.untestedParams.join(', ')}. Add parameter sets that include these parameters.`,
        file: proc.tests[0]?.file,
      });
    }

    // MEDIUM: Phantom parameters (in tests but not in DB)
    if (proc.phantomParams && proc.phantomParams.length > 0) {
      gaps.push({
        severity: 'MEDIUM',
        category: 'Phantom parameters',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" has ${proc.phantomParams.length} parameter(s) in test YAML that don't exist in the DB definition: ${proc.phantomParams.join(', ')}. These may be typos or the proc definition may have changed.`,
        file: proc.tests[0]?.file,
      });
    }
  }

  // Sort by severity (CRITICAL first)
  const severityOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  gaps.sort((a, b) => {
    const orderDiff = severityOrder[a.severity]! - severityOrder[b.severity]!;
    if (orderDiff !== 0) return orderDiff;
    return a.proc.localeCompare(b.proc);
  });

  return gaps;
}

/**
 * Build the live parameter coverage matrix for the summary.
 * Returns per-proc parameter coverage rows for all tested procs that have DB metadata.
 */
export function buildParamCoverage(
  procs: SqlProcCoverage[],
): Array<{ proc: string; connection: string; params: SqlParamCoverageRow[] }> {
  const result: Array<{ proc: string; connection: string; params: SqlParamCoverageRow[] }> = [];

  for (const proc of procs) {
    if (!proc.dbMetadata) continue;
    const rows = buildParamCoverageRows(proc);
    if (rows.length > 0) {
      result.push({
        proc: proc.proc,
        connection: proc.connection,
        params: rows,
      });
    }
  }

  return result;
}
