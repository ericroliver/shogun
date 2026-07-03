# Story 17 — Spec Drift Detection

**Wave:** 4  
**Status:** Ready for implementation  
**Depends on:** Story 10 (run bridge — requires run data), Story 4 (response code matrix — drift is inlined there)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

The OpenAPI spec is a contract between the API and its consumers. When the API returns a response code that isn't documented in the spec, that is a legitimate API defect — the implementation diverges from the contract. Currently, this divergence is invisible. A test that expects 200 and gets 500 shows as a test failure, but the spec drift (500 not documented) is never surfaced as a contract violation.

There is also a second, subtler problem: a test that expects 400 but the API returns 200. Both codes may be documented in the spec, so it is not spec drift — but it is a test-vs-reality mismatch that indicates the API's behavior has changed from what the test was written to expect.

---

## Goal

When run data is available (`--last-run`), detect two categories of drift:

1. **Undocumented actual codes** — the API returned a code not in the spec for that endpoint. This is a spec defect.
2. **Test-vs-reality mismatches** — the test expected code X, the API returned code Y. Both may be documented. This is a behavioral change signal.

Both are surfaced inline in the response code matrix (Story 4) and in the `--gaps` report (Story 11). This story formalizes the detection logic and adds a dedicated drift summary section.

---

## Note on Implementation Overlap

Story 4 (response code matrix) already scaffolds the `ResponseCodeEntry.status` field with values `'undocumented'` and `'mismatch'`, and Story 10 (run bridge) populates `testedByActual` and adds undocumented/mismatch entries. This story:

1. Formalizes the drift detection as a named `computeSpecDrift()` function in `analyzer.ts`.
2. Adds a dedicated drift summary section to the pretty reporter.
3. Adds a `specDrift` top-level field to the JSON output.
4. Ensures the `--gaps` report includes drift gaps (already scaffolded in Story 11).

If Stories 4 and 10 have already been implemented with the drift logic inline, this story extracts and formalizes it.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
export type DriftType = 'undocumented-code' | 'test-vs-reality';

export interface SpecDriftEntry {
  type: DriftType;
  endpoint: string;          // "POST /api/users"
  code: string;              // the response code involved
  detail: string;            // human-readable description
  testName?: string;         // for test-vs-reality: which test
  testFile?: string;         // for test-vs-reality: which file
}

export interface SpecDriftReport {
  entries: SpecDriftEntry[];
  undocumentedCodeCount: number;
  testVsRealityCount: number;
  affectedEndpoints: string[];  // deduplicated list of endpoints with any drift
}
```

---

## Analyzer: `computeSpecDrift()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeSpecDrift(
  specEndpoints: SpecEndpoint[],
): SpecDriftReport {
  const entries: SpecDriftEntry[] = [];

  for (const ep of specEndpoints) {
    const specKey = `${ep.method} ${ep.path}`;
    const specCodes = new Set(ep.documentedResponseCodes);

    for (const test of ep.tests) {
      if (!test.runResult) continue;

      const actualCode = String(test.runResult.httpStatus);
      const expectedCode = test.expectedStatus !== undefined
        ? String(test.expectedStatus)
        : undefined;

      // Undocumented actual code: API returned a code not in spec
      if (actualCode !== '0' && !specCodes.has(actualCode)) {
        // Only add once per endpoint+code combination
        const alreadyAdded = entries.some(
          e => e.type === 'undocumented-code' && e.endpoint === specKey && e.code === actualCode
        );
        if (!alreadyAdded) {
          entries.push({
            type: 'undocumented-code',
            endpoint: specKey,
            code: actualCode,
            detail: `API returned ${actualCode} but spec does not document this code`,
          });
        }
      }

      // Test-vs-reality mismatch: test expected X, API returned Y
      if (
        expectedCode !== undefined &&
        actualCode !== '0' &&
        actualCode !== expectedCode
      ) {
        entries.push({
          type: 'test-vs-reality',
          endpoint: specKey,
          code: actualCode,
          detail: `Test expects ${expectedCode}, API returned ${actualCode}`,
          testName: test.name,
          testFile: test.file,
        });
      }
    }
  }

  const undocumentedCodeCount = entries.filter(e => e.type === 'undocumented-code').length;
  const testVsRealityCount = entries.filter(e => e.type === 'test-vs-reality').length;
  const affectedEndpoints = [...new Set(entries.map(e => e.endpoint))];

  return { entries, undocumentedCodeCount, testVsRealityCount, affectedEndpoints };
}
```

---

## Acceptance Criteria

- [ ] `computeSpecDrift()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] `SpecDriftReport`, `SpecDriftEntry`, `DriftType` types are added to `src/commands/coverage/types.ts`.

- [ ] `computeSpecDrift()` is called in `index.ts` only when run data is present (`runSummary !== null`). When no run data, `specDrift` is `null`.

- [ ] **Response code matrix integration** (Story 4 + Story 10 extension): the `ResponseCodeEntry` for undocumented actual codes has `status: 'undocumented'` and is rendered with `⚠️` inline in the matrix. The `ResponseCodeEntry` for mismatches has `status: 'mismatch'` and is rendered with `↔` inline. This is already scaffolded in Stories 4 and 10 — confirm it is wired to `computeSpecDrift()` output.

- [ ] **Pretty reporter** — when run data is present and drift is detected, a drift summary section is shown after the endpoint list (before the tip line):

  ```
  ── Spec Drift (requires --last-run) ─────────────────────────────────────────
  
  Undocumented response codes (2 occurrences, 2 endpoints):
    ⚠️  POST /api/users          500 returned but not in spec
    ⚠️  POST /api/apikeys        422 returned but not in spec
  
  Test-vs-reality mismatches (3 occurrences):
    ↔  POST /api/users          "Create User (invalid role)" expects 400, got 200
    ↔  GET  /api/graph/nodes    "Get Nodes (empty workspace)" expects 200, got 404
    ↔  DELETE /api/apikeys/{id} "Delete API Key" expects 204, got 200
  ```

- [ ] When no drift is detected (all actual codes match spec, all tests match actual), the drift section is omitted entirely.

- [ ] When `--last-run` is NOT given, the drift section is omitted entirely (no run data = no drift detection).

- [ ] **JSON reporter** — the JSON output gains a top-level `specDrift` field:

  ```json
  {
    "specDrift": {
      "undocumentedCodeCount": 2,
      "testVsRealityCount": 3,
      "affectedEndpoints": ["POST /api/users", "POST /api/apikeys", "GET /api/graph/nodes", "DELETE /api/apikeys/{id}"],
      "entries": [
        {
          "type": "undocumented-code",
          "endpoint": "POST /api/users",
          "code": "500",
          "detail": "API returned 500 but spec does not document this code"
        },
        {
          "type": "test-vs-reality",
          "endpoint": "POST /api/users",
          "code": "200",
          "detail": "Test expects 400, API returned 200",
          "testName": "Create User (invalid role)",
          "testFile": "tests/collections/users/create-user-invalid-role.yaml"
        }
      ]
    }
  }
  ```

  When no run data: `"specDrift": null`.

- [ ] **`--gaps` report** (Story 11 extension): drift entries are already added as `'Spec drift'` and `'Test-vs-reality mismatch'` gaps with severity `HIGH` in `collectAllGaps()`. Confirm this is wired to `computeSpecDrift()` output.

- [ ] The `CoverageSummary` gains:
  ```typescript
  specDriftCount: number;   // total drift entries (0 if no run data)
  ```

---

## Notes for Implementer

- `actualCode === '0'` means the run result had `httpStatus: 0` — this happens when curl fails to connect (network error, timeout). Skip these — they are not spec drift, they are infrastructure failures.
- Undocumented code deduplication: if 5 tests all hit the same endpoint and all get 500, report the undocumented code once per endpoint, not 5 times. Test-vs-reality mismatches are NOT deduplicated — each mismatch is a separate test failure signal.
- The drift section in the pretty reporter is only shown when `--last-run` is active. Add a note in the tip line when run data is absent: `Tip: --last-run to add spec drift detection`.
- This story is the "favorite intelligence feature" from the test team's feedback. It is the most direct API defect signal in the entire coverage system. Treat it as a first-class output, not an afterthought.
