/**
 * src/backend-interface.ts
 * Defines the BackendExecutor interface that all backends must implement.
 *
 * UnixBackend: wraps existing curl/jq/diff logic (MOVED, NOT CHANGED)
 * PowerShellBackend: new Invoke-RestMethod/PS cmdlets implementation
 */

import type {
  ShogunRequest,
  ShogunResponse,
  EnvVars,
  AssertionResults,
  ShapeAssertionResult,
  AssertContext,
} from './types.js';

// Re-export AssertContext so asserter.ts and backends can import it from here
export type { AssertContext } from './types.js';

export interface QueryResult {
  passed: boolean;
  error?: string;
}

export interface DependencyCheck {
  name: string;
  found: boolean;
  version?: string;
  optional: boolean;
}

export interface SnapshotResult {
  passed: boolean;
  diff?: string;
  needsBaseline?: boolean;
}

export interface ExecutorOptions {
  timeout?: number;
  followRedirects?: boolean;
}

export interface BackendExecutor {
  /** Backend name (for logging/debugging) */
  readonly name: 'unix' | 'powershell';

  /** HTTP execution — spawn curl or Invoke-RestMethod */
  executeRequest(
    req: ShogunRequest,
    env: EnvVars,
    opts?: ExecutorOptions,
  ): Promise<ShogunResponse>;

  /** JSON query/assertion — spawn jq or PowerShell */
  runJsonQuery(json: string, expression: string): Promise<QueryResult>;

  /** Run multiple shape assertions against a JSON response body */
  runShapeAssertions(
    json: string,
    expressions: string[],
  ): Promise<ShapeAssertionResult[]>;

  /** JSON normalization for snapshot comparison */
  normalizeJson(json: string, ignoreFields: string[]): Promise<string>;

  /** Diff production for snapshot failures */
  runDiff(expected: string, actual: string): Promise<string>;

  /** Health check: verify backend tools are available */
  checkDependencies(): Promise<DependencyCheck[]>;

  /** Snapshot assertion helper (optional — can use default in asserter) */
  runSnapshotAssertion?(ctx: AssertContext): Promise<SnapshotResult>;
}
