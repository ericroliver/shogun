/**
 * src/commands/coverage/reporter/sql-pretty.ts
 * Terminal pretty output for SQL stored procedure coverage.
 */

import type {
  SqlCoverageSummary,
  SqlProcCoverage,
  SqlCoverageGap,
} from '../types.js';
import type { RunSummary } from '../../../types.js';

/**
 * Render the SQL coverage report as a terminal-friendly string.
 */
export function renderSqlPretty(
  summary: SqlCoverageSummary,
  procs: SqlProcCoverage[],
  detail: boolean,
  runSummary?: RunSummary | null,
): string {
  const lines: string[] = [];

  // --- Header ---
  lines.push('SQL Stored Procedure Coverage Report');
  lines.push('═'.repeat(50));
  lines.push('');

  // Connections summary
  if (summary.connectionsUsed.length > 0) {
    lines.push(`  Connections:      ${summary.connectionsUsed.join(', ')}`);
  }
  if (Object.keys(summary.driverCounts).length > 0) {
    const driverList = Object.entries(summary.driverCounts)
      .map(([d, c]) => `${d} (${c})`)
      .join(', ');
    lines.push(`  Drivers:          ${driverList}`);
  }
  lines.push(`  Procedures:       ${summary.totalProcs}`);
  lines.push(`  SQL tests:        ${summary.totalTests}`);
  lines.push(`  Parameter sets:   ${summary.totalParamSets}`);
  lines.push(`  Baselined:        ${summary.baselinedProcs} / ${summary.totalProcs} procs`);
  if (summary.needsBaselineCount > 0) {
    lines.push(`  Needs baseline:   ${summary.needsBaselineCount} procs`);
  }
  lines.push(`  Pre-scripts:      ${summary.preScriptCount} test(s)`);
  lines.push(`  Post-scripts:     ${summary.postScriptCount} test(s)`);

  // Run results
  if (summary.hasRunData) {
    lines.push('');
    lines.push('  Last run:');
    if (runSummary) {
      const suiteLabel = runSummary.suite ? `  (suite: ${runSummary.suite})` : '';
      lines.push(`    Run ID:        ${runSummary.runId}${suiteLabel}`);
    }
    lines.push(`    Passed:        ${summary.passedTests}`);
    lines.push(`    Failed:        ${summary.failedTests}`);
    lines.push(`    Needs baseline:${summary.needsBaselineTests}`);
  }

  lines.push('');

  // --- Proc matrix table ---
  lines.push('── Procedure Coverage Matrix ' + '─'.repeat(25));
  lines.push('');

  // Column widths
  const procWidth = Math.max(...procs.map(p => p.proc.length), 25);
  const connWidth = Math.max(...procs.map(p => p.connection.length), 12);

  // Header row
  const header = [
    'Procedure'.padEnd(procWidth),
    'Connection'.padEnd(connWidth),
    'Params',
    'Baseline',
    'Pre/Post',
    'Tests',
  ];
  if (summary.hasRunData) {
    header.push('Run Status');
  }
  if (detail) {
    header.push('Collections');
  }
  lines.push('  ' + header.join('  '));
  lines.push('  ' + '─'.repeat(header.join('  ').length));

  // Data rows
  for (const proc of procs) {
    const baseline = proc.baselineExists ? '✓' : '✗';
    const prePost = [
      proc.hasPreScript ? 'pre' : '',
      proc.hasPostScript ? 'post' : '',
    ].filter(Boolean).join('+') || '—';

    const row = [
      proc.proc.padEnd(procWidth),
      proc.connection.padEnd(connWidth),
      String(proc.paramSetCount).padStart(6),
      baseline.padStart(8),
      prePost.padEnd(8),
      String(proc.testCount).padStart(5),
    ];
    if (summary.hasRunData) {
      const status = proc.runStatus ?? '—';
      const statusIcon = status === 'passed' ? '✓' : status === 'failed' ? '✗' : status === 'mixed' ? '⚠' : status === 'needs_baseline' ? '○' : '—';
      row.push(`${statusIcon} ${status}`.padEnd(15));
    }
    if (detail) {
      row.push(proc.collections.join(', '));
    }
    lines.push('  ' + row.join('  '));
  }

  lines.push('');

  // --- Live DB introspection section ---
  if (summary.hasLiveData && summary.dbTotalProcs !== null && summary.dbTotalProcs !== undefined) {
    lines.push('── Live Database Introspection ' + '─'.repeat(22));
    lines.push('');
    lines.push(`  DB procedures:     ${summary.dbTotalProcs}`);
    lines.push(`  Tested in DB:      ${summary.dbTestedProcs ?? 0}`);
    lines.push(`  Untested in DB:    ${summary.dbUntestedProcs ?? 0}`);

    const dbCoveragePct = summary.dbTotalProcs > 0
      ? Math.round(((summary.dbTestedProcs ?? 0) / summary.dbTotalProcs) * 1000) / 10
      : 0;
    lines.push(`  DB coverage:       ${dbCoveragePct}%`);
    lines.push('');

    // Untested procs table
    if (summary.untestedProcs && summary.untestedProcs.length > 0) {
      lines.push('── Untested Procedures (in DB, no test files) ' + '─'.repeat(8));
      lines.push('');

      const untestedProcWidth = Math.max(
        ...summary.untestedProcs.map(p => p.qualifiedName.length), 25,
      );
      const untestedConnWidth = Math.max(
        ...summary.untestedProcs.map(p => p.connection.length), 12,
      );

      lines.push(`  ${'Procedure'.padEnd(untestedProcWidth)}  ${'Connection'.padEnd(untestedConnWidth)}  Parameters`);
      lines.push(`  ${'─'.repeat(untestedProcWidth)}  ${'─'.repeat(untestedConnWidth)}  ${'─'.repeat(30)}`);

      for (const proc of summary.untestedProcs) {
        const inputParams = proc.parameters.filter(p => !p.isOutput);
        const paramSummary = inputParams.length > 0
          ? inputParams.map(p => `${p.name}:${p.dataType}`).join(', ')
          : '(none)';
        lines.push(`  ${proc.qualifiedName.padEnd(untestedProcWidth)}  ${proc.connection.padEnd(untestedConnWidth)}  ${paramSummary}`);
      }
      lines.push('');
    }

    // Per-proc parameter coverage (only for procs with DB metadata)
    const liveProcs = procs.filter(p => p.dbMetadata);
    if (liveProcs.length > 0) {
      lines.push('── Parameter Coverage (DB vs Tests) ' + '─'.repeat(14));
      lines.push('');

      for (const proc of liveProcs) {
        const inputParams = proc.dbMetadata!.parameters.filter(p => !p.isOutput);
        if (inputParams.length === 0) continue;

        const exercised = proc.exercisedParams ?? [];
        const untested = proc.untestedParams ?? [];
        const phantom = proc.phantomParams ?? [];

        lines.push(`  ${proc.proc} (${proc.connection})`);
        lines.push(`    DB input params:  ${inputParams.length} — ${inputParams.map(p => `${p.name}:${p.dataType}`).join(', ')}`);

        if (exercised.length > 0) {
          lines.push(`    Exercised:       ${exercised.length} / ${inputParams.length} — ${exercised.join(', ')}`);
        }
        if (untested.length > 0) {
          lines.push(`    ⚠ Untested:       ${untested.length} — ${untested.join(', ')}`);
        }
        if (phantom.length > 0) {
          lines.push(`    ⚠ Phantom:        ${phantom.length} — ${phantom.join(', ')} (in YAML, not in DB)`);
        }
        lines.push('');
      }
    }
  }

  // --- Detail: per-param-set breakdown ---
  if (detail) {
    lines.push('── Parameter Set Detail ' + '─'.repeat(28));
    lines.push('');
    for (const proc of procs) {
      lines.push(`${proc.proc} (${proc.paramSetCount} param set${proc.paramSetCount === 1 ? '' : 's'})`);
      for (const test of proc.tests) {
        const paramInfo = test.paramSetCount > 0
          ? test.paramKeys.length > 0
            ? `{${test.paramKeys.join(', ')}}`
            : '(empty params)'
          : '(no params loaded)';
        const runInfo = test.runResult
          ? ` → ${test.runResult.status}${test.runResult.errors > 0 ? ` (${test.runResult.errors} errors)` : ''}`
          : '';
        lines.push(`  Set ${paramInfo} [${test.collection}]${runInfo}`);
      }
      lines.push('');
    }
  }

  // --- Gaps ---
  if (summary.gaps.length > 0) {
    lines.push('── Coverage Gaps ' + '─'.repeat(35));
    lines.push('');

    const severityIcon: Record<string, string> = {
      CRITICAL: '🔴',
      HIGH: '🟠',
      MEDIUM: '🟡',
      LOW: '🔵',
    };

    for (const gap of summary.gaps) {
      const icon = severityIcon[gap.severity] ?? '⚪';
      lines.push(`  ${icon} [${gap.severity}] ${gap.proc}`);
      lines.push(`     ${gap.category}: ${gap.detail}`);
      if (gap.file) {
        lines.push(`     File: ${gap.file}`);
      }
      lines.push('');
    }
  }

  // --- Summary line ---
  const coveragePct = summary.totalProcs > 0
    ? Math.round((summary.baselinedProcs / summary.totalProcs) * 1000) / 10
    : 0;
  lines.push(`Coverage: ${summary.baselinedProcs}/${summary.totalProcs} procedures baselined (${coveragePct}%)`);
  lines.push(`Parameter sets: ${summary.totalParamSets} total across ${summary.totalProcs} procedures`);

  // Live coverage summary
  if (summary.hasLiveData && summary.dbTotalProcs !== null && summary.dbTotalProcs !== undefined) {
    const dbCoveragePct = summary.dbTotalProcs > 0
      ? Math.round(((summary.dbTestedProcs ?? 0) / summary.dbTotalProcs) * 1000) / 10
      : 0;
    lines.push(`DB coverage: ${summary.dbTestedProcs ?? 0}/${summary.dbTotalProcs} procedures tested (${dbCoveragePct}%)`);
  }

  return lines.join('\n') + '\n';
}
