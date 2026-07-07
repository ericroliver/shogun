# Story 13 — Negative Testing Coverage & Test Tag Intelligence

**Wave:** 4  
**Status:** Ready for implementation  
**Depends on:** Story 0 (config layer — expectedTagsByMethod), Story 2 (enhanced test collection), Story 12 (risk score — for sort order)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

Two related gaps in the current coverage picture:

1. **Negative testing ratio**: A suite with 90% happy-path (2xx) tests and 10% error-path (4xx/5xx) tests has a fundamentally different risk profile than one with 60/40. This ratio is invisible in the current report. Worse, an endpoint with only 2xx tests has never had its error handling exercised at all.

2. **Tag coverage gaps**: The team uses tags (`crud`, `guard`, `validation`, `readonly`, `smoke`) to classify tests. A POST endpoint with `crud` tests but no `validation` tests is missing an entire category of coverage. The expected tag coverage per method is team-configurable (Story 0).

---

## Goal

Report the 2xx/4xx/5xx test ratio both suite-wide and per endpoint. Flag endpoints with only happy-path tests. Report tag coverage gaps per endpoint based on the configurable `expectedTagsByMethod` mapping.

---

## New Types in `src/commands/coverage/types.ts`

```typescript
export interface NegativeTestingRatio {
  total: number;
  twoxx: number;    // tests with expectedStatus 200–299
  fourxx: number;   // tests with expectedStatus 400–499
  fivexx: number;   // tests with expectedStatus 500–599
  twoxxPct: number;
  fourxxPct: number;
  fivexxPct: number;
  onlyHappyPath: boolean;  // fourxx === 0 && fivexx === 0 && total > 0
}

export interface TagCoverageGap {
  method: string;
  expectedTags: string[];
  presentTags: string[];
  missingTags: string[];
}

export interface EndpointTestingProfile {
  specKey: string;
  negativeRatio: NegativeTestingRatio;
  tagGap?: TagCoverageGap;  // undefined if no expected tags configured for this method
}
```

---

## Analyzer: `computeTestingProfiles()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeTestingProfiles(
  specEndpoints: SpecEndpoint[],
  expectedTagsByMethod: Record<string, string[]>,
): EndpointTestingProfile[] {
  return specEndpoints
    .filter(ep => ep.tests.length > 0)
    .map(ep => {
      const specKey = `${ep.method} ${ep.path}`;

      // Negative testing ratio
      const total = ep.tests.length;
      const twoxx = ep.tests.filter(t =>
        t.expectedStatus !== undefined && t.expectedStatus >= 200 && t.expectedStatus < 300
      ).length;
      const fourxx = ep.tests.filter(t =>
        t.expectedStatus !== undefined && t.expectedStatus >= 400 && t.expectedStatus < 500
      ).length;
      const fivexx = ep.tests.filter(t =>
        t.expectedStatus !== undefined && t.expectedStatus >= 500 && t.expectedStatus < 600
      ).length;

      const negativeRatio: NegativeTestingRatio = {
        total,
        twoxx,
        fourxx,
        fivexx,
        twoxxPct: total > 0 ? Math.round((twoxx / total) * 100) : 0,
        fourxxPct: total > 0 ? Math.round((fourxx / total) * 100) : 0,
        fivexxPct: total > 0 ? Math.round((fivexx / total) * 100) : 0,
        onlyHappyPath: fourxx === 0 && fivexx === 0 && total > 0,
      };

      // Tag coverage gap
      const methodUpper = ep.method.toUpperCase();
      const expectedTags = expectedTagsByMethod[methodUpper] ?? [];
      let tagGap: TagCoverageGap | undefined;

      if (expectedTags.length > 0) {
        const presentTagsSet = new Set(ep.tests.flatMap(t => t.tags));
        const missingTags = expectedTags.filter(tag => !presentTagsSet.has(tag));
        tagGap = {
          method: methodUpper,
          expectedTags,
          presentTags: [...presentTagsSet],
          missingTags,
        };
      }

      return { specKey, negativeRatio, tagGap };
    });
}
```

---

## Acceptance Criteria

- [ ] `computeTestingProfiles()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] `EndpointTestingProfile`, `NegativeTestingRatio`, `TagCoverageGap` types are added to `src/commands/coverage/types.ts`.

- [ ] `expectedTagsByMethod` is read from `resolveCoverageConfig(config).expectedTagsByMethod` (Story 0). Keys are normalized to uppercase.

- [ ] **Pretty reporter** — base report gains a suite-wide negative testing summary:

  ```
  Test profile:      72 tests  —  2xx: 58 (81%)  4xx: 12 (17%)  5xx: 2 (3%)
  ```

- [ ] **Pretty reporter** — `--detail` view shows per-endpoint profile for covered endpoints:

  ```
  POST   /api/apikeys                        3 tests   apikeys    risk: 55
    Response codes: 201 ✓  400 ✗  403 ✗
    Test profile:   2xx: 3 (100%)  4xx: 0  5xx: 0  ⚠️ only happy-path
    Tag gaps:       missing [validation] for POST
  ```

  The `⚠️ only happy-path` marker appears when `onlyHappyPath === true`.

- [ ] **Pretty reporter** — per-endpoint negative testing ratio is shown per endpoint in `--detail` view:

  ```
  GET    /api/graph/nodes                    5 tests   graph
    Test profile:   2xx: 3 (60%)  4xx: 2 (40%)  5xx: 0
  ```

- [ ] **JSON reporter** — each endpoint object gains a `testingProfile` field:

  ```json
  {
    "testingProfile": {
      "negativeRatio": {
        "total": 3,
        "twoxx": 3, "fourxx": 0, "fivexx": 0,
        "twoxxPct": 100, "fourxxPct": 0, "fivexxPct": 0,
        "onlyHappyPath": true
      },
      "tagGap": {
        "method": "POST",
        "expectedTags": ["crud", "validation"],
        "presentTags": ["crud", "smoke"],
        "missingTags": ["validation"]
      }
    }
  }
  ```

- [ ] **`--gaps` report** (Story 11 extension): add two new gap categories:
  - `"Only happy-path tests"` — severity `MEDIUM` — for endpoints where `onlyHappyPath === true`
  - `"Missing expected tags"` — severity `LOW` — for endpoints with `tagGap.missingTags.length > 0`

  These gaps are added to `collectAllGaps()` in `analyzer.ts`.

- [ ] The `CoverageSummary` gains:
  ```typescript
  suiteNegativeRatio: NegativeTestingRatio;  // suite-wide aggregate
  onlyHappyPathCount: number;                // endpoints with only 2xx tests
  ```

---

## Notes for Implementer

- Tests with no `expectedStatus` (undefined) are not counted in any ratio bucket — they contribute to `total` but not to `twoxx`/`fourxx`/`fivexx`. This is intentional: a test with no declared status is not making a claim about the response code.
- The `expectedTagsByMethod` config uses the team's tag taxonomy. The defaults (`readonly`, `crud`, `validation`, `guard`) are a starting point. Teams override via config. If a method has no entry in `expectedTagsByMethod`, `tagGap` is `undefined` for that endpoint — no tag gap is reported.
- Tag matching is case-sensitive — tags in test YAML must match the config exactly. Document this in a comment.
- The suite-wide `suiteNegativeRatio` is computed by aggregating all test entries (not per-endpoint), so a test that appears in multiple endpoints (unlikely but possible) is counted once.
