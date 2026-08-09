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

  return lines.join('\n') + '\n';
}
