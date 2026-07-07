# Story 8b — Thin Test Flag

**Wave:** 2  
**Status:** Ready for implementation  
**Depends on:** Story 8 (assertion quality metrics)  
**Files touched:** `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`, `src/commands/coverage/reporter/gaps.ts` (new file, stub used by Story 11)

---

## Problem

A raw quality score number (e.g., "score: 1") is not immediately actionable. A reviewer must mentally compare it against a threshold to decide whether to act. The "thin test" concept — a test that only checks the status code and nothing else — is a concrete, named problem that deserves a named flag.

---

## Goal

Any test with a raw quality score ≤ 1 (status-only, no shape assertions, no snapshot, no post-script asserts) is flagged as `⚠️ thin`. This flag appears in `--detail` output and in `--gaps` output (Story 11). It is more actionable than a raw number — a reviewer can immediately filter to thin tests and prioritize adding assertions.

---

## Definition

A test is **thin** if its `rawScore <= 1`. This means:
- Score 0: no status assertion, no shape, no snapshot, no post-script asserts (completely empty assertions)
- Score 1: only a status assertion (`response.status: 200`) — proves the endpoint didn't crash, nothing more

A test with any shape assertion (score ≥ 3), any snapshot (score ≥ 3), or any post-script assert (score ≥ 2) is NOT thin.

---

## Acceptance Criteria

- [ ] `isThin` is already computed in Story 8's `computeAssertionQuality()` as `rawScore <= 1`. This story adds the **surfacing** of that flag in output.

- [ ] **Pretty reporter** — `--detail` view marks thin tests inline:

  ```
  GET    /api/graph/nodes                    3 tests   graph
    Quality score:  35 / 100  (3 tests: scores 1 ⚠️thin, 4, 2)
  ```

  When ALL tests for an endpoint are thin, the endpoint line itself gets a marker:

  ```
  GET    /api/graph/nodes                    3 tests   graph  ⚠️ all tests thin
  ```

- [ ] **Pretty reporter** — base report (no `--detail`) gains a thin-test count in the summary:

  ```
  Thin tests:        12 tests score ≤ 1 (status-only, no assertions)
  ```

  If zero thin tests: this line is omitted.

- [ ] **JSON reporter** — the top-level `summary` object gains:
  ```json
  {
    "thinTestCount": 12,
    "thinTestFiles": [
      "tests/collections/graph/get-graph-nodes.yaml",
      "tests/collections/code/get-checkpoints.yaml"
    ]
  }
  ```

- [ ] **`reporter/gaps.ts`** (new file): create a stub that exports `renderGaps()` — this function is fully implemented in Story 11. For now, the stub just throws `new Error('Not implemented — see Story 11')`. The file must exist and compile cleanly so Story 11 can fill it in.

- [ ] The `CoverageSummary` gains:
  ```typescript
  thinTestCount: number;
  ```

- [ ] A thin test is flagged regardless of whether the endpoint is otherwise well-covered. A test with 6 shape assertions on the same endpoint does not "cancel out" a thin test — both are reported.

---

## Notes for Implementer

- The thin-test summary line in the base report is only shown when `thinTestCount > 0`. Do not show a "0 thin tests" line — it adds noise.
- `thinTestFiles` in the JSON output is the list of `test.file` values for all thin tests, deduplicated and sorted. This gives a CI system a direct list of files to act on.
- The `reporter/gaps.ts` stub is needed now because Story 11 (`--gaps` flag) imports from it. Creating the stub here prevents Story 11 from needing to create a new file — it just fills in the implementation.
