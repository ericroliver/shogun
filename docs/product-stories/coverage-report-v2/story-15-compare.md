# Story 15 — `--compare` Flag (Two-Run Coverage Delta)

**Wave:** 4  
**Status:** Ready for implementation  
**Depends on:** Story 0 (config layer — defaultSuite), Story 10 (run loader)  
**Files touched:** `src/commands/coverage/run-loader.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`, [`src/index.ts`](../../../src/index.ts)

---

## Problem

Coverage is not a static snapshot — it changes as tests are added, removed, or modified. A team that ships a new feature wants to know: "Did we add coverage for the new endpoints? Did we accidentally lose coverage anywhere?" Currently there is no way to compare two runs and see the delta.

---

## Goal

Add `--compare` to load two run summaries and show the coverage delta: new tests added, tests removed, endpoints newly covered, endpoints that lost coverage, pass/fail status changes. When explicit run IDs are not given, default to the last two runs of `defaultSuite` (Story 0 config).

---

## CLI Interface

```bash
# Compare last two runs of defaultSuite (or truly latest two if no defaultSuite)
shogun coverage --env local --compare

# Compare last two runs of a specific suite
shogun coverage --env local --compare --suite tsap

# Compare specific run IDs
shogun coverage --env local --compare 2026-07-03T14-22-00 2026-07-02T09-15-00

# Compare with full detail
shogun coverage --env local --compare --detail
```

---

## New Args in `CoverageArgs`

```typescript
export interface CoverageArgs {
  // ... existing fields ...
  compare?: boolean;       // --compare (no explicit IDs — use defaultSuite resolution)
  compareRunIds?: [string, string];  // --compare <id1> <id2> (explicit IDs)
}
```

---

## Run Resolution for `--compare`

When `--compare` is given without explicit run IDs:
1. Determine suite filter: `args.suite` if provided, else `coverageConfig.defaultSuite`, else `undefined`.
2. Scan `runs/` in reverse chronological order, collect the first two runs matching the suite filter.
3. If fewer than two matching runs exist, print an error and exit 1:
   ```
   Error: Need at least 2 runs to compare. Only 1 run found for suite "tsap".
   Run `shogun run --suite tsap --env local` again to generate a second run.
   ```

Add to `run-loader.ts`:

```typescript
export function loadTwoRunsForCompare(
  args: { compare?: boolean; compareRunIds?: [string, string]; suite?: string },
  coverageConfig: { defaultSuite?: string },
  config: ShogunConfig,
  cwd: string,
): [RunSummary, RunSummary] | null {
  const runsBase = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsBase)) return null;

  if (args.compareRunIds) {
    const [id1, id2] = args.compareRunIds;
    const r1 = loadRunById(id1, runsBase);
    const r2 = loadRunById(id2, runsBase);
    if (!r1 || !r2) return null;
    return [r1, r2]; // r1 is newer, r2 is older
  }

  const suiteFilter = args.suite === 'any'
    ? undefined
    : (args.suite ?? coverageConfig.defaultSuite);

  const runDirs = readdirSync(runsBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();

  const matched: RunSummary[] = [];
  for (const runId of runDirs) {
    if (matched.length >= 2) break;
    const summary = loadRunById(runId, runsBase);
    if (!summary) continue;
    if (!suiteFilter || summary.suite === suiteFilter) matched.push(summary);
  }

  if (matched.length < 2) return null;
  return [matched[0]!, matched[1]!]; // [newer, older]
}
```

---

## New Types in `src/commands/coverage/types.ts`

```typescript
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
```

---

## Acceptance Criteria

- [ ] `loadTwoRunsForCompare()` is implemented in `run-loader.ts` as specified.

- [ ] `CoverageArgs` gains `compare?: boolean` and `compareRunIds?: [string, string]`.

- [ ] [`src/index.ts`](../../../src/index.ts) recognizes `--compare` with optional positional run IDs:
  - `--compare` alone → `compare: true`
  - `--compare <id1> <id2>` → `compareRunIds: [id1, id2]`

- [ ] When `--compare` is set, the coverage command loads two run summaries, joins both to test entries, computes `RunDelta`, and renders the compare report.

- [ ] **Pretty reporter** — compare mode shows a delta report:

  ```
  Coverage Delta — enigma API v1.2.3
  Comparing: 2026-07-03T14-22-00 (newer) vs 2026-07-02T09-15-00 (older)
  Suite: tsap
  
  Endpoint Coverage:  45 → 47  (+2)
  Pass Rate:          94.6% → 96.1%  (+1.5pp)
  
  Newly Covered (2):
    ✅ POST   /api/workspaces
    ✅ DELETE /api/workspaces/{id}
  
  Lost Coverage (0):
    (none)
  
  Tests Now Failing (1):
    ✗ "Get Graph Node by Path"  graph/get-graph-node-by-path.yaml
  
  Tests Now Passing (3):
    ✓ "Create API Key"          apikeys/create-api-key.yaml
    ✓ "Delete API Key"          apikeys/delete-api-key.yaml
    ✓ "Get API Keys"            apikeys/get-api-keys.yaml
  
  Tests Added (4):
    + "Create Workspace"        workspace/create-workspace.yaml
    + "Delete Workspace"        workspace/delete-workspace.yaml
    ...
  ```

- [ ] **JSON reporter** — when `--compare` is set, the JSON output gains a top-level `delta` object of type `RunDelta`.

- [ ] When `--compare` is set but fewer than two matching runs exist, print the error message and exit 1.

- [ ] `defaultSuite` config applies to run resolution when explicit run IDs are not given (same logic as Story 10).

- [ ] `--compare` is compatible with `--tag` (scope to tag group), `--suite` (override suite filter), `--detail`.

---

## Notes for Implementer

- The compare report replaces the normal endpoint list — when `--compare` is set, show the delta report instead of the grouped endpoint matrix.
- Test identity for delta comparison: `"${collection}/${testName}"`. If a test is renamed, it appears as removed+added, not as a rename. This is acceptable.
- `endpointCoverageDelta` is the raw count difference, not a percentage. The percentage change is shown in the output but not stored in `RunDelta`.
- When `compareRunIds` is given, the first ID is treated as "newer" and the second as "older" regardless of their actual timestamps.
