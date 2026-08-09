/**
 * src/commands/coverage/reporter/sql-json.ts
 * JSON output for SQL stored procedure coverage.
 */

import type {
  SqlCoverageSummary,
  SqlProcCoverage,
} from '../types.js';

/**
 * Render the SQL coverage report as a JSON string.
 */
export function renderSqlJson(
  summary: SqlCoverageSummary,
  procs: SqlProcCoverage[],
): string {
  const output = {
    summary,
    procedures: procs.map(proc => ({
      proc: proc.proc,
      connection: proc.connection,
      driver: proc.driver,
      testCount: proc.testCount,
      paramSetCount: proc.paramSetCount,
      paramKeys: proc.paramKeys,
      baselineExists: proc.baselineExists,
      hasPreScript: proc.hasPreScript,
      hasPostScript: proc.hasPostScript,
      collections: proc.collections,
      runStatus: proc.runStatus ?? null,
      passCount: proc.passCount,
      failCount: proc.failCount,
      needsBaselineCount: proc.needsBaselineCount,
      // Phase 2: live introspection fields
      inDatabase: proc.inDatabase ?? null,
      dbMetadata: proc.dbMetadata ?? null,
      exercisedParams: proc.exercisedParams ?? null,
      untestedParams: proc.untestedParams ?? null,
      phantomParams: proc.phantomParams ?? null,
      tests: proc.tests.map(t => ({
        name: t.name,
        file: t.file,
        collection: t.collection,
        paramSetCount: t.paramSetCount,
        paramKeys: t.paramKeys,
        baselineExists: t.baselineExists,
        baselinePath: t.baselinePath,
        hasPreScript: t.hasPreScript,
        hasPostScript: t.hasPostScript,
        ignoreFields: t.ignoreFields,
        diffMode: t.diffMode,
        outputFormat: t.outputFormat,
        timeout: t.timeout ?? null,
        tags: t.tags,
        runResult: t.runResult ?? null,
      })),
    })),
    // Phase 2: live introspection data (null when --live not used)
    liveCoverage: summary.hasLiveData ? {
      dbTotalProcs: summary.dbTotalProcs,
      dbTestedProcs: summary.dbTestedProcs,
      dbUntestedProcs: summary.dbUntestedProcs,
      untestedProcs: summary.untestedProcs?.map(p => ({
        schema: p.schema,
        name: p.name,
        qualifiedName: p.qualifiedName,
        connection: p.connection,
        parameters: p.parameters.map(param => ({
          name: param.name,
          dataType: param.dataType,
          isOutput: param.isOutput,
          hasDefault: param.hasDefault,
        })),
        createDate: p.createDate,
        modifyDate: p.modifyDate,
      })) ?? [],
      paramCoverage: summary.paramCoverage ?? [],
    } : null,
  };

  return JSON.stringify(output, null, 2);
}
