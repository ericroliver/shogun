# Story 10 — `--last-run` Integration (Run Results Bridge)

**Wave:** 3  
**Status:** Ready for implementation  
**Depends on:** Story 0 (config layer), Story 2 (enhanced test collection), Story 4 (response code matrix)  
**Files touched:** `src/commands/coverage/run-loader.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/index.ts`, `src/commands/coverage/analyzer.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`, [`src/index.ts`](../../../src/index.ts)

---

## Problem

Static analysis (spec + test YAML) can only show what tests *intend* — what status codes they expect, what fields they send. It cannot show what the API *actually returned*. A test that expects 200 and gets 500 is a failure, but the coverage report currently has no way to surface that. The run results plane (run.json files in `runs/`) contains exactly this data — actual HTTP statuses, pass/fail outcomes, durations — and it has never been joined to coverage analysis.

---

## Goal

When `--last-run` is passed, load the most recent run's `summary.json`, join its results to the test entries by name+collection, and surface actual HTTP statuses, pass/fail outcomes, and durations in the coverage report. Also wire the `defaultSuite` config (Story 0) to filter which run is loaded.

---

## CLI Interface

```bash
# Load latest run (filtered by coverage.defaultSuite if configured)
shogun coverage --env local --last-run

# Override suite filter for run resolution
shogun coverage --env local --last-run --suite smoke

# Bypass suite filter entirely — truly latest run
shogun coverage --env local --last-run --suite any

# Load a specific run by ID
shogun coverage --env local --run 2026-07-03T14-22-00
```

---

## Run Resolution Logic

The run resolution algorithm (implemented in `run-loader.ts`):

1. If `--run <id>` is given: load `runs/<id>/summary.json` directly. Error if not found.
2. If `--last-run` is given:
   a. Determine the suite filter: `args.suite` if provided, else `coverageConfig.defaultSuite` if configured, else `undefined`.
   b. If suite filter is `'any'`: load the truly latest run (current `loadLatestRun()` behavior).
   c. If suite filter is a suite name: scan `runs/` directories in reverse chronological order, load each `summary.json`, return the first one where `summary.suite === suiteFilter`.
   d. If no matching run is found: **print a clear error and exit non-zero**. Do NOT silently fall back to static-only.

**Error message format** (when no run found for suite):
```
Error: No run found for suite "tsap".
Run `shogun run --suite tsap --env local` first, or use --suite <name> to target a different suite.
Use --suite any to load the truly latest run regardless of suite.
```

---

## New Args in `CoverageArgs`

```typescript
export interface CoverageArgs {
  // ... existing fields ...
  lastRun?: boolean;    // --last-run
  runId?: string;       // --run <id>
}
```

---

## `run-loader.ts` Implementation

Replace the stub from Story 1 with:

```typescript
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary, ShogunConfig } from '../../types.js';
import type { TestEntry } from './types.js';

export function loadRunForCoverage(
  args: { lastRun?: boolean; runId?: string; suite?: string },
  coverageConfig: { defaultSuite?: string },
  config: ShogunConfig,
  cwd: string,
): RunSummary | null {
  if (!args.lastRun && !args.runId) return null;

  const runsBase = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsBase)) return null;

  if (args.runId) {
    return loadRunById(args.runId, runsBase);
  }

  // --last-run: determine suite filter
  const suiteFilter = args.suite === 'any'
    ? undefined
    : (args.suite ?? coverageConfig.defaultSuite);

  return loadLatestRunForSuite(runsBase, suiteFilter);
}

function loadRunById(runId: string, runsBase: string): RunSummary | null {
  const summaryPath = join(runsBase, runId, 'summary.json');
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf8')) as RunSummary;
  } catch {
    return null;
  }
}

function loadLatestRunForSuite(
  runsBase: string,
  suiteFilter: string | undefined,
): RunSummary | null {
  const runDirs = readdirSync(runsBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse(); // newest first

  for (const runId of runDirs) {
    const summary = loadRunById(runId, runsBase);
    if (!summary) continue;
    if (!suiteFilter || summary.suite === suiteFilter) return summary;
  }
  return null;
}

export function joinRunResultsToTests(
  testEntries: TestEntry[],
  runSummary: RunSummary,
): void {
  // Build lookup: "collection/test-name" → TestResult
  const resultMap = new Map<string, import('../../types.js').TestResult>();
  for (const result of runSummary.results) {
    // result.file is like "tests/collections/graph/get-graph-nodes.yaml"
    // Derive collection from path: segment after "collections/"
    const parts = result.file.replace(/\\/g, '/').split('/');
    const collIdx = parts.indexOf('collections');
    if (collIdx < 0) continue;
    const collection = parts[collIdx + 1] ?? '';
    const key = `${collection}/${result.name}`;
    resultMap.set(key, result);
  }

  // Join to test entries
  for (const test of testEntries) {
    const key = `${test.collection}/${test.name}`;
    const result = resultMap.get(key);
    if (!result) continue;
    test.runResult = {
      httpStatus: result.httpStatus ?? 0,
      durationMs: result.durationMs,
      status: result.status,
      assertionsPassed: result.status === 'passed',
    };
  }
}
```

---

## Acceptance Criteria

- [ ] `run-loader.ts` is implemented as specified (replacing the Story 1 stub).

- [ ] `CoverageArgs` gains `lastRun?: boolean` and `runId?: string`.

- [ ] [`src/index.ts`](../../../src/index.ts) coverage arg parsing recognizes `--last-run` (sets `lastRun: true`) and `--run <id>` (sets `runId: value`).

- [ ] `index.ts` calls `loadRunForCoverage()` after loading config. If `--last-run` or `--run` is given and no run is found for the resolved suite, print the error message and return exit code 1. **Do not silently fall back to static-only.**

- [ ] `joinRunResultsToTests()` is called after `loadRunForCoverage()` returns a non-null summary. It mutates `testEntries` in-place, setting `test.runResult` for matched tests.

- [ ] **Response code matrix update** (Story 4 extension): when run data is available, `computeResponseCodeCoverage()` is extended to:
  - Populate `testedByActual: true` for codes that appear in `test.runResult.httpStatus` across all tests for the endpoint.
  - Add entries for actual codes not in spec or declared codes (status `'undocumented'`).
  - Detect mismatches: if `test.expectedStatus !== undefined` and `test.runResult.httpStatus !== test.expectedStatus`, add a `mismatch` entry with `mismatchDetail: "test expects ${expected}, API returned ${actual}"`.
  - Set `hasDrift: true` on the endpoint when any undocumented or mismatch entry exists.

- [ ] **Pretty reporter** — when run data is present, the summary gains:
  ```
  Last run:          2026-07-03T14-22-00  (suite: tsap)  409 tests  387 passed  22 failed
  ```

- [ ] **Pretty reporter** — `--detail` view shows run outcomes per endpoint:
  ```
  POST   /api/apikeys                        2 tests   apikeys
    Response codes: 201 ✓  400 ✗  403 ✗
    Run results:    2 passed  0 failed  avg 142ms
    Drift:          500 returned but not in spec ⚠️
  ```

- [ ] **Pretty reporter** — test-vs-reality mismatches are shown inline in the response code matrix:
  ```
  POST   /api/users
    Response codes: 201 ✓  400 ↔  403 ✗
    Mismatch:       test expects 400, API returned 200
  ```

- [ ] **JSON reporter** — each test entry in `endpoint.tests[]` gains a `runResult` field when available:
  ```json
  {
    "name": "Create API Key",
    "runResult": {
      "httpStatus": 201,
      "durationMs": 142,
      "status": "passed",
      "assertionsPassed": true
    }
  }
  ```

- [ ] When `--last-run` is NOT given, all `test.runResult` fields are `undefined` and no run-data sections appear in output. Static-only behavior is fully preserved.

---

## `defaultSuite` Config Behavior

| Scenario | Behavior |
|----------|----------|
| `--last-run`, no `--suite`, `defaultSuite: tsap` configured | Load latest run where `suite === "tsap"` |
| `--last-run --suite smoke` | Load latest run where `suite === "smoke"` (overrides config) |
| `--last-run --suite any` | Load truly latest run regardless of suite |
| `--last-run`, no `--suite`, no `defaultSuite` configured | Load truly latest run (current behavior) |
| `--last-run`, suite filter set, no matching run found | Print error, exit 1 |

---

## Notes for Implementer

- The run-result join is by `collection/test-name`. If a test was renamed between the run and the coverage scan, it won't match — `test.runResult` stays `undefined`. This is acceptable; do not implement fuzzy matching.
- `result.httpStatus` may be `undefined` in the `TestResult` type (it is optional). Guard with `?? 0` when assigning to `runResult.httpStatus`.
- The `loadLatestRun` and `loadRunById` functions in [`src/logger.ts`](../../../src/logger.ts) are private (not exported). Do NOT import from `logger.ts` — implement the equivalent logic directly in `run-loader.ts` as shown above.
- The `--run <id>` flag is a convenience for targeting a specific historical run. The run ID format is the timestamp directory name (e.g., `2026-07-03T14-22-00`).
