/**
 * src/commands/coverage/reporter/sql-markdown.ts
 * Markdown table output for SQL stored procedure coverage.
 */

import type {
  SqlCoverageSummary,
  SqlProcCoverage,
} from '../types.js';

/**
 * Render the SQL coverage report as a markdown string.
 */
export function renderSqlMarkdown(
  summary: SqlCoverageSummary,
  procs: SqlProcCoverage[],
  detail: boolean,
): string {
  const lines: string[] = [];

  lines.push('## SQL Stored Procedure Coverage Report\n');
  lines.push(
    `> ${summary.baselinedProcs} / ${summary.totalProcs} procedures baselined ` +
    `· ${summary.totalTests} tests · ${summary.totalParamSets} parameter sets\n`
  );

  // Summary table
  lines.push('### Summary\n');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Procedures | ${summary.totalProcs} |`);
  lines.push(`| SQL tests | ${summary.totalTests} |`);
  lines.push(`| Parameter sets | ${summary.totalParamSets} |`);
  lines.push(`| Baselined | ${summary.baselinedProcs} / ${summary.totalProcs} |`);
  lines.push(`| Needs baseline | ${summary.needsBaselineCount} |`);
  lines.push(`| Pre-scripts | ${summary.preScriptCount} |`);
  lines.push(`| Post-scripts | ${summary.postScriptCount} |`);
  lines.push(`| Connections | ${summary.connectionsUsed.join(', ')} |`);
  const driverList = Object.entries(summary.driverCounts)
    .map(([d, c]) => `${d} (${c})`)
    .join(', ');
  lines.push(`| Drivers | ${driverList} |`);

  if (summary.hasRunData) {
    lines.push(`| Tests passed | ${summary.passedTests} |`);
    lines.push(`| Tests failed | ${summary.failedTests} |`);
    lines.push(`| Tests needs baseline | ${summary.needsBaselineTests} |`);
  }

  lines.push('');

  // Procedure matrix table
  lines.push('### Procedure Coverage Matrix\n');
  if (summary.hasRunData) {
    lines.push('| Procedure | Connection | Params | Baseline | Pre/Post | Tests | Run Status |');
    lines.push('|-----------|------------|--------|----------|----------|-------|------------|');
  } else {
    lines.push('| Procedure | Connection | Params | Baseline | Pre/Post | Tests |');
    lines.push('|-----------|------------|--------|----------|----------|-------|');
  }

  for (const proc of procs) {
    const baseline = proc.baselineExists ? '✅' : '❌';
    const prePost = [
      proc.hasPreScript ? 'pre' : '',
      proc.hasPostScript ? 'post' : '',
    ].filter(Boolean).join('+') || '—';

    if (summary.hasRunData) {
      const status = proc.runStatus ?? '—';
      const statusIcon = status === 'passed' ? '✅' : status === 'failed' ? '❌' : status === 'mixed' ? '⚠️' : status === 'needs_baseline' ? '⭕' : '—';
      lines.push(
        `| ${proc.proc} | ${proc.connection} | ${proc.paramSetCount} | ${baseline} | ${prePost} | ${proc.testCount} | ${statusIcon} ${status} |`
      );
    } else {
      lines.push(
        `| ${proc.proc} | ${proc.connection} | ${proc.paramSetCount} | ${baseline} | ${prePost} | ${proc.testCount} |`
      );
    }
  }

  lines.push('');

  // Detail: per-proc parameter breakdown
  if (detail) {
    lines.push('### Parameter Set Detail\n');
    for (const proc of procs) {
      lines.push(`#### ${proc.proc} (${proc.paramSetCount} param set${proc.paramSetCount === 1 ? '' : 's'})\n`);
      lines.push('| Test | Collection | Param Keys | Param Sets | Baseline | Run Status |');
      lines.push('|------|------------|------------|------------|----------|------------|');
      for (const test of proc.tests) {
        const paramKeys = test.paramKeys.length > 0 ? test.paramKeys.join(', ') : '—';
        const baseline = test.baselineExists ? '✅' : '❌';
        const runStatus = test.runResult?.status ?? '—';
        lines.push(
          `| ${test.name} | ${test.collection} | ${paramKeys} | ${test.paramSetCount} | ${baseline} | ${runStatus} |`
        );
      }
      lines.push('');
    }
  }

  // Gaps
  if (summary.gaps.length > 0) {
    lines.push('### Coverage Gaps\n');
    lines.push('| Severity | Procedure | Category | Detail |');
    lines.push('|----------|-----------|----------|--------|');
    for (const gap of summary.gaps) {
      lines.push(`| ${gap.severity} | ${gap.proc} | ${gap.category} | ${gap.detail} |`);
    }
    lines.push('');
  }

  // Coverage percentage
  const coveragePct = summary.totalProcs > 0
    ? Math.round((summary.baselinedProcs / summary.totalProcs) * 1000) / 10
    : 0;
  lines.push(
    `**Coverage:** ${summary.baselinedProcs}/${summary.totalProcs} procedures baselined (${coveragePct}%) · ` +
    `${summary.totalParamSets} parameter sets total`
  );

  return lines.join('\n') + '\n';
}
