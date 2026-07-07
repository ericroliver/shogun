/**
 * src/commands/coverage/reporter/json.ts
 * JSON output — with byTag grouping, risk scores, testing profiles, gaps, deps, drift, and delta.
 *
 * Note: The --detail flag has no effect on JSON output. JSON always includes
 * all fields (response codes, parameters, body fields, quality scores, etc.)
 * — the consumer decides what to use.
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
  CoverageGap,
  DependencyGraph,
  SpecDriftReport,
  RunDelta,
} from '../types.js';
import { groupEndpointsByTag, sortedTagNames } from '../analyzer.js';

export function renderJson(
  summary: CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
  responseCodeCoverage?: EndpointResponseCodeCoverage[],
  parameterCoverage?: EndpointParameterCoverage[],
  bodyFieldCoverage?: EndpointBodyFieldCoverage[],
  qualityScores?: EndpointQualityScore[],
  riskScores?: EndpointRiskScore[],
  testingProfiles?: EndpointTestingProfile[],
  gaps?: CoverageGap[],
  gapsMode?: boolean,
  dependencyGraph?: DependencyGraph | null,
  specDrift?: SpecDriftReport | null,
  delta?: RunDelta | null,
): string {
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

  // Collect thin test files (deduplicated + sorted) for summary
  const thinTestFilesSet = new Set<string>();
  if (qualityScores) {
    for (const qs of qualityScores) {
      for (const t of qs.tests) {
        if (t.isThin) thinTestFilesSet.add(t.file);
      }
    }
  }
  const thinTestFiles = [...thinTestFilesSet].sort();

  // Build byTag subtotals
  const groups = groupEndpointsByTag(specEndpoints);
  const byTag: Record<string, {
    totalEndpoints: number;
    coveredEndpoints: number;
    coveragePct: number;
  }> = {};
  for (const tag of sortedTagNames(groups)) {
    const eps = groups.get(tag)!;
    const total = eps.length;
    const covered = eps.filter(e => e.tests.length > 0).length;
    const pct = total > 0 ? Math.round((covered / total) * 1000) / 10 : 0;
    byTag[tag] = { totalEndpoints: total, coveredEndpoints: covered, coveragePct: pct };
  }

  // Sort endpoints by tag, then method, then path
  const sorted = [...specEndpoints].sort((a, b) => {
    const tagA = a.tag ?? '(untagged)';
    const tagB = b.tag ?? '(untagged)';
    if (tagA !== tagB) return tagA.localeCompare(tagB);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });

  const endpoints = sorted
    .filter(ep => !uncoveredOnly || ep.tests.length === 0)
    .map(ep => {
      const rcc = rccMap.get(`${ep.method} ${ep.path}`);
      const pc = pcMap.get(`${ep.method} ${ep.path}`);
      const bfc = bfcMap.get(`${ep.method} ${ep.path}`);
      const qs = qsMap.get(`${ep.method} ${ep.path}`);
      const rs = riskMap.get(`${ep.method} ${ep.path}`);
      const tp = profileMap.get(`${ep.method} ${ep.path}`);
      return {
        method: ep.method,
        path: ep.path,
        tag: ep.tag,
        summary: ep.summary,
        covered: ep.tests.length > 0,
        riskScore: rs ? {
          score: rs.score,
          isUncovered: rs.isUncovered,
          signals: rs.signals,
        } : undefined,
        responseCodeCoverage: rcc ? {
          coveredCount: rcc.coveredCount,
          totalSpecCodes: rcc.totalSpecCodes,
          coveragePct: rcc.coveragePct,
          hasDrift: rcc.hasDrift,
          codes: rcc.allCodes.map(c => ({
            code: c.code,
            inSpec: c.inSpec,
            testedByDeclared: c.testedByDeclared,
            testedByActual: c.testedByActual,
            status: c.status,
          })),
        } : undefined,
        parameterCoverage: pc ? {
          testedCount: pc.testedCount,
          totalCount: pc.totalCount,
          coveragePct: pc.coveragePct,
          hasUntested: pc.hasUntested,
          parameters: pc.parameters.map(p => ({
            name: p.name,
            in: p.in,
            required: p.required,
            tested: p.tested,
            inferredOnly: p.inferredOnly,
          })),
        } : undefined,
        bodyFieldCoverage: bfc ? {
          testedCount: bfc.testedCount,
          totalCount: bfc.totalCount,
          coveragePct: bfc.coveragePct,
          hasUntested: bfc.hasUntested,
          hasUntestedRequired: bfc.hasUntestedRequired,
          fields: bfc.fields.map(f => ({
            name: f.name,
            required: f.required,
            tested: f.tested,
          })),
        } : undefined,
        qualityScore: qs ? {
          normalizedScore: qs.normalizedScore,
          thinTestCount: qs.thinTestCount,
          tests: qs.tests.map(t => ({
            testName: t.testName,
            file: t.file,
            rawScore: t.rawScore,
            isThin: t.isThin,
            breakdown: t.breakdown,
          })),
        } : undefined,
        testingProfile: tp ? {
          negativeRatio: tp.negativeRatio,
          tagGap: tp.tagGap,
        } : undefined,
        tests: ep.tests.map(t => ({
          name: t.name,
          file: t.file,
          collection: t.collection,
          staticPath: t.staticPath,
          tags: t.tags,
          runResult: t.runResult,
        })),
      };
    });

  const summaryOut = { ...summary, thinTestFiles };
  const output: Record<string, unknown> = { summary: summaryOut, byTag, endpoints };
  if (gapsMode && gaps) {
    output.gaps = gaps;
  }
  if (dependencyGraph) {
    output.dependencyGraph = dependencyGraph;
  }
  if (specDrift) {
    output.specDrift = specDrift;
  } else {
    output.specDrift = null;
  }
  if (delta) {
    output.delta = delta;
  }
  return JSON.stringify(output, null, 2);
}
