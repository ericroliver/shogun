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

  // Live DB introspection section
  if (summary.hasLiveData && summary.dbTotalProcs !== null && summary.dbTotalProcs !== undefined) {
    lines.push('### Live Database Introspection\n');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| DB procedures | ${summary.dbTotalProcs} |`);
    lines.push(`| Tested in DB | ${summary.dbTestedProcs ?? 0} |`);
    lines.push(`| Untested in DB | ${summary.dbUntestedProcs ?? 0} |`);
    const dbCoveragePct = summary.dbTotalProcs > 0
      ? Math.round(((summary.dbTestedProcs ?? 0) / summary.dbTotalProcs) * 1000) / 10
      : 0;
    lines.push(`| DB coverage | ${dbCoveragePct}% |`);
    lines.push('');

    // Untested procs table
    if (summary.untestedProcs && summary.untestedProcs.length > 0) {
      lines.push('### Untested Procedures (in DB, no test files)\n');
      lines.push('| Procedure | Connection | Parameters |');
      lines.push('|-----------|------------|------------|');
      for (const proc of summary.untestedProcs) {
        const inputParams = proc.parameters.filter(p => !p.isOutput);
        const paramSummary = inputParams.length > 0
          ? inputParams.map(p => `${p.name}:${p.dataType}`).join(', ')
          : '(none)';
        lines.push(`| ${proc.qualifiedName} | ${proc.connection} | ${paramSummary} |`);
      }
      lines.push('');
    }

    // Parameter coverage for tested procs
    const liveProcs = procs.filter(p => p.dbMetadata);
    if (liveProcs.length > 0) {
      lines.push('### Parameter Coverage (DB vs Tests)\n');
      for (const proc of liveProcs) {
        const inputParams = proc.dbMetadata!.parameters.filter(p => !p.isOutput);
        if (inputParams.length === 0) continue;

        const exercised = proc.exercisedParams ?? [];
        const untested = proc.untestedParams ?? [];
        const phantom = proc.phantomParams ?? [];

        lines.push(`#### ${proc.proc} (${proc.connection})\n`);
        lines.push('| Parameter | Type | Exercised | Status |');
        lines.push('|-----------|------|-----------|--------|');
        for (const param of inputParams) {
          const isExercised = exercised.includes(param.name.toLowerCase());
          const status = isExercised ? '✅' : '⚠️ Untested';
          lines.push(`| ${param.name} | ${param.dataType} | ${isExercised ? 'Yes' : 'No'} | ${status} |`);
        }
        if (phantom.length > 0) {
          lines.push(`\n> ⚠️ **Phantom parameters** (in test YAML, not in DB): ${phantom.join(', ')}\n`);
        }
        lines.push('');
      }
    }
  }

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

  if (summary.hasLiveData && summary.dbTotalProcs !== null && summary.dbTotalProcs !== undefined) {
    const dbCoveragePct = summary.dbTotalProcs > 0
      ? Math.round(((summary.dbTestedProcs ?? 0) / summary.dbTotalProcs) * 1000) / 10
      : 0;
    lines.push(`\n**DB Coverage:** ${summary.dbTestedProcs ?? 0}/${summary.dbTotalProcs} procedures tested (${dbCoveragePct}%)`);
  }

  return lines.join('\n') + '\n';
}
