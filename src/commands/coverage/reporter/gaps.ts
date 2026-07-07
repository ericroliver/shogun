/**
 * src/commands/coverage/reporter/gaps.ts
 * Gap analysis output — unified multi-dimensional gap report.
 */

import type {
  CoverageSummary,
  CoverageGap,
  GapSeverity,
  EndpointRiskScore,
} from '../types.js';

export function renderGaps(
  summary: CoverageSummary,
  gaps: CoverageGap[],
  riskScores?: EndpointRiskScore[],
  top?: number,
): void {
  console.log(`Coverage Gaps — ${summary.apiTitle} v${summary.apiVersion}`);
  console.log('');

  if (gaps.length === 0) {
    console.log('No coverage gaps found. All endpoints covered, all response codes tested.');
    return;
  }

  // Build risk score lookup
  const riskMap = new Map<string, number>();
  if (riskScores) {
    for (const r of riskScores) riskMap.set(r.specKey, r.score);
  }

  // Severity rank for sorting within the top-N window
  const sevRank: Record<GapSeverity, number> = {
    CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
  };

  // Apply --top N: keep the N highest-priority gaps (severity first, then
  // endpoint risk score descending, then endpoint name for stable order).
  let displayed = gaps;
  let truncated = 0;
  if (top !== undefined && top > 0 && gaps.length > top) {
    displayed = [...gaps].sort((a, b) => {
      const sr = sevRank[a.severity] - sevRank[b.severity];
      if (sr !== 0) return sr;
      const ra = riskMap.get(a.endpoint) ?? 0;
      const rb = riskMap.get(b.endpoint) ?? 0;
      if (rb !== ra) return rb - ra;
      return a.endpoint.localeCompare(b.endpoint);
    }).slice(0, top);
    truncated = gaps.length - top;
  }

  const severities: GapSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

  for (const sev of severities) {
    const sevGaps = displayed.filter(g => g.severity === sev);
    if (sevGaps.length === 0) continue;

    console.log(`${sev} (${sevGaps.length} gaps)`);
    console.log('─'.repeat(80));

    for (const gap of sevGaps) {
      const riskLabel = riskMap.has(gap.endpoint) ? `  [risk: ${riskMap.get(gap.endpoint)}]` : '';
      console.log(`● ${gap.category.padEnd(26)} ${gap.endpoint}${riskLabel}`);
      console.log(`  ${gap.detail}`);
      if (gap.file) {
        console.log(`  ${gap.file}`);
      }
      console.log('');
    }
  }

  const critical = gaps.filter(g => g.severity === 'CRITICAL').length;
  const high = gaps.filter(g => g.severity === 'HIGH').length;
  const medium = gaps.filter(g => g.severity === 'MEDIUM').length;
  const low = gaps.filter(g => g.severity === 'LOW').length;
  console.log(`Total: ${gaps.length} gaps  (${critical} critical, ${high} high, ${medium} medium, ${low} low)`);
  if (truncated > 0) {
    console.log(`Showing top ${displayed.length} of ${gaps.length} gaps (${truncated} hidden). Use --top ${gaps.length} to see all.`);
  }

  const tips: string[] = [];
  tips.push('--detail to see full depth matrix');
  tips.push('--last-run to add run data');
  if (top === undefined) tips.push('--top N to limit to highest-priority gaps');
  console.log(`Tip: ${tips.join('  |  ')}`);
}
