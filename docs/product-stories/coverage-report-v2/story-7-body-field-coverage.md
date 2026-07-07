# Story 7 — Request Body Field Coverage

**Wave:** 2  
**Status:** Ready for implementation  
**Depends on:** Story 2 (enhanced test collection), Story 3 (enhanced spec extraction)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

POST/PUT/PATCH endpoints often have request body schemas with multiple fields — some required, some optional. Tests frequently exercise only the required fields and never touch optional ones. Optional fields often have their own validation logic (format checks, enum constraints, length limits) that goes completely untested. The current coverage report cannot surface this gap.

---

## Goal

For each POST/PUT/PATCH endpoint with a spec-declared request body schema, show which top-level body fields are exercised by at least one test. Surface untested fields as gaps.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
export interface BodyFieldCoverageEntry {
  name: string;
  required: boolean;    // from spec schema
  tested: boolean;      // at least one test includes this field in its request body
}

export interface EndpointBodyFieldCoverage {
  specKey: string;
  fields: BodyFieldCoverageEntry[];
  testedCount: number;
  totalCount: number;
  coveragePct: number;
  hasUntested: boolean;
  hasUntestedRequired: boolean;  // any required field is untested — higher severity
}
```

---

## Analyzer: `computeBodyFieldCoverage()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeBodyFieldCoverage(
  specEndpoints: SpecEndpoint[],
): EndpointBodyFieldCoverage[] {
  return specEndpoints
    .filter(ep =>
      ['POST', 'PUT', 'PATCH'].includes(ep.method) &&
      ep.requestBodyFields.length > 0
    )
    .map(ep => {
      // Collect all body field names exercised across all tests for this endpoint
      const testedFields = new Set<string>();
      for (const test of ep.tests) {
        for (const field of test.requestBodyFields) {
          testedFields.add(field.toLowerCase());
        }
      }

      // Note: SpecEndpoint.requestBodyFields is string[] (field names only).
      // We need required info — extend SpecEndpoint in Story 3 to carry
      // { name: string; required: boolean }[] instead of string[].
      // For this story, treat all fields as non-required if required info unavailable.
      const fields: BodyFieldCoverageEntry[] = ep.requestBodyFields.map(fieldName => ({
        name: fieldName,
        required: false, // populated when SpecEndpoint carries required metadata
        tested: testedFields.has(fieldName.toLowerCase()),
      }));

      const testedCount = fields.filter(f => f.tested).length;
      const totalCount = fields.length;
      return {
        specKey: `${ep.method} ${ep.path}`,
        fields,
        testedCount,
        totalCount,
        coveragePct: totalCount > 0
          ? Math.round((testedCount / totalCount) * 1000) / 10
          : 100,
        hasUntested: fields.some(f => !f.tested),
        hasUntestedRequired: fields.some(f => f.required && !f.tested),
      };
    });
}
```

---

## Acceptance Criteria

- [ ] `computeBodyFieldCoverage()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] `EndpointBodyFieldCoverage[]` is computed in `index.ts` and passed to reporters.

- [ ] **`SpecEndpoint.requestBodyFields`** is updated from `string[]` to `Array<{ name: string; required: boolean }>` in `src/commands/coverage/types.ts`. Update `spec-extractor.ts` accordingly — the `required` array from the JSON schema is already available in `resolveSchemaRef()`. Update `BodyFieldCoverageEntry.required` to use this data.

- [ ] **Pretty reporter** — base report gains a new summary line:

  ```
  Body fields:       18 / 27 spec body fields tested  (66.7%)
  ```

- [ ] **Pretty reporter** — `--detail` view shows body field coverage per endpoint (only for POST/PUT/PATCH with spec body fields):

  ```
  POST   /api/apikeys                        2 tests   apikeys
    Response codes: 201 ✓  400 ✗  403 ✗
    Body fields:    name ✓  scopes ✓  expiresAt ✗  description ✗
  ```

  Required untested fields are marked with `✗!` to distinguish from optional untested fields:

  ```
  POST   /api/users                          1 test    users
    Body fields:    email ✓  password ✓  role ✗!  displayName ✗
                                              ↑ required, untested
  ```

- [ ] **JSON reporter** — each endpoint object gains a `bodyFieldCoverage` field:

  ```json
  {
    "bodyFieldCoverage": {
      "testedCount": 2,
      "totalCount": 4,
      "coveragePct": 50.0,
      "hasUntested": true,
      "hasUntestedRequired": false,
      "fields": [
        { "name": "name",        "required": true,  "tested": true  },
        { "name": "scopes",      "required": true,  "tested": true  },
        { "name": "expiresAt",   "required": false, "tested": false },
        { "name": "description", "required": false, "tested": false }
      ]
    }
  }
  ```

- [ ] Endpoints with zero spec-declared body fields (GET, DELETE, or POST with no schema) are excluded from body field summary stats and have no `bodyFieldCoverage` block in JSON output.

- [ ] The `CoverageSummary` gains:
  ```typescript
  totalSpecBodyFields: number;
  testedBodyFields: number;
  bodyFieldCoveragePct: number;
  ```

---

## Notes for Implementer

- Field name matching is case-insensitive (normalize both sides to lowercase).
- The `required` flag on `BodyFieldCoverageEntry` requires the spec extractor to carry `{ name: string; required: boolean }[]` instead of `string[]`. This is a small change to Story 3's output — update `SpecEndpoint.requestBodyFields` type and the extractor's `extractTopLevelFields()` to return objects instead of strings. The `required` array is available on the resolved schema object.
- Tests that use a fixture file (`request.body.file`) have their body fields extracted in Story 2 — the collector reads the fixture JSON and extracts top-level keys. Those keys flow through `test.requestBodyFields` and are matched here.
- Tests that set `ctx.request.body` in a pre-script are NOT captured in this story (pre-script body assignment is a heuristic that requires script scanning beyond what Story 2 does). This is an acceptable gap — the 80/20 is inline bodies and fixture files.
