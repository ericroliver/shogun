# Story 1 — Module Restructure: `coverage.ts` → `src/commands/coverage/`

**Wave:** 1 (Foundation — do this before adding any new coverage logic)  
**Status:** Ready for implementation  
**Files touched:** [`src/commands/coverage.ts`](../../../src/commands/coverage.ts) (deleted), new directory `src/commands/coverage/`

---

## Problem

[`src/commands/coverage.ts`](../../../src/commands/coverage.ts) is currently a single 522-line file. The v2 scope adds spec extraction, test metadata collection, run result joining, multi-dimensional analysis, a risk scorer, a dependency graph builder, and four output formats. Putting all of that in one file produces an unmaintainable 2000+ line monolith. The v2 work must be done in a modular structure from the start.

---

## Goal

Split [`src/commands/coverage.ts`](../../../src/commands/coverage.ts) into a directory of focused modules with clear responsibilities. The public interface (`coverage(args)` entry point) stays identical — no behavior change, no new features in this story.

---

## Target Directory Structure

```
src/commands/coverage/
  index.ts            — entry point: arg parsing, orchestration, calls other modules
  types.ts            — all internal coverage types (TestEntry, SpecEndpoint, CoverageReport, etc.)
  spec-extractor.ts   — extract endpoints from OpenAPI spec (currently in coverage.ts)
  test-collector.ts   — collect test entries from YAML files (currently in coverage.ts)
  matcher.ts          — three-tier path matching algorithm (currently in coverage.ts)
  analyzer.ts         — compute coverage dimensions, gaps, scores (stub for now)
  run-loader.ts       — load and join run.json results (stub for now)
  reporter/
    pretty.ts         — terminal pretty output
    json.ts           — JSON output
    markdown.ts       — markdown table output
```

---

## Acceptance Criteria

- [ ] `src/commands/coverage.ts` is deleted.
- [ ] `src/commands/coverage/index.ts` exports `coverage(args: CoverageArgs): Promise<number>` — the same signature as the current file's export.
- [ ] [`src/index.ts`](../../../src/index.ts) import of `coverage` is updated from `'./commands/coverage.js'` to `'./commands/coverage/index.js'`. No other changes to `src/index.ts`.
- [ ] All existing behavior is preserved exactly — same output, same exit codes, same flag handling. This is a pure refactor.
- [ ] `src/commands/coverage/types.ts` contains the internal interfaces currently defined in `coverage.ts`:
  - `CoverageArgs` (public, re-exported from `index.ts`)
  - `TestEntry`
  - `SpecEndpoint`
  - `CoverageSummary`
  - The minimal OpenAPI 3 types (`OpenApiSpec`, `PathItem`, `OperationObject`)
- [ ] `src/commands/coverage/spec-extractor.ts` contains `extractSpecEndpoints()` — extracted verbatim from current `coverage.ts`.
- [ ] `src/commands/coverage/test-collector.ts` contains `collectTestEntries()` — extracted verbatim from current `coverage.ts`.
- [ ] `src/commands/coverage/matcher.ts` contains `matchTests()` and `matchTestToSpecEndpoint()` and `isDynamic()` — extracted verbatim from current `coverage.ts`.
- [ ] `src/commands/coverage/reporter/pretty.ts` contains `renderPretty()` — extracted verbatim.
- [ ] `src/commands/coverage/reporter/json.ts` contains `renderJson()` — extracted verbatim.
- [ ] `src/commands/coverage/reporter/markdown.ts` contains `renderMarkdown()` — extracted verbatim.
- [ ] `src/commands/coverage/analyzer.ts` is a stub file with a comment: `// Coverage analysis — populated in Story 8 (Assertion Quality) and Story 12 (Risk Score)`.
- [ ] `src/commands/coverage/run-loader.ts` is a stub file with a comment: `// Run result loading — populated in Story 10 (--last-run bridge)`.
- [ ] `npm run build` passes with no TypeScript errors after the restructure.

---

## Module Dependency Map

```
index.ts
  ├── types.ts          (internal types)
  ├── spec-extractor.ts (uses types.ts)
  ├── test-collector.ts (uses types.ts, loader.ts)
  ├── matcher.ts        (uses types.ts)
  ├── analyzer.ts       (stub)
  ├── run-loader.ts     (stub)
  └── reporter/
        ├── pretty.ts   (uses types.ts)
        ├── json.ts     (uses types.ts)
        └── markdown.ts (uses types.ts)
```

---

## Notes for Implementer

- This is a mechanical extraction — copy functions verbatim, adjust imports, delete the original file. Do not change any logic.
- All imports between the new modules use relative paths with `.js` extensions (ESM convention already used throughout the codebase).
- The `buildSummary()` helper currently in `coverage.ts` belongs in `index.ts` for now (it's called only from `renderCoverage()` which is also in `index.ts`). Move it to `analyzer.ts` in a later story when the analyzer grows.
- `renderCoverage()` (the dispatch function) stays in `index.ts` — it's the glue between analysis and rendering.
- The stub files (`analyzer.ts`, `run-loader.ts`) must be valid TypeScript — empty exports are fine: `export {};`
