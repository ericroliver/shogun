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
  };

  return JSON.stringify(output, null, 2);
}
