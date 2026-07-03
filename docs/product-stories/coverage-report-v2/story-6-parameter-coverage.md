# Story 6 — Parameter Coverage

**Wave:** 2  
**Status:** Ready for implementation  
**Depends on:** Story 2 (enhanced test collection), Story 3 (enhanced spec extraction)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

The spec declares query and path parameters for many endpoints. Tests may exercise some parameters but not others. Currently there is no way to see which parameters have never been passed in any test — a common source of untested validation logic (e.g., a `?filter=` query param that triggers different server behavior).

---

## Goal

For each endpoint with spec-declared parameters, show which parameters are exercised by at least one test. Surface untested parameters as gaps. This is a static analysis — no HTTP calls.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
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
```

---

## Analyzer: `computeParameterCoverage()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeParameterCoverage(
  specEndpoints: SpecEndpoint[],
): EndpointParameterCoverage[] {
  return specEndpoints
    .filter(ep => ep.parameters.length > 0)
    .map(ep => {
      // Collect all param names exercised by tests (from YAML request.params + query string)
      const testedParams = new Set<string>();
      for (const test of ep.tests) {
        for (const p of test.requestParams) {
          testedParams.add(p.toLowerCase());
        }
      }

      const parameters: ParameterCoverageEntry[] = ep.parameters.map(specParam => ({
        name: specParam.name,
        in: specParam.in as 'path' | 'query',
        required: specParam.required,
        tested: testedParams.has(specParam.name.toLowerCase()),
        inferredOnly: false, // pre-script heuristic wired in Story 10 extension
      }));

      const testedCount = parameters.filter(p => p.tested).length;
      const totalCount = parameters.length;
      return {
        specKey: `${ep.method} ${ep.path}`,
        parameters,
        testedCount,
        totalCount,
        coveragePct: totalCount > 0
          ? Math.round((testedCount / totalCount) * 1000) / 10
          : 100,
        hasUntested: parameters.some(p => !p.tested),
      };
    });
}
```

---

## Acceptance Criteria

- [ ] `computeParameterCoverage()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] `EndpointParameterCoverage[]` is computed in `index.ts` and passed to reporters.

- [ ] **Pretty reporter** — base report gains a new summary line:

  ```
  Parameters:        22 / 31 spec params tested  (71.0%)
  ```

- [ ] **Pretty reporter** — `--detail` view shows parameter coverage per endpoint (only for endpoints that have spec-declared parameters):

  ```
  GET    /api/graph/nodes                    2 tests   graph
    Response codes: 200 ✓
    Parameters:     limit ✓  offset ✓  filter ✗  sort ✗
  ```

  Legend:
  - `✓` = tested
  - `✗` = untested
  - `~` = inferred from pre-script (Story 10 extension)

- [ ] **JSON reporter** — each endpoint object gains a `parameterCoverage` field:

  ```json
  {
    "parameterCoverage": {
      "testedCount": 2,
      "totalCount": 4,
      "coveragePct": 50.0,
      "hasUntested": true,
      "parameters": [
        { "name": "limit",  "in": "query", "required": false, "tested": true,  "inferredOnly": false },
        { "name": "offset", "in": "query", "required": false, "tested": true,  "inferredOnly": false },
        { "name": "filter", "in": "query", "required": false, "tested": false, "inferredOnly": false },
        { "name": "sort",   "in": "query", "required": false, "tested": false, "inferredOnly": false }
      ]
    }
  }
  ```

- [ ] Endpoints with zero spec-declared parameters are excluded from the parameter summary stats and have no `parameterCoverage` block in JSON output (or `null`).

- [ ] Path parameters (e.g., `{id}` in `/api/users/{id}`) are included. They are almost always "tested" because any test that hits the endpoint must supply the path segment — but they should still appear in the matrix for completeness.

- [ ] The `CoverageSummary` gains two new fields:
  ```typescript
  totalSpecParams: number;
  testedParams: number;
  paramCoveragePct: number;
  ```

---

## Notes for Implementer

- Parameter name matching is case-insensitive (normalize both sides to lowercase before comparing).
- Path parameters in the test's `staticPath` are always "tested" if the test matched the endpoint — the path segment is present by definition. However, the `requestParams` array from Story 2 only captures `request.params` (query params) and query string params. Path params from the URL template are NOT in `requestParams`. To handle this: for path parameters (`in: 'path'`), mark `tested: true` if the test matched this endpoint (i.e., `ep.tests.length > 0` and the test is in `ep.tests`). The path param was exercised by the mere fact of the test hitting the endpoint.
- The `inferredOnly` flag is reserved for Story 10's pre-script heuristic extension. In this story, always set it to `false`.
- Parameter coverage is only shown in `--detail` mode in the pretty reporter. The summary line is always shown.
