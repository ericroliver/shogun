# Story 4 — Response Code Coverage Matrix

**Wave:** 1 (Highest-value visible output in Wave 1)  
**Status:** Ready for implementation  
**Depends on:** Story 1 (module restructure), Story 2 (enhanced test collection), Story 3 (enhanced spec extraction)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`, `src/commands/coverage/reporter/markdown.ts`, `src/commands/coverage/index.ts`

---

## Problem

The current coverage report answers only "did at least one test touch this endpoint?" A test suite can show 100% endpoint coverage while never testing a single error path. The most common real-world gap: POST endpoints with documented 400/403/404 responses that have zero tests exercising those codes. This is invisible in the current report.

---

## Goal

For each covered endpoint, show a matrix of documented response codes vs. codes declared by tests (expected status). When run data is available (Story 10), also show actual codes returned by the API. Surface undocumented actual codes inline with a `⚠️` marker. Detect test-vs-reality mismatches (test expects 400, API returned 200).

This story implements the static layer (spec vs. test-declared). The run-data layer is wired in Story 10 — the data structures are designed for it here.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
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
```

---

## Analyzer: `computeResponseCodeCoverage()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeResponseCodeCoverage(
  specEndpoints: SpecEndpoint[],
): EndpointResponseCodeCoverage[] {
  return specEndpoints.map(ep => {
    const specCodes = new Set(ep.documentedResponseCodes);
    const declaredCodes = new Set(
      ep.tests
        .filter(t => t.expectedStatus !== undefined)
        .map(t => String(t.expectedStatus!))
    );

    // Union of all codes we know about
    const allCodeSet = new Set([...specCodes, ...declaredCodes]);
    const allCodes: ResponseCodeEntry[] = [...allCodeSet].sort().map(code => {
      const inSpec = specCodes.has(code);
      const testedByDeclared = declaredCodes.has(code);
      let status: ResponseCodeStatus;
      if (inSpec && testedByDeclared) status = 'tested';
      else if (inSpec && !testedByDeclared) status = 'untested';
      else status = 'undocumented'; // declared but not in spec
      return { code, inSpec, testedByActual: false, status };
    });

    const coveredCount = allCodes.filter(c => c.status === 'tested').length;
    const totalSpecCodes = ep.documentedResponseCodes.length;
    const coveragePct = totalSpecCodes > 0
      ? Math.round((coveredCount / totalSpecCodes) * 1000) / 10
      : 0;

    return {
      specKey: `${ep.method} ${ep.path}`,
      allCodes,
      coveredCount,
      totalSpecCodes,
      coveragePct,
      hasDrift: allCodes.some(c => c.status === 'undocumented' || c.status === 'mismatch'),
    };
  });
}
```

**Note:** The `testedByActual` field and `mismatch` status are populated in Story 10 when run data is joined. This story leaves them at their defaults (`false`, never `'mismatch'`).

---

## Acceptance Criteria

- [ ] `computeResponseCodeCoverage()` is implemented in `src/commands/coverage/analyzer.ts` as specified above.

- [ ] `EndpointResponseCodeCoverage[]` is computed in `index.ts` after matching and passed to all reporters.

- [ ] **Pretty reporter** (`reporter/pretty.ts`): when `--detail` is NOT set, the response code matrix is NOT shown (it is a detail-level feature). When `--detail` IS set (Story 9), it is shown. For this story, add the rendering logic but gate it behind a `detailLevel` parameter that defaults to `false`. The base report summary gains one new line:

  ```
  Coverage Report — enigma API v1.2.3
    Spec endpoints:    87
    Tests scanned:     72  (8 collections)
    Covered:           45  (51.7%)
    Uncovered:         42
    Response codes:    38 / 61 spec codes tested  (62.3%)   ← NEW summary line
  ```

- [ ] **Pretty reporter detail view** (shown with `--detail`): for each covered endpoint, render the response code matrix inline:

  ```
  POST   /api/users                          3 tests   users
    Response codes: 201 ✓  400 ✓  403 ✓  404 ✗
  
  POST   /api/apikeys                        2 tests   apikeys
    Response codes: 201 ✓  400 ✗  403 ✗
    Drift: 500 returned but not in spec ⚠️   ← only shown when run data present (Story 10)
  ```

  Legend:
  - `✓` = `status === 'tested'`
  - `✗` = `status === 'untested'`
  - `⚠️` = `status === 'undocumented'` (inline, not in a separate section)
  - `↔` = `status === 'mismatch'` (Story 10)

- [ ] **JSON reporter** (`reporter/json.ts`): each endpoint object gains a `responseCodeCoverage` field:

  ```json
  {
    "method": "POST",
    "path": "/api/users",
    "covered": true,
    "responseCodeCoverage": {
      "coveredCount": 3,
      "totalSpecCodes": 4,
      "coveragePct": 75.0,
      "hasDrift": false,
      "codes": [
        { "code": "201", "inSpec": true, "testedByDeclared": true, "testedByActual": false, "status": "tested" },
        { "code": "400", "inSpec": true, "testedByDeclared": true, "testedByActual": false, "status": "tested" },
        { "code": "403", "inSpec": true, "testedByDeclared": true, "testedByActual": false, "status": "tested" },
        { "code": "404", "inSpec": true, "testedByDeclared": false, "testedByActual": false, "status": "untested" }
      ]
    }
  }
  ```

- [ ] **Markdown reporter** (`reporter/markdown.ts`): the summary table gains a `Response Codes` column showing `coveredCount/totalSpecCodes`:

  ```markdown
  | Status | Method | Endpoint | Tests | Response Codes | Collections |
  |--------|--------|----------|-------|----------------|-------------|
  | ✅ | POST | `/api/users` | 3 | 3/4 | users |
  | ❌ | GET | `/api/code/search` | 0 | 0/2 | — |
  ```

- [ ] **`CoverageArgs`** in `src/commands/coverage/types.ts` gains `detail?: boolean` (used in Story 9 — add the field now so the reporters can accept it).

- [ ] The overall `CoverageSummary` gains two new fields:
  ```typescript
  totalSpecResponseCodes: number;   // sum of documentedResponseCodes.length across all endpoints
  coveredResponseCodes: number;     // sum of coveredCount across all EndpointResponseCodeCoverage
  responseCodeCoveragePct: number;  // coveredResponseCodes / totalSpecResponseCodes * 100
  ```

- [ ] Endpoints with zero documented response codes (spec has no `responses` block) are excluded from the response code summary stats — they contribute 0 to both numerator and denominator.

---

## Notes for Implementer

- The `--detail` flag is formally introduced in Story 9. In this story, add the `detail?: boolean` field to `CoverageArgs` and thread it through to the reporters, but the CLI arg parsing in `src/index.ts` is updated in Story 9.
- The drift/mismatch rendering in the pretty reporter is scaffolded here but will only show real data after Story 10 (run loader). For now, `hasDrift` will always be `false` and the drift line will never render.
- Uncovered endpoints (zero tests) have no response code matrix to show — skip them in the detail view.
- The response code summary line in the base pretty report is always shown (not gated behind `--detail`). It is a summary stat, not a per-endpoint detail.
