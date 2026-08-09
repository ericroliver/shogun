/**
 * src/commands/coverage/sql-analyzer.ts
 * SQL coverage analysis — builds proc coverage matrix and computes gaps.
 *
 * Groups SqlTestEntry[] by proc+connection, computes per-proc coverage,
 * detects gaps (no baseline, no param sets, no scripts), and produces
 * a SqlCoverageSummary.
 */

import type {
  SqlTestEntry,
  SqlProcCoverage,
  SqlCoverageSummary,
  SqlCoverageGap,
  SqlTestRunResult,
} from './types.js';
import type { RunSummary, TestResult } from '../../types.js';

/**
 * Group SQL test entries by proc+connection into per-proc coverage rows.
 */
export function groupByProc(entries: SqlTestEntry[]): SqlProcCoverage[] {
  const groups = new Map<string, SqlTestEntry[]>();

  for (const entry of entries) {
    const key = `${entry.connection}::${entry.proc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }

  const procs: SqlProcCoverage[] = [];

  for (const [, tests] of groups) {
    const first = tests[0]!;
    const paramSetCount = tests.reduce((sum, t) => sum + t.paramSetCount, 0);

    // Union of all param keys across all tests for this proc
    const paramKeySet = new Set<string>();
    for (const t of tests) {
      for (const k of t.paramKeys) paramKeySet.add(k);
    }

    const collections = [...new Set(tests.map(t => t.collection))].sort();
    const baselineExists = tests.some(t => t.baselineExists);
    const hasPreScript = tests.some(t => t.hasPreScript);
    const hasPostScript = tests.some(t => t.hasPostScript);

    // Run result aggregation
    let passCount = 0;
    let failCount = 0;
    let needsBaselineCount = 0;
    let hasRunData = false;

    for (const t of tests) {
      if (t.runResult) {
        hasRunData = true;
        if (t.runResult.status === 'passed') passCount++;
        else if (t.runResult.status === 'failed') failCount++;
        else if (t.runResult.status === 'needs_baseline') needsBaselineCount++;
      }
    }

    let runStatus: SqlProcCoverage['runStatus'];
    if (hasRunData) {
      if (failCount > 0 && passCount > 0) runStatus = 'mixed';
      else if (failCount > 0) runStatus = 'failed';
      else if (needsBaselineCount > 0 && passCount === 0) runStatus = 'needs_baseline';
      else runStatus = 'passed';
    }

    procs.push({
      proc: first.proc,
      connection: first.connection,
      driver: first.driver,
      tests,
      testCount: tests.length,
      paramSetCount,
      paramKeys: [...paramKeySet].sort(),
      baselineExists,
      hasPreScript,
      hasPostScript,
      collections,
      runStatus,
      passCount,
      failCount,
      needsBaselineCount,
    });
  }

  // Sort: procs with baselines first, then by connection+proc name
  procs.sort((a, b) => {
    if (a.baselineExists !== b.baselineExists) return a.baselineExists ? -1 : 1;
    if (a.connection !== b.connection) return a.connection.localeCompare(b.connection);
    return a.proc.localeCompare(b.proc);
  });

  return procs;
}

/**
 * Collect all SQL coverage gaps from the proc coverage matrix.
 *
 * Gap categories:
 *   CRITICAL: No baseline (proc has tests but no baseline file)
 *   HIGH:     No parameter sets (proc has tests but 0 param sets loaded)
 *   MEDIUM:   No pre/post scripts (less structured testing)
 *   LOW:      Single collection only (no cross-collection coverage)
 */
export function collectSqlGaps(procs: SqlProcCoverage[]): SqlCoverageGap[] {
  const gaps: SqlCoverageGap[] = [];

  for (const proc of procs) {
    // CRITICAL: No baseline
    if (!proc.baselineExists) {
      gaps.push({
        severity: 'CRITICAL',
        category: 'Missing baseline',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" (connection: ${proc.connection}) has ${proc.testCount} test(s) but no baseline file. Run with --snapshot to create one.`,
        file: proc.tests[0]?.file,
      });
    }

    // HIGH: No parameter sets
    if (proc.paramSetCount === 0) {
      gaps.push({
        severity: 'HIGH',
        category: 'No parameter sets',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" has tests but 0 parameter sets loaded. Check parameter file references or inline parameters.`,
        file: proc.tests[0]?.file,
      });
    }

    // MEDIUM: No pre/post scripts
    if (!proc.hasPreScript && !proc.hasPostScript) {
      gaps.push({
        severity: 'MEDIUM',
        category: 'No scripts',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" has no pre or post scripts — consider adding setup/teardown or assertion scripts.`,
        file: proc.tests[0]?.file,
      });
    }

    // MEDIUM: Run failures
    if (proc.runStatus === 'failed' || proc.runStatus === 'mixed') {
      gaps.push({
        severity: 'MEDIUM',
        category: 'Run failures',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" has ${proc.failCount} failing test(s) in the last run.`,
        file: proc.tests[0]?.file,
      });
    }

    // LOW: Single collection only
    if (proc.collections.length === 1) {
      gaps.push({
        severity: 'LOW',
        category: 'Single collection',
        proc: proc.proc,
        detail: `Proc "${proc.proc}" is only tested in collection "${proc.collections[0]}". Consider adding tests in other collections for broader coverage.`,
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
 * Join run results from a RunSummary to SQL test entries.
 * Matches by collection/test-name, same as the HTTP joinRunResultsToTests.
 */
export function joinRunResultsToSqlTests(
  sqlEntries: SqlTestEntry[],
  runSummary: RunSummary,
): void {
  // Build lookup: "collection/test-name" → TestResult
  const resultMap = new Map<string, TestResult>();
  for (const result of runSummary.results) {
    const parts = result.file.replace(/\\/g, '/').split('/');
    const collIdx = parts.indexOf('collections');
    if (collIdx < 0) continue;
    const collection = parts[collIdx + 1] ?? '';
    const key = `${collection}/${result.name}`;
    resultMap.set(key, result);
  }

  // Join to SQL test entries
  for (const entry of sqlEntries) {
    const key = `${entry.collection}/${entry.name}`;
    const result = resultMap.get(key);
    if (!result) continue;

    const runResult: SqlTestRunResult = {
      status: result.status,
      durationMs: result.durationMs,
      paramCount: result.sqlExecSummary?.totalParams ?? 0,
      executed: result.sqlExecSummary?.executed ?? 0,
      errors: result.sqlExecSummary?.errors ?? 0,
      totalRows: result.sqlExecSummary?.totalRows ?? 0,
      snapshotDiff: undefined, // Not stored in run.json currently
    };
    entry.runResult = runResult;
  }
}

/**
 * Build the SQL coverage summary from proc coverage + gaps.
 */
export function buildSqlCoverageSummary(
  entries: SqlTestEntry[],
  procs: SqlProcCoverage[],
  hasRunData: boolean,
): SqlCoverageSummary {
  const totalProcs = procs.length;
  const totalTests = entries.length;
  const totalParamSets = entries.reduce((sum, e) => sum + e.paramSetCount, 0);
  const baselinedProcs = procs.filter(p => p.baselineExists).length;
  const needsBaselineCount = procs.filter(p => !p.baselineExists).length;
  const preScriptCount = entries.filter(e => e.hasPreScript).length;
  const postScriptCount = entries.filter(e => e.hasPostScript).length;

  // Distinct connections
  const connectionsUsed = [...new Set(procs.map(p => p.connection))].sort();

  // Driver counts
  const driverCounts: Record<string, number> = {};
  for (const proc of procs) {
    const driver = proc.driver ?? 'unknown';
    driverCounts[driver] = (driverCounts[driver] ?? 0) + 1;
  }

  // Run result stats
  let passedTests = 0;
  let failedTests = 0;
  let needsBaselineTests = 0;
  for (const entry of entries) {
    if (!entry.runResult) continue;
    if (entry.runResult.status === 'passed') passedTests++;
    else if (entry.runResult.status === 'failed') failedTests++;
    else if (entry.runResult.status === 'needs_baseline') needsBaselineTests++;
  }

  const gaps = collectSqlGaps(procs);

  return {
    totalProcs,
    totalTests,
    totalParamSets,
    baselinedProcs,
    needsBaselineCount,
    preScriptCount,
    postScriptCount,
    connectionsUsed,
    driverCounts,
    passedTests,
    failedTests,
    needsBaselineTests,
    hasRunData,
    gaps,
  };
}
