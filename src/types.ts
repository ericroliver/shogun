/**
 * src/types.ts
 * Shared types for the shogun API testing engine.
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type EnvVars = Record<string, string>;

// ---------------------------------------------------------------------------
// Test Definition (parsed from YAML)
// ---------------------------------------------------------------------------

/** A file attachment for multipart/form-data requests. */
export interface FormFile {
  /** Path to the file to upload (relative to the YAML file location, or absolute) */
  path: string;
  /** Content-Type for this file part (optional, curl auto-detects by extension) */
  content_type?: string;
  /** Override the filename sent in the multipart part (optional, defaults to basename of path) */
  filename?: string;
}

export interface RequestBody {
  /** Inline JSON body — supports ${VAR} interpolation */
  inline?: Record<string, unknown>;
  /** Path to a JSON fixture file (relative to the YAML file location) */
  file?: string;
  /** Multipart form text fields (used when content_type is multipart/form-data) */
  form_fields?: Record<string, string>;
  /** Multipart form file attachments (used when content_type is multipart/form-data) */
  form_files?: Record<string, FormFile>;
}

export interface RequestDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL path, may contain ${VAR} tokens */
  path: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  /** Content-Type for this request (optional, overrides config.defaults.content_type) */
  content_type?: string;
  body?: RequestBody;
}

// ---------------------------------------------------------------------------
// SQL Testing Types
// ---------------------------------------------------------------------------

/**
 * Supported SQL driver types.
 * v1: mssql only.
 * Future: postgres (pg), sqlite (better-sqlite3).
 */
export type SqlDriverType = 'mssql' | 'postgres' | 'sqlite';

/**
 * Named database connection configuration for SQL tests.
 * Defined in shogun.config.yaml under `connections:`.
 */
export interface SqlConnectionConfig {
  /** Database driver — determines which SqlDriver implementation is used */
  driver: SqlDriverType;
  /** Connection string with ${VAR} interpolation from env */
  connectionString: string;
  /** Query timeout in seconds (optional, defaults to config.defaults.timeout) */
  timeout?: number;
}

/**
 * SQL test configuration within a test definition.
 */
export interface SqlTestConfig {
  /** Named connection from config.connections */
  connection: string;
  /** Stored procedure name (required if `query` is not set) */
  proc?: string;
  /** Raw SQL query to execute (required if `proc` is not set). Use @paramName for parameter substitution. */
  query?: string;
  /** Override name for the baseline file. Defaults to proc name or sanitized test name. */
  baseline?: string;
  /** Parameter sets — inline array, file reference, or omitted (provided via --params at runtime) */
  parameters?:
    | { inline: Record<string, unknown>[] }
    | { file: string };
  /** Output artifact format. Baseline is always JSON. Default: json */
  outputFormat?: 'json' | 'csv' | 'both';
  /** Query timeout override (seconds) */
  timeout?: number;
  /** Pre-execution script (runs once before all parameter sets) */
  pre?: string;
  /** Post-execution script (runs once after all parameter sets) */
  post?: string;
}

/**
 * SQL test context available in pre/post scripts for type: sql tests.
 */
export interface SqlScriptContext {
  /** Number of parameter sets to be executed (available in pre-script) */
  paramCount: number;
  /** The parameter sets themselves (available in pre-script) */
  params: Record<string, unknown>[];
  /** Results after execution (available in post-script only, undefined in pre) */
  results?: import('./sql-driver.js').SqlExecResult[];
  /** The proc name (undefined for query-based tests) */
  proc?: string;
  /** The raw SQL query (undefined for proc-based tests) */
  query?: string;
  /** The connection name */
  connection: string;
}

// ---------------------------------------------------------------------------
// Agent Testing Types
// ---------------------------------------------------------------------------

/**
 * Agent test configuration.
 * Present when `type === 'agent'` on a TestDefinition.
 */
export interface AgentTestConfig {
  /** OpenAI-compatible /chat/completions endpoint URL (required) */
  endpoint: string;
  /** Model identifier for the target agent (required) */
  model: string;
  /** The prompt sent to the target agent (required) */
  prompt: string;
  /** Target agent temperature (optional, default 0.7) */
  temperature?: number;
  /** Max tokens for target agent response (optional — omitted from request body if not set) */
  max_tokens?: number;
  /** API key for target agent, sent as Authorization: Bearer <key>. If not set, no auth header. */
  api_key?: string;
  /** Optional additional parameters */
  parameters?: {
    /** Mapped to messages[0] with role: "system" */
    system_prompt?: string;
    /** File paths whose contents are appended to the user message */
    context_files?: string[];
  };
}

/**
 * Expected behavior definition for agent tests.
 * At least one of `description` or `evaluate.criteria` must be present.
 */
export interface AgentExpectedDef {
  /** Semantic description of expected behavior */
  description?: string;
}

/**
 * Evaluation configuration for agent tests.
 * Can appear at test level; endpoint/model/api_key fall back to global config.
 */
export interface AgentEvaluateConfig {
  /** List of evaluation criteria (optional, but at least one of criteria or expected.description is required) */
  criteria?: string[];
  /** Minimum grade (0–100) to pass. Default: 80 */
  min_pass?: number;
  /** Override global evaluator endpoint */
  endpoint?: string;
  /** Override global evaluator model */
  model?: string;
  /** Override global evaluator API key */
  api_key?: string;
  /** Override global evaluator temperature. Default: 0 */
  temperature?: number;
  /** Override global evaluator timeout (seconds). Default: 300 */
  timeout?: number;
  /** Optional system prompt for the evaluator */
  evaluator_system_prompt?: string;
}

/**
 * The structured JSON that the evaluator LLM must return.
 * Shogun parses and validates this; any deviation is an evaluation error.
 */
export interface EvaluatorResponse {
  status: 'evaluated' | 'indeterminate';
  /** Required when status === 'evaluated' */
  grade?: number;
  reasoning: string;
  criteriaResults?: {
    criterion: string;
    met: boolean;
    reasoning?: string;
  }[];
}

/**
 * Shogun's assertion result for an agent test.
 * Produced by Shogun after validating the EvaluatorResponse and applying min_pass.
 */
export interface EvaluationAssertionResult {
  status: 'evaluated' | 'indeterminate';
  /** From evaluator, present when status === 'evaluated' */
  grade?: number;
  /** Computed by Shogun: grade >= min_pass */
  passed: boolean;
  /** The min_pass threshold applied (default 80) */
  minPass: number;
  reasoning: string;
  criteriaResults?: {
    criterion: string;
    met: boolean;
    reasoning?: string;
  }[];
  evaluatorModel?: string;
  durationMs?: number;
}

export interface ResponseDef {
  /** Expected HTTP status code */
  status?: number;
  /** Enable snapshot baseline diff */
  snapshot?: boolean;
  /** jq paths to strip before snapshot diff (merged with global config) */
  ignore_fields?: string[];
  /** Array of jq boolean expressions — each must evaluate truthy */
  shape?: string[];
  /**
   * SQL diff mode: 'strict' (default) or 'relaxed'.
   * strict:  any schema or data difference fails the test.
   * relaxed: extra columns in actual results are ignored; only columns present
   *          in the baseline are compared. Row count and value changes still fail.
   * HTTP tests ignore this field.
   */
  diff_mode?: 'strict' | 'relaxed';
}

export interface TestDefinition {
  name: string;
  description?: string;
  /** Test type: 'http' (default), 'sql', or 'agent'. Existing YAML files omit this field. */
  type?: 'http' | 'sql' | 'agent';
  collection?: string;
  tags?: string[];
  /**
   * Ordered list of test IDs this test depends on.
   * Format: "collection/test-name" (cross-collection) or "test-name" (same collection).
   * The runner will execute all deps — and their collection setups — before this test.
   * Each dep runs at most once per session regardless of how many tests reference it.
   */
  dependsOn?: string[];
  /** Per-test env var overrides (merged on top of loaded .env) */
  env?: EnvVars;
  /** TypeScript source — runs before curl (HTTP) or before all params (SQL) */
  pre?: string;
  /** HTTP request definition. Required for HTTP tests, omitted for SQL tests. */
  request?: RequestDef;
  response?: ResponseDef;
  /** TypeScript source — runs after assertions (HTTP) or after all params (SQL) */
  post?: string;
  /** SQL test configuration. Used when type is 'sql'. */
  sql?: SqlTestConfig;
  /** Agent test configuration. Used when type is 'agent'. */
  agent?: AgentTestConfig;
  /** Expected behavior definition for agent tests. */
  expected?: AgentExpectedDef;
  /** Evaluation configuration for agent tests. */
  evaluate?: AgentEvaluateConfig;
}

// ---------------------------------------------------------------------------
// Collection Definition (parsed from _collection.yaml)
// ---------------------------------------------------------------------------

export interface CollectionDefinition {
  name: string;
  description?: string;
  order?: string[];
  tags?: string[];
  /**
   * Named setup fixtures to run before this collection's own setup: script.
   * References fixture names in tests/setup-fixtures/ (without .yaml extension).
   * Fixtures are idempotent — each runs at most once per session.
   */
  setup_fixtures?: string[];
  /** TypeScript source — runs once before first test (after setup_fixtures) */
  setup?: string;
  /** TypeScript source — runs once after last test, even on failure */
  teardown?: string;
  /**
   * Pre-seeded into ctx.vars before setup_fixtures and setup run.
   * Collection vars override suite vars on collision.
   * Values declared here belong to the collection, not the .env file.
   */
  vars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Suite Definition (parsed from tests/suites/*.yaml)
// ---------------------------------------------------------------------------

export interface SuiteDefinition {
  name: string;
  description?: string;
  collections: string[];
  tags?: string[];
  /**
   * Pre-seeded into ctx.vars at run start, before any collection setup fires.
   * Suite vars are overridden by collection vars on collision.
   * Use for suite-level parameters like WORKSPACE_NAME that differ per suite.
   */
  vars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Setup Fixture Definition (parsed from tests/setup-fixtures/*.yaml)
// ---------------------------------------------------------------------------

/**
 * A named, reusable setup script that can be referenced by multiple collections
 * via setup_fixtures: [...]. Fixtures are stateless setup-only scripts — no teardown.
 * They should be idempotent (guard with ctx.vars._fixtureLoaded_{name}).
 */
export interface SetupFixtureDefinition {
  name: string;
  description?: string;
  /** TypeScript source — same ctx as collection setup, including ctx.http */
  script: string;
}

// ---------------------------------------------------------------------------
// Runtime context — injected into pre/post scripts
// ---------------------------------------------------------------------------

export interface ShogunRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
  /** Content-Type for this request (set from RequestDef or pre-script) */
  content_type?: string;
}

/**
 * A single Server-Sent Event parsed from an SSE response.
 * Only populated when Content-Type is text/event-stream.
 */
export interface SseEvent {
  /** SSE event type (from `event:` line, default: "message") */
  event: string;
  /** Parsed data from `data:` line(s). JSON-parsed if possible, else string. */
  data: unknown;
}

export interface ShogunResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
  duration: number;
  /** Time reported by curl's own %{time_total} (ms) */
  curlMs: number;
  /**
   * Parsed SSE events (only set when Content-Type is text/event-stream).
   * Each entry has `{ event: string, data: unknown }`.
   * For non-SSE responses, this is undefined.
   */
  events?: SseEvent[];
}

export type HttpMethod = {
  get(path: string, opts?: RequestOpts): Promise<ShogunResponse>;
  post(path: string, body: unknown, opts?: RequestOpts): Promise<ShogunResponse>;
  put(path: string, body: unknown, opts?: RequestOpts): Promise<ShogunResponse>;
  patch(path: string, body: unknown, opts?: RequestOpts): Promise<ShogunResponse>;
  delete(path: string, opts?: RequestOpts): Promise<ShogunResponse>;
};

export interface RequestOpts {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  timeout?: number;
}

export interface ShogunContext {
  /** Merged env vars: global config + .env file + test-level overrides */
  env: EnvVars;
  /** Mutable cross-test variable store — persists for the entire run */
  vars: Record<string, unknown>;
  /** Current request — mutable in pre-script */
  request: ShogunRequest;
  /** Current response — available in post-script */
  response: ShogunResponse;
  /** Throws ShogunAssertionError if condition is false */
  assert(condition: boolean, message: string): void;
  /** Write a message to stdout and to the per-test run log */
  log(message: string): void;
  /** HTTP helpers for setup/teardown/chaining (does NOT use curl) */
  http: HttpMethod;
  /** Shared scripts loaded from scripts/ directory */
  scripts: Record<string, unknown>;
}

export interface ShogunContext {
  /** Merged env vars: global config + .env file + test-level overrides */
  env: EnvVars;
  /** Mutable cross-test variable store — persists for the entire run */
  vars: Record<string, unknown>;
  /** Current request — mutable in pre-script */
  request: ShogunRequest;
  /** Current response — available in post-script */
  response: ShogunResponse;
  /** Throws ShogunAssertionError if condition is false */
  assert(condition: boolean, message: string): void;
  /** Write a message to stdout and to the per-test run log */
  log(message: string): void;
  /** HTTP helpers for setup/teardown/chaining (does NOT use curl) */
  http: HttpMethod;
  /** Shared scripts loaded from scripts/ directory */
  scripts: Record<string, unknown>;
  /** SQL test context — only populated for type: sql tests */
  sql?: SqlScriptContext;
}

export interface AssertContext {
  test: TestDefinition;
  response: ShogunResponse;
  config: ShogunConfig;
  cwd: string;
  collectionName?: string;
  /** When true: write snapshot instead of diffing */
  snapshotMode?: boolean;
}

// ---------------------------------------------------------------------------
// Assertion results
// ---------------------------------------------------------------------------

export interface ShapeAssertionResult {
  expr: string;
  passed: boolean;
  error?: string;
}

export interface AssertionResults {
  status?: boolean;
  shape?: ShapeAssertionResult[];
  snapshot?: boolean;
  snapshotDiff?: string | null;
  postScript?: boolean;
  postScriptError?: string;
  // Agent test evaluation result
  evaluation?: EvaluationAssertionResult;
}

// ---------------------------------------------------------------------------
// Run log schema
// ---------------------------------------------------------------------------

export type TestResultStatus = 'passed' | 'failed' | 'needs_baseline' | 'dependency_failed';

export interface TestTimings {
  /** Wall-clock time for curl to complete, per curl's own %{time_total} */
  curlMs: number;
  /** Time spent in jq shape checks + snapshot diff */
  assertMs: number;
  /** Time spent running the pre-script (tsx transpile + execute) */
  preMs: number;
  /** Time spent running the post-script (tsx transpile + execute) */
  postMs: number;
  /** Remainder: request build, env merge, bookkeeping */
  otherMs: number;
}

export interface TestResult {
  name: string;
  file: string;
  status: TestResultStatus;
  httpStatus?: number;
  durationMs: number;
  timings?: TestTimings;
  assertions: AssertionResults;
  scriptOutput?: string[];
  error?: string;
  /**
   * When status === 'dependency_failed': the canonical ID ("collection/test-name")
   * of the first dependency that failed. Enables root-cause tracing without noise.
   */
  failedDependency?: string;
  /**
   * The resolved request that was (or would have been) sent to the server.
   * Only populated on failed tests — omitted on passing tests to reduce noise.
   */
  resolvedRequest?: ShogunRequest;
  /**
   * The raw HTTP response received from the server.
   * Only populated on failed tests — omitted on passing tests to reduce noise.
   */
  resolvedResponse?: ShogunResponse;
  /**
   * Summary of SQL execution results (only for type: sql tests).
   * Populated on failed SQL tests for diagnostics.
   */
  sqlExecSummary?: {
    totalParams: number;
    executed: number;
    errors: number;
    totalRows: number;
  };

  // Agent test diagnostics (present only for type: agent tests)
  /** Raw target agent HTTP response (on failure or verbose) */
  agentResponse?: ShogunResponse;
  /** The evaluation prompt HTTP request (on failure or verbose) */
  evaluationRequest?: ShogunRequest;
  /** Raw evaluator HTTP response (on failure or verbose) */
  evaluationResponse?: ShogunResponse;
}

export interface RunSummary {
  runId: string;
  env: string;
  collection?: string | string[];
  suite?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  needsBaseline: number;
  dependencyFailed: number;
  results: TestResult[];
}

// ---------------------------------------------------------------------------
// Session state — tracks what has executed within a single shogun run
// ---------------------------------------------------------------------------

/**
 * Maintained for the lifetime of a single `shogun run` invocation.
 * Ensures deps and fixtures execute at most once per session.
 */
export interface SessionState {
  /**
   * Canonical test IDs ("collection/test-name") → execution outcome.
   * Tests not yet attempted are absent from the map.
   */
  testsRun: Map<string, 'passed' | 'failed'>;
  /**
   * Collection names whose setup hook (including setup_fixtures) has already run.
   */
  collectionsSetup: Set<string>;
  /**
   * Collection names whose teardown hook has already run.
   */
  collectionsTornDown: Set<string>;
  /**
   * Fixture names already executed this session (idempotency enforcement layer).
   */
  fixturesRun: Set<string>;
}

// ---------------------------------------------------------------------------
// Config file schema (shogun.config.yaml)
// ---------------------------------------------------------------------------

export interface SpecConfig {
  /**
   * Server-relative route to the live OpenAPI JSON endpoint.
   * Fetched at runtime as: {BASE_URL}/{path}
   * Example: "swagger/v1/swagger.json"
   */
  path: string;
}

// ---------------------------------------------------------------------------
// Coverage configuration (shogun.config.yaml → coverage:)
// ---------------------------------------------------------------------------

/**
 * Per-dimension risk-score weights for the coverage risk score (Story 12).
 * Values are normalized at analysis time; they do not need to sum to 1.0.
 */
export interface CoverageRiskWeights {
  /** Weight for response-code coverage gaps. Default: 0.35 */
  responseCodeGap: number;
  /** Weight for parameter coverage gaps. Default: 0.15 */
  parameterGap: number;
  /** Weight for request body field coverage gaps. Default: 0.15 */
  bodyFieldGap: number;
  /** Weight for assertion quality deficit. Default: 0.20 */
  assertionQuality: number;
  /** Weight for run-result failures (only when --last-run is used). Default: 0.15 */
  runResults: number;
}

/**
 * Per-dimension coverage thresholds (0–100) for the `--min-coverage` CI gate.
 * Omit a dimension to skip checking it.
 */
export interface CoverageMinThresholds {
  endpoint?: number;
  responseCode?: number;
  parameter?: number;
  bodyField?: number;
}

/**
 * Optional `coverage:` block in shogun.config.yaml. All keys are optional;
 * sensible defaults ship out of the box so existing repos need zero config
 * changes to get v2 coverage behavior.
 */
export interface CoverageConfig {
  /** When --last-run is used without --suite, filter to this suite's runs. */
  defaultSuite?: string;
  /** Per-dimension risk-score weights (partial — merged over defaults). */
  riskWeights?: Partial<CoverageRiskWeights>;
  /** Method → expected test tags. Endpoints missing expected tags are flagged. */
  expectedTagsByMethod?: Record<string, string[]>;
  /** Per-dimension coverage thresholds for --min-coverage CI gate. */
  minCoverage?: CoverageMinThresholds;
  /**
   * Status codes to suppress from per-endpoint spec-drift output.
   * Useful for cross-cutting concerns like 401 (JWT middleware) that apply
   * globally and would otherwise flood the drift report. Suppressed codes
   * are summarised once as a global note instead of per-endpoint.
   * Default: ['401']
   */
  suppressDrift?: string[];
}

/**
 * Global evaluation configuration in shogun.config.yaml.
 * Per-test evaluate config can override endpoint/model/api_key.
 */
export interface EvaluationConfig {
  endpoint: string;
  api_key?: string;
  model: string;
  temperature?: number;  // default 0
  timeout?: number;  // default 300 (seconds)
}

export interface ShogunConfig {
  version: number;
  defaults?: {
    env?: string;
    timeout?: number;
    follow_redirects?: boolean;
    content_type?: string;
    /**
     * When true (default), shogun automatically injects AUTH_TOKEN from the env
     * file as an `Authorization: Bearer <token>` header on every request that
     * does not already have an Authorization header set.
     *
     * Set to false to disable auto-injection entirely. Auth must then be wired
     * explicitly in each collection's setup script via ctx.vars.authHeader and
     * applied in each test's pre-script. This is the recommended approach for
     * test suites that include unauthenticated guard tests.
     *
     * Default: true (preserves backward-compatible behaviour)
     */
    auto_inject_auth?: boolean;
  };
  paths?: {
    tests?: string;
    envs?: string;
    expected?: string;
    runs?: string;
    scripts?: string;
    /** Directory containing setup fixture YAML files. Default: tests/setup-fixtures */
    setup_fixtures?: string;
  };
  ignore_fields_global?: string[];
  reporting?: {
    format?: 'pretty' | 'json' | 'tap';
    on_fail?: 'diff' | 'body' | 'silent';
    save_passing_logs?: boolean;
  };
  /** OpenAPI spec source configuration */
  spec?: SpecConfig;
  /** Named database connections for SQL tests. Optional — HTTP-only repos don't need this. */
  connections?: Record<string, SqlConnectionConfig>;
  /** Coverage report v2 configuration. All keys optional. */
  coverage?: CoverageConfig;
  /** Global evaluation configuration for agent tests. */
  evaluation?: EvaluationConfig;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ShogunAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShogunAssertionError';
  }
}

export class ShogunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShogunConfigError';
  }
}
