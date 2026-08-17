/**
 * src/runner.ts
 * Main test execution loop.
 * Orchestrates: load → pre-script → curl → assert → post-script → log
 *
 * New in this version:
 *  - SessionState: deduplicates test execution and collection setup across a run
 *  - setup_fixtures: runs named shared setup scripts before each collection's own setup
 *  - dependsOn: automatically resolves and runs test dependencies before the target test
 */

import { join, relative, resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import {
  loadConfig, loadEnv, loadTestFile, loadCollection, discoverCollections,
  loadSuite, loadSetupFixture, buildDependencyOrder, resolveTestRef,
  resolveSqlConnection, loadSqlParameters,
} from './loader.js';
import { executeRequest, checkDependencies } from './executor.js';
import { runAssertions, assertionsAllPassed, writeSnapshot } from './asserter.js';
import { runScript } from './scripter.js';
import { RunLogger } from './logger.js';
import {
  printCollectionHeader, printTestStart, printTestResult, printSummary,
  printSqlTestDetails,
} from './reporter.js';
import { SqlDriverRegistry } from './sql-driver.js';
import type { SqlExecResult, SqlDriver } from './sql-driver.js';
import {
  getSqlBaselinePath, writeSqlBaseline, diffSqlBaseline, writeCsvArtifacts,
} from './sql-snapshot.js';
import type {
  ShogunRequest, ShogunResponse, TestResult, TestTimings, EnvVars,
  RunSummary, ShogunConfig, SessionState, SuiteDefinition,
  TestDefinition, SqlConnectionConfig, SqlScriptContext,
  AgentTestConfig, AgentExpectedDef, AgentEvaluateConfig, EvaluatorResponse,
  EvaluationAssertionResult,
} from './types.js';
import { buildEvaluationPrompt, parseEvaluatorResponse, validateCriteriaCorrespondence } from './agent-evaluator.js';
import { resolveEvaluationConfig } from './loader.js';

export interface RunOptions {
  env?: string;
  collection?: string | string[];
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap';
  snapshotMode?: boolean;
  cwd?: string;
  /** Runtime parameter override for SQL tests — JSON string (e.g. '[{"UserId": 42}]') */
  params?: string;
}

export async function runTests(opts: RunOptions): Promise<RunSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const envName = opts.env ?? config.defaults?.env ?? 'local';

  // Validate tools
  await checkDependencies();

  // Load environment
  const env = loadEnv(envName, config, cwd);
  const baseUrl = env.BASE_URL ?? process.env.BASE_URL ?? '';

  if (!baseUrl) {
    throw new Error(`BASE_URL is not set in ${envName}.env`);
  }

  const scriptsDir = join(cwd, config.paths?.scripts ?? 'scripts');
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');
  const logger = new RunLogger(config, cwd);
  const startedAt = new Date().toISOString();

  // Shared vars across entire run
  const vars: Record<string, unknown> = {};

  // Session state — deduplicates test runs, collection setups, fixture executions
  const session: SessionState = {
    testsRun: new Map(),
    collectionsSetup: new Set(),
    collectionsTornDown: new Set(),
    fixturesRun: new Set(),
  };

  // Shared opts passed to helpers
  const sharedOpts: SharedRunOpts = {
    env, vars, baseUrl, config, scriptsDir, cwd, collectionsDir,
    snapshotMode: opts.snapshotMode, session, logger,
    runtimeParams: parseRuntimeParams(opts.params),
  };

  // -------------------------------------------------------------------------
  // Single file mode — run outside collection context
  // -------------------------------------------------------------------------

  if (opts.file) {
    const result = await runSingleFile(opts.file, sharedOpts);
    logger.recordTest(result, 'file');
    if (result.sqlExecSummary) {
      printSqlTestDetails(result);
    }
    const summary = logger.finalize({ env: envName, startedAt });
    printSummary(summary);
    return summary;
  }

  // -------------------------------------------------------------------------
  // Determine collection plan
  // -------------------------------------------------------------------------

  let collectionNames: string[] = [];

  if (opts.suite) {
    const suite: SuiteDefinition = loadSuite(opts.suite, config, cwd);
    collectionNames = suite.collections;
    if (!opts.tags?.length && suite.tags?.length) {
      opts.tags = suite.tags;
    }
    // Merge suite-level vars into ctx.vars — lowest precedence layer
    if (suite.vars) {
      Object.assign(vars, suite.vars);
    }
  } else if (opts.collection) {
    collectionNames = Array.isArray(opts.collection) ? opts.collection : [opts.collection];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  // -------------------------------------------------------------------------
  // Run each collection
  // -------------------------------------------------------------------------

  for (const collectionName of collectionNames) {
    const { definition, testFiles } = loadCollection(collectionName, config, cwd);

    // Tag filter at collection level
    if (!opts.suite && opts.tags?.length && !opts.tags.some(t => definition.tags?.includes(t))) {
      continue;
    }

    printCollectionHeader(definition.name ?? collectionName);

    // Run collection setup (includes setup_fixtures), deduped by session
    const setupOk = await ensureCollectionSetup(collectionName, definition, sharedOpts);

    if (!setupOk) {
      // Fail all tests in this collection
      for (const file of testFiles) {
        const test = loadTestFile(file, env);
        const failed: TestResult = {
          name: test.name,
          file,
          status: 'failed',
          durationMs: 0,
          assertions: {},
          error: `Collection setup failed for "${collectionName}"`,
        };
        logger.recordTest(failed, collectionName);
        const display = getTestDisplayInfo(test);
        printTestStart(test.name, display.method, display.path);
        printTestResult(failed);
      }
      continue;
    }

    // Run each test
    for (const file of testFiles) {
      const test = loadTestFile(file, { ...env });

      // Tag filter at test level
      if (opts.tags?.length && !opts.tags.some(t => test.tags?.includes(t))) {
        continue;
      }

      const display = getTestDisplayInfo(test);
      printTestStart(test.name, display.method, display.path);

      // Resolve the canonical ID from the actual file path — handles cross-collection
      // refs stored in _failures_ / _debug_ collections where collectionName is the
      // container collection but the file lives under a different collection dir.
      const canonicalId = relative(collectionsDir, file).replace(/\.yaml$/, '').replace(/\\/g, '/');
      const actualCollection = canonicalId.includes('/')
        ? canonicalId.slice(0, canonicalId.indexOf('/'))
        : collectionName;

      // Run dependsOn chain first (session-deduped)
      const depResult = await resolveDependencies(
        canonicalId,
        actualCollection,
        sharedOpts,
      );

      let result: TestResult;

      if (depResult.failedDep) {
        // A dependency failed — mark this test as dependency_failed
        result = {
          name: test.name,
          file,
          status: 'dependency_failed',
          durationMs: 0,
          assertions: {},
          error: `Dependency "${depResult.failedDep}" failed`,
          failedDependency: depResult.failedDep,
        };
      } else {
        result = await runSingleTest(test, file, {
          ...sharedOpts,
          env: { ...env, ...(test.env ?? {}) },
          collectionName: actualCollection,
        });

        // Register in session
        session.testsRun.set(canonicalId, result.status === 'passed' ? 'passed' : 'failed');
      }

      logger.recordTest(result, collectionName);
      printTestResult(result);
      if (result.sqlExecSummary) {
        printSqlTestDetails(result);
      }
    }
    await ensureCollectionTeardown(collectionName, definition, sharedOpts);
  }

  const summary = logger.finalize({
    env: envName,
    collection: opts.collection,
    suite: opts.suite,
    startedAt,
  });

  printSummary(summary);

  // Auto-update the _failures_ collection on every run.
  // A run with failures rewrites the order list with the failing tests.
  // A clean run clears the list so stale failures don't linger and mislead
  // agents/humans into re-investigating tests that now pass.
  updateFailuresCollection(summary.results, config, cwd);

  return summary;
}

// ---------------------------------------------------------------------------
// Shared opts type (internal)
// ---------------------------------------------------------------------------

interface SharedRunOpts {
  env: EnvVars;
  vars: Record<string, unknown>;
  baseUrl: string;
  config: ShogunConfig;
  scriptsDir: string;
  cwd: string;
  collectionsDir: string;
  snapshotMode?: boolean;
  session: SessionState;
  logger: RunLogger;
  /** Runtime parameter override for SQL tests (parsed JSON array) */
  runtimeParams?: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Collection setup / teardown (session-deduped)
// ---------------------------------------------------------------------------

/**
 * Runs setup_fixtures then collection setup — at most once per session.
 * Returns true if setup succeeded (or was already done), false on failure.
 */
async function ensureCollectionSetup(
  collectionName: string,
  definition: { setup_fixtures?: string[]; setup?: string; name?: string; vars?: Record<string, string> },
  opts: SharedRunOpts,
): Promise<boolean> {
  if (opts.session.collectionsSetup.has(collectionName)) return true;

  const dummyRequest = makeDummyRequest(opts.baseUrl);

  // 0. Merge collection-level vars into ctx.vars — overrides suite vars
  if (definition.vars) {
    Object.assign(opts.vars, definition.vars);
  }

  // 1. Run setup_fixtures in order
  if (definition.setup_fixtures?.length) {
    for (const fixtureName of definition.setup_fixtures) {
      // Fixture-level idempotency
      if (opts.session.fixturesRun.has(fixtureName)) {
        console.log(`  ⊙ fixture "${fixtureName}" already run this session — skipping`);
        continue;
      }

      let fixture;
      try {
        fixture = loadSetupFixture(fixtureName, opts.config, opts.cwd);
      } catch (err) {
        console.error(`  ✗ Failed to load setup fixture "${fixtureName}": ${err}`);
        return false;
      }

      try {
        const result = await runScript(fixture.script, {
          env: opts.env,
          vars: opts.vars,
          request: dummyRequest,
          scriptsDir: opts.scriptsDir,
          defaultContentType: opts.config.defaults?.content_type,
        });
        applyVarMutations(opts.vars, result.varMutations);
        if (!result.passed) {
          console.error(`  ✗ Setup fixture "${fixtureName}" failed: ${result.error}`);
          return false;
        }
        opts.session.fixturesRun.add(fixtureName);
        console.log(`  ✓ fixture "${fixtureName}" complete`);
      } catch (err) {
        console.error(`  ✗ Setup fixture "${fixtureName}" threw: ${err}`);
        return false;
      }
    }
  }

  // 2. Run collection's own setup script
  if (definition.setup) {
    try {
      if (process.env.SHOGUN_DEBUG) {
        process.stderr.write(`[runner] running collection setup for "${collectionName}"\n`);
      }
      const result = await runScript(definition.setup, {
        env: opts.env,
        vars: opts.vars,
        request: dummyRequest,
        scriptsDir: opts.scriptsDir,
        defaultContentType: opts.config.defaults?.content_type,
      });
      if (process.env.SHOGUN_DEBUG) {
        process.stderr.write(`[runner] collection setup result: passed=${result.passed}, error=${result.error ?? 'none'}, varMutations=${JSON.stringify(result.varMutations ?? {}).slice(0, 300)}\n`);
      }
      applyVarMutations(opts.vars, result.varMutations);
      if (!result.passed) {
        console.error(`Collection setup failed: ${result.error}`);
        return false;
      }
    } catch (err) {
      console.error(`Collection setup threw: ${err}`);
      return false;
    }
  }

  opts.session.collectionsSetup.add(collectionName);
  return true;
}

async function ensureCollectionTeardown(
  collectionName: string,
  definition: { teardown?: string },
  opts: SharedRunOpts,
): Promise<void> {
  if (opts.session.collectionsTornDown.has(collectionName)) return;
  if (!definition.teardown) {
    opts.session.collectionsTornDown.add(collectionName);
    return;
  }

  try {
    const dummyRequest = makeDummyRequest(opts.baseUrl);
    const result = await runScript(definition.teardown, {
      env: opts.env,
      vars: opts.vars,
      request: dummyRequest,
      scriptsDir: opts.scriptsDir,
      defaultContentType: opts.config.defaults?.content_type,
    });
    if (!result.passed) {
      console.warn(`  ${c.yellow}Teardown warning (${collectionName}): ${result.error}${c.reset}`);
    }
  } catch (err) {
    console.warn(`  Teardown threw (non-fatal, ${collectionName}): ${err}`);
  }

  opts.session.collectionsTornDown.add(collectionName);
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Resolves and executes the full dependsOn chain for a test.
 * Returns { failedDep } if any dep failed, or { failedDep: null } if all passed.
 *
 * Each dep runs at most once per session (session.testsRun deduplication).
 * If a dep is in a different collection, that collection's setup runs first.
 */
async function resolveDependencies(
  targetCanonicalId: string,
  ownerCollection: string,
  opts: SharedRunOpts,
): Promise<{ failedDep: string | null }> {
  let depOrder: string[];
  try {
    depOrder = buildDependencyOrder(targetCanonicalId, opts.collectionsDir, opts.env);
  } catch (err) {
    // Cycle or missing dep — surface as failure
    return { failedDep: `[dependency resolution error] ${err}` };
  }

  if (depOrder.length === 0) return { failedDep: null };

  for (const depId of depOrder) {
    // Already ran this session?
    const priorOutcome = opts.session.testsRun.get(depId);
    if (priorOutcome === 'passed') continue;
    if (priorOutcome === 'failed') {
      return { failedDep: depId };
    }

    // Need to run it — ensure its collection setup is done first
    const depCollection = depId.slice(0, depId.indexOf('/'));
    const depTestName = depId.slice(depId.indexOf('/') + 1);
    const depFile = join(opts.collectionsDir, depCollection, `${depTestName}.yaml`);

    if (depCollection !== ownerCollection) {
      // Load and setup the dep's collection
      let depDefinition;
      try {
        const loaded = loadCollection(depCollection, opts.config, opts.cwd);
        depDefinition = loaded.definition;
      } catch (err) {
        opts.session.testsRun.set(depId, 'failed');
        return { failedDep: depId };
      }

      const setupOk = await ensureCollectionSetup(depCollection, depDefinition, opts);
      if (!setupOk) {
        opts.session.testsRun.set(depId, 'failed');
        return { failedDep: depId };
      }
    }

    // Execute the dependency test
    const depTest = loadTestFile(depFile, opts.env);
    const depDisplay = getTestDisplayInfo(depTest);
    printTestStart(depTest.name, depDisplay.method, depDisplay.path);

    const depResult = await runSingleTest(depTest, depFile, {
      ...opts,
      env: { ...opts.env, ...(depTest.env ?? {}) },
      collectionName: depCollection,
    });

    opts.logger.recordTest(depResult, depCollection);
    printTestResult(depResult);
    if (depResult.sqlExecSummary) {
      printSqlTestDetails(depResult);
    }

    const outcome = depResult.status === 'passed' ? 'passed' : 'failed';
    opts.session.testsRun.set(depId, outcome);

    if (outcome === 'failed') {
      return { failedDep: depId };
    }
  }

  return { failedDep: null };
}

// ---------------------------------------------------------------------------
// Single test execution
// ---------------------------------------------------------------------------

interface SingleTestOpts extends SharedRunOpts {
  collectionName?: string;
}

/**
 * Dispatcher: routes to runHttpTest or runSqlTest based on test type.
 * If type is absent or 'http', the existing HTTP path runs unchanged.
 */
async function runSingleTest(
  test: TestDefinition,
  file: string,
  opts: SingleTestOpts,
): Promise<TestResult> {
  const testType = test.type ?? 'http';

  if (testType === 'sql' && test.sql) {
    return runSqlTest(test, file, opts);
  }

  if (testType === 'agent' && test.agent) {
    return runAgentTest(test, file, opts);
  }

  // Existing HTTP path — unchanged
  return runHttpTest(test, file, opts);
}

// ---------------------------------------------------------------------------
// HTTP test execution (existing behavior — unchanged, just renamed)
// ---------------------------------------------------------------------------

async function runHttpTest(
  test: TestDefinition,
  file: string,
  opts: SingleTestOpts,
): Promise<TestResult> {
  const scriptOutput: string[] = [];
  const startMs = Date.now();

  // Guard: request must be present for HTTP tests (Zod enforces this too)
  if (!test.request) {
    return makeFailedResult(test.name, file, startMs, {}, 'request is required for HTTP tests', scriptOutput);
  }

  // Build initial request
  const req = test.request;
  let request: ShogunRequest = {
    method: req.method,
    path: req.path,
    url: buildUrl(opts.baseUrl, req.path),
    headers: (req as { headers?: Record<string, string> }).headers ?? {},
    params: normalizeParams((req as { params?: Record<string, string | number | boolean> }).params ?? {}),
    body: (req as { body?: unknown }).body,
  };

  // Pre-script
  let preMs = 0;
  if (test.pre) {
    const preStart = Date.now();
    try {
      if (process.env.SHOGUN_DEBUG) {
        process.stderr.write(`[runner] pre-script for "${test.name}" (${preMs}ms in)\n`);
      }
      const preResult = await runScript(test.pre, {
        env: opts.env,
        vars: opts.vars,
        request,
        scriptsDir: opts.scriptsDir,
        defaultContentType: opts.config.defaults?.content_type,
      });
      preMs = Date.now() - preStart;
      if (process.env.SHOGUN_DEBUG) {
        process.stderr.write(`[runner] pre-script done: passed=${preResult.passed}, preMs=${preMs}, error=${preResult.error ?? 'none'}, reqMutations=${JSON.stringify(preResult.requestMutations ?? {}).slice(0, 200)}, varMutations=${JSON.stringify(preResult.varMutations ?? {}).slice(0, 200)}\n`);
      }
      scriptOutput.push(...preResult.logs);
      if (!preResult.passed) {
        return makeFailedResult(test.name, file, startMs, {}, `Pre-script failed: ${preResult.error}`, scriptOutput);
      }
      // Apply request mutations from pre-script
      if (preResult.requestMutations) {
        request = mergeRequest(request, preResult.requestMutations, opts.baseUrl);
      }
      // Apply var mutations
      applyVarMutations(opts.vars, preResult.varMutations);
    } catch (err) {
      preMs = Date.now() - preStart;
      return makeFailedResult(test.name, file, startMs, {}, `Pre-script threw: ${err}`, scriptOutput);
    }
  }

  // Execute HTTP request
  let response: ShogunResponse;
  try {
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[runner] executeRequest: ${request.method} ${request.url}\n`);
    }
    response = await executeRequest(request, opts.env, {
      timeout: parseInt(opts.env.TIMEOUT ?? String(opts.config.defaults?.timeout ?? 10), 10),
      autoInjectAuth: opts.config.defaults?.auto_inject_auth !== false,
      contentType: opts.config.defaults?.content_type,
    });
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[runner] executeRequest done: status=${response.status}, curlMs=${response.curlMs}, bodyLen=${response.raw.length}\n`);
    }
  } catch (err) {
    return makeFailedResult(test.name, file, startMs, {}, `curl failed: ${err}`, scriptOutput);
  }

  // Assertions
  const assertStart = Date.now();
  const fullTest = test as Parameters<typeof runAssertions>[0]['test'];
  const assertions = await runAssertions({
    test: fullTest,
    response,
    config: opts.config,
    cwd: opts.cwd,
    collectionName: opts.collectionName,
    snapshotMode: opts.snapshotMode,
  });
  const assertMs = Date.now() - assertStart;

  // Check for missing baseline
  const needsBaseline = test.response &&
    (test.response as { snapshot?: boolean }).snapshot &&
    assertions.snapshot === false &&
    !assertions.snapshotDiff;

  // Post-script
  let postMs = 0;
  if (test.post) {
    const postStart = Date.now();
    try {
      const postResult = await runScript(test.post, {
        env: opts.env,
        vars: opts.vars,
        request,
        response,
        scriptsDir: opts.scriptsDir,
        defaultContentType: opts.config.defaults?.content_type,
      });
      postMs = Date.now() - postStart;
      scriptOutput.push(...postResult.logs);
      applyVarMutations(opts.vars, postResult.varMutations);
      assertions.postScript = postResult.passed;
      if (!postResult.passed) {
        assertions.postScriptError = postResult.error;
      }
    } catch (err) {
      postMs = Date.now() - postStart;
      assertions.postScript = false;
      assertions.postScriptError = String(err);
    }
  }

  const durationMs = Date.now() - startMs;
  const curlMs = response.curlMs;
  const allPassed = assertionsAllPassed(assertions);
  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[runner] assertions: ${JSON.stringify(assertions)}\n`);
    process.stderr.write(`[runner] allPassed=${allPassed}, needsBaseline=${needsBaseline}, finalStatus=${needsBaseline ? 'needs_baseline' : allPassed ? 'passed' : 'failed'}\n`);
  }
  const finalStatus = needsBaseline ? 'needs_baseline' : allPassed ? 'passed' : 'failed';

  const timings: TestTimings = {
    curlMs,
    assertMs,
    preMs,
    postMs,
    otherMs: Math.max(0, durationMs - curlMs - assertMs - preMs - postMs),
  };

  return {
    name: test.name,
    file,
    status: finalStatus,
    httpStatus: response.status,
    durationMs,
    timings,
    assertions,
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    // Attach full request + response on failures so the reporter can dump diagnostics
    ...(finalStatus === 'failed' ? { resolvedRequest: request, resolvedResponse: response } : {}),
  };
}

// ---------------------------------------------------------------------------
// SQL test execution
// ---------------------------------------------------------------------------

async function runSqlTest(
  test: TestDefinition,
  file: string,
  opts: SingleTestOpts,
): Promise<TestResult> {
  const startMs = Date.now();
  const scriptOutput: string[] = [];
  const sql = test.sql!;

  // Determine execution mode: proc or query
  const isQuery = !sql.proc && !!sql.query;
  const execTarget = isQuery ? sql.query! : sql.proc!;

  // 1. Resolve connection config
  const connConfig = resolveSqlConnection(sql.connection, opts.config, opts.env);
  if (!connConfig) {
    return makeFailedResult(test.name, file, startMs, {},
      `Connection "${sql.connection}" not found in config.connections`, scriptOutput);
  }

  // 2. Resolve driver (import mssql driver to register it, then look up)
  try {
    await import('./drivers/mssql-driver.js');
  } catch {
    // mssql package not installed — will fail at driver lookup with clear error
  }

  let driver: SqlDriver;
  try {
    driver = SqlDriverRegistry.get(connConfig.driver);
  } catch (err) {
    return makeFailedResult(test.name, file, startMs, {},
      `Driver error: ${err}`, scriptOutput);
  }

  // 3. Load parameter sets (runtime --params override takes precedence)
  let paramSets: Record<string, unknown>[];
  if (opts.runtimeParams) {
    paramSets = opts.runtimeParams;
  } else if (!sql.parameters) {
    return makeFailedResult(test.name, file, startMs, {},
      `No parameters defined — provide 'parameters' in YAML or use --params flag`, scriptOutput);
  } else {
    try {
      paramSets = loadSqlParameters(sql.parameters, file, opts.env);
    } catch (err) {
      return makeFailedResult(test.name, file, startMs, {},
        `Parameter loading failed: ${err}`, scriptOutput);
    }
  }

  if (paramSets.length === 0) {
    return makeFailedResult(test.name, file, startMs, {},
      `No parameter sets found`, scriptOutput);
  }

  // 4. Run pre-script (optional — has ctx.sql with paramCount, params, proc/query, connection)
  if (sql.pre) {
    const dummyRequest = makeDummyRequest(opts.baseUrl);
    const sqlContext: SqlScriptContext = {
      paramCount: paramSets.length,
      params: paramSets,
      proc: sql.proc,
      query: sql.query,
      connection: sql.connection,
    };
    try {
      const preResult = await runScript(sql.pre, {
        env: opts.env,
        vars: opts.vars,
        request: dummyRequest,
        scriptsDir: opts.scriptsDir,
        sqlContext,
        defaultContentType: opts.config.defaults?.content_type,
      });
      scriptOutput.push(...preResult.logs);
      if (!preResult.passed) {
        return makeFailedResult(test.name, file, startMs, {},
          `SQL pre-script failed: ${preResult.error}`, scriptOutput);
      }
      applyVarMutations(opts.vars, preResult.varMutations);
    } catch (err) {
      return makeFailedResult(test.name, file, startMs, {},
        `SQL pre-script threw: ${err}`, scriptOutput);
    }
  }

  // 5. Execute proc or query for each parameter set
  const timeout = sql.timeout ?? connConfig.timeout ?? opts.config.defaults?.timeout ?? 30;
  let results: SqlExecResult[];
  try {
    if (isQuery) {
      results = await driver.executeQueryBatch(connConfig, execTarget, paramSets, timeout);
    } else {
      results = await driver.executeBatch(connConfig, execTarget, paramSets, timeout);
    }
  } catch (err) {
    return makeFailedResult(test.name, file, startMs, {},
      `SQL execution failed: ${err}`, scriptOutput);
  }

  // 6. Check for execution errors
  const execErrors = results.filter(r => r.error);
  if (execErrors.length > 0) {
    return makeFailedResult(test.name, file, startMs, {},
      `${execErrors.length} of ${results.length} parameter sets failed to execute: ${execErrors[0].error}`, scriptOutput);
  }

  // 7. Snapshot capture/diff
  // For baseline naming: use explicit baseline name, or proc name, or sanitized test name
  const baselineName = sql.baseline ?? (isQuery ? safeBaselineName(test.name) : sql.proc!);
  const baselinePath = getSqlBaselinePath(baselineName, opts.config, opts.cwd, opts.collectionName);
  const ignoreFields = [
    ...(opts.config.ignore_fields_global ?? []),
    ...(test.response?.ignore_fields ?? []),
  ];
  const diffMode = test.response?.diff_mode ?? 'strict';

  if (opts.snapshotMode) {
    await writeSqlBaseline(results, baselinePath, ignoreFields);
    return {
      name: test.name,
      file,
      status: 'passed',
      durationMs: Date.now() - startMs,
      assertions: { snapshot: true },
      scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    };
  }

  const snapshotResult = diffSqlBaseline(results, baselinePath, ignoreFields, diffMode);
  if (snapshotResult.needsBaseline) {
    return {
      name: test.name,
      file,
      status: 'needs_baseline',
      durationMs: Date.now() - startMs,
      assertions: {},
      scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    };
  }

  // 8. Write CSV artifacts (if requested)
  if (sql.outputFormat === 'csv' || sql.outputFormat === 'both') {
    const runDir = opts.logger.runDir;
    if (runDir) {
      writeCsvArtifacts(results, runDir, opts.collectionName ?? 'default', baselineName);
    }
  }

  // 9. Run post-script (optional — has ctx.sql with results)
  if (sql.post) {
    const dummyRequest = makeDummyRequest(opts.baseUrl);
    const sqlContext: SqlScriptContext = {
      paramCount: paramSets.length,
      params: paramSets,
      results,
      proc: sql.proc,
      query: sql.query,
      connection: sql.connection,
    };
    try {
      const postResult = await runScript(sql.post, {
        env: opts.env,
        vars: opts.vars,
        request: dummyRequest,
        scriptsDir: opts.scriptsDir,
        sqlContext,
        defaultContentType: opts.config.defaults?.content_type,
      });
      scriptOutput.push(...postResult.logs);
      applyVarMutations(opts.vars, postResult.varMutations);
    } catch (err) {
      return makeFailedResult(test.name, file, startMs, {},
        `SQL post-script threw: ${err}`, scriptOutput);
    }
  }

  // 10. Return result — one TestResult per SQL test
  const durationMs = Date.now() - startMs;
  const passed = snapshotResult.passed;
  const totalRows = results.reduce((sum, r) =>
    sum + r.resultSets.reduce((s, rs) => s + rs.rows.length, 0), 0);

  // Always include sqlExecSummary — useful for Playwright and other integrations
  const sqlExecSummary = {
    totalParams: results.length,
    executed: results.length,
    errors: execErrors.length,
    totalRows,
  };

  return {
    name: test.name,
    file,
    status: passed ? 'passed' : 'failed',
    durationMs,
    assertions: {
      snapshot: passed,
      snapshotDiff: snapshotResult.diff ?? null,
    },
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    sqlExecSummary,
  };
}

// ---------------------------------------------------------------------------
// Agent test execution
// ---------------------------------------------------------------------------

/**
 * Runs an agent test by constructing an OpenAI-compatible /chat/completions
 * request, sending it to the target agent via executeRequest(), and
 * extracting choices[0].message.content as the agent output.
 *
 * The evaluation phase (Story 4) is not yet wired — this function returns
 * a placeholder result with status 'failed' and an error noting that
 * evaluation is not yet implemented.
 */
export async function runAgentTest(
  test: TestDefinition,
  file: string,
  opts: SingleTestOpts,
): Promise<TestResult> {
  const startMs = Date.now();
  const scriptOutput: string[] = [];
  const agent = test.agent!;

  // --- 1. Construct OpenAI-compatible request body ---
  const messages: Array<{ role: string; content: string }> = [];

  if (agent.parameters?.system_prompt) {
    messages.push({ role: 'system', content: agent.parameters.system_prompt });
  }

  let userContent = agent.prompt;

  // Append context file contents to the user message
  if (agent.parameters?.context_files?.length) {
    for (const filePath of agent.parameters.context_files) {
      try {
        const resolved = resolve(opts.cwd, filePath);
        const contents = readFileSync(resolved, 'utf8');
        userContent += `\n\n--- ${filePath} ---\n${contents}`;
      } catch (err) {
        return makeFailedResult(test.name, file, startMs, {},
          `Failed to read context file "${filePath}": ${err}`, scriptOutput);
      }
    }
  }

  messages.push({ role: 'user', content: userContent });

  const requestBody: Record<string, unknown> = {
    model: agent.model,
    messages,
    temperature: agent.temperature ?? 0.7,
  };

  if (agent.max_tokens !== undefined) {
    requestBody.max_tokens = agent.max_tokens;
  }

  // --- 2. Build ShogunRequest ---
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (agent.api_key) {
    headers['Authorization'] = `Bearer ${agent.api_key}`;
  }

  const request: ShogunRequest = {
    method: 'POST',
    path: agent.endpoint,
    url: agent.endpoint,  // full URL, not relative to BASE_URL
    headers,
    params: {},
    body: JSON.stringify(requestBody),
  };

  // --- 3. Execute HTTP request to target agent ---
  // Disable AUTH_TOKEN auto-injection (Constraint 3)
  let response: ShogunResponse;
  try {
    response = await executeRequest(request, opts.env, {
      timeout: parseInt(opts.env.TIMEOUT ?? String(opts.config.defaults?.timeout ?? 300), 10),
      autoInjectAuth: false,  // explicitly disabled
      contentType: 'application/json',
    });
  } catch (err) {
    return {
      ...makeFailedResult(test.name, file, startMs, {},
        `Agent HTTP request failed: ${err}`, scriptOutput),
      agentResponse: undefined,
      resolvedRequest: request,
    };
  }

  const curlMs = response.curlMs;

  // --- 4. Extract choices[0].message.content (Constraint 2) ---
  let agentOutput: string;
  try {
    const body = typeof response.body === 'string'
      ? JSON.parse(response.body)
      : response.body;

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      // Execution failure — not a grade of zero
      return {
        ...makeFailedResult(test.name, file, startMs, {},
          'Agent response missing choices[0].message.content or content is empty', scriptOutput),
        agentResponse: response,
        resolvedRequest: request,
      };
    }
    agentOutput = content;
  } catch (err) {
    return {
      ...makeFailedResult(test.name, file, startMs, {},
        `Failed to parse agent response: ${err}`, scriptOutput),
      agentResponse: response,
      resolvedRequest: request,
    };
  }

  // --- 5. Resolve evaluation config ---
  const evalConfig = resolveEvaluationConfig(test.evaluate, opts.config, opts.env);

  // --- 6. Send to evaluator ---
  const evalResult = await evaluateAgentResponse({
    agentOutput,
    expected: test.expected,
    evaluate: test.evaluate,
    evalConfig,
    env: opts.env,
  });

  const assertMs = evalResult.durationMs;

  // --- 7. Handle evaluation errors ---
  if (evalResult.evaluationError) {
    return {
      name: test.name,
      file,
      status: 'failed',
      durationMs: Date.now() - startMs,
      timings: {
        curlMs,
        assertMs,
        preMs: 0,
        postMs: 0,
        otherMs: Math.max(0, Date.now() - startMs - curlMs - assertMs),
      },
      assertions: {},
      error: evalResult.evaluationError,
      scriptOutput: scriptOutput.length ? scriptOutput : undefined,
      agentResponse: response,
      resolvedRequest: request,
      evaluationRequest: evalResult.evaluationRequest,
      evaluationResponse: evalResult.evaluationResponse ?? undefined,
    };
  }

  // --- 8. Validate criteria correspondence (Constraint 7) ---
  const evaluatorResponse = evalResult.evaluatorResponse!;
  try {
    validateCriteriaCorrespondence(evaluatorResponse, test.evaluate?.criteria);
  } catch (err) {
    return {
      name: test.name,
      file,
      status: 'failed',
      durationMs: Date.now() - startMs,
      timings: {
        curlMs,
        assertMs,
        preMs: 0,
        postMs: 0,
        otherMs: Math.max(0, Date.now() - startMs - curlMs - assertMs),
      },
      assertions: {},
      error: `Evaluation contract validation failed: ${err}`,
      scriptOutput: scriptOutput.length ? scriptOutput : undefined,
      agentResponse: response,
      resolvedRequest: request,
      evaluationRequest: evalResult.evaluationRequest,
      evaluationResponse: evalResult.evaluationResponse ?? undefined,
    };
  }

  // --- 9. Apply min_pass and produce EvaluationAssertionResult ---
  const minPass = test.evaluate?.min_pass ?? 80;
  const evaluated = evaluatorResponse.status === 'evaluated';
  const passed = evaluated && (evaluatorResponse.grade ?? 0) >= minPass;

  const evaluationResult: EvaluationAssertionResult = {
    status: evaluatorResponse.status,
    grade: evaluatorResponse.grade,
    passed,
    reasoning: evaluatorResponse.reasoning,
    criteriaResults: evaluatorResponse.criteriaResults,
    evaluatorModel: evalConfig.model,
    durationMs: assertMs,
  };

  const allPassed = passed;  // for agent tests, evaluation is the only assertion
  const finalStatus: TestResult['status'] = allPassed ? 'passed' : 'failed';

  const durationMs = Date.now() - startMs;

  return {
    name: test.name,
    file,
    status: finalStatus,
    durationMs,
    timings: {
      curlMs,
      assertMs,
      preMs: 0,
      postMs: 0,
      otherMs: Math.max(0, durationMs - curlMs - assertMs),
    },
    assertions: { evaluation: evaluationResult },
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
    // Diagnostics: include on failure; omit on pass
    ...(finalStatus === 'failed' ? {
      agentResponse: response,
      resolvedRequest: request,
      evaluationRequest: evalResult.evaluationRequest,
      evaluationResponse: evalResult.evaluationResponse ?? undefined,
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Agent evaluation transport
// ---------------------------------------------------------------------------

/**
 * Sends the agent output to the evaluator and returns the raw evaluator response
 * plus the evaluation request. Does NOT validate the evaluator's contract —
 * that is Story 5's job.
 *
 * Returns:
 *   - evaluatorResponse: the parsed EvaluatorResponse (if parsing succeeded)
 *   - evaluationError: error message (if parsing or HTTP failed)
 *   - evaluationRequest: the ShogunRequest sent to the evaluator
 *   - evaluationResponse: the raw ShogunResponse from the evaluator
 *   - durationMs: time for the evaluation HTTP call + parsing
 */
async function evaluateAgentResponse(args: {
  agentOutput: string;
  expected: AgentExpectedDef | undefined;
  evaluate: AgentEvaluateConfig | undefined;
  evalConfig: { endpoint: string; model: string; api_key?: string; temperature: number; evaluator_system_prompt?: string };
  env: EnvVars;
}): Promise<{
  evaluatorResponse: EvaluatorResponse | null;
  evaluationError: string | null;
  evaluationRequest: ShogunRequest;
  evaluationResponse: ShogunResponse | null;
  durationMs: number;
}> {
  const startMs = Date.now();

  // Build evaluation messages
  const messages = buildEvaluationPrompt({
    expected: args.expected,
    evaluate: args.evaluate,
    agentOutput: args.agentOutput,
    evaluatorSystemPrompt: args.evalConfig.evaluator_system_prompt,
  });

  // Build request body
  const requestBody = {
    model: args.evalConfig.model,
    temperature: args.evalConfig.temperature,
    messages,
  };

  // Build ShogunRequest
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (args.evalConfig.api_key) {
    headers['Authorization'] = `Bearer ${args.evalConfig.api_key}`;
  }

  const evaluationRequest: ShogunRequest = {
    method: 'POST',
    path: args.evalConfig.endpoint,
    url: args.evalConfig.endpoint,
    headers,
    params: {},
    body: JSON.stringify(requestBody),
  };

  // Execute
  let evaluationResponse: ShogunResponse;
  try {
    evaluationResponse = await executeRequest(evaluationRequest, args.env, {
      timeout: 300,
      autoInjectAuth: false,  // Constraint 3
      contentType: 'application/json',
    });
  } catch (err) {
    return {
      evaluatorResponse: null,
      evaluationError: `Evaluator HTTP request failed: ${err}`,
      evaluationRequest,
      evaluationResponse: null,
      durationMs: Date.now() - startMs,
    };
  }

  // Extract content from evaluator response
  let rawContent: string;
  try {
    const body = typeof evaluationResponse.body === 'string'
      ? JSON.parse(evaluationResponse.body)
      : evaluationResponse.body;
    rawContent = body?.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      return {
        evaluatorResponse: null,
        evaluationError: 'Evaluator response missing choices[0].message.content or content is empty.',
        evaluationRequest,
        evaluationResponse,
        durationMs: Date.now() - startMs,
      };
    }
  } catch (err) {
    return {
      evaluatorResponse: null,
      evaluationError: `Failed to parse evaluator HTTP response: ${err}`,
      evaluationRequest,
      evaluationResponse,
      durationMs: Date.now() - startMs,
    };
  }

  // Parse strict JSON
  try {
    const evaluatorResponse = parseEvaluatorResponse(rawContent);
    return {
      evaluatorResponse,
      evaluationError: null,
      evaluationRequest,
      evaluationResponse,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    return {
      evaluatorResponse: null,
      evaluationError: String(err),
      evaluationRequest,
      evaluationResponse,
      durationMs: Date.now() - startMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Test display helper
// ---------------------------------------------------------------------------

/**
 * Returns the method and path to display for a test, handling SQL tests
 * which don't have a `request` field.
 */
function getTestDisplayInfo(test: TestDefinition): { method: string; path: string } {
  if (test.type === 'agent' && test.agent) {
    return {
      method: 'AGENT',
      path: test.agent.model ?? '(unknown model)',
    };
  }
  if (test.type === 'sql' && test.sql) {
    if (test.sql.query) {
      // Show a truncated version of the query
      const q = test.sql.query.replace(/\s+/g, ' ').trim();
      const truncated = q.length > 60 ? q.slice(0, 57) + '...' : q;
      return { method: 'SQL-QUERY', path: truncated };
    }
    return { method: 'SQL', path: test.sql.proc ?? '(unknown proc)' };
  }
  return {
    method: test.request?.method ?? 'GET',
    path: test.request?.path ?? '/',
  };
}

async function runSingleFile(
  file: string,
  opts: SharedRunOpts,
): Promise<TestResult> {
  const test = loadTestFile(file, opts.env);
  return runSingleTest(test, file, opts);
}

// ---------------------------------------------------------------------------
// Failures collection updater
// ---------------------------------------------------------------------------

/**
 * Rewrites local-dev-test-repo/tests/collections/_failures_/_collection.yaml
 * (or the equivalent path under `cwd`) so that its `order` list contains only
 * the cross-collection references for tests that failed in this run.
 *
 * Called on every run. A run with failures rewrites the order list with the
 * failing tests; a clean run writes an empty order list so stale failures
 * don't linger and mislead agents/humans into re-investigating tests that
 * now pass.
 */
function updateFailuresCollection(
  results: import('./types.js').TestResult[],
  config: import('./types.js').ShogunConfig,
  cwd: string,
): void {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');
  const failuresDir = join(collectionsDir, '_failures_');

  const failedRefs = results
    .filter(r => r.status === 'failed' || r.status === 'dependency_failed')
    .map(r => {
      // r.file is an absolute path like: …/collections/some-coll/test-name.yaml
      // We want: "some-coll/test-name"
      const rel = relative(collectionsDir, r.file).replace(/\\/g, '/');  // "some-coll/test-name.yaml"
      return rel.replace(/\.yaml$/, '');                     // "some-coll/test-name"
    })
    // Deduplicate (shouldn't happen, but be safe)
    .filter((ref, i, arr) => arr.indexOf(ref) === i);

  const isClean = failedRefs.length === 0;
  const orderLines = isClean ? '  # (empty — last run was clean)' : failedRefs.map(ref => `  - ${ref}`).join('\n');
  const timestamp = new Date().toISOString();

  const yaml = `# _failures_/_collection.yaml
#
# Auto-managed by the shogun runner.
#
# After any run, shogun rewrites the \`order\` list below with the
# collection/test references of every test that failed in that run.  Re-running
# this collection with:
#
#   shogun run --collection _failures_
#
# lets you quickly re-execute only the tests that broke in the previous run
# without having to remember which ones they were.
#
# A clean run (zero failures) clears the list so stale failures don't linger
# and mislead agents/humans into re-investigating tests that now pass.
#
# Tests with \`dependsOn\` declared will have their dependencies automatically
# satisfied when re-run — even from this failures collection.
#
# The setup/teardown scripts are intentionally empty — each referenced test
# brings its own collection's setup via the cross-collection reference
# mechanism.  Do not add shared auth or workspace-load logic here; it belongs
# in the originating collection.
#
# ⚠️  Do not hand-edit the \`order\` list — it is overwritten on every run.
#     To permanently pin a subset of tests, copy the list into a new named
#     collection or suite instead.
#
# Last updated: ${timestamp}

name: Failures
description: >
  Automatically populated with the tests that failed in the most recent run.
  Re-run with \`shogun run --collection _failures_\` to replay only failures.

order:
${orderLines}

tags:
  - failures
  - auto

setup: |
  ctx.log('_failures_ collection — no shared setup; each test owns its own context.');

teardown: |
  ctx.log('_failures_ collection teardown complete.');
`;

  if (!existsSync(failuresDir)) {
    mkdirSync(failuresDir, { recursive: true });
  }

  const outPath = join(failuresDir, '_collection.yaml');
  writeFileSync(outPath, yaml, 'utf8');
  if (isClean) {
    console.log(`\n  ✓  _failures_ collection cleared (clean run): ${outPath}`);
  } else {
    console.log(`\n  ✎  _failures_ collection updated (${failedRefs.length} test${failedRefs.length === 1 ? '' : 's'}): ${outPath}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildUrl(baseUrl: string, path: string): string {
  if (path.startsWith('http')) return path;
  return baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}

export function normalizeParams(params: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

export function mergeRequest(base: ShogunRequest, mutations: Partial<ShogunRequest>, baseUrl: string): ShogunRequest {
  const merged = { ...base, ...mutations };
  // Re-derive URL if path changed
  if (mutations.path && mutations.path !== base.path) {
    merged.url = buildUrl(baseUrl, mutations.path);
  }
  return merged;
}

export function applyVarMutations(vars: Record<string, unknown>, varMutations?: Record<string, unknown>): void {
  if (!varMutations) return;
  for (const [key, value] of Object.entries(varMutations)) {
    vars[key] = value;
  }
}

export function makeDummyRequest(baseUrl: string): ShogunRequest {
  return {
    method: 'GET',
    path: '/',
    url: baseUrl,
    headers: {},
    params: {},
  };
}

/** Sanitize a test name into a safe filename for baseline files. */
function safeBaselineName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse the --params CLI flag (JSON string) into an array of parameter sets.
 * Returns undefined if the flag was not provided or is invalid.
 * On invalid JSON, throws with a clear error message.
 */
function parseRuntimeParams(params?: string): Record<string, unknown>[] | undefined {
  if (!params) return undefined;
  try {
    const parsed = JSON.parse(params);
    if (!Array.isArray(parsed)) {
      throw new Error('--params must be a JSON array of objects, e.g. \'[{"UserId": 42}]\'');
    }
    return parsed as Record<string, unknown>[];
  } catch (err) {
    throw new Error(`Invalid --params JSON: ${err}. Expected format: '[{"paramName": "value"}]'`);
  }
}

export function makeFailedResult(
  name: string,
  file: string,
  startMs: number,
  assertions: Record<string, unknown>,
  error: string,
  scriptOutput: string[],
): TestResult {
  return {
    name,
    file,
    status: 'failed',
    durationMs: Date.now() - startMs,
    assertions,
    error,
    scriptOutput: scriptOutput.length ? scriptOutput : undefined,
  };
}

// Color codes (same as reporter, inlined to avoid circular dep)
const isTTY = process.stdout.isTTY;
const c = {
  yellow: isTTY ? '\x1b[33m' : '',
  reset:  isTTY ? '\x1b[0m'  : '',
};
