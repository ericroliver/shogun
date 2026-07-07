# Shogun Coverage v2 — Dev Proposal Review & Feedback

**Date:** 2026-07-03
**Agent:** ab-shield
**Context:** Review of the shogun dev team's proposed coverage v2 enhancement plan
**Related:** `shogun-coverage-improvement-analysis.md` (original gap analysis)

---

## TSAP Codification: `--last-run` Default Suite

**Verdict: Yes, implement — via config, not hardcode.**

### Problem
Typical workflow: run full `tsap` suite (409 tests) → a test fails → run a single collection to debug (e.g., 15 tests) → `--last-run` now picks up the debug run, not the full suite. Coverage against a partial run is actively misleading.

### Recommended Approach
Config-driven in `shogun.config.yaml`:

```yaml
coverage:
  defaultSuite: tsap    # when --last-run is used without --suite, filter to this suite's runs
```

- `shogun coverage --last-run` → loads latest run where `suite == "tsap"`
- `shogun coverage --last-run --suite smoke` → overrides to smoke
- `shogun coverage --last-run --suite any` → truly latest run regardless of suite
- No `defaultSuite` configured → fall back to truly latest run (current behavior)

This keeps it general (not ab-shield-specific) while solving the problem for any team with a primary full suite.

### Applies to `--compare` too
Comparing a tsap run against a debug run produces noise. The `defaultSuite` config should apply to both `--last-run` and `--compare` resolution. When `--compare` is given without explicit run IDs, default to "last two runs of defaultSuite."

### Error handling
When `--last-run` is used but no run exists for the resolved suite, print a clear message:
> *"No tsap run found. Run `shogun run --suite tsap` first, or use `--suite <name>` to target a different suite."*

Do NOT silently fall back to static-only. Silent fallback hides the problem and produces a misleading report.

---

## Dimension-by-Dimension Feedback

### Dimension 1: Endpoint Coverage (refined) ✅
No concerns. Keeping it as the baseline is correct.

---

### Dimension 2: Response Code Coverage ✅✅ (highest value)

The three-layer model is excellent:
- **Spec-declared** → what the API promises
- **Test-declared** (`response.status`) → what tests expect
- **Run-actual** (`httpStatus`) → what the API returned

**Suggestion: Surface undocumented actual codes inline in the matrix, not just in a separate drift section.**

```
POST /api/users        Spec: 201, 400, 403, 404
  Declared:  201 ✓  400 ✓  403 ✓  404 ✗
  Actual:    201 ✓  400 ✓  403 ✓  —
  Drift:     none
```

vs.

```
POST /api/users        Spec: 201, 400, 403, 404
  Declared:  201 ✓  400 ✓  403 ✓  404 ✗
  Actual:    201 ✓  500 ⚠️  403 ✓  —       ← 500 not in spec!
  Drift:     500 returned but not documented
```

This ties into the Spec Drift Detection (section 5.5), but it should be visible in the response code matrix itself. A reviewer scanning the matrix should see drift immediately, not need to cross-reference a separate section.

Also detect **test-vs-reality mismatches** — test expects 400 but API returned 200. This isn't spec drift (both codes are documented), it's a test failure that indicates the API behavior diverged from the test's expectation.

---

### Dimension 3: Parameter Coverage ✅

The heuristic for `ctx.request.params[...]` in pre-scripts is pragmatic. Flagging as "inferred" is the right call since it's not 100% reliable.

**Suggestion:** For path parameters (like `{id}` in `/api/apikeys/{id}`), consider distinguishing:
- **Format coverage** — tested with valid UUID? Invalid UUID? Non-existent UUID?
- **Presence coverage** — tested with the parameter omitted? (edge case for optional path params)

This may be scope creep — the basic "was this parameter exercised at all" is the 80/20.

---

### Dimension 4: Request Body Field Coverage ✅

The three-source approach (inline body, fixture file, pre-script assignment) is thorough.

**Suggestion:** Track **field value diversity** — if `role` is always set to `"Admin"` across all tests, we're not testing `"User"` or `"SuperAdmin"` values. This is where real bugs hide. A simple version: show distinct values used per field. Harder to implement, may be a later iteration.

---

### Dimension 5: Assertion Quality Score ✅ (with reservations)

The weighted scoring is a good first pass. Concerns:

1. **Pre-script weight (0.5) is misplaced.** A pre-script that sets up a UUID isn't an assertion — it's test infrastructure. It inflates the score of tests that do setup work without actually asserting more. Drop it from the quality score, or rename the dimension to "Test Complexity Score" if it's meant to capture overall test depth.

2. **What do shape assertions actually check?** A test with `shape: ["$.id"]` scores the same as a test with `shape: ["$.id", "$.name", "$.apiKey", "$.keyPrefix", "$.createdAt", "$.scopes[0].name"]`. Both count as "1 shape assertion" but the second is 6× more thorough. If the weight is per-shape-entry (not per-test-with-shape), then `2 × count` addresses this. Just confirm the implementation counts entries, not tests-with-shape.

3. **Normalize to a 0–100 scale per endpoint**, not per test. A per-endpoint score combining all tests gives a more actionable "this endpoint's tests are thin" signal than individual test scores.

4. **Consider a "thin test" flag** — any test scoring ≤ 1 (status-only, no shape, no post-script asserts) gets flagged. More actionable than a raw number.

---

## `--last-run` Integration

**Strongly support elevating this above P2.** It's the bridge that makes dimensions 2 and 5 meaningful. Without run data, response code coverage only shows *what tests expect*, not *what the API actually returns*.

The opt-in design is correct — the default coverage report should remain static-only (no HTTP, read-only) for CI gate usage.

---

## Intelligence Layer Feedback

### 5.1 Coverage Risk Score ✅✅
This is the killer feature. Prioritizing gaps by risk is exactly what a QA lead needs.

**Suggestion:** Make the weighting configurable so teams can tune what "risk" means for their context. For us, response code gaps and failing tests should weigh heavier than body field gaps.

### 5.2 Test Dependency Graph ✅
Excellent for identifying cascade risks.

**Concern:** Heuristic script scanning will have false positives — a string like `"ctx.vars.foo"` in a log message would be picked up. Consider requiring assignment syntax (`ctx.vars.foo = ...` for writes) and read syntax (`ctx.vars.foo` not preceded by `=`) for reads. Still heuristic, but more precise.

### 5.3 Negative Testing Coverage ✅
Simple, high-value. The 2xx/4xx/5xx ratio is immediately actionable.

**Suggestion:** Also show the ratio **per endpoint** — an endpoint with only 2xx tests has a different risk profile than one with a 2xx/4xx mix, regardless of the overall suite ratio.

### 5.4 Test Tag Intelligence ✅
The method-based expected tag coverage is clever (POST should have validation, GET should have readonly).

**Suggestion:** Make the expected-tag-per-method mapping configurable. Our tag taxonomy (`crud`, `guard`, `validation`, `behaviors`, `readonly`, `smoke`) may differ from other teams'. A default mapping with override capability would be ideal.

### 5.5 Spec Drift Detection ✅✅
Favorite intelligence feature. Catching undocumented response codes is a legitimate API defect signal — exactly what ab-shield exists to find.

**Suggestion:** Also detect **status code mismatches** — test expects 400, API returned 200. This isn't spec drift (the code is documented), it's a test-vs-reality drift. Both should be surfaced.

---

## Structural/UX Improvements

All solid. Quick notes:

| Feature | Feedback |
|---------|----------|
| `--gaps` (replaces `--uncovered`) | ✅ Strongly support. Multi-dimensional gap view is far more useful than just uncovered endpoints. |
| `--min-coverage` | ✅ Essential for CI. **Suggestion:** Support per-dimension thresholds (e.g., `--min-endpoint-coverage 100 --min-response-code-coverage 80`) rather than a single number. |
| `--out` + JSON truncation fix | ✅ Critical. The truncation bug at ~134KB made JSON format unusable for programmatic analysis. `--out` with file-based writing (no stdout buffer) solves this completely. |
| Grouped output by tag | ✅ Huge readability win. Our 65-endpoint flat list is hard to scan. |
| `--detail` progressive disclosure | ✅ Good UX. Base stays compact, detail adds the matrix. |
| `--compare` | ✅ Valuable for regression tracking. Ensure `defaultSuite` config applies. |

---

## Summary: Key Feedback Points

| Area | Feedback |
|------|----------|
| **TSAP default** | Implement via `coverage.defaultSuite` config in `shogun.config.yaml`, not hardcoded. Apply to `--last-run` and `--compare`. Clear error when no run found. |
| **Assertion quality** | Drop pre-script weight (it's not an assertion). Consider per-endpoint normalization and a "thin test" flag for tests scoring ≤ 1. |
| **Response code matrix** | Surface undocumented actual codes inline in the matrix, not just in a separate drift section. Also detect test-vs-reality mismatches. |
| **Risk score** | Make weightings configurable per team. |
| **Tag intelligence** | Make method→expected-tags mapping configurable with defaults. |
| **`--min-coverage`** | Support per-dimension thresholds, not a single number. |
| **Missing run message** | Don't silently fall back to static-only when `--last-run` finds nothing. Print a clear actionable message. |
| **Dependency graph** | Require assignment/read syntax for heuristic scanning to reduce false positives. |
| **Negative testing** | Show ratio per endpoint, not just suite-wide. |
| **Body field coverage** | Consider tracking field value diversity in a future iteration. |

---

## Overall Assessment

The dev team's proposal is excellent — it addresses essentially every gap identified in the original analysis and goes further with the intelligence layer. The five-dimension model transforms coverage from a binary "did we touch this?" into a multi-faceted quality assessment. The `--last-run` bridge is correctly identified as transformative. The risk score and spec drift detection are the standout features that differentiate shogun from every other coverage tool.

The main feedback is about **configurability** (risk weights, tag mappings, default suite, min-coverage thresholds) — making the tool adaptable to different team workflows rather than encoding one team's assumptions. And a few precision improvements on the heuristics (assertion quality weighting, dependency graph scanning).
