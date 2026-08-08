/**
 * src/commands/coverage/index.ts
 * `shogun coverage` — API test coverage matrix.
 *
 * Cross-references the OpenAPI spec against every test YAML in the configured
 * collections directory and emits a coverage report. No HTTP calls to the API
 * under test — this is purely static file I/O + spec fetch.
 */

import {
  loadConfig,
  loadEnv,
  fetchSpec,
  resolveCoverageConfig,
} from '../../loader.js';
import type { ShogunConfig, RunSummary } from '../../types.js';
import type {
  OpenApiSpec,
  SpecEndpoint,
  TestEntry,
  EndpointResponseCodeCoverage,
  EndpointParameterCoverage,
  EndpointBodyFieldCoverage,
  EndpointQualityScore,
  CoverageGap,
  EndpointRiskScore,
  EndpointTestingProfile,
  DependencyGraph,
  SpecDriftReport,
  RunDelta,
  McpCoverageReport,
} from './types.js';
import { extractSpecEndpoints } from './spec-extractor.js';
import { collectTestEntries } from './test-collector.js';
import { matchTests } from './matcher.js';
import {
  buildSummary,
  computeResponseCodeCoverage,
  computeParameterCoverage,
  computeBodyFieldCoverage,
  computeAssertionQuality,
  collectAllGaps,
  computeRiskScores,
  computeTestingProfiles,
  buildDependencyGraph,
  computeSpecDrift,
  computeRunDelta,
  computeMcpCoverage,
} from './analyzer.js';
import { loadRunForCoverage, joinRunResultsToTests, loadTwoRunsForCompare } from './run-loader.js';
import { renderPretty } from './reporter/pretty.js';
import { renderJson } from './reporter/json.js';
import { renderMarkdown } from './reporter/markdown.js';
import { renderGaps } from './reporter/gaps.js';
import { renderDeps } from './reporter/deps.js';
import { renderCompare } from './reporter/compare.js';
import { writeOutput } from './reporter/output.js';

// Re-export public types
export type { CoverageArgs } from './types.js';

export async function coverage(args: import('./types.js').CoverageArgs): Promise<number> {
  const cwd = args.cwd ?? process.cwd();

  // 1. Load config
  let config: ShogunConfig;
  try {
    config = loadConfig(cwd);
  } catch {
    config = { version: 1 as const };
  }

  // 2. Load env (optional — needed when spec is a live relative URL)
  let env: Record<string, string> = {};
  const envName = args.env ?? config.defaults?.env;
  if (envName) {
    try {
      env = loadEnv(envName, config, cwd);
    } catch {
      // swallow — env may not be needed if spec is a local file or full URL
    }
  }

  // 3. Fetch + parse spec
  let openApi: OpenApiSpec;
  try {
    const result = await fetchSpec(args.specSource, config, env, cwd);
    openApi = JSON.parse(result.raw) as OpenApiSpec;
  } catch (err) {
    console.error(`Error fetching/parsing spec: ${(err as Error).message}`);
    return 1;
  }

  // 4. Extract spec endpoints (with optional tag filter)
  const specEndpoints: SpecEndpoint[] = extractSpecEndpoints(openApi, args.tag);

  // 5. Collect test entries (with optional collection/suite filter)
  let testEntries: TestEntry[];
  try {
    testEntries = await collectTestEntries(config, cwd, args.collection, args.suite);
  } catch (err) {
    console.error(`Error scanning tests: ${(err as Error).message}`);
    return 1;
  }

  if (testEntries.length === 0 && !args.suite && !args.collection) {
    console.error('No test files found. Is the tests/collections directory present?');
    return 1;
  }

  // 6. Match tests → spec endpoints
  matchTests(testEntries, specEndpoints);

  const coverageConfig = resolveCoverageConfig(config);

  // 7. --compare mode: load two runs, compute delta, render compare report
  if (args.compare || args.compareRunIds) {
    const twoRuns = loadTwoRunsForCompare(
      { compare: args.compare, compareRunIds: args.compareRunIds, suite: args.suite },
      { defaultSuite: coverageConfig.defaultSuite },
      config,
      cwd,
    );

    if (!twoRuns) {
      const suiteFilter = args.suite === 'any'
        ? undefined
        : (args.suite ?? coverageConfig.defaultSuite);
      if (args.compareRunIds) {
        console.error(`Error: Could not load both runs for comparison. Check run IDs.`);
      } else if (suiteFilter) {
        console.error(
          `Error: Need at least 2 runs to compare. Fewer than 2 runs found for suite "${suiteFilter}".\n` +
          `Run \`shogun run --suite ${suiteFilter} --env ${envName ?? 'local'}\` again to generate a second run.`
        );
      } else {
        console.error('Error: Need at least 2 runs to compare. Fewer than 2 runs found.');
      }
      return 1;
    }

    const [newerRun, olderRun] = twoRuns;
    const delta: RunDelta = computeRunDelta(newerRun, olderRun, specEndpoints);

    // Compute summary for the newer run
    joinRunResultsToTests(testEntries, newerRun);
    const responseCodeCoverage = computeResponseCodeCoverage(specEndpoints);
    const parameterCoverage = computeParameterCoverage(specEndpoints);
    const bodyFieldCoverage = computeBodyFieldCoverage(specEndpoints);
    const qualityScores = computeAssertionQuality(specEndpoints);
    const riskScores = computeRiskScores(specEndpoints, responseCodeCoverage, parameterCoverage, bodyFieldCoverage, qualityScores, coverageConfig.riskWeights);
    const testingProfiles = computeTestingProfiles(specEndpoints, coverageConfig.expectedTagsByMethod);
    const specDrift = computeSpecDrift(specEndpoints, resolveSuppressedDrift(coverageConfig.suppressDrift, args.suppressDrift));
    const mcpCoverage = computeMcpCoverage(testEntries);

    const summary = buildSummary(openApi, specEndpoints, testEntries, responseCodeCoverage, parameterCoverage, bodyFieldCoverage, qualityScores, riskScores, testingProfiles, specDrift, mcpCoverage);

    if (args.format === 'json') {
      const jsonOutput = renderJson(summary, specEndpoints, false, responseCodeCoverage, parameterCoverage, bodyFieldCoverage, qualityScores, riskScores, testingProfiles, undefined, false, null, specDrift, delta, mcpCoverage);
      writeOutput(jsonOutput, args.out);
    } else {
      const compareOutput = renderCompare(summary, delta);
      writeOutput(compareOutput, args.out);
    }

    return evaluateThresholds(summary, coverageConfig, args);
  }

  // 8. Load run results if requested (--last-run or --run)
  let runSummary: RunSummary | null = null;
  if (args.lastRun || args.runId) {
    runSummary = loadRunForCoverage(
      { lastRun: args.lastRun, runId: args.runId, suite: args.suite },
      { defaultSuite: coverageConfig.defaultSuite },
      config,
      cwd,
    );

    if (!runSummary) {
      const suiteFilter = args.suite === 'any'
        ? undefined
        : (args.suite ?? coverageConfig.defaultSuite);
      if (args.runId) {
        console.error(`Error: Run "${args.runId}" not found in runs/ directory.`);
      } else if (suiteFilter) {
        console.error(
          `Error: No run found for suite "${suiteFilter}".\n` +
          `Run \`shogun run --suite ${suiteFilter} --env ${envName ?? 'local'}\` first, or use --suite <name> to target a different suite.\n` +
          `Use --suite any to load the truly latest run regardless of suite.`
        );
      } else {
        console.error('Error: No runs found in the runs/ directory.');
      }
      return 1;
    }

    joinRunResultsToTests(testEntries, runSummary);
  }

  // 9. Compute coverage dimensions (after run data is joined)
  const responseCodeCoverage: EndpointResponseCodeCoverage[] =
    computeResponseCodeCoverage(specEndpoints);
  const parameterCoverage: EndpointParameterCoverage[] =
    computeParameterCoverage(specEndpoints);
  const bodyFieldCoverage: EndpointBodyFieldCoverage[] =
    computeBodyFieldCoverage(specEndpoints);
  const qualityScores: EndpointQualityScore[] =
    computeAssertionQuality(specEndpoints);

  // 10. Compute risk scores (Story 12)
  const riskScores: EndpointRiskScore[] = computeRiskScores(
    specEndpoints,
    responseCodeCoverage,
    parameterCoverage,
    bodyFieldCoverage,
    qualityScores,
    coverageConfig.riskWeights,
  );

  // 11. Compute testing profiles (Story 13)
  const testingProfiles: EndpointTestingProfile[] = computeTestingProfiles(
    specEndpoints,
    coverageConfig.expectedTagsByMethod,
  );

  // 12. Compute spec drift (Story 17 — only when run data is present)
  const suppressedDrift = resolveSuppressedDrift(coverageConfig.suppressDrift, args.suppressDrift);
  const specDrift: SpecDriftReport | null = runSummary ? computeSpecDrift(specEndpoints, suppressedDrift) : null;

  // 13. Compute gaps (Story 11 + Story 13 extension)
  const gaps: CoverageGap[] = collectAllGaps(
    specEndpoints,
    responseCodeCoverage,
    parameterCoverage,
    bodyFieldCoverage,
    qualityScores,
    testingProfiles,
  );

  // 14. Compute dependency graph (Story 14 — only when --deps is set)
  let dependencyGraph: DependencyGraph | null = null;
  if (args.deps) {
    dependencyGraph = buildDependencyGraph(testEntries);
  }

  // 14b. Compute MCP coverage (Phase 3)
  const mcpCoverage: McpCoverageReport | null = computeMcpCoverage(testEntries);

  // 15. Build summary
  const summary = buildSummary(
    openApi,
    specEndpoints,
    testEntries,
    responseCodeCoverage,
    parameterCoverage,
    bodyFieldCoverage,
    qualityScores,
    riskScores,
    testingProfiles,
    specDrift,
    mcpCoverage,
  );

  // 16. Render
  const format = args.format ?? 'pretty';
  const gapsMode = args.gaps ?? args.uncovered ?? false;

  if (format === 'json') {
    const jsonOutput = renderJson(summary, specEndpoints, gapsMode, responseCodeCoverage, parameterCoverage, bodyFieldCoverage, qualityScores, riskScores, testingProfiles, gaps, gapsMode, dependencyGraph, specDrift, null, mcpCoverage);
    writeOutput(jsonOutput, args.out);
    return evaluateThresholds(summary, coverageConfig, args);
  }

  if (gapsMode) {
    // Issue 7: when --collection is set, scope gaps to endpoints that have at
    // least one test from the scoped collection(s). Uncovered endpoints with
    // no tests from the collection are excluded — they aren't actionable in a
    // collection-focused gap review.
    let scopedGaps = gaps;
    if (args.collection) {
      const collSet = new Set(
        Array.isArray(args.collection) ? args.collection : [args.collection]
      );
      const scopedEndpoints = new Set<string>();
      for (const ep of specEndpoints) {
        if (ep.tests.some(t => collSet.has(t.collection))) {
          scopedEndpoints.add(`${ep.method} ${ep.path}`);
        }
      }
      scopedGaps = gaps.filter(g => scopedEndpoints.has(g.endpoint));
    }

    let output = renderSummaryHeaderStr(summary, runSummary);
    if (format === 'markdown') {
      output += renderMarkdownStr(summary, specEndpoints, true, responseCodeCoverage);
    } else {
      output += renderGapsStr(summary, scopedGaps, riskScores, args.top);
    }
    if (dependencyGraph) {
      output += renderDepsStr(dependencyGraph);
    }
    writeOutput(output, args.out);
    return evaluateThresholds(summary, coverageConfig, args);
  }

  if (format === 'markdown') {
    const output = renderMarkdownStr(summary, specEndpoints, false, responseCodeCoverage);
    writeOutput(output, args.out);
    return evaluateThresholds(summary, coverageConfig, args);
  }

  // Pretty — capture output as string for --out support
  let prettyOutput = renderPrettyStr(summary, specEndpoints, false, responseCodeCoverage, parameterCoverage, bodyFieldCoverage, qualityScores, riskScores, testingProfiles, args.detail ?? false, runSummary, specDrift, mcpCoverage);
  if (dependencyGraph) {
    prettyOutput += renderDepsStr(dependencyGraph);
  }
  writeOutput(prettyOutput, args.out);
  return evaluateThresholds(summary, coverageConfig, args);
}

// ---------------------------------------------------------------------------
// Suppressed drift resolution (Issue 3)
// ---------------------------------------------------------------------------

/**
 * Merge config-level suppressed drift codes with CLI --suppress-drift codes.
 * CLI flags augment (never replace) the config default. Codes are normalised
 * to strings and trimmed. An empty array means "suppress nothing".
 */
function resolveSuppressedDrift(
  configCodes: string[],
  cliCodes?: string[],
): string[] {
  const merged = new Set<string>(configCodes.map(c => c.trim()).filter(Boolean));
  if (cliCodes) {
    for (const c of cliCodes) {
      const trimmed = c.trim();
      if (trimmed) merged.add(trimmed);
    }
  }
  return [...merged].sort();
}

// ---------------------------------------------------------------------------
// Threshold evaluation (Story 16)
// ---------------------------------------------------------------------------

function evaluateThresholds(
  summary: import('./types.js').CoverageSummary,
  coverageConfig: { minCoverage?: import('../../types.js').CoverageMinThresholds },
  args: import('./types.js').CoverageArgs,
): number {
  const violations: string[] = [];
  const minCov = coverageConfig.minCoverage ?? {};

  // Per-dimension thresholds from config
  if (minCov.endpoint !== undefined && summary.coveragePct < minCov.endpoint) {
    violations.push(`  ✗ endpoint coverage: ${summary.coveragePct}% < ${minCov.endpoint}% (required)`);
  }
  if (minCov.responseCode !== undefined && summary.responseCodeCoveragePct < minCov.responseCode) {
    violations.push(`  ✗ responseCode coverage: ${summary.responseCodeCoveragePct}% < ${minCov.responseCode}% (required)`);
  }
  if (minCov.parameter !== undefined && summary.paramCoveragePct < minCov.parameter) {
    violations.push(`  ✗ parameter coverage: ${summary.paramCoveragePct}% < ${minCov.parameter}% (required)`);
  }
  if (minCov.bodyField !== undefined && summary.bodyFieldCoveragePct < minCov.bodyField) {
    violations.push(`  ✗ bodyField coverage: ${summary.bodyFieldCoveragePct}% < ${minCov.bodyField}% (required)`);
  }

  // Global CLI threshold (--min-coverage)
  if (args.minCoverage !== undefined && summary.coveragePct < args.minCoverage) {
    violations.push(`  ✗ endpoint coverage: ${summary.coveragePct}% < ${args.minCoverage}% (required by --min-coverage)`);
  }

  if (violations.length > 0) {
    console.error('Coverage threshold violations:');
    for (const v of violations) {
      console.error(v);
    }
    console.error('');
    console.error('Run `shogun coverage --gaps` to see what needs to be fixed.');
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// String-returning renderer wrappers (for --out support)
// ---------------------------------------------------------------------------

function renderSummaryHeaderStr(summary: import('./types.js').CoverageSummary, runSummary: RunSummary | null): string {
  const lines: string[] = [];
  lines.push(`Coverage Report — ${summary.apiTitle} v${summary.apiVersion}`);
  lines.push(`  Spec endpoints:    ${summary.totalEndpoints}`);
  lines.push(`  Tests scanned:     ${summary.totalTests}  (${summary.collections} collections)`);
  lines.push(`  Covered:           ${summary.coveredEndpoints}  (${summary.coveragePct}%)`);
  lines.push(`  Uncovered:         ${summary.uncoveredEndpoints}`);
  lines.push(`  Response codes:    ${summary.coveredResponseCodes} / ${summary.totalSpecResponseCodes} spec codes tested  (${summary.responseCodeCoveragePct}%)`);
  lines.push(`  Parameters:        ${summary.testedParams} / ${summary.totalSpecParams} spec params tested  (${summary.paramCoveragePct}%)`);
  lines.push(`  Body fields:       ${summary.testedBodyFields} / ${summary.totalSpecBodyFields} spec body fields tested  (${summary.bodyFieldCoveragePct}%)`);
  lines.push(`  Assertion quality: avg score ${summary.avgQualityScore} / 100 across covered endpoints`);
  lines.push(`                     (per test: status 1 + shape 2×n + snapshot 3 + postScript asserts; ÷ 10 × 100)`);
  if (summary.thinTestCount > 0) {
    lines.push(`  Thin tests:        ${summary.thinTestCount} tests score ≤ 1 (status-only, no assertions)`);
  }
  lines.push(`  High-risk endpoints: ${summary.highRiskEndpointCount} endpoints with risk ≥ 50`);
  const nr = summary.suiteNegativeRatio;
  lines.push(`  Test profile:      ${nr.total} tests  —  2xx: ${nr.twoxx} (${nr.twoxxPct}%)  4xx: ${nr.fourxx} (${nr.fourxxPct}%)  5xx: ${nr.fivexx} (${nr.fivexxPct}%)`);
  if (runSummary) {
    const suiteLabel = runSummary.suite ? `  (suite: ${runSummary.suite})` : '';
    lines.push(`  Last run:          ${runSummary.runId}${suiteLabel}  ${runSummary.total} tests  ${runSummary.passed} passed  ${runSummary.failed} failed`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

function renderGapsStr(summary: import('./types.js').CoverageSummary, gaps: CoverageGap[], riskScores?: EndpointRiskScore[], top?: number): string {
  // Capture console.log output into a string
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    renderGaps(summary, gaps, riskScores, top);
  } finally {
    console.log = origLog;
  }
  return lines.join('\n') + '\n';
}

function renderDepsStr(graph: DependencyGraph): string {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    renderDeps(graph);
  } finally {
    console.log = origLog;
  }
  return lines.join('\n') + '\n';
}

function renderMarkdownStr(
  summary: import('./types.js').CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
  responseCodeCoverage?: EndpointResponseCodeCoverage[],
): string {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    renderMarkdown(summary, specEndpoints, uncoveredOnly, responseCodeCoverage);
  } finally {
    console.log = origLog;
  }
  return lines.join('\n') + '\n';
}

function renderPrettyStr(
  summary: import('./types.js').CoverageSummary,
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
  specDrift?: SpecDriftReport | null,
  mcpCoverage?: McpCoverageReport | null,
): string {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    renderPretty(summary, specEndpoints, uncoveredOnly, responseCodeCoverage, parameterCoverage, bodyFieldCoverage, qualityScores, riskScores, testingProfiles, detail, runSummary);

    // Spec drift section (Story 17). Render when there are visible entries OR
    // suppressed entries (so the global note is shown even when everything was
    // suppressed — the user still gets signal that drift exists).
    if (specDrift && (specDrift.entries.length > 0 || specDrift.suppressedCount > 0)) {
      console.log('── Spec Drift (requires --last-run) ' + '─'.repeat(43));
      console.log('');
      if (specDrift.undocumentedCodeCount > 0) {
        const undocumented = specDrift.entries.filter(e => e.type === 'undocumented-code');
        const endpoints = new Set(undocumented.map(e => e.endpoint));
        console.log(`Undocumented response codes (${undocumented.length} occurrences, ${endpoints.size} endpoints):`);
        for (const entry of undocumented) {
          console.log(`  ⚠️  ${entry.endpoint.padEnd(50)} ${entry.code} returned but not in spec`);
        }
        console.log('');
      }
      if (specDrift.testVsRealityCount > 0) {
        const mismatches = specDrift.entries.filter(e => e.type === 'test-vs-reality');
        console.log(`Test-vs-reality mismatches (${mismatches.length} occurrences):`);
        for (const entry of mismatches) {
          const testLabel = entry.testName ? `"${entry.testName}"` : '';
          console.log(`  ↔  ${entry.endpoint.padEnd(50)} ${testLabel} ${entry.detail}`);
        }
        console.log('');
      }
      // Global note for suppressed drift (Issue 3): cross-cutting codes like
      // 401 (auth middleware) are hidden per-endpoint to keep signal high.
      if (specDrift.suppressedCount > 0) {
        const codes = specDrift.suppressedCodes.join(', ');
        console.log(`Suppressed drift: ${specDrift.suppressedCount} occurrences of [${codes}] across ${specDrift.suppressedEndpointCount} endpoints hidden (cross-cutting concern).`);
        console.log(`  Use --suppress-drift "" or coverage.suppressDrift: [] in config to reveal.`);
        console.log('');
      }
    }

    // MCP / JSON-RPC coverage section (Phase 3)
    if (mcpCoverage) {
      console.log('── MCP / JSON-RPC Coverage ' + '─'.repeat(41));
      console.log('');
      console.log(`MCP tests: ${mcpCoverage.totalMcpTests}`);
      console.log('');

      if (mcpCoverage.methods.length > 0) {
        console.log('JSON-RPC Methods:');
        for (const m of mcpCoverage.methods) {
          console.log(`  ${m.method.padEnd(30)} ${m.testCount} test${m.testCount === 1 ? '' : 's'}`);
        }
        console.log('');
      }

      if (mcpCoverage.tools.length > 0) {
        console.log('MCP Tools (tools/call):');
        for (const t of mcpCoverage.tools) {
          console.log(`  ${t.tool.padEnd(40)} ${t.testCount} test${t.testCount === 1 ? '' : 's'}`);
        }
        console.log('');
      }

      if (mcpCoverage.unnamedToolCallCount > 0) {
        console.log(`  ⚠️  ${mcpCoverage.unnamedToolCallCount} tools/call test(s) with no tool name extracted (check pre-scripts)`);
        console.log('');
      }
    }
  } finally {
    console.log = origLog;
  }
  return lines.join('\n') + '\n';
}
