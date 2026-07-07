/**
 * src/commands/coverage/reporter/compare.ts
 * Two-run coverage delta output.
 */

import type { RunDelta, CoverageSummary } from '../types.js';

export function renderCompare(summary: CoverageSummary, delta: RunDelta): string {
  const lines: string[] = [];
  lines.push(`Coverage Delta — ${summary.apiTitle} v${summary.apiVersion}`);
  lines.push(`Comparing: ${delta.newerRunId} (newer) vs ${delta.olderRunId} (older)`);
  if (delta.newerSuite || delta.olderSuite) {
    lines.push(`Suite: ${delta.newerSuite ?? delta.olderSuite ?? 'unknown'}`);
  }
  lines.push('');

  const epDelta = delta.endpointCoverageDelta;
  const epSign = epDelta >= 0 ? '+' : '';
  lines.push(`Endpoint Coverage:  ${summary.coveredEndpoints - epDelta} → ${summary.coveredEndpoints}  (${epSign}${epDelta})`);

  const passSign = delta.passRateDelta >= 0 ? '+' : '';
  lines.push(`Pass Rate:          ${passSign}${delta.passRateDelta}pp`);
  lines.push('');

  if (delta.newlyCovered.length > 0) {
    lines.push(`Newly Covered (${delta.newlyCovered.length}):`);
    for (const ep of delta.newlyCovered) {
      lines.push(`  ✅ ${ep}`);
    }
    lines.push('');
  }

  if (delta.lostCoverage.length > 0) {
    lines.push(`Lost Coverage (${delta.lostCoverage.length}):`);
    for (const ep of delta.lostCoverage) {
      lines.push(`  ❌ ${ep}`);
    }
    lines.push('');
  } else {
    lines.push('Lost Coverage (0):');
    lines.push('  (none)');
    lines.push('');
  }

  if (delta.testsNowFailing.length > 0) {
    lines.push(`Tests Now Failing (${delta.testsNowFailing.length}):`);
    for (const t of delta.testsNowFailing) {
      lines.push(`  ✗ "${t}"`);
    }
    lines.push('');
  }

  if (delta.testsNowPassing.length > 0) {
    lines.push(`Tests Now Passing (${delta.testsNowPassing.length}):`);
    for (const t of delta.testsNowPassing) {
      lines.push(`  ✓ "${t}"`);
    }
    lines.push('');
  }

  if (delta.testsAdded.length > 0) {
    lines.push(`Tests Added (${delta.testsAdded.length}):`);
    for (const t of delta.testsAdded) {
      lines.push(`  + "${t}"`);
    }
    lines.push('');
  }

  if (delta.testsRemoved.length > 0) {
    lines.push(`Tests Removed (${delta.testsRemoved.length}):`);
    for (const t of delta.testsRemoved) {
      lines.push(`  - "${t}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
