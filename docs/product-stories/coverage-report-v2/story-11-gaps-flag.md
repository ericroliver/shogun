# Story 11 — `--gaps` Flag (Unified Gap Analysis)

**Wave:** 3  
**Status:** Ready for implementation  
**Depends on:** Stories 4, 6, 7, 8, 8b (all depth dimensions), Story 10 (run bridge, optional)  
**Files touched:** `src/commands/coverage/reporter/gaps.ts` (stub from Story 8b), `src/commands/coverage/types.ts`, `src/commands/coverage/index.ts`, [`src/index.ts`](../../../src/index.ts)

---

## Problem

The current `--uncovered` flag shows only endpoints with zero tests. This is the thinnest possible gap view. A team that has achieved 100% endpoint coverage still has gaps: untested response codes, untested parameters, untested body fields, thin tests. There is no single command that surfaces all of these gaps together in a prioritized, actionable list.

---

## Goal

Replace `--uncovered` with `--gaps` — a multi-dimensional gap analysis mode that aggregates all coverage gaps into a single focused report, sorted by severity. `--uncovered` is kept as a deprecated alias for backward compatibility but is not documented in the tip line.

---

## CLI Interface

```bash
# Show all coverage gaps across all dimensions
shogun coverage --env local --gaps

# Gaps for a specific tag group
shogun coverage --env local --gaps --tag Graph

# Gaps with run data (adds failing tests, spec drift)
shogun coverage --env local --gaps --last-run
```

---

## Gap Categories

The gaps report aggregates gaps from all dimensions into a single sorted list:

| Category | Severity | Source |
|----------|----------|--------|
| Uncovered endpoint | CRITICAL | endpoint coverage |
| Untested required body field | HIGH | body field coverage |
| Untested response code (4xx/5xx) | HIGH | response code coverage |
| Failing test | HIGH | run results (requires `--last-run`) |
| Spec drift — undocumented actual code | HIGH | spec drift (requires `--last-run`) |
| Test-vs-reality mismatch | HIGH | spec drift (requires `--last-run`) |
| Untested response code (2xx) | MEDIUM | response code coverage |
| Untested optional body field | MEDIUM | body field coverage |
| Untested parameter | MEDIUM | parameter coverage |
| Thin test | LOW | assertion quality |

---

## New Types in `src/commands/coverage/types.ts`

```typescript
export type GapSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface CoverageGap {
  severity: GapSeverity;
  category: string;          // human-readable category name
  endpoint: string;          // "POST /api/users"
  detail: string;            // specific gap description
  file?: string;             // test file path (for thin tests, failing tests)
}
```

---

## Analyzer: `collectAllGaps()`

Add to `src/commands/coverage/analyzer.ts`:

```typescript
export function collectAllGaps(
  specEndpoints: SpecEndpoint[],
  responseCodeCoverage: EndpointResponseCodeCoverage[],
  paramCoverage: EndpointParameterCoverage[],
  bodyFieldCoverage: EndpointBodyFieldCoverage[],
  qualityScores: EndpointQualityScore[],
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const rcMap = new Map(responseCodeCoverage.map(r => [r.specKey, r]));
  const paramMap = new Map(paramCoverage.map(p => [p.specKey, p]));
  const bodyMap = new Map(bodyFieldCoverage.map(b => [b.specKey, b]));
  const qualMap = new Map(qualityScores.map(q => [q.specKey, q]));

  for (const ep of specEndpoints) {
    const specKey = `${ep.method} ${ep.path}`;

    // Uncovered endpoint
    if (ep.tests.length === 0) {
      gaps.push({ severity: 'CRITICAL', category: 'Uncovered endpoint', endpoint: specKey, detail: 'No tests target this endpoint' });
      continue; // no further gaps possible for uncovered endpoints
    }

    // Response code gaps
    const rc = rcMap.get(specKey);
    if (rc) {
      for (const code of rc.allCodes) {
        if (code.status === 'untested') {
          const is4xxOr5xx = code.code.startsWith('4') || code.code.startsWith('5');
          gaps.push({
            severity: is4xxOr5xx ? 'HIGH' : 'MEDIUM',
            category: 'Untested response code',
            endpoint: specKey,
            detail: `${code.code} is documented but no test declares this status`,
          });
        }
        if (code.status === 'undocumented') {
          gaps.push({ severity: 'HIGH', category: 'Spec drift', endpoint: specKey, detail: `${code.code} returned by API but not in spec` });
        }
        if (code.status === 'mismatch' && code.mismatchDetail) {
          gaps.push({ severity: 'HIGH', category: 'Test-vs-reality mismatch', endpoint: specKey, detail: code.mismatchDetail });
        }
      }
    }

    // Body field gaps
    const body = bodyMap.get(specKey);
    if (body) {
      for (const field of body.fields) {
        if (!field.tested) {
          gaps.push({
            severity: field.required ? 'HIGH' : 'MEDIUM',
            category: field.required ? 'Untested required body field' : 'Untested optional body field',
            endpoint: specKey,
            detail: `Field "${field.name}" is never sent in any test`,
          });
        }
      }
    }

    // Parameter gaps
    const params = paramMap.get(specKey);
    if (params) {
      for (const param of params.parameters) {
        if (!param.tested) {
          gaps.push({
            severity: 'MEDIUM',
            category: 'Untested parameter',
            endpoint: specKey,
            detail: `${param.in} param "${param.name}" is never exercised`,
          });
        }
      }
    }

    // Thin tests
    const qual = qualMap.get(specKey);
    if (qual) {
      for (const test of qual.tests) {
        if (test.isThin) {
          gaps.push({
            severity: 'LOW',
            category: 'Thin test',
            endpoint: specKey,
            detail: `"${test.testName}" has only a status check (score: ${test.rawScore})`,
            file: test.file,
          });
        }
      }
      // Failing tests (requires run data)
      for (const test of ep.tests) {
        if (test.runResult?.status === 'failed') {
          gaps.push({
            severity: 'HIGH',
            category: 'Failing test',
            endpoint: specKey,
            detail: `"${test.name}" failed in last run`,
            file: test.file,
          });
        }
      }
    }
  }

  // Sort: CRITICAL first, then HIGH, MEDIUM, LOW; within severity by endpoint
  const severityOrder: Record<GapSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  gaps.sort((a, b) => {
    const sd = severityOrder[a.severity] - severityOrder[b.severity];
    if (sd !== 0) return sd;
    return a.endpoint.localeCompare(b.endpoint);
  });

  return gaps;
}
```

---

## Acceptance Criteria

- [ ] `collectAllGaps()` is implemented in `src/commands/coverage/analyzer.ts` as specified.

- [ ] `CoverageGap` type is added to `src/commands/coverage/types.ts`.

- [ ] `CoverageArgs` gains `gaps?: boolean`.

- [ ] [`src/index.ts`](../../../src/index.ts) recognizes `--gaps` (sets `gaps: true`) and `--uncovered` (sets `gaps: true` as deprecated alias — no separate handling needed).

- [ ] `reporter/gaps.ts` (stub from Story 8b) is fully implemented with `renderGaps()`:

  ```
  Coverage Gaps — enigma API v1.2.3
  
  CRITICAL (3 gaps)
  ─────────────────────────────────────────────────────────────────────────────
  ● Uncovered endpoint    DELETE /api/graph/links/{id}
    No tests target this endpoint
  
  ● Uncovered endpoint    GET /api/code/search/symbols
    No tests target this endpoint
  
  HIGH (8 gaps)
  ─────────────────────────────────────────────────────────────────────────────
  ● Untested response code   POST /api/apikeys
    403 is documented but no test declares this status
  
  ● Spec drift               POST /api/users
    500 returned by API but not in spec
  
  MEDIUM (12 gaps)
  ─────────────────────────────────────────────────────────────────────────────
  ● Untested parameter       GET /api/graph/nodes
    query param "filter" is never exercised
  
  LOW (5 gaps)
  ─────────────────────────────────────────────────────────────────────────────
  ● Thin test                GET /api/graph/nodes
    "Get Graph Nodes" has only a status check (score: 1)
    tests/collections/graph/get-graph-nodes.yaml
  
  Total: 28 gaps  (3 critical, 8 high, 12 medium, 5 low)
  Tip: --detail to see full depth matrix  |  --last-run to add run data
  ```

- [ ] When `--gaps` is set, the normal endpoint list is NOT shown — only the gaps report. The summary header is still shown.

- [ ] When `--gaps` is set and there are zero gaps, print:
  ```
  No coverage gaps found. All endpoints covered, all response codes tested.
  ```
  And exit 0.

- [ ] **JSON reporter** — when `--gaps` is set, the JSON output gains a top-level `gaps` array:
  ```json
  {
    "summary": { ... },
    "gaps": [
      { "severity": "CRITICAL", "category": "Uncovered endpoint", "endpoint": "DELETE /api/graph/links/{id}", "detail": "No tests target this endpoint" }
    ]
  }
  ```

- [ ] `--gaps` is compatible with `--detail` (shows gaps report + detail matrix for covered endpoints), `--last-run` (adds run-data gaps), `--tag` (scopes to tag group), `--suite`, `--collection`.

---

## Notes for Implementer

- The `--uncovered` flag is kept as a silent alias for `--gaps` — it sets `gaps: true` in `CoverageArgs`. The tip line in the pretty reporter no longer mentions `--uncovered`; it mentions `--gaps` instead.
- Failing tests in the gaps report require `test.runResult` to be populated (Story 10). If no run data is present, no "Failing test" gaps appear — this is correct behavior.
- The gap count in the summary line (`Total: 28 gaps`) counts all gaps including LOW severity. This gives the most complete picture.
