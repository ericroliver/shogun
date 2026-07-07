/**
 * src/commands/coverage/reporter/pretty.ts
 * Terminal pretty output — grouped by spec tag, with risk scores.
 */

import type {
  CoverageSummary,
  SpecEndpoint,
  EndpointResponseCodeCoverage,
  EndpointParameterCoverage,
  EndpointBodyFieldCoverage,
  EndpointQualityScore,
  EndpointRiskScore,
  EndpointTestingProfile,
} from '../types.js';
import type { RunSummary } from '../../../types.js';
import { groupEndpointsByTag, sortedTagNames } from '../analyzer.js';

export function renderPretty(
  summary: CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
  responseCodeCoverage?: EndpointResponseCodeCoverage[],
  parameterCoverage?: EndpointParameterCoverage[],
  bodyFieldCoverage?: EndpointBodyFieldCoverage[],
  qualityScores?: EndpointQualityScore[],
  riskScores?: EndpointRiskScore[],
  testingProfiles?: EndpointTestingProfile[],
  detail: boolean = false,
  runSummary?: RunSummary | null,
): void {
  console.log(`Coverage Report — ${summary.apiTitle} v${summary.apiVersion}`);
  console.log(`  Spec endpoints:    ${summary.totalEndpoints}`);
  console.log(`  Tests scanned:     ${summary.totalTests}  (${summary.collections} collections)`);
  console.log(`  Covered:           ${summary.coveredEndpoints}  (${summary.coveragePct}%)`);
  console.log(`  Uncovered:         ${summary.uncoveredEndpoints}`);
  console.log(
    `  Response codes:    ${summary.coveredResponseCodes} / ${summary.totalSpecResponseCodes} ` +
    `spec codes tested  (${summary.responseCodeCoveragePct}%)`
  );
  console.log(
    `  Parameters:        ${summary.testedParams} / ${summary.totalSpecParams} ` +
    `spec params tested  (${summary.paramCoveragePct}%)`
  );
  console.log(
    `  Body fields:       ${summary.testedBodyFields} / ${summary.totalSpecBodyFields} ` +
    `spec body fields tested  (${summary.bodyFieldCoveragePct}%)`
  );
  console.log(
    `  Assertion quality: avg score ${summary.avgQualityScore} / 100 across covered endpoints`
  );
  console.log(
    `                     (per test: status 1 + shape 2×n + snapshot 3 + postScript asserts; ÷ 10 × 100)`
  );
  if (summary.thinTestCount > 0) {
    console.log(
      `  Thin tests:        ${summary.thinTestCount} tests score ≤ 1 (status-only, no assertions)`
    );
  }
  console.log(`  High-risk endpoints: ${summary.highRiskEndpointCount} endpoints with risk ≥ 50`);
  const nr = summary.suiteNegativeRatio;
  console.log(
    `  Test profile:      ${nr.total} tests  —  2xx: ${nr.twoxx} (${nr.twoxxPct}%)  4xx: ${nr.fourxx} (${nr.fourxxPct}%)  5xx: ${nr.fivexx} (${nr.fivexxPct}%)`
  );
  if (runSummary) {
    const suiteLabel = runSummary.suite ? `  (suite: ${runSummary.suite})` : '';
    console.log(
      `  Last run:          ${runSummary.runId}${suiteLabel}  ${runSummary.total} tests  ${runSummary.passed} passed  ${runSummary.failed} failed`
    );
  }
  console.log('');

  // Build lookups by specKey
  const rccMap = new Map<string, EndpointResponseCodeCoverage>();
  if (responseCodeCoverage) {
    for (const rcc of responseCodeCoverage) rccMap.set(rcc.specKey, rcc);
  }
  const pcMap = new Map<string, EndpointParameterCoverage>();
  if (parameterCoverage) {
    for (const pc of parameterCoverage) pcMap.set(pc.specKey, pc);
  }
  const bfcMap = new Map<string, EndpointBodyFieldCoverage>();
  if (bodyFieldCoverage) {
    for (const bfc of bodyFieldCoverage) bfcMap.set(bfc.specKey, bfc);
  }
  const qsMap = new Map<string, EndpointQualityScore>();
  if (qualityScores) {
    for (const qs of qualityScores) qsMap.set(qs.specKey, qs);
  }
  const riskMap = new Map<string, EndpointRiskScore>();
  if (riskScores) {
    for (const rs of riskScores) riskMap.set(rs.specKey, rs);
  }
  const profileMap = new Map<string, EndpointTestingProfile>();
  if (testingProfiles) {
    for (const tp of testingProfiles) profileMap.set(tp.specKey, tp);
  }

  // Sort endpoints by risk score descending within each group
  const groups = groupEndpointsByTag(specEndpoints);
  // Re-sort within each group by risk score descending
  for (const [, eps] of groups) {
    eps.sort((a, b) => {
      const riskA = riskMap.get(`${a.method} ${a.path}`)?.score ?? 0;
      const riskB = riskMap.get(`${b.method} ${b.path}`)?.score ?? 0;
      if (riskA !== riskB) return riskB - riskA; // higher risk first
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return a.path.localeCompare(b.path);
    });
  }

  for (const tag of sortedTagNames(groups)) {
    const eps = groups.get(tag)!;

    const visibleEps = uncoveredOnly ? eps.filter(e => e.tests.length === 0) : eps;
    if (visibleEps.length === 0) continue;

    const total = eps.length;
    const covered = eps.filter(e => e.tests.length > 0).length;
    const pct = total > 0 ? Math.round((covered / total) * 1000) / 10 : 0;

    const header = `── ${tag} (${total} endpoints, ${covered} covered, ${pct}%) `;
    const padLen = Math.max(0, 80 - header.length);
    console.log(header + '─'.repeat(padLen));

    for (const ep of visibleEps) {
      const methodPad = ep.method.padEnd(7);
      const pathPad = ep.path.padEnd(50);
      const testCount = ep.tests.length;
      const testLabel = testCount === 1 ? '1 test ' : `${testCount} tests`;
      const collectionNames = [...new Set(ep.tests.map(t => t.collection))].join(', ');

      // Risk indicator
      const risk = riskMap.get(`${ep.method} ${ep.path}`);
      const riskScore = risk?.score ?? 0;
      const riskIndicator = riskScore >= 100 ? '✗ ' : riskScore >= 30 ? '⚠ ' : '  ';
      const riskLabel = riskScore > 0 ? `  risk: ${riskScore}` : '';
      const uncoveredMarker = testCount === 0 ? '  ← uncovered' : '';

      // Check if all tests are thin (Story 8b)
      const qs = qsMap.get(`${ep.method} ${ep.path}`);
      const allThin = qs && qs.thinTestCount === qs.tests.length && qs.tests.length > 0;
      const thinMarker = allThin ? '  ⚠️ all tests thin' : '';

      console.log(`${riskIndicator}${methodPad} ${pathPad} ${testLabel.padEnd(8)} ${collectionNames}${riskLabel}${uncoveredMarker}${thinMarker}`);

      // Detail view
      if (detail && testCount > 0) {
        // Risk breakdown
        if (risk && risk.score > 0) {
          const s = risk.signals;
          console.log(`    Risk breakdown: response-codes ${s.responseCodeGap.toFixed(2)}  params ${s.parameterGap.toFixed(2)}  body-fields ${s.bodyFieldGap.toFixed(2)}  quality ${s.assertionQuality.toFixed(2)}  run ${s.runResults.toFixed(2)}`);
        }

        // Response code matrix
        const rcc = rccMap.get(`${ep.method} ${ep.path}`);
        if (rcc && rcc.allCodes.length > 0) {
          const codeParts = rcc.allCodes.map(c => {
            const marker = c.status === 'tested' ? '✓'
              : c.status === 'untested' ? '✗'
              : c.status === 'undocumented' ? '⚠️'
              : '↔';
            return `${c.code} ${marker}`;
          });
          console.log(`    Response codes: ${codeParts.join('  ')}`);

          if (rcc.hasDrift) {
            const driftCodes = rcc.allCodes.filter(
              c => c.status === 'undocumented' || c.status === 'mismatch'
            );
            for (const dc of driftCodes) {
              if (dc.status === 'undocumented') {
                console.log(`    Drift: ${dc.code} returned but not in spec ⚠️`);
              } else if (dc.status === 'mismatch' && dc.mismatchDetail) {
                console.log(`    Drift: ${dc.mismatchDetail} ↔`);
              }
            }
          }
        }

        // Parameter coverage
        const pc = pcMap.get(`${ep.method} ${ep.path}`);
        if (pc && pc.parameters.length > 0) {
          const paramParts = pc.parameters.map(p => {
            const marker = p.tested ? (p.inferredOnly ? '~' : '✓') : '✗';
            return `${p.name} ${marker}`;
          });
          console.log(`    Parameters:     ${paramParts.join('  ')}`);
        }

        // Body field coverage
        const bfc = bfcMap.get(`${ep.method} ${ep.path}`);
        if (bfc && bfc.fields.length > 0) {
          const fieldParts = bfc.fields.map(f => {
            if (f.tested) return `${f.name} ✓`;
            return f.required ? `${f.name} ✗!` : `${f.name} ✗`;
          });
          console.log(`    Body fields:    ${fieldParts.join('  ')}`);
        }

        // Quality score
        // Formula (per test): rawScore = status(1 if response.status set)
        //   + shape(2 × shapeAssertions.length) + snapshot(3 if enabled)
        //   + postScript(count of assert() calls in post script).
        //   Endpoint score = min(100, Σ rawScores / (tests × 10) × 100).
        //   A test is "thin" when rawScore ≤ 1 (status-only, no assertions).
        if (qs) {
          const scoreParts = qs.tests.map(t =>
            t.isThin ? `${t.rawScore} ⚠️thin` : `${t.rawScore}`
          );
          console.log(`    Quality score:  ${qs.normalizedScore} / 100  (${qs.tests.length} tests: scores ${scoreParts.join(', ')})`);
          // Per-test breakdown: status ✓/✗, shape n, snapshot ✓/✗, postScript n
          for (const t of qs.tests) {
            const st = t.breakdown.statusScore > 0 ? '✓' : '✗';
            const sh = t.breakdown.shapeScore / 2;
            const sn = t.breakdown.snapshotScore > 0 ? '✓' : '✗';
            const ps = t.breakdown.postScriptScore;
            console.log(`      · ${t.testName}: status ${st}  shape ${sh}  snapshot ${sn}  postScript ${ps}  → ${t.rawScore}`);
          }
        }

        // Run results
        if (runSummary) {
          const testsWithResults = ep.tests.filter(t => t.runResult);
          if (testsWithResults.length > 0) {
            const passed = testsWithResults.filter(t => t.runResult!.status === 'passed').length;
            const failed = testsWithResults.filter(t => t.runResult!.status === 'failed').length;
            const avgMs = Math.round(
              testsWithResults.reduce((sum, t) => sum + t.runResult!.durationMs, 0) / testsWithResults.length
            );
            console.log(`    Run results:    ${passed} passed  ${failed} failed  avg ${avgMs}ms`);
          }
        }

        // Testing profile (Story 13)
        const tp = profileMap.get(`${ep.method} ${ep.path}`);
        if (tp) {
          const nr = tp.negativeRatio;
          const happyMarker = nr.onlyHappyPath ? '  ⚠️ only happy-path' : '';
          console.log(`    Test profile:   2xx: ${nr.twoxx} (${nr.twoxxPct}%)  4xx: ${nr.fourxx} (${nr.fourxxPct}%)  5xx: ${nr.fivexx} (${nr.fivexxPct}%)${happyMarker}`);
          if (tp.tagGap && tp.tagGap.missingTags.length > 0) {
            console.log(`    Tag gaps:       missing [${tp.tagGap.missingTags.join(', ')}] for ${tp.tagGap.method}`);
          }
        }
      }
    }
    console.log('');
  }

  const tips: string[] = [];
  tips.push('--gaps for prioritized gap analysis');
  if (!detail) tips.push('--detail for per-endpoint depth matrix');
  tips.push('--format markdown to embed in a doc');
  console.log(`Tip: ${tips.join('  |  ')}`);
}
