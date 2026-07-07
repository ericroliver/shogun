# Story 14 — Test Dependency Graph

**Wave:** 4  
**Status:** Ready for implementation  
**Depends on:** Story 2 (enhanced test collection — pre/post script presence)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`, [`src/index.ts`](../../../src/index.ts)

---

## Problem

Many tests depend on other tests' output via `ctx.vars`. A test that creates a resource stashes its ID in `ctx.vars.createdId`; downstream tests read it. If the create test fails, all downstream tests fail too — a cascade. Currently there is no way to see this coupling. A reviewer looking at 22 failing tests cannot tell if they are 22 independent failures or 1 root failure cascading through 21 dependents.

---

## Goal

Scan `pre` and `post` scripts for `ctx.vars` reads and writes. Build a dependency graph showing which tests produce which vars and which tests consume them. Flag cascade risks (many tests depending on one feeder), orphaned vars (written but never read), and cross-collection dependencies.

---

## Heuristic Scanning Rules

The scanner uses regex with syntax context to reduce false positives. The rules (from the revised plan):

**Write detection** — `ctx.vars.X = ...` (assignment):
```
/ctx\.vars\.(\w+)\s*=/g
```
Captures the var name from an assignment expression. Excludes reads.

**Read detection** — `ctx.vars.X` NOT preceded by `=`:
```
/(?<!=\s*)ctx\.vars\.(\w+)/g
```
This is a heuristic — it will miss reads inside complex expressions and may catch some false positives in comments. That is acceptable. Over-reporting reads is better than under-reporting.

**What is NOT scanned**: collection setup/teardown scripts. Only per-test `pre` and `post` scripts are scanned. Setup scripts are infrastructure, not test logic.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
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
```

---

## Analyzer: `buildDependencyGraph()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function buildDependencyGraph(testEntries: TestEntry[]): DependencyGraph {
  const writes: VarWrite[] = [];
  const reads: VarRead[] = [];

  const writeRegex = /ctx\.vars\.(\w+)\s*=/g;
  // Read: ctx.vars.X not preceded by = (with optional whitespace)
  const readRegex = /(?<![=\s])ctx\.vars\.(\w+)(?!\s*=)/g;

  for (const test of testEntries) {
    // Scan pre script
    if (test.hasPreScript) {
      // Note: TestEntry only stores hasPreScript (boolean), not the script body.
      // To scan scripts, the test-collector must be extended to store script bodies.
      // See "Notes for Implementer" below.
    }
    // Scan post script (same pattern)
  }

  // Build var → writers map
  const writersByVar = new Map<string, VarWrite[]>();
  for (const w of writes) {
    if (!writersByVar.has(w.varName)) writersByVar.set(w.varName, []);
    writersByVar.get(w.varName)!.push(w);
  }

  // Build edges: for each read, find the writer(s) of that var
  const edges: DependencyEdge[] = [];
  for (const read of reads) {
    const writers = writersByVar.get(read.varName) ?? [];
    for (const writer of writers) {
      edges.push({
        varName: read.varName,
        producer: { testName: writer.testName, collection: writer.collection, file: writer.file },
        consumer: { testName: read.testName, collection: read.collection, file: read.file },
        crossCollection: writer.collection !== read.collection,
      });
    }
  }

  // Orphaned vars: written but never read
  const readVarNames = new Set(reads.map(r => r.varName));
  const orphanedVars: OrphanedVar[] = [];
  for (const [varName, writers] of writersByVar) {
    if (!readVarNames.has(varName)) {
      for (const w of writers) {
        orphanedVars.push({ varName, writtenBy: { testName: w.testName, collection: w.collection, file: w.file } });
      }
    }
  }

  // Cascade risks: vars with 3+ consumers from a single producer
  const cascadeRisks: CascadeRisk[] = [];
  const edgesByProducerVar = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const key = `${edge.varName}::${edge.producer.testName}::${edge.producer.collection}`;
    if (!edgesByProducerVar.has(key)) edgesByProducerVar.set(key, []);
    edgesByProducerVar.get(key)!.push(edge);
  }
  for (const [, edgeGroup] of edgesByProducerVar) {
    if (edgeGroup.length >= 3) {
      const first = edgeGroup[0]!;
      cascadeRisks.push({
        varName: first.varName,
        producer: first.producer,
        consumerCount: edgeGroup.length,
        consumers: edgeGroup.map(e => e.consumer),
      });
    }
  }

  const crossCollectionDeps = edges.filter(e => e.crossCollection);

  return { edges, orphanedVars, cascadeRisks, crossCollectionDeps };
}
```

---

## Required Extension to `TestEntry` (Story 2 amendment)

The dependency graph scanner needs the raw script bodies, not just `hasPreScript`/`hasPostScript` booleans. Extend `TestEntry` in `src/commands/coverage/types.ts`:

```typescript
// Add to TestEntry:
preScriptBody?: string;   // raw pre script source (only stored if hasPreScript === true)
postScriptBody?: string;  // raw post script source (only stored if hasPostScript === true)
```

Update `test-collector.ts` to store `parsed.pre` as `preScriptBody` and `parsed.post` as `postScriptBody` when present.

**Note:** This is a small amendment to Story 2. If Story 2 has already been implemented, add these two fields in this story.

---

## CLI Interface

```bash
# Show dependency graph in detail view
shogun coverage --env local --detail --deps

# Show only dependency graph (no endpoint list)
shogun coverage --env local --deps
```

`--deps` is a new flag that enables dependency graph output.

---

## Acceptance Criteria

- [ ] `TestEntry` gains `preScriptBody?: string` and `postScriptBody?: string`. `test-collector.ts` stores the raw script bodies.

- [ ] `buildDependencyGraph()` is implemented in `src/commands/coverage/analyzer.ts` using the write/read regex patterns specified above.

- [ ] `CoverageArgs` gains `deps?: boolean`.

- [ ] [`src/index.ts`](../../../src/index.ts) recognizes `--deps` (sets `deps: true`).

- [ ] **Pretty reporter** — when `--deps` is set, a dependency graph section is appended after the endpoint list:

  ```
  ── Dependency Graph ─────────────────────────────────────────────────────────
  
  Cascade Risks (vars with 3+ consumers):
    ctx.vars.createdNodePath  written by: graph/create-graph-node-a
      consumed by: graph/get-graph-node (3 tests), graph/patch-graph-node, graph/delete-graph-node
      ⚠️ If create-graph-node-a fails, 5 downstream tests will fail
  
  Cross-Collection Dependencies (2):
    ctx.vars.workspaceLoaded  written by: workspace/load-workspace
      consumed by: graph/get-graph-nodes  ← cross-collection
  
  Orphaned Vars (written but never read):
    ctx.vars.tempDebugId  written by: apikeys/create-api-key
  ```

- [ ] When `--deps` is set but no scripts are found (no pre/post scripts in any test), print:
  ```
  No ctx.vars dependencies found in test scripts.
  ```

- [ ] **JSON reporter** — when `--deps` is set, the JSON output gains a top-level `dependencyGraph` object.

- [ ] When `--deps` is NOT set, the dependency graph is NOT computed (skip `buildDependencyGraph()` entirely — it is expensive for large suites).

---

## Notes for Implementer

- The write regex `ctx\.vars\.(\w+)\s*=` will match `ctx.vars.foo = ...` but also `ctx.vars.foo === ...` (equality check). Add a negative lookahead to exclude `===` and `==`: `/ctx\.vars\.(\w+)\s*(?!=)/g` — match `=` not followed by another `=`.
- The read regex is intentionally permissive. A string like `ctx.log("ctx.vars.foo is set")` will be picked up as a read. This is acceptable — over-reporting reads is better than missing real dependencies.
- Cascade risk threshold is 3 consumers. This is a heuristic — adjust if it produces too much noise.
- The dependency graph is only computed when `--deps` is set. Do not compute it in the default run path.
