# Story 5 — Grouped Output by Spec Tag

**Wave:** 1 (Readability — high impact, low effort)  
**Status:** Ready for implementation  
**Depends on:** Story 1 (module restructure)  
**Files touched:** `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/markdown.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

The current pretty reporter renders a flat list of all endpoints. With 65+ endpoints, this is unreadable — a reviewer must scan the entire list to find gaps in a specific domain. The OpenAPI spec already groups endpoints by tag (e.g., `Graph`, `Code`, `Agents`, `ApiKeys`). The coverage report should mirror that grouping.

---

## Goal

Group all endpoint output by OpenAPI spec tag with per-group subtotals. Endpoints with no tag go into an `(untagged)` group at the end. This is a pure presentation change — no new data is computed.

---

## Acceptance Criteria

### Pretty Reporter

- [ ] Endpoints are grouped by `ep.tag` (the first tag from the spec operation's `tags[]` array, already stored on `SpecEndpoint`).

- [ ] Each group renders with a header line and subtotal:

  ```
  ── Graph (12 endpoints, 10 covered, 83.3%) ──────────────────────────────────
    GET    /api/graph/nodes                    2 tests   graph
    POST   /api/graph/nodes                    1 test    graph
    GET    /api/graph/nodes/{path}             1 test    graph
    PATCH  /api/graph/nodes/{path}             1 test    graph
    DELETE /api/graph/nodes/{path}             2 tests   graph
    GET    /api/graph/links                    1 test    graph
    ...
    GET    /api/graph/search                   0 tests   ← uncovered, shown in group
    DELETE /api/graph/links/{id}               0 tests

  ── Code (18 endpoints, 9 covered, 50.0%) ────────────────────────────────────
    GET    /api/code/checkpoints               1 test    code
    ...
  ```

- [ ] Within each group, covered endpoints are listed first (sorted by method then path), then uncovered endpoints. This matches the current covered/uncovered split but scoped per group.

- [ ] The overall summary header (endpoint counts, coverage %) is still shown at the top before the groups.

- [ ] Endpoints with `ep.tag === undefined` are collected into a group named `(untagged)` rendered last.

- [ ] The `--uncovered` flag (current behavior) still works: when set, only uncovered endpoints are shown within each group. Groups where all endpoints are covered are omitted entirely.

- [ ] The `COVERED (N)` / `UNCOVERED (N)` section headers from the current flat renderer are removed — the group headers replace them.

### Markdown Reporter

- [ ] The markdown table gains a `Tag` column:

  ```markdown
  | Status | Method | Endpoint | Tests | Response Codes | Tag | Collections |
  |--------|--------|----------|-------|----------------|-----|-------------|
  | ✅ | GET | `/api/graph/nodes` | 2 | 2/3 | Graph | graph |
  | ❌ | GET | `/api/code/search` | 0 | 0/2 | Code | — |
  ```

- [ ] Rows are sorted by tag then method then path.

### JSON Reporter

- [ ] The JSON output gains a top-level `byTag` object alongside `endpoints`:

  ```json
  {
    "summary": { ... },
    "byTag": {
      "Graph": {
        "totalEndpoints": 12,
        "coveredEndpoints": 10,
        "coveragePct": 83.3
      },
      "Code": {
        "totalEndpoints": 18,
        "coveredEndpoints": 9,
        "coveragePct": 50.0
      }
    },
    "endpoints": [ ... ]
  }
  ```

- [ ] The `endpoints` array is sorted by tag then method then path.

---

## Helper: `groupEndpointsByTag()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function groupEndpointsByTag(
  specEndpoints: SpecEndpoint[],
): Map<string, SpecEndpoint[]> {
  const groups = new Map<string, SpecEndpoint[]>();
  for (const ep of specEndpoints) {
    const tag = ep.tag ?? '(untagged)';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(ep);
  }
  // Sort endpoints within each group: covered first, then by method+path
  for (const [, eps] of groups) {
    eps.sort((a, b) => {
      const aCovered = a.tests.length > 0 ? 0 : 1;
      const bCovered = b.tests.length > 0 ? 0 : 1;
      if (aCovered !== bCovered) return aCovered - bCovered;
      if (a.method !== b.method) return a.method.localeCompare(b.method);
      return a.path.localeCompare(b.path);
    });
  }
  return groups;
}
```

---

## Notes for Implementer

- The `(untagged)` group should always be last, regardless of alphabetical order. All other groups are sorted alphabetically by tag name.
- The group header separator line (`──`) should be 80 characters wide total (pad with `─` to fill).
- The per-group subtotal line format: `── {Tag} ({total} endpoints, {covered} covered, {pct}%) ──...`
- The `--tag` filter (spec-side filter, already implemented) scopes which endpoints appear — grouping still applies within the filtered set.
- This story does not change `CoverageArgs` — no new CLI flags.
