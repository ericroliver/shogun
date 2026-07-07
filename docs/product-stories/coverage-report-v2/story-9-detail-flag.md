# Story 9 — `--detail` Flag (Progressive Disclosure)

**Wave:** 2  
**Status:** Ready for implementation  
**Depends on:** Stories 4, 6, 7, 8 (all depth dimensions must exist before this flag is wired)  
**Files touched:** [`src/index.ts`](../../../src/index.ts), `src/commands/coverage/index.ts`, `src/commands/coverage/types.ts`

---

## Problem

The depth dimensions added in Stories 4–8 (response code matrix, parameter coverage, body field coverage, assertion quality) are valuable but verbose. Showing all of them by default would make the base coverage report unreadable for large suites. Teams running coverage in CI need a compact summary; teams doing gap analysis need the full depth. Both needs must be served without separate commands.

---

## Goal

Add a `--detail` flag to `shogun coverage`. When absent, the report shows the compact summary (endpoint coverage, response code summary line, parameter summary line, body field summary line, quality summary line, thin test count). When present, the report adds the per-endpoint depth matrix inline under each endpoint.

---

## CLI Interface

```bash
# Compact summary (default — CI-friendly)
shogun coverage --env local

# Full depth matrix per endpoint
shogun coverage --env local --detail

# Detail + gaps only (most useful for gap analysis)
shogun coverage --env local --detail --gaps
```

---

## Acceptance Criteria

- [ ] `CoverageArgs` in `src/commands/coverage/types.ts` already has `detail?: boolean` (added in Story 4). This story wires it to the CLI.

- [ ] [`src/index.ts`](../../../src/index.ts) coverage arg parsing is updated to recognize `--detail` and set `args.detail = true`. No other changes to `src/index.ts`.

- [ ] `src/commands/coverage/index.ts` passes `detail: args.detail ?? false` through to all reporters.

- [ ] **Pretty reporter** — when `detail === false` (default):
  - Show the summary header (endpoint counts, coverage %, response code summary, parameter summary, body field summary, quality summary, thin test count).
  - Show the grouped endpoint list (Story 5) with one line per endpoint: method, path, test count, collections.
  - Do NOT show per-endpoint response code matrix, parameter coverage, body field coverage, or quality score breakdown.

- [ ] **Pretty reporter** — when `detail === true`:
  - Show everything from the compact view.
  - Under each covered endpoint, show the depth matrix:
    ```
    POST   /api/apikeys                        2 tests   apikeys
      Response codes: 201 ✓  400 ✗  403 ✗
      Parameters:     workspaceId ✓
      Body fields:    name ✓  scopes ✓  expiresAt ✗  description ✗
      Quality score:  72 / 100  (2 tests: scores 8, 4)
    ```
  - Uncovered endpoints do NOT get a depth matrix (there are no tests to analyze).

- [ ] **Markdown reporter** — `--detail` adds a second table below the summary table showing the per-endpoint depth matrix as additional columns or a separate section. Exact format is at implementer's discretion — keep it readable.

- [ ] **JSON reporter** — `--detail` has no effect on JSON output. JSON always includes all fields (the consumer decides what to use). This is already the case — document it in a comment in `reporter/json.ts`.

- [ ] The `--detail` flag is compatible with all other flags: `--suite`, `--collection`, `--tag`, `--gaps`, `--last-run`, `--format`.

- [ ] The existing `--uncovered` flag (now superseded by `--gaps` in Story 11) continues to work. It is not removed in this story.

---

## Compact vs. Detail Output Comparison

**Compact (default):**
```
Coverage Report — enigma API v1.2.3
  Spec endpoints:    87
  Tests scanned:     72  (8 collections)
  Covered:           45  (51.7%)
  Uncovered:         42
  Response codes:    38 / 61 spec codes tested  (62.3%)
  Parameters:        22 / 31 spec params tested  (71.0%)
  Body fields:       18 / 27 spec body fields tested  (66.7%)
  Assertion quality: avg score 47 / 100
  Thin tests:        12 tests score ≤ 1

── Graph (12 endpoints, 10 covered, 83.3%) ──────────────────────────────────
  GET    /api/graph/nodes                    2 tests   graph
  POST   /api/graph/nodes                    1 test    graph
  ...
```

**Detail (`--detail`):**
```
Coverage Report — enigma API v1.2.3
  [same summary header]

── Graph (12 endpoints, 10 covered, 83.3%) ──────────────────────────────────
  GET    /api/graph/nodes                    2 tests   graph
    Response codes: 200 ✓
    Parameters:     limit ✓  offset ✓  filter ✗
    Quality score:  45 / 100  (2 tests: scores 4, 5)

  POST   /api/graph/nodes                    1 test    graph
    Response codes: 200 ✓  400 ✗  403 ✗
    Body fields:    path ✓  title ✓  content ✗
    Quality score:  60 / 100  (1 test: score 6)
  ...
```

---

## Notes for Implementer

- The `--detail` flag is a display toggle only — it does not change what data is computed. All depth dimensions are always computed; `--detail` controls whether they are rendered.
- This keeps the implementation simple: compute everything, render selectively.
- The `--detail` flag in `src/index.ts` is a boolean flag (no value). Parse it as: `detail: argv.includes('--detail')`.
