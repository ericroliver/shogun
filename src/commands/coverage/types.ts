/**
 * src/commands/coverage/types.ts
 * Internal types for the coverage command.
 */

// ---------------------------------------------------------------------------
// Public args interface
// ---------------------------------------------------------------------------

export interface CoverageArgs {
  /** Positional: override spec source (URL or local file path) */
  specSource?: string;
  /** --env: load env file for live spec fetching */
  env?: string;
  /** --collection: scope test-side to one collection */
  collection?: string | string[];
  /** --suite: scope test-side to a named suite */
  suite?: string;
  /** --tag: scope spec-side to a tag group */
  tag?: string;
  /** --uncovered: deprecated alias for --gaps */
  uncovered?: boolean;
  /** --gaps: show unified gap analysis instead of endpoint list */
  gaps?: boolean;
  /** --format: output format */
  format?: 'pretty' | 'json' | 'markdown';
  /** --detail: show per-endpoint depth matrix (progressive disclosure) */
  detail?: boolean;
  /** --last-run: join latest run results into coverage analysis */
  lastRun?: boolean;
  /** --run <id>: load a specific run by ID */
  runId?: string;
  /** --deps: show test dependency graph */
  deps?: boolean;
  /** --compare: compare two runs and show delta */
  compare?: boolean;
  /** --compare <id1> <id2>: explicit run IDs for comparison */
  compareRunIds?: [string, string];
  /** --min-coverage <n>: global endpoint coverage threshold (CI gate) */
  minCoverage?: number;
  /** --out <file>: write report to file instead of stdout */
  out?: string;
  /** --top <n>: limit --gaps output to the top N highest-priority gaps */
  top?: number;
  /** --suppress-drift <code,code>: hide spec-drift entries for these status codes */
  suppressDrift?: string[];
  /** cwd override */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface TestRunResult {
  httpStatus: number;
  durationMs: number;
  status: 'passed' | 'failed' | 'needs_baseline' | 'dependency_failed';
  assertionsPassed: boolean;
}

export interface TestEntry {
  // --- existing fields (unchanged) ---
  name: string;
  file: string;           // relative path from cwd
  collection: string;
  staticPath: string;     // raw request.path from YAML
  method: string;         // normalized to uppercase
  tags: string[];
  matchedSpecKey?: string; // "GET /api/graph/nodes" — set after matching

  // --- NEW: response assertion metadata ---
  expectedStatus?: number;          // response.status from YAML
  shapeAssertions: string[];        // response.shape[] entries (may be empty)
  snapshotEnabled: boolean;         // response.snapshot === true
  postScriptAssertCount: number;    // heuristic: count of `assert(` in post script body
  hasPreScript: boolean;            // pre: field is present and non-empty
  hasPostScript: boolean;           // post: field is present and non-empty

  // --- NEW: request metadata ---
  requestBodyFields: string[];      // top-level keys from inline body or fixture file
  requestParams: string[];          // keys from request.params + query string params

  // --- NEW: run result (populated only with --last-run, Story 10) ---
  runResult?: TestRunResult;

  // --- NEW: raw script bodies (Story 14 — dependency graph) ---
  preScriptBody?: string;   // raw pre script source (only stored if hasPreScript === true)
  postScriptBody?: string;  // raw post script source (only stored if hasPostScript === true)

  // --- NEW: explicit covers annotation (405 method-guard / parent-path) ---
  covers?: CoverAnnotation[];
}

/**
 * Explicit coverage declaration. Allows a test to declare which spec endpoint
 * and response code it covers, bypassing the normal method+path matching.
 *
 * Use cases:
 *   - 405 method-guard tests that send a wrong HTTP method intentionally
 *   - Parent-path tests that cover multiple child endpoints
 *   - Sub-routes with literal UUIDs that don't template-match
 */
export interface CoverAnnotation {
  /** Spec endpoint key, e.g. "POST /api/auth/login" */
  endpoint: string;
  /** Response code this test covers, e.g. 405 */
  responseCode?: number;
}

export interface SpecParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
}

export interface SpecBodyField {
  name: string;
  required: boolean;
}

export interface SpecEndpoint {
  method: string;         // uppercase
  path: string;           // raw OAS path e.g. /api/graph/nodes/{path}
  tag?: string;
  summary?: string;
  tests: TestEntry[];     // populated during match phase

  // --- NEW: contract detail ---
  documentedResponseCodes: string[];   // e.g. ["200", "400", "403", "404"]
  parameters: SpecParam[];             // path + query params from spec
  requestBodyFields: SpecBodyField[];  // top-level field names + required flag from requestBody schema
}

// ---------------------------------------------------------------------------
// Response code coverage (Story 4)
// ---------------------------------------------------------------------------

export type ResponseCodeStatus =
  | 'tested'          // spec-declared AND test-declared (and actual matches if run data present)
  | 'untested'        // spec-declared but NO test declares this code
  | 'undocumented'    // test-declared (or actual) but NOT in spec
  | 'mismatch';       // test expects X, API returned Y (requires run data)

export interface ResponseCodeEntry {
  code: string;                    // e.g. "200", "400"
  inSpec: boolean;                 // documented in OpenAPI spec
  testedByDeclared: boolean;       // at least one test has response.status == this code
  testedByActual: boolean;         // at least one run result had httpStatus == this code (run data only)
  status: ResponseCodeStatus;
  mismatchDetail?: string;         // e.g. "test expects 400, API returned 200"
}

export interface EndpointResponseCodeCoverage {
  specKey: string;                 // "POST /api/users"
  allCodes: ResponseCodeEntry[];   // union of spec + declared + actual codes
  coveredCount: number;            // codes with status === 'tested'
  totalSpecCodes: number;          // documentedResponseCodes.length
  coveragePct: number;             // coveredCount / totalSpecCodes * 100 (0 if totalSpecCodes === 0)
  hasDrift: boolean;               // any code with status === 'undocumented' or 'mismatch'
}

// ---------------------------------------------------------------------------
// Parameter coverage (Story 6)
// ---------------------------------------------------------------------------

export interface ParameterCoverageEntry {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  tested: boolean;       // at least one test exercises this parameter
  inferredOnly: boolean; // true if coverage was detected via pre-script heuristic, not YAML
}

export interface EndpointParameterCoverage {
  specKey: string;
  parameters: ParameterCoverageEntry[];
  testedCount: number;
  totalCount: number;
  coveragePct: number;
  hasUntested: boolean;
}

// ---------------------------------------------------------------------------
// Request body field coverage (Story 7)
// ---------------------------------------------------------------------------

export interface BodyFieldCoverageEntry {
  name: string;
  required: boolean;    // from spec schema
  tested: boolean;      // at least one test includes this field in its request body
}

export interface EndpointBodyFieldCoverage {
  specKey: string;
  fields: BodyFieldCoverageEntry[];
  testedCount: number;
  totalCount: number;
  coveragePct: number;
  hasUntested: boolean;
  hasUntestedRequired: boolean;  // any required field is untested — higher severity
}

// ---------------------------------------------------------------------------
// Assertion quality metrics (Story 8) + thin test flag (Story 8b)
// ---------------------------------------------------------------------------

export interface TestQualityScore {
  testName: string;
  file: string;
  rawScore: number;          // sum of weighted signals
  isThin: boolean;           // rawScore <= 1
  breakdown: {
    statusScore: number;     // 0 or 1
    shapeScore: number;      // 2 * shapeAssertions.length
    snapshotScore: number;   // 0 or 3
    postScriptScore: number; // postScriptAssertCount
  };
}

export interface EndpointQualityScore {
  specKey: string;
  tests: TestQualityScore[];
  normalizedScore: number;   // 0–100, aggregate of all tests for this endpoint
  thinTestCount: number;     // count of tests with isThin === true
}

// ---------------------------------------------------------------------------
// Gap analysis (Story 11)
// ---------------------------------------------------------------------------

export type GapSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface CoverageGap {
  severity: GapSeverity;
  category: string;          // human-readable category name
  endpoint: string;          // "POST /api/users"
  detail: string;            // specific gap description
  file?: string;             // test file path (for thin tests, failing tests)
}

// ---------------------------------------------------------------------------
// Risk score (Story 12)
// ---------------------------------------------------------------------------

export interface EndpointRiskScore {
  specKey: string;
  score: number;           // 0–100, higher = more risk
  isUncovered: boolean;    // true if no tests (score is always 100)
  signals: {
    responseCodeGap: number;    // 0–1
    parameterGap: number;       // 0–1
    bodyFieldGap: number;       // 0–1
    assertionQuality: number;   // 0–1
    runResults: number;         // 0–1
  };
}

// ---------------------------------------------------------------------------
// Negative testing & tag intelligence (Story 13)
// ---------------------------------------------------------------------------

export interface NegativeTestingRatio {
  total: number;
  twoxx: number;    // tests with expectedStatus 200–299
  fourxx: number;   // tests with expectedStatus 400–499
  fivexx: number;   // tests with expectedStatus 500–599
  twoxxPct: number;
  fourxxPct: number;
  fivexxPct: number;
  onlyHappyPath: boolean;  // fourxx === 0 && fivexx === 0 && total > 0
}

export interface TagCoverageGap {
  method: string;
  expectedTags: string[];
  presentTags: string[];
  missingTags: string[];
}

export interface EndpointTestingProfile {
  specKey: string;
  negativeRatio: NegativeTestingRatio;
  tagGap?: TagCoverageGap;  // undefined if no expected tags configured for this method
}

// ---------------------------------------------------------------------------
// Test dependency graph (Story 14)
// ---------------------------------------------------------------------------

export interface VarWrite {
  varName: string;
  testName: string;
  collection: string;
  file: string;
  scriptType: 'pre' | 'post';
}

export interface VarRead {
  varName: string;
  testName: string;
  collection: string;
  file: string;
  scriptType: 'pre' | 'post';
}

export interface DependencyEdge {
  varName: string;
  producer: { testName: string; collection: string; file: string };
  consumer: { testName: string; collection: string; file: string };
  crossCollection: boolean;
}

export interface OrphanedVar {
  varName: string;
  writtenBy: { testName: string; collection: string; file: string };
}

export interface CascadeRisk {
  varName: string;
  producer: { testName: string; collection: string };
  consumerCount: number;
  consumers: Array<{ testName: string; collection: string }>;
}

export interface DependencyGraph {
  edges: DependencyEdge[];
  orphanedVars: OrphanedVar[];
  cascadeRisks: CascadeRisk[];   // vars with 3+ consumers
  crossCollectionDeps: DependencyEdge[];
}

// ---------------------------------------------------------------------------
// Spec drift detection (Story 17)
// ---------------------------------------------------------------------------

export type DriftType = 'undocumented-code' | 'test-vs-reality';

export interface SpecDriftEntry {
  type: DriftType;
  endpoint: string;          // "POST /api/users"
  code: string;              // the response code involved
  detail: string;            // human-readable description
  testName?: string;         // for test-vs-reality: which test
  testFile?: string;         // for test-vs-reality: which file
}

export interface SpecDriftReport {
  entries: SpecDriftEntry[];
  undocumentedCodeCount: number;
  testVsRealityCount: number;
  affectedEndpoints: string[];  // deduplicated list of endpoints with any drift
  /** Codes hidden from per-endpoint output via --suppress-drift / config. */
  suppressedCodes: string[];
  /** Number of drift occurrences hidden by suppression (for the global note). */
  suppressedCount: number;
  /** Number of distinct endpoints affected by suppressed drift. */
  suppressedEndpointCount: number;
}

// ---------------------------------------------------------------------------
// Run delta / compare (Story 15)
// ---------------------------------------------------------------------------

export interface RunDelta {
  newerRunId: string;
  olderRunId: string;
  newerSuite?: string;
  olderSuite?: string;

  // Endpoint coverage changes
  newlyCovered: string[];      // endpoints covered in newer but not older
  lostCoverage: string[];      // endpoints covered in older but not newer
  stillUncovered: string[];    // endpoints uncovered in both

  // Test changes
  testsAdded: string[];        // test names in newer but not older (by name+collection)
  testsRemoved: string[];      // test names in older but not newer
  testsNowPassing: string[];   // failed in older, passed in newer
  testsNowFailing: string[];   // passed in older, failed in newer

  // Summary stats
  endpointCoverageDelta: number;   // newer.coveredEndpoints - older.coveredEndpoints
  passRateDelta: number;           // newer pass% - older pass%
}

export interface CoverageSummary {
  apiTitle: string;
  apiVersion: string;
  totalEndpoints: number;
  coveredEndpoints: number;
  uncoveredEndpoints: number;
  totalTests: number;
  collections: number;
  coveragePct: number;
  totalSpecResponseCodes: number;   // sum of documentedResponseCodes.length across all endpoints
  coveredResponseCodes: number;     // sum of coveredCount across all EndpointResponseCodeCoverage
  responseCodeCoveragePct: number;  // coveredResponseCodes / totalSpecResponseCodes * 100
  totalSpecParams: number;          // sum of parameters.length across all endpoints
  testedParams: number;             // sum of testedCount across all EndpointParameterCoverage
  paramCoveragePct: number;         // testedParams / totalSpecParams * 100
  totalSpecBodyFields: number;      // sum of requestBodyFields.length across all endpoints
  testedBodyFields: number;         // sum of testedCount across all EndpointBodyFieldCoverage
  bodyFieldCoveragePct: number;     // testedBodyFields / totalSpecBodyFields * 100
  avgQualityScore: number;          // average normalizedScore across all covered endpoints
  thinTestCount: number;            // total thin tests across all endpoints
  highRiskEndpointCount: number;    // endpoints with riskScore >= 50
  suiteNegativeRatio: NegativeTestingRatio;  // suite-wide aggregate
  onlyHappyPathCount: number;                // endpoints with only 2xx tests
  specDriftCount: number;                    // total drift entries (0 if no run data)
}

// ---------------------------------------------------------------------------
// Minimal OpenAPI 3 types (only what we need)
// ---------------------------------------------------------------------------

export interface RefObject {
  '$ref': string;
}

export interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaObject | RefObject>;
  required?: string[];
  allOf?: Array<SchemaObject | RefObject>;
  oneOf?: Array<SchemaObject | RefObject>;
  anyOf?: Array<SchemaObject | RefObject>;
  items?: SchemaObject | RefObject;
}

export interface ParameterObject {
  name: string;
  in: string;
  required?: boolean;
  schema?: SchemaObject | RefObject;
}

export interface RequestBodyObject {
  content?: {
    'application/json'?: {
      schema?: SchemaObject | RefObject;
    };
    [contentType: string]: unknown;
  };
}

export interface ResponsesObject {
  [statusCode: string]: unknown;
}

export interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    schemas?: Record<string, SchemaObject | RefObject>;
    parameters?: Record<string, ParameterObject>;
    requestBodies?: Record<string, RequestBodyObject>;
  };
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
}

export interface OperationObject {
  tags?: string[];
  summary?: string;
  responses?: ResponsesObject;
  parameters?: Array<ParameterObject | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
