# Story 0 — Coverage Config Layer

**Wave:** 1 (Foundation — must ship before Stories 10, 11, 12, 13, 15, 16)  
**Status:** Ready for implementation  
**Files touched:** [`src/types.ts`](../../../src/types.ts), [`src/loader.ts`](../../../src/loader.ts)

---

## Problem

Every configurable knob in the v2 coverage system — default suite for `--last-run`, risk score weights, expected tag mappings, per-dimension CI thresholds — is currently either hardcoded or nonexistent. Different teams have different priorities: one team cares most about response code gaps, another about body field coverage. Hardcoding one team's assumptions into the engine makes the tool less useful for everyone else.

---

## Goal

Add a `coverage:` block to `shogun.config.yaml` that lets teams tune the coverage system without code changes. All keys are optional; sensible defaults ship out of the box so existing repos need zero config changes to get v2 behavior.

---

## Config Schema

The following block is added to `shogun.config.yaml` (all keys optional):

```yaml
coverage:
  # When --last-run is used without --suite, filter to this suite's runs.
  # Omit to fall back to truly latest run (current behavior).
  defaultSuite: tsap

  # Per-dimension risk-score weights (must sum to 1.0). Defaults shown.
  riskWeights:
    responseCodeGap: 0.35
    parameterGap: 0.15
    bodyFieldGap: 0.15
    assertionQuality: 0.20
    runResults: 0.15

  # Method → expected test tags. Endpoints missing expected tags are flagged.
  # Override to match your team's tag taxonomy.
  expectedTagsByMethod:
    GET:    [readonly]
    POST:   [crud, validation]
    PATCH:  [crud]
    PUT:    [crud, validation]
    DELETE: [crud, guard]

  # Per-dimension coverage thresholds for --min-coverage CI gate.
  # Omit a dimension to skip checking it.
  minCoverage:
    endpoint: 100
    responseCode: 80
    parameter: 70
    bodyField: 70
```

---

## Acceptance Criteria

- [ ] `CoverageConfig` interface is added to [`src/types.ts`](../../../src/types.ts) with the following shape:

```typescript
export interface CoverageRiskWeights {
  responseCodeGap: number;   // default: 0.35
  parameterGap: number;      // default: 0.15
  bodyFieldGap: number;      // default: 0.15
  assertionQuality: number;  // default: 0.20
  runResults: number;        // default: 0.15
}

export interface CoverageMinThresholds {
  endpoint?: number;
  responseCode?: number;
  parameter?: number;
  bodyField?: number;
}

export interface CoverageConfig {
  defaultSuite?: string;
  riskWeights?: Partial<CoverageRiskWeights>;
  expectedTagsByMethod?: Record<string, string[]>;
  minCoverage?: CoverageMinThresholds;
}
```

- [ ] `ShogunConfig` in [`src/types.ts`](../../../src/types.ts) gains an optional `coverage?: CoverageConfig` field.

- [ ] The Zod schema `ShogunConfigSchema` in [`src/loader.ts`](../../../src/loader.ts) is extended to parse the `coverage:` block. All fields are optional. Unknown keys within `coverage:` emit a `console.warn` but do not throw (forward-compatibility).

- [ ] A `resolveCoverageConfig(config: ShogunConfig): Required<CoverageConfig>` helper is exported from [`src/loader.ts`](../../../src/loader.ts). It merges user-supplied values over the hardcoded defaults:

```typescript
export const DEFAULT_RISK_WEIGHTS: CoverageRiskWeights = {
  responseCodeGap: 0.35,
  parameterGap: 0.15,
  bodyFieldGap: 0.15,
  assertionQuality: 0.20,
  runResults: 0.15,
};

export const DEFAULT_EXPECTED_TAGS_BY_METHOD: Record<string, string[]> = {
  GET:    ['readonly'],
  POST:   ['crud', 'validation'],
  PATCH:  ['crud'],
  PUT:    ['crud', 'validation'],
  DELETE: ['crud', 'guard'],
};

export function resolveCoverageConfig(config: ShogunConfig): {
  defaultSuite: string | undefined;
  riskWeights: CoverageRiskWeights;
  expectedTagsByMethod: Record<string, string[]>;
  minCoverage: CoverageMinThresholds;
} {
  const c = config.coverage ?? {};
  return {
    defaultSuite: c.defaultSuite,
    riskWeights: { ...DEFAULT_RISK_WEIGHTS, ...(c.riskWeights ?? {}) },
    expectedTagsByMethod: c.expectedTagsByMethod ?? DEFAULT_EXPECTED_TAGS_BY_METHOD,
    minCoverage: c.minCoverage ?? {},
  };
}
```

- [ ] `loadConfig()` continues to work with no `coverage:` block — no breaking change.

- [ ] The existing `ShogunConfigSchema` Zod parse does not fail on a config file that contains a `coverage:` block (regression test: add a config fixture with a full `coverage:` block and assert `loadConfig()` returns it correctly).

---

## Notes for Implementer

- The `riskWeights` values do not need to be validated to sum to 1.0 at load time — the analyzer normalizes them. Just parse them as numbers.
- `expectedTagsByMethod` keys are HTTP method names (uppercase or lowercase — normalize to uppercase in `resolveCoverageConfig`).
- `minCoverage` dimension keys (`endpoint`, `responseCode`, `parameter`, `bodyField`) are numbers 0–100. No range validation needed at load time.
- This story has no visible output change. It is pure infrastructure for downstream stories.
- Do not modify `coverage.ts` in this story — only `types.ts` and `loader.ts`.
