/**
 * src/commands/coverage/analyzer.ts
 * Coverage analysis — populated in Story 8 (Assertion Quality) and Story 12 (Risk Score).
 */

import type {
  OpenApiSpec,
  SpecEndpoint,
  TestEntry,
  CoverageSummary,
  EndpointResponseCodeCoverage,
  ResponseCodeEntry,
  ResponseCodeStatus,
  EndpointParameterCoverage,
  ParameterCoverageEntry,
  EndpointBodyFieldCoverage,
  BodyFieldCoverageEntry,
  EndpointQualityScore,
  TestQualityScore,
  CoverageGap,
  GapSeverity,
  EndpointRiskScore,
  EndpointTestingProfile,
  NegativeTestingRatio,
  TagCoverageGap,
  VarWrite,
  VarRead,
  DependencyEdge,
  OrphanedVar,
  CascadeRisk,
  DependencyGraph,
  SpecDriftEntry,
  SpecDriftReport,
  RunDelta,
  McpCoverageReport,
  McpMethodCoverage,
  McpToolCoverage,
} from './types.js';
import type { CoverageRiskWeights, RunSummary } from '../../types.js';

// ---------------------------------------------------------------------------
// Group endpoints by spec tag (Story 5)
// ---------------------------------------------------------------------------

export function groupEndpointsByTag(
  specEndpoints: SpecEndpoint[],
): Map<string, SpecEndpoint[]> {
  const groups = new Map<string, SpecEndpoint[]>();
  for (const ep of specEndpoints) {
    const tag = ep.tag ?? '(untagged)';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(ep);
  }
  // Sort endpoints within each group: covered first, then by method+path
  for (const [, eps] of groups) {
    eps.sort((a, b) => {
      const aCovered = a.tests.length > 0 ? 0 : 1;
      const bCovered = b.tests.length > 0 ? 0 : 1;
      if (aCovered !== bCovered) return aCovered - bCovered;
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return a.path.localeCompare(b.path);
    });
  }
  return groups;
}

/**
 * Returns tag names sorted alphabetically, with `(untagged)` always last.
 */
export function sortedTagNames(groups: Map<string, SpecEndpoint[]>): string[] {
  const tags = [...groups.keys()].filter(t => t !== '(untagged)').sort();
  if (groups.has('(untagged)')) tags.push('(untagged)');
  return tags;
}

export function buildSummary(
  openApi: OpenApiSpec,
  specEndpoints: SpecEndpoint[],
  testEntries: TestEntry[],
  responseCodeCoverage?: EndpointResponseCodeCoverage[],
  parameterCoverage?: EndpointParameterCoverage[],
  bodyFieldCoverage?: EndpointBodyFieldCoverage[],
  qualityScores?: EndpointQualityScore[],
  riskScores?: EndpointRiskScore[],
  testingProfiles?: EndpointTestingProfile[],
  specDrift?: SpecDriftReport | null,
  mcpCoverage?: McpCoverageReport | null,
): CoverageSummary {
  const coveredEndpoints = specEndpoints.filter(e => e.tests.length > 0).length;
  const uncoveredEndpoints = specEndpoints.length - coveredEndpoints;
  const collections = new Set(testEntries.map(t => t.collection)).size;
  const pct = specEndpoints.length > 0
    ? Math.round((coveredEndpoints / specEndpoints.length) * 1000) / 10
    : 0;

  // Response code summary stats
  const rcc = responseCodeCoverage ?? computeResponseCodeCoverage(specEndpoints);
  const totalSpecResponseCodes = rcc.reduce((sum, c) => sum + c.totalSpecCodes, 0);
  const coveredResponseCodes = rcc.reduce((sum, c) => sum + c.coveredCount, 0);
  const responseCodeCoveragePct = totalSpecResponseCodes > 0
    ? Math.round((coveredResponseCodes / totalSpecResponseCodes) * 1000) / 10
    : 0;

  // Parameter summary stats
  const pc = parameterCoverage ?? computeParameterCoverage(specEndpoints);
  const totalSpecParams = pc.reduce((sum, c) => sum + c.totalCount, 0);
  const testedParams = pc.reduce((sum, c) => sum + c.testedCount, 0);
  const paramCoveragePct = totalSpecParams > 0
    ? Math.round((testedParams / totalSpecParams) * 1000) / 10
    : 0;

  // Body field summary stats
  const bfc = bodyFieldCoverage ?? computeBodyFieldCoverage(specEndpoints);
  const totalSpecBodyFields = bfc.reduce((sum, c) => sum + c.totalCount, 0);
  const testedBodyFields = bfc.reduce((sum, c) => sum + c.testedCount, 0);
  const bodyFieldCoveragePct = totalSpecBodyFields > 0
    ? Math.round((testedBodyFields / totalSpecBodyFields) * 1000) / 10
    : 0;

  // Assertion quality + thin test stats
  const qs = qualityScores ?? computeAssertionQuality(specEndpoints);
  const avgQualityScore = qs.length > 0
    ? Math.round(qs.reduce((sum, q) => sum + q.normalizedScore, 0) / qs.length)
    : 0;
  const thinTestCount = qs.reduce((sum, q) => sum + q.thinTestCount, 0);

  return {
    apiTitle: openApi.info?.title ?? 'API',
    apiVersion: openApi.info?.version ?? 'unknown',
    totalEndpoints: specEndpoints.length,
    coveredEndpoints,
    uncoveredEndpoints,
    totalTests: testEntries.length,
    collections,
    coveragePct: pct,
    totalSpecResponseCodes,
    coveredResponseCodes,
    responseCodeCoveragePct,
    totalSpecParams,
    testedParams,
    paramCoveragePct,
    totalSpecBodyFields,
    testedBodyFields,
    bodyFieldCoveragePct,
    avgQualityScore,
    thinTestCount,
    highRiskEndpointCount: riskScores
      ? riskScores.filter(r => r.score >= 50).length
      : specEndpoints.filter(e => e.tests.length === 0).length, // uncovered = risk 100
    suiteNegativeRatio: computeSuiteNegativeRatio(testEntries),
    onlyHappyPathCount: testingProfiles
      ? testingProfiles.filter(p => p.negativeRatio.onlyHappyPath).length
      : 0,
    specDriftCount: specDrift ? specDrift.entries.length : 0,
    mcpCoverage: mcpCoverage ?? null,
  };
}

/**
 * Computes the suite-wide negative testing ratio from all test entries.
 */
function computeSuiteNegativeRatio(testEntries: TestEntry[]): NegativeTestingRatio {
  const total = testEntries.length;
  const twoxx = testEntries.filter(t =>
    t.expectedStatus !== undefined && t.expectedStatus >= 200 && t.expectedStatus < 300
  ).length;
  const fourxx = testEntries.filter(t =>
    t.expectedStatus !== undefined && t.expectedStatus >= 400 && t.expectedStatus < 500
  ).length;
  const fivexx = testEntries.filter(t =>
    t.expectedStatus !== undefined && t.expectedStatus >= 500 && t.expectedStatus < 600
  ).length;

  return {
    total,
    twoxx,
    fourxx,
    fivexx,
    twoxxPct: total > 0 ? Math.round((twoxx / total) * 100) : 0,
    fourxxPct: total > 0 ? Math.round((fourxx / total) * 100) : 0,
    fivexxPct: total > 0 ? Math.round((fivexx / total) * 100) : 0,
    onlyHappyPath: fourxx === 0 && fivexx === 0 && total > 0,
  };
}

// ---------------------------------------------------------------------------
// Response code coverage (Story 4)
// ---------------------------------------------------------------------------

export function computeResponseCodeCoverage(
  specEndpoints: SpecEndpoint[],
): EndpointResponseCodeCoverage[] {
  return specEndpoints.map(ep => {
    const specCodes = new Set(ep.documentedResponseCodes);
    const declaredCodes = new Set(
      ep.tests
        .filter(t => t.expectedStatus !== undefined)
        .map(t => String(t.expectedStatus!))
    );

    // Also credit response codes declared via `covers` annotations
    for (const test of ep.tests) {
      if (test.covers) {
        for (const cover of test.covers) {
          // Only credit if this covers annotation targets THIS endpoint
          if (cover.endpoint === `${ep.method} ${ep.path}` && cover.responseCode !== undefined) {
            declaredCodes.add(String(cover.responseCode));
          }
        }
      }
    }

    // Collect actual codes from run results (Story 10)
    const actualCodes = new Set<string>();
    const mismatches: { expected: string; actual: string }[] = [];
    for (const test of ep.tests) {
      if (test.runResult && test.runResult.httpStatus > 0) {
        const actualCode = String(test.runResult.httpStatus);
        actualCodes.add(actualCode);
        // Detect mismatch: test expects X, API returned Y
        if (test.expectedStatus !== undefined &&
            String(test.expectedStatus) !== actualCode) {
          mismatches.push({
            expected: String(test.expectedStatus),
            actual: actualCode,
          });
        }
      }
    }

    // Union of all codes we know about
    const allCodeSet = new Set([...specCodes, ...declaredCodes, ...actualCodes]);
    const allCodes: ResponseCodeEntry[] = [...allCodeSet].sort().map(code => {
      const inSpec = specCodes.has(code);
      const testedByDeclared = declaredCodes.has(code);
      const testedByActual = actualCodes.has(code);

      // Check for mismatch on this code
      const mismatchForCode = mismatches.find(m => m.actual === code || m.expected === code);

      let status: ResponseCodeStatus;
      if (mismatchForCode) {
        status = 'mismatch';
      } else if (inSpec && testedByDeclared) {
        status = 'tested';
      } else if (inSpec && !testedByDeclared) {
        status = 'untested';
      } else {
        status = 'undocumented'; // declared or actual but not in spec
      }

      const entry: ResponseCodeEntry = {
        code,
        inSpec,
        testedByDeclared,
        testedByActual,
        status,
      };

      if (status === 'mismatch' && mismatchForCode) {
        entry.mismatchDetail = `test expects ${mismatchForCode.expected}, API returned ${mismatchForCode.actual}`;
      }

      return entry;
    });

    const coveredCount = allCodes.filter(c => c.status === 'tested').length;
    const totalSpecCodes = ep.documentedResponseCodes.length;
    const coveragePct = totalSpecCodes > 0
      ? Math.round((coveredCount / totalSpecCodes) * 1000) / 10
      : 0;

    return {
      specKey: `${ep.method} ${ep.path}`,
      allCodes,
      coveredCount,
      totalSpecCodes,
      coveragePct,
      hasDrift: allCodes.some(c => c.status === 'undocumented' || c.status === 'mismatch'),
    };
  });
}

// ---------------------------------------------------------------------------
// Parameter coverage (Story 6)
// ---------------------------------------------------------------------------

export function computeParameterCoverage(
  specEndpoints: SpecEndpoint[],
): EndpointParameterCoverage[] {
  return specEndpoints
    .filter(ep => ep.parameters.length > 0)
    .map(ep => {
      // Collect all param names exercised by tests (from YAML request.params + query string)
      const testedParams = new Set<string>();
      for (const test of ep.tests) {
        for (const p of test.requestParams) {
          testedParams.add(p.toLowerCase());
        }
      }

      const hasTests = ep.tests.length > 0;

      const parameters: ParameterCoverageEntry[] = ep.parameters.map(specParam => {
        // Path params are exercised by the mere fact of a test hitting the endpoint
        const tested = specParam.in === 'path'
          ? hasTests
          : testedParams.has(specParam.name.toLowerCase());
        return {
          name: specParam.name,
          in: specParam.in as 'path' | 'query',
          required: specParam.required,
          tested,
          inferredOnly: false, // pre-script heuristic wired in Story 10 extension
        };
      });

      const testedCount = parameters.filter(p => p.tested).length;
      const totalCount = parameters.length;
      return {
        specKey: `${ep.method} ${ep.path}`,
        parameters,
        testedCount,
        totalCount,
        coveragePct: totalCount > 0
          ? Math.round((testedCount / totalCount) * 1000) / 10
          : 100,
        hasUntested: parameters.some(p => !p.tested),
      };
    });
}

// ---------------------------------------------------------------------------
// Request body field coverage (Story 7)
// ---------------------------------------------------------------------------

export function computeBodyFieldCoverage(
  specEndpoints: SpecEndpoint[],
): EndpointBodyFieldCoverage[] {
  return specEndpoints
    .filter(ep =>
      ['POST', 'PUT', 'PATCH'].includes(ep.method) &&
      ep.requestBodyFields.length > 0
    )
    .map(ep => {
      // Collect all body field names exercised across all tests for this endpoint
      const testedFields = new Set<string>();
      for (const test of ep.tests) {
        for (const field of test.requestBodyFields) {
          testedFields.add(field.toLowerCase());
        }
      }

      const fields: BodyFieldCoverageEntry[] = ep.requestBodyFields.map(specField => ({
        name: specField.name,
        required: specField.required,
        tested: testedFields.has(specField.name.toLowerCase()),
      }));

      const testedCount = fields.filter(f => f.tested).length;
      const totalCount = fields.length;
      return {
        specKey: `${ep.method} ${ep.path}`,
        fields,
        testedCount,
        totalCount,
        coveragePct: totalCount > 0
          ? Math.round((testedCount / totalCount) * 1000) / 10
          : 100,
        hasUntested: fields.some(f => !f.tested),
        hasUntestedRequired: fields.some(f => f.required && !f.tested),
      };
    });
}

// ---------------------------------------------------------------------------
// Assertion quality metrics (Story 8) + thin test flag (Story 8b)
// ---------------------------------------------------------------------------

export function computeAssertionQuality(
  specEndpoints: SpecEndpoint[],
): EndpointQualityScore[] {
  return specEndpoints
    .filter(ep => ep.tests.length > 0)
    .map(ep => {
      const testScores: TestQualityScore[] = ep.tests.map(test => {
        const statusScore = test.expectedStatus !== undefined ? 1 : 0;
        const shapeScore = test.shapeAssertions.length * 2;
        const snapshotScore = test.snapshotEnabled ? 3 : 0;
        const postScriptScore = test.postScriptAssertCount;
        const rawScore = statusScore + shapeScore + snapshotScore + postScriptScore;

        return {
          testName: test.name,
          file: test.file,
          rawScore,
          isThin: rawScore <= 1,
          breakdown: { statusScore, shapeScore, snapshotScore, postScriptScore },
        };
      });

      // Normalize to 0–100: sum raw scores, cap at a "perfect" ceiling of 10 per test
      // Perfect test = status(1) + 3 shape entries(6) + snapshot(3) = 10
      const PERFECT_PER_TEST = 10;
      const maxPossible = ep.tests.length * PERFECT_PER_TEST;
      const totalRaw = testScores.reduce((sum, t) => sum + t.rawScore, 0);
      const normalizedScore = maxPossible > 0
        ? Math.min(100, Math.round((totalRaw / maxPossible) * 100))
        : 0;

      return {
        specKey: `${ep.method} ${ep.path}`,
        tests: testScores,
        normalizedScore,
        thinTestCount: testScores.filter(t => t.isThin).length,
      };
    });
}

// ---------------------------------------------------------------------------
// Gap analysis (Story 11)
// ---------------------------------------------------------------------------

export function collectAllGaps(
  specEndpoints: SpecEndpoint[],
  responseCodeCoverage: EndpointResponseCodeCoverage[],
  paramCoverage: EndpointParameterCoverage[],
  bodyFieldCoverage: EndpointBodyFieldCoverage[],
  qualityScores: EndpointQualityScore[],
  testingProfiles?: EndpointTestingProfile[],
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const rcMap = new Map(responseCodeCoverage.map(r => [r.specKey, r]));
  const paramMap = new Map(paramCoverage.map(p => [p.specKey, p]));
  const bodyMap = new Map(bodyFieldCoverage.map(b => [b.specKey, b]));
  const qualMap = new Map(qualityScores.map(q => [q.specKey, q]));
  const profileMap = new Map<string, EndpointTestingProfile>();
  if (testingProfiles) {
    for (const tp of testingProfiles) profileMap.set(tp.specKey, tp);
  }

  for (const ep of specEndpoints) {
    const specKey = `${ep.method} ${ep.path}`;

    // Uncovered endpoint
    if (ep.tests.length === 0) {
      gaps.push({ severity: 'CRITICAL', category: 'Uncovered endpoint', endpoint: specKey, detail: 'No tests target this endpoint' });
      continue; // no further gaps possible for uncovered endpoints
    }

    // Response code gaps
    const rc = rcMap.get(specKey);
    if (rc) {
      for (const code of rc.allCodes) {
        if (code.status === 'untested') {
          const is4xxOr5xx = code.code.startsWith('4') || code.code.startsWith('5');
          gaps.push({
            severity: is4xxOr5xx ? 'HIGH' : 'MEDIUM',
            category: 'Untested response code',
            endpoint: specKey,
            detail: `${code.code} is documented but no test declares this status`,
          });
        }
        if (code.status === 'undocumented') {
          gaps.push({ severity: 'HIGH', category: 'Spec drift', endpoint: specKey, detail: `${code.code} returned by API but not in spec` });
        }
        if (code.status === 'mismatch' && code.mismatchDetail) {
          gaps.push({ severity: 'HIGH', category: 'Test-vs-reality mismatch', endpoint: specKey, detail: code.mismatchDetail });
        }
      }
    }

    // Body field gaps
    const body = bodyMap.get(specKey);
    if (body) {
      for (const field of body.fields) {
        if (!field.tested) {
          gaps.push({
            severity: field.required ? 'HIGH' : 'MEDIUM',
            category: field.required ? 'Untested required body field' : 'Untested optional body field',
            endpoint: specKey,
            detail: `Field "${field.name}" is never sent in any test`,
          });
        }
      }
    }

    // Parameter gaps
    const params = paramMap.get(specKey);
    if (params) {
      for (const param of params.parameters) {
        if (!param.tested) {
          gaps.push({
            severity: 'MEDIUM',
            category: 'Untested parameter',
            endpoint: specKey,
            detail: `${param.in} param "${param.name}" is never exercised`,
          });
        }
      }
    }

    // Thin tests + failing tests
    const qual = qualMap.get(specKey);
    if (qual) {
      for (const test of qual.tests) {
        if (test.isThin) {
          gaps.push({
            severity: 'LOW',
            category: 'Thin test',
            endpoint: specKey,
            detail: `"${test.testName}" has only a status check (score: ${test.rawScore})`,
            file: test.file,
          });
        }
      }
    }
    // Failing tests (requires run data)
    for (const test of ep.tests) {
      if (test.runResult?.status === 'failed') {
        gaps.push({
          severity: 'HIGH',
          category: 'Failing test',
          endpoint: specKey,
          detail: `"${test.name}" failed in last run`,
          file: test.file,
        });
      }
    }

    // Only happy-path tests (Story 13)
    const profile = profileMap.get(specKey);
    if (profile?.negativeRatio.onlyHappyPath) {
      gaps.push({
        severity: 'MEDIUM',
        category: 'Only happy-path tests',
        endpoint: specKey,
        detail: `${profile.negativeRatio.total} tests, all expecting 2xx — no error-path coverage`,
      });
    }

    // Missing expected tags (Story 13)
    if (profile?.tagGap && profile.tagGap.missingTags.length > 0) {
      gaps.push({
        severity: 'LOW',
        category: 'Missing expected tags',
        endpoint: specKey,
        detail: `Missing [${profile.tagGap.missingTags.join(', ')}] for ${profile.tagGap.method}`,
      });
    }
  }

  // Sort: CRITICAL first, then HIGH, MEDIUM, LOW; within severity by endpoint
  const severityOrder: Record<GapSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  gaps.sort((a, b) => {
    const sd = severityOrder[a.severity] - severityOrder[b.severity];
    if (sd !== 0) return sd;
    return a.endpoint.localeCompare(b.endpoint);
  });

  return gaps;
}

// ---------------------------------------------------------------------------
// Risk score (Story 12)
// ---------------------------------------------------------------------------

export function computeRiskScores(
  specEndpoints: SpecEndpoint[],
  responseCodeCoverage: EndpointResponseCodeCoverage[],
  paramCoverage: EndpointParameterCoverage[],
  bodyFieldCoverage: EndpointBodyFieldCoverage[],
  qualityScores: EndpointQualityScore[],
  weights: CoverageRiskWeights,
): EndpointRiskScore[] {
  const rcMap = new Map(responseCodeCoverage.map(r => [r.specKey, r]));
  const paramMap = new Map(paramCoverage.map(p => [p.specKey, p]));
  const bodyMap = new Map(bodyFieldCoverage.map(b => [b.specKey, b]));
  const qualMap = new Map(qualityScores.map(q => [q.specKey, q]));

  return specEndpoints.map(ep => {
    const specKey = `${ep.method} ${ep.path}`;

    if (ep.tests.length === 0) {
      return {
        specKey,
        score: 100,
        isUncovered: true,
        signals: { responseCodeGap: 1, parameterGap: 1, bodyFieldGap: 1, assertionQuality: 1, runResults: 0 },
      };
    }

    const rc = rcMap.get(specKey);
    const responseCodeGap = rc && rc.totalSpecCodes > 0
      ? 1 - (rc.coveredCount / rc.totalSpecCodes)
      : 0;

    const param = paramMap.get(specKey);
    const parameterGap = param && param.totalCount > 0
      ? 1 - (param.testedCount / param.totalCount)
      : 0;

    const body = bodyMap.get(specKey);
    const bodyFieldGap = body && body.totalCount > 0
      ? 1 - (body.testedCount / body.totalCount)
      : 0;

    const qual = qualMap.get(specKey);
    const assertionQuality = qual
      ? 1 - (qual.normalizedScore / 100)
      : 0;

    const totalTests = ep.tests.length;
    const failedTests = ep.tests.filter(t => t.runResult?.status === 'failed').length;
    const runResults = totalTests > 0 ? failedTests / totalTests : 0;

    const rawScore =
      weights.responseCodeGap  * responseCodeGap  +
      weights.parameterGap     * parameterGap     +
      weights.bodyFieldGap     * bodyFieldGap     +
      weights.assertionQuality * assertionQuality +
      weights.runResults       * runResults;

    return {
      specKey,
      score: Math.min(100, Math.round(rawScore * 100)),
      isUncovered: false,
      signals: { responseCodeGap, parameterGap, bodyFieldGap, assertionQuality, runResults },
    };
  });
}

// ---------------------------------------------------------------------------
// Negative testing & tag intelligence (Story 13)
// ---------------------------------------------------------------------------

export function computeTestingProfiles(
  specEndpoints: SpecEndpoint[],
  expectedTagsByMethod: Record<string, string[]>,
): EndpointTestingProfile[] {
  return specEndpoints
    .filter(ep => ep.tests.length > 0)
    .map(ep => {
      const specKey = `${ep.method} ${ep.path}`;

      // Negative testing ratio
      const total = ep.tests.length;
      const twoxx = ep.tests.filter(t =>
        t.expectedStatus !== undefined && t.expectedStatus >= 200 && t.expectedStatus < 300
      ).length;
      const fourxx = ep.tests.filter(t =>
        t.expectedStatus !== undefined && t.expectedStatus >= 400 && t.expectedStatus < 500
      ).length;
      const fivexx = ep.tests.filter(t =>
        t.expectedStatus !== undefined && t.expectedStatus >= 500 && t.expectedStatus < 600
      ).length;

      const negativeRatio: NegativeTestingRatio = {
        total,
        twoxx,
        fourxx,
        fivexx,
        twoxxPct: total > 0 ? Math.round((twoxx / total) * 100) : 0,
        fourxxPct: total > 0 ? Math.round((fourxx / total) * 100) : 0,
        fivexxPct: total > 0 ? Math.round((fivexx / total) * 100) : 0,
        onlyHappyPath: fourxx === 0 && fivexx === 0 && total > 0,
      };

      // Tag coverage gap
      // Tag matching is case-sensitive — tags in test YAML must match config exactly
      const methodUpper = ep.method.toUpperCase();
      const expectedTags = expectedTagsByMethod[methodUpper] ?? [];
      let tagGap: TagCoverageGap | undefined;

      if (expectedTags.length > 0) {
        const presentTagsSet = new Set(ep.tests.flatMap(t => t.tags));
        const missingTags = expectedTags.filter(tag => !presentTagsSet.has(tag));
        tagGap = {
          method: methodUpper,
          expectedTags,
          presentTags: [...presentTagsSet],
          missingTags,
        };
      }

      return { specKey, negativeRatio, tagGap };
    });
}

// ---------------------------------------------------------------------------
// Test dependency graph (Story 14)
// ---------------------------------------------------------------------------

export function buildDependencyGraph(testEntries: TestEntry[]): DependencyGraph {
  const writes: VarWrite[] = [];
  const reads: VarRead[] = [];

  // Write: ctx.vars.X = ... (assignment, not equality check)
  // Match = not followed by another = (excludes === and ==)
  const writeRegex = /ctx\.vars\.(\w+)\s*=(?!=)/g;
  // Read: ctx.vars.X not in an assignment context
  const readRegex = /ctx\.vars\.(\w+)(?!\s*=)/g;

  for (const test of testEntries) {
    // Scan pre script
    if (test.preScriptBody) {
      scanScript(test.preScriptBody, 'pre', test, writes, reads, writeRegex, readRegex);
    }
    // Scan post script
    if (test.postScriptBody) {
      scanScript(test.postScriptBody, 'post', test, writes, reads, writeRegex, readRegex);
    }
  }

  // Build var → writers map
  const writersByVar = new Map<string, VarWrite[]>();
  for (const w of writes) {
    if (!writersByVar.has(w.varName)) writersByVar.set(w.varName, []);
    writersByVar.get(w.varName)!.push(w);
  }

  // Build edges: for each read, find the writer(s) of that var
  const edges: DependencyEdge[] = [];
  for (const read of reads) {
    const writers = writersByVar.get(read.varName) ?? [];
    for (const writer of writers) {
      edges.push({
        varName: read.varName,
        producer: { testName: writer.testName, collection: writer.collection, file: writer.file },
        consumer: { testName: read.testName, collection: read.collection, file: read.file },
        crossCollection: writer.collection !== read.collection,
      });
    }
  }

  // Orphaned vars: written but never read
  const readVarNames = new Set(reads.map(r => r.varName));
  const orphanedVars: OrphanedVar[] = [];
  for (const [varName, writers] of writersByVar) {
    if (!readVarNames.has(varName)) {
      for (const w of writers) {
        orphanedVars.push({ varName, writtenBy: { testName: w.testName, collection: w.collection, file: w.file } });
      }
    }
  }

  // Cascade risks: vars with 3+ consumers from a single producer
  const cascadeRisks: CascadeRisk[] = [];
  const edgesByProducerVar = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const key = `${edge.varName}::${edge.producer.testName}::${edge.producer.collection}`;
    if (!edgesByProducerVar.has(key)) edgesByProducerVar.set(key, []);
    edgesByProducerVar.get(key)!.push(edge);
  }
  for (const [, edgeGroup] of edgesByProducerVar) {
    if (edgeGroup.length >= 3) {
      const first = edgeGroup[0]!;
      cascadeRisks.push({
        varName: first.varName,
        producer: first.producer,
        consumerCount: edgeGroup.length,
        consumers: edgeGroup.map(e => e.consumer),
      });
    }
  }

  const crossCollectionDeps = edges.filter(e => e.crossCollection);

  return { edges, orphanedVars, cascadeRisks, crossCollectionDeps };
}

function scanScript(
  script: string,
  scriptType: 'pre' | 'post',
  test: TestEntry,
  writes: VarWrite[],
  reads: VarRead[],
  writeRegex: RegExp,
  readRegex: RegExp,
): void {
  // Find all writes
  let match: RegExpExecArray | null;
  const writeRegexLocal = new RegExp(writeRegex.source, 'g');
  while ((match = writeRegexLocal.exec(script)) !== null) {
    writes.push({
      varName: match[1]!,
      testName: test.name,
      collection: test.collection,
      file: test.file,
      scriptType,
    });
  }

  // Find all reads — exclude positions that are part of a write
  const writePositions = new Set<number>();
  const writeRegexForPos = new RegExp(writeRegex.source, 'g');
  while ((match = writeRegexForPos.exec(script)) !== null) {
    // Mark the ctx.vars.X part as a write position
    const ctxIdx = script.indexOf('ctx.vars', match.index);
    if (ctxIdx >= 0) {
      writePositions.add(ctxIdx);
    }
  }

  const readRegexLocal = new RegExp(readRegex.source, 'g');
  while ((match = readRegexLocal.exec(script)) !== null) {
    const ctxIdx = script.indexOf('ctx.vars', match.index);
    if (ctxIdx >= 0 && writePositions.has(ctxIdx)) continue; // skip writes
    reads.push({
      varName: match[1]!,
      testName: test.name,
      collection: test.collection,
      file: test.file,
      scriptType,
    });
  }
}

// ---------------------------------------------------------------------------
// Spec drift detection (Story 17)
// ---------------------------------------------------------------------------

export function computeSpecDrift(
  specEndpoints: SpecEndpoint[],
  suppressedCodes: string[] = [],
): SpecDriftReport {
  const entries: SpecDriftEntry[] = [];
  const suppressedSet = new Set(suppressedCodes.map(c => c.trim()));
  const suppressedEntries: SpecDriftEntry[] = [];

  for (const ep of specEndpoints) {
    const specKey = `${ep.method} ${ep.path}`;
    const specCodes = new Set(ep.documentedResponseCodes);

    for (const test of ep.tests) {
      if (!test.runResult) continue;

      const actualCode = String(test.runResult.httpStatus);
      const expectedCode = test.expectedStatus !== undefined
        ? String(test.expectedStatus)
        : undefined;

      // Undocumented actual code: API returned a code not in spec
      // Skip httpStatus === 0 (curl connection failures — not spec drift)
      if (actualCode !== '0' && !specCodes.has(actualCode)) {
        // Only add once per endpoint+code combination
        const alreadyAdded = entries.some(
          e => e.type === 'undocumented-code' && e.endpoint === specKey && e.code === actualCode
        );
        const alreadySuppressed = suppressedEntries.some(
          e => e.type === 'undocumented-code' && e.endpoint === specKey && e.code === actualCode
        );
        if (!alreadyAdded && !alreadySuppressed) {
          const entry: SpecDriftEntry = {
            type: 'undocumented-code',
            endpoint: specKey,
            code: actualCode,
            detail: `API returned ${actualCode} but spec does not document this code`,
          };
          if (suppressedSet.has(actualCode)) {
            suppressedEntries.push(entry);
          } else {
            entries.push(entry);
          }
        }
      }

      // Test-vs-reality mismatch: test expected X, API returned Y
      // (Not subject to suppression — these are always actionable.)
      if (
        expectedCode !== undefined &&
        actualCode !== '0' &&
        actualCode !== expectedCode
      ) {
        entries.push({
          type: 'test-vs-reality',
          endpoint: specKey,
          code: actualCode,
          detail: `Test expects ${expectedCode}, API returned ${actualCode}`,
          testName: test.name,
          testFile: test.file,
        });
      }
    }
  }

  const undocumentedCodeCount = entries.filter(e => e.type === 'undocumented-code').length;
  const testVsRealityCount = entries.filter(e => e.type === 'test-vs-reality').length;
  const affectedEndpoints = [...new Set(entries.map(e => e.endpoint))];

  return {
    entries,
    undocumentedCodeCount,
    testVsRealityCount,
    affectedEndpoints,
    suppressedCodes: [...suppressedSet].sort(),
    suppressedCount: suppressedEntries.length,
    suppressedEndpointCount: new Set(suppressedEntries.map(e => e.endpoint)).size,
  };
}

// ---------------------------------------------------------------------------
// Run delta / compare (Story 15)
// ---------------------------------------------------------------------------

export function computeRunDelta(
  newer: RunSummary,
  older: RunSummary,
  specEndpoints: SpecEndpoint[],
): RunDelta {
  // Build endpoint coverage sets from run results
  // An endpoint is "covered" in a run if any test for it passed or failed
  const buildCoveredSet = (run: RunSummary): Set<string> => {
    const covered = new Set<string>();
    // Build test → endpoint lookup from specEndpoints
    for (const ep of specEndpoints) {
      const specKey = `${ep.method} ${ep.path}`;
      for (const test of ep.tests) {
        const result = run.results.find(r => r.name === test.name && r.file === test.file);
        if (result) {
          covered.add(specKey);
          break;
        }
      }
    }
    return covered;
  };

  const newerCovered = buildCoveredSet(newer);
  const olderCovered = buildCoveredSet(older);

  const newlyCovered = [...newerCovered].filter(e => !olderCovered.has(e)).sort();
  const lostCoverage = [...olderCovered].filter(e => !newerCovered.has(e)).sort();
  const stillUncovered = specEndpoints
    .filter(ep => {
      const specKey = `${ep.method} ${ep.path}`;
      return !newerCovered.has(specKey) && !olderCovered.has(specKey);
    })
    .map(ep => `${ep.method} ${ep.path}`)
    .sort();

  // Build test identity sets: "collection/test-name"
  const buildTestSet = (run: RunSummary): Set<string> => {
    const set = new Set<string>();
    for (const r of run.results) {
      const parts = r.file.replace(/\\/g, '/').split('/');
      const collIdx = parts.indexOf('collections');
      const collection = collIdx >= 0 ? (parts[collIdx + 1] ?? '') : '';
      set.add(`${collection}/${r.name}`);
    }
    return set;
  };

  const newerTests = buildTestSet(newer);
  const olderTests = buildTestSet(older);

  const testsAdded = [...newerTests].filter(t => !olderTests.has(t)).sort();
  const testsRemoved = [...olderTests].filter(t => !newerTests.has(t)).sort();

  // Pass/fail status changes
  const buildStatusMap = (run: RunSummary): Map<string, 'passed' | 'failed'> => {
    const map = new Map<string, 'passed' | 'failed'>();
    for (const r of run.results) {
      const parts = r.file.replace(/\\/g, '/').split('/');
      const collIdx = parts.indexOf('collections');
      const collection = collIdx >= 0 ? (parts[collIdx + 1] ?? '') : '';
      const key = `${collection}/${r.name}`;
      if (r.status === 'passed' || r.status === 'failed') {
        map.set(key, r.status);
      }
    }
    return map;
  };

  const newerStatus = buildStatusMap(newer);
  const olderStatus = buildStatusMap(older);

  const testsNowPassing: string[] = [];
  const testsNowFailing: string[] = [];
  for (const [key, newStatus] of newerStatus) {
    const oldStatus = olderStatus.get(key);
    if (oldStatus === 'failed' && newStatus === 'passed') testsNowPassing.push(key);
    if (oldStatus === 'passed' && newStatus === 'failed') testsNowFailing.push(key);
  }

  // Summary stats
  const endpointCoverageDelta = newerCovered.size - olderCovered.size;
  const newerPassRate = newer.total > 0 ? (newer.passed / newer.total) * 100 : 0;
  const olderPassRate = older.total > 0 ? (older.passed / older.total) * 100 : 0;
  const passRateDelta = Math.round((newerPassRate - olderPassRate) * 10) / 10;

  return {
    newerRunId: newer.runId,
    olderRunId: older.runId,
    newerSuite: newer.suite,
    olderSuite: older.suite,
    newlyCovered,
    lostCoverage,
    stillUncovered,
    testsAdded,
    testsRemoved,
    testsNowPassing: testsNowPassing.sort(),
    testsNowFailing: testsNowFailing.sort(),
    endpointCoverageDelta,
    passRateDelta,
  };
}

// ---------------------------------------------------------------------------
// MCP / JSON-RPC coverage (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Compute MCP / JSON-RPC coverage from test entries.
 *
 * Returns null if no tests have a jsonrpcMethod (i.e. no MCP tests in the suite).
 * Otherwise, returns a report with:
 *   - Per JSON-RPC method counts (tools/call, initialize, tools/list, etc.)
 *   - Per MCP tool name counts (only for tools/call methods)
 *   - Count of tools/call tests with no tool name extracted (potential issue)
 */
export function computeMcpCoverage(testEntries: TestEntry[]): McpCoverageReport | null {
  const mcpTests = testEntries.filter(t => t.jsonrpcMethod !== undefined);
  if (mcpTests.length === 0) return null;

  // Group by JSON-RPC method
  const methodMap = new Map<string, Array<{ name: string; file: string; collection: string }>>();
  for (const test of mcpTests) {
    const method = test.jsonrpcMethod!;
    if (!methodMap.has(method)) methodMap.set(method, []);
    methodMap.get(method)!.push({
      name: test.name,
      file: test.file,
      collection: test.collection,
    });
  }

  const methods: McpMethodCoverage[] = [...methodMap.entries()]
    .map(([method, tests]) => ({
      method,
      testCount: tests.length,
      tests: tests.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.testCount - a.testCount);

  // Group by MCP tool name (only for tools/call)
  const toolMap = new Map<string, Array<{ name: string; file: string; collection: string }>>();
  let unnamedToolCallCount = 0;

  for (const test of mcpTests) {
    if (test.jsonrpcMethod !== 'tools/call') continue;
    if (test.mcpToolName) {
      if (!toolMap.has(test.mcpToolName)) toolMap.set(test.mcpToolName, []);
      toolMap.get(test.mcpToolName)!.push({
        name: test.name,
        file: test.file,
        collection: test.collection,
      });
    } else {
      unnamedToolCallCount++;
    }
  }

  const tools: McpToolCoverage[] = [...toolMap.entries()]
    .map(([tool, tests]) => ({
      tool,
      testCount: tests.length,
      tests: tests.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.testCount - a.testCount);

  return {
    totalMcpTests: mcpTests.length,
    methods,
    tools,
    unnamedToolCallCount,
  };
}
