# Story 8 — Assertion Quality Metrics

**Wave:** 2  
**Status:** Ready for implementation  
**Depends on:** Story 2 (enhanced test collection)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

A test that only checks `response.status: 200` is nearly worthless — it proves the endpoint didn't crash, nothing more. These "thin tests" hide behind a green checkmark and inflate coverage numbers. The current report has no way to distinguish a test with 6 shape assertions and a post-script from a test with only a status check.

---

## Goal

Compute a per-test assertion quality score based on assertion density. Aggregate scores per endpoint (normalized to 0–100). Surface the per-endpoint score in the detail view. The thin-test flag (score ≤ 1) is implemented in Story 8b.

---

## Scoring Table

| Signal | Weight | Source |
|--------|--------|--------|
| Status assertion present | 1 | `response.status` in YAML (`expectedStatus !== undefined`) |
| Shape assertions | 2 × count of entries | `response.shape[]` entries (`shapeAssertions.length`) |
| Snapshot comparison enabled | 3 | `response.snapshot: true` (`snapshotEnabled === true`) |
| Post-script assertions | 1 × count of `assert(` calls | `postScriptAssertCount` |

**Pre-script presence is NOT scored.** A pre-script that sets up a UUID is test infrastructure, not an assertion. It is collected as metadata (Story 2) but excluded from the quality score.

**Shape weight is per-entry, not per-test.** A test with `shape: ["$.id", "$.name", "$.createdAt"]` scores `2 × 3 = 6` for shape, not `2 × 1 = 2`. This is an explicit implementation requirement.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
export interface TestQualityScore {
  testName: string;
  file: string;
  rawScore: number;          // sum of weighted signals
  isThin: boolean;           // rawScore <= 1 (set in Story 8b)
  breakdown: {
    statusScore: number;     // 0 or 1
    shapeScore: number;      // 2 * shapeAssertions.length
    snapshotScore: number;   // 0 or 3
    postScriptScore: number; // postScriptAssertCount
  };
}

export interface EndpointQualityScore {
  specKey: string;
  tests: TestQualityScore[];
  normalizedScore: number;   // 0–100, aggregate of all tests for this endpoint
  thinTestCount: number;     // count of tests with isThin === true (Story 8b)
}
```

---

## Analyzer: `computeAssertionQuality()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeAssertionQuality(
  specEndpoints: SpecEndpoint[],
): EndpointQualityScore[] {
  return specEndpoints
    .filter(ep => ep.tests.length > 0)
    .map(ep => {
      const testScores: TestQualityScore[] = ep.tests.map(test => {
        const statusScore = test.expectedStatus !== undefined ? 1 : 0;
        const shapeScore = test.shapeAssertions.length * 2;
        const snapshotScore = test.snapshotEnabled ? 3 : 0;
        const postScriptScore = test.postScriptAssertCount;
        const rawScore = statusScore + shapeScore + snapshotScore + postScriptScore;

        return {
          testName: test.name,
          file: test.file,
          rawScore,
          isThin: rawScore <= 1,  // Story 8b sets this; compute it here too
          breakdown: { statusScore, shapeScore, snapshotScore, postScriptScore },
        };
      });

      // Normalize to 0–100: sum raw scores, cap at a "perfect" ceiling of 10 per test
      // Perfect test = status(1) + 3 shape entries(6) + snapshot(3) = 10
      const PERFECT_PER_TEST = 10;
      const maxPossible = ep.tests.length * PERFECT_PER_TEST;
      const totalRaw = testScores.reduce((sum, t) => sum + t.rawScore, 0);
      const normalizedScore = maxPossible > 0
        ? Math.min(100, Math.round((totalRaw / maxPossible) * 100))
        : 0;

      return {
        specKey: `${ep.method} ${ep.path}`,
        tests: testScores,
        normalizedScore,
        thinTestCount: testScores.filter(t => t.isThin).length,
      };
    });
}
```

---

## Acceptance Criteria

- [ ] `computeAssertionQuality()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] Shape weight is confirmed as **per-entry** (2 × `shapeAssertions.length`), not per-test-with-shape. This is an explicit implementation requirement — do not implement it as a flat `2` for any test that has shape assertions.

- [ ] Pre-script presence (`hasPreScript`) is NOT included in the score calculation. It is available on `TestEntry` as metadata but must not contribute to `rawScore`.

- [ ] `EndpointQualityScore[]` is computed in `index.ts` and passed to reporters.

- [ ] **Pretty reporter** — base report gains a new summary line:

  ```
  Assertion quality: avg score 47 / 100 across covered endpoints
  ```

- [ ] **Pretty reporter** — `--detail` view shows quality score per endpoint:

  ```
  POST   /api/apikeys                        2 tests   apikeys
    Response codes: 201 ✓  400 ✗  403 ✗
    Body fields:    name ✓  scopes ✓  expiresAt ✗
    Quality score:  72 / 100  (2 tests: scores 8, 4)
  ```

- [ ] **JSON reporter** — each endpoint object gains a `qualityScore` field:

  ```json
  {
    "qualityScore": {
      "normalizedScore": 72,
      "thinTestCount": 0,
      "tests": [
        {
          "testName": "Create API Key",
          "file": "tests/collections/apikeys/create-api-key.yaml",
          "rawScore": 8,
          "isThin": false,
          "breakdown": { "statusScore": 1, "shapeScore": 4, "snapshotScore": 3, "postScriptScore": 0 }
        }
      ]
    }
  }
  ```

- [ ] The `CoverageSummary` gains:
  ```typescript
  avgQualityScore: number;   // average normalizedScore across all covered endpoints
  ```

---

## Notes for Implementer

- The `PERFECT_PER_TEST = 10` ceiling is intentional — it prevents a test with 20 shape assertions from inflating the score beyond 100. A test can exceed 10 raw points (e.g., snapshot=3 + 5 shape entries=10 + status=1 = 14), but the normalization caps the endpoint score at 100.
- `isThin` is computed here (rawScore ≤ 1) and also used in Story 8b. Do not wait for Story 8b to set this field — compute it in this story.
- The average quality score in the summary is the mean of `normalizedScore` across all `EndpointQualityScore` entries (covered endpoints only). Round to nearest integer.
