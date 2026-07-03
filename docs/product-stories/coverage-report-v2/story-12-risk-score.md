# Story 12 — Coverage Risk Score

**Wave:** 3  
**Status:** Ready for implementation  
**Depends on:** Story 0 (config layer — weights), Stories 4, 6, 7, 8 (all depth dimensions), Story 11 (gaps flag)  
**Files touched:** `src/commands/coverage/analyzer.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/pretty.ts`, `src/commands/coverage/reporter/json.ts`

---

## Problem

A flat list of gaps (Story 11) tells you what is missing but not where to focus first. An endpoint with one untested optional body field has a very different risk profile than an endpoint with zero tests, three untested error codes, and a failing test. Without prioritization, teams waste time on low-risk gaps while high-risk ones go unaddressed.

---

## Goal

Compute a per-endpoint risk score (0–100) that combines all coverage dimensions into a single number. Sort endpoints by risk score descending in the default report — the most dangerous gaps lead. Weights are configurable via `coverage.riskWeights` (Story 0).

---

## Risk Score Formula

The risk score is a weighted sum of normalized gap signals, scaled to 0–100:

```
riskScore = (
  responseCodeGapWeight  × responseCodeGapSignal  +
  parameterGapWeight     × parameterGapSignal     +
  bodyFieldGapWeight     × bodyFieldGapSignal     +
  assertionQualityWeight × assertionQualitySignal +
  runResultsWeight       × runResultsSignal
) × 100
```

Where each signal is a value in [0, 1]:

| Signal | Formula | Notes |
|--------|---------|-------|
| `responseCodeGapSignal` | `1 - (coveredCount / totalSpecCodes)` | 0 = all codes tested, 1 = no codes tested. 0 if no spec codes. |
| `parameterGapSignal` | `1 - (testedCount / totalCount)` | 0 = all params tested, 1 = no params tested. 0 if no params. |
| `bodyFieldGapSignal` | `1 - (testedCount / totalCount)` | 0 = all fields tested, 1 = no fields tested. 0 if no fields. |
| `assertionQualitySignal` | `1 - (normalizedScore / 100)` | 0 = perfect quality, 1 = all tests thin. 0 if no tests. |
| `runResultsSignal` | `failedTests / totalTests` | 0 = all passing, 1 = all failing. 0 if no run data. |

**Uncovered endpoints** (zero tests) receive a fixed risk score of **100** — they are always the highest risk regardless of weights.

**Default weights** (from `DEFAULT_RISK_WEIGHTS` in Story 0):
```
responseCodeGap: 0.35
parameterGap:    0.15
bodyFieldGap:    0.15
assertionQuality: 0.20
runResults:      0.15
```

---

## New Types in `src/commands/coverage/types.ts`

```typescript
export interface EndpointRiskScore {
  specKey: string;
  score: number;           // 0–100, higher = more risk
  isUncovered: boolean;    // true if no tests (score is always 100)
  signals: {
    responseCodeGap: number;    // 0–1
    parameterGap: number;       // 0–1
    bodyFieldGap: number;       // 0–1
    assertionQuality: number;   // 0–1
    runResults: number;         // 0–1
  };
}
```

---

## Analyzer: `computeRiskScores()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function computeRiskScores(
  specEndpoints: SpecEndpoint[],
  responseCodeCoverage: EndpointResponseCodeCoverage[],
  paramCoverage: EndpointParameterCoverage[],
  bodyFieldCoverage: EndpointBodyFieldCoverage[],
  qualityScores: EndpointQualityScore[],
  weights: CoverageRiskWeights,
): EndpointRiskScore[] {
  const rcMap = new Map(responseCodeCoverage.map(r => [r.specKey, r]));
  const paramMap = new Map(paramCoverage.map(p => [p.specKey, p]));
  const bodyMap = new Map(bodyFieldCoverage.map(b => [b.specKey, b]));
  const qualMap = new Map(qualityScores.map(q => [q.specKey, q]));

  return specEndpoints.map(ep => {
    const specKey = `${ep.method} ${ep.path}`;

    if (ep.tests.length === 0) {
      return {
        specKey,
        score: 100,
        isUncovered: true,
        signals: { responseCodeGap: 1, parameterGap: 1, bodyFieldGap: 1, assertionQuality: 1, runResults: 0 },
      };
    }

    const rc = rcMap.get(specKey);
    const responseCodeGap = rc && rc.totalSpecCodes > 0
      ? 1 - (rc.coveredCount / rc.totalSpecCodes)
      : 0;

    const param = paramMap.get(specKey);
    const parameterGap = param && param.totalCount > 0
      ? 1 - (param.testedCount / param.totalCount)
      : 0;

    const body = bodyMap.get(specKey);
    const bodyFieldGap = body && body.totalCount > 0
      ? 1 - (body.testedCount / body.totalCount)
      : 0;

    const qual = qualMap.get(specKey);
    const assertionQuality = qual
      ? 1 - (qual.normalizedScore / 100)
      : 0;

    const totalTests = ep.tests.length;
    const failedTests = ep.tests.filter(t => t.runResult?.status === 'failed').length;
    const runResults = totalTests > 0 ? failedTests / totalTests : 0;

    const rawScore =
      weights.responseCodeGap  * responseCodeGap  +
      weights.parameterGap     * parameterGap     +
      weights.bodyFieldGap     * bodyFieldGap     +
      weights.assertionQuality * assertionQuality +
      weights.runResults       * runResults;

    return {
      specKey,
      score: Math.round(rawScore * 100),
      isUncovered: false,
      signals: { responseCodeGap, parameterGap, bodyFieldGap, assertionQuality, runResults },
    };
  });
}
```

---

## Acceptance Criteria

- [ ] `computeRiskScores()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] `EndpointRiskScore` type is added to `src/commands/coverage/types.ts`.

- [ ] Weights are read from `resolveCoverageConfig(config).riskWeights` (Story 0). If no `coverage:` block is configured, the defaults from `DEFAULT_RISK_WEIGHTS` are used.

- [ ] **Endpoint sort order**: in the default pretty report, endpoints within each tag group are sorted by risk score descending (highest risk first). Previously they were sorted covered-first then by method+path. The new sort is: uncovered endpoints first (score 100), then covered endpoints by score descending, then by method+path as tiebreaker.

- [ ] **Pretty reporter** — each endpoint line gains a risk score indicator when score > 0:

  ```
  ── Graph (12 endpoints, 10 covered, 83.3%) ──────────────────────────────────
  ⚠ POST   /api/graph/nodes/{path}              1 test    graph    risk: 72
  ⚠ GET    /api/graph/nodes                     2 tests   graph    risk: 45
    DELETE /api/graph/nodes/{path}              2 tests   graph    risk: 8
    GET    /api/graph/links                     1 test    graph    risk: 5
  ✗ GET    /api/graph/search                    0 tests            risk: 100
  ```

  Risk indicator:
  - `✗` = uncovered (risk 100)
  - `⚠` = risk ≥ 30
  - ` ` (space) = risk < 30

- [ ] **Pretty reporter** — `--detail` view shows the risk score breakdown per endpoint:

  ```
  POST   /api/graph/nodes/{path}              1 test    graph    risk: 72
    Risk breakdown: response-codes 0.60  params 0.00  body-fields 0.50  quality 0.40  run 0.00
    Response codes: 200 ✓  400 ✗  403 ✗
    ...
  ```

- [ ] **JSON reporter** — each endpoint object gains a `riskScore` field:

  ```json
  {
    "riskScore": {
      "score": 72,
      "isUncovered": false,
      "signals": {
        "responseCodeGap": 0.60,
        "parameterGap": 0.00,
        "bodyFieldGap": 0.50,
        "assertionQuality": 0.40,
        "runResults": 0.00
      }
    }
  }
  ```

- [ ] **`--gaps` report** (Story 11): gaps are already sorted by severity. The risk score is shown next to each endpoint in the gaps report:

  ```
  HIGH (8 gaps)
  ─────────────────────────────────────────────────────────────────────────────
  ● Untested response code   POST /api/apikeys  [risk: 68]
    403 is documented but no test declares this status
  ```

- [ ] The `CoverageSummary` gains:
  ```typescript
  highRiskEndpointCount: number;  // endpoints with riskScore >= 50
  ```

---

## Notes for Implementer

- The weight values from config do not need to sum to 1.0 — the formula works regardless. If a team sets all weights to 1.0, scores will exceed 100 and be capped at 100 by `Math.min(100, ...)`. Add that cap.
- `runResultsSignal` is always 0 when no run data is present (`test.runResult` is undefined). This means the `runResults` weight has no effect in static-only mode — correct behavior.
- The risk score is a heuristic, not a precise measurement. The goal is relative ordering, not absolute accuracy. Teams can tune weights to match their priorities.
