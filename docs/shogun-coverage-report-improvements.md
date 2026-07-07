# Shogun Coverage Report Improvement Analysis

**Date:** 2026-07-03
**Agent:** ab-shield
**Context:** Improvement session analyzing shogun's coverage reporting capabilities

---

## 1. Current State of Coverage Reporting

### What `shogun coverage` currently reports

The coverage command produces a **flat endpoint-level matrix**:

| Field | Description |
|-------|-------------|
| `method` | HTTP method (GET, POST, PUT, DELETE) |
| `path` | Static path (e.g. `/api/apikeys/{id}`) |
| `tag` | OpenAPI spec tag (e.g. `ApiKeys`, `Users`) |
| `covered` | Boolean — at least 1 test targets this endpoint |
| `tests[]` | List of test objects that match this endpoint |

Each test object contains:
- `name` — test name
- `file` — relative path to YAML
- `collection` — collection name
- `staticPath` — the path with resolved variables (e.g. `/api/apikeys/00000000-0000-4000-8000-000000000000`)
- `tags` — test-level tags (e.g. `crud`, `guard`, `readonly`)

### Summary stats:
- `totalEndpoints` (65)
- `coveredEndpoints` (65)
- `uncoveredEndpoints` (0)
- `totalTests` (410)
- `collections` (29)
- `coveragePct` (100%)

### What it looks like (text mode):
```
Coverage Report — AfterBurner API vv1
  Spec endpoints:  65
  Tests scanned:   410  (29 collections)
  Covered:         65  (100%)
  Uncovered:       0
```
Then a flat list of every endpoint with its test count and collection names.

---

## 2. Data Available But NOT Surfaced by Coverage

### 2.1 From the OpenAPI Spec (available via `shogun spec --endpoint`)

The spec contains rich per-endpoint detail that the coverage report ignores entirely:

| Data Point | Available? | Used in Coverage? | Impact |
|-----------|-----------|-------------------|--------|
| **Documented response status codes** (200, 201, 400, 403, 404, 503, etc.) | ✅ Yes | ❌ No | Cannot see if 403 on an endpoint is tested |
| **Query parameters** (name, type, required) | ✅ Yes | ❌ No | Cannot see if `?page=-1` validation is tested |
| **Path parameters** (name, type) | ✅ Yes | ❌ No | Cannot see if invalid UUID format is tested |
| **Request body schema** (field names, types, required/nullable) | ✅ Yes | ❌ No | Cannot see if each body field is tested |
| **Response body schema** (if spec defines one) | ✅ Sometimes | ❌ No | Cannot see if response shape is verified |
| **Endpoint summary/description** | ✅ Yes (mostly empty) | ❌ No | Minor |
| **Content-Type** for request bodies | ✅ Yes | ❌ No | Cannot see if Content-Type validation is tested |

**Concrete example of the gap:**
- `GET /health` documents response `503` (service unhealthy) — **zero tests exercise 503**
- `POST /api/users` documents `403 Forbidden` and `404 Not Found` — coverage says "21 tests, covered ✓" but doesn't reveal whether 403 and 404 paths are tested
- `PUT /api/llm-provider-configs/{id}` documents `204, 400, 403, 404` — we have 7 tests but can't see which codes are hit

### 2.2 From Test YAML Files (the test source)

Each test YAML has structural data not surfaced:

| Data Point | Available? | Used in Coverage? |
|-----------|-----------|-------------------|
| `response.status` — the expected HTTP status asserted | ✅ Yes (376/410 tests) | ❌ No |
| `response.shape[]` — JSONPath shape assertions | ✅ Yes (58/410 tests) | ❌ No |
| `response.snapshot` — whether snapshot comparison is enabled | ✅ Yes (2/410 tests) | ❌ No |
| `request.body` — whether the test sends a request body | ✅ Yes (40/410 tests) | ❌ No |
| `request.headers` — custom headers sent | ✅ Yes (186/410 tests) | ❌ No |
| `pre:` script presence | ✅ Yes (301/410 tests) | ❌ No |
| `post:` script presence | ✅ Yes (410/410 tests) | ❌ No |
| Test `description:` (human-readable test intent) | ✅ Yes | ❌ No |

### 2.3 From Run Results (run.json per test execution)

Each test run captures execution data not surfaced by coverage:

| Data Point | Available? | Used in Coverage? |
|-----------|-----------|-------------------|
| `httpStatus` — actual HTTP status returned | ✅ Yes | ❌ No |
| `durationMs` — execution time | ✅ Yes | ❌ No |
| `timings` — breakdown (curlMs, assertMs, preMs, postMs) | ✅ Yes | ❌ No |
| `assertions.status` — whether status assertion passed | ✅ Yes | ❌ No |
| `assertions.shape[]` — individual shape expression results | ✅ Yes | ❌ No |
| `assertions.snapshot` — snapshot comparison result | ✅ Yes | ❌ No |
| `assertions.postScript` — post-script assertion result | ✅ Yes | ❌ No |
| `scriptOutput[]` — log lines from the test | ✅ Yes | ❌ No |

### 2.4 From Collection Files (_collection.yaml)

| Data Point | Available? | Used in Coverage? |
|-----------|-----------|-------------------|
| Collection `order` — test execution sequence | ✅ Yes | ❌ No |
| Collection `setup:` / `teardown:` scripts | ✅ Yes | ❌ No |
| Collection-level `tags` | ✅ Yes | ❌ No (only test-level tags surfaced) |
| Collection `description` | ✅ Yes | ❌ No |

---

## 3. Gap Analysis: What the Current 100% Coverage Hides

### 3.1 "100% Covered" is endpoint-presence-only coverage

The current metric is: **"at least one test sends a request to this endpoint."** This is the thinnest possible coverage definition. It's like saying "we called this function once" — it says nothing about:

- Which response codes were exercised
- Which error paths were tested
- Which query parameters were tested
- Which request body fields were validated
- Whether the response shape was verified
- Whether the test actually asserts anything meaningful

### 3.2 Concrete blind spots in our current 100% suite

| Blind Spot | Example | Risk |
|-----------|---------|------|
| **Response code gaps** | `GET /health` documents 503 — no test hits it | Health degradation undetected |
| **Parameter coverage gaps** | `GET /api/tokenmetrics` has 9 query params — coverage doesn't show which are tested | Missing filter validation bugs |
| **Body field coverage gaps** | `POST /api/users` has 6 body fields (3 required) — coverage says "21 tests" but doesn't show field-level coverage | Missing required-field validation bugs |
| **Shape assertion coverage** | Only 58/410 tests have shape assertions — 352 tests don't verify response structure | Response shape regressions undetected |
| **Snapshot coverage** | Only 2/410 tests use snapshots | Response drift undetected |
| **Test quality (assertion density)** | One test with 13 shape checks + 15 post-script asserts is treated the same as one test with a single status check | False confidence in thin tests |

---

## 4. Recommended Coverage Report Improvements

### Tier 1: High-Value, Data Already Exists

These improvements use data that shogun already has access to (spec + test YAML + run results) but doesn't surface:

#### 4.1 Response Code Coverage Matrix
**What:** For each endpoint, show documented response codes vs. codes actually exercised by tests.

```
POST /api/users                    Documented: 201, 400, 403, 404
  ✅ 201  — 5 tests (users-create-happy-path, ...)
  ✅ 400  — 8 tests (users-create-no-email, users-create-empty-body, ...)
  ✅ 403  — 1 test (users-create-non-superadmin)
  ⬜ 404  — 0 tests  ← GAP
```

**Source:** `shogun spec --endpoint` (documented codes) + `response.status` in test YAML (expected codes) + run.json `httpStatus` (actual codes).

**Why it matters:** This is the single most valuable addition. Right now "covered" means "at least 1 test hit this path." Response code coverage tells you whether error paths are tested.

#### 4.2 Parameter Coverage
**What:** For endpoints with query/path parameters, show which parameters have at least one test exercising them.

```
GET /api/tokenmetrics               9 query params
  ✅ page        — 2 tests (pagination, negative-page)
  ✅ pageSize    — 2 tests
  ✅ providers   — 3 tests (filter, invalid-provider, summary)
  ⬜ workflows   — 0 tests  ← GAP
  ⬜ models      — 0 tests  ← GAP
  ⬜ startDate   — 0 tests  ← GAP
  ...
```

**Source:** `shogun spec --endpoint` (parameter definitions) + test YAML `request.path` (query string) or `pre:` script (dynamic params).

**Why it matters:** Many API bugs are in parameter validation. An endpoint can have 6 tests but zero tests for 7 of its 9 query parameters.

#### 4.3 Request Body Field Coverage
**What:** For POST/PUT endpoints with request body schemas, show which body fields are exercised by tests.

```
POST /api/users                    6 body fields (3 required)
  ✅ firstName       — 15 tests
  ✅ lastName        — 15 tests
  ✅ email           — 18 tests
  ✅ role            — 5 tests
  ✅ organizationId  — 12 tests
  ⬜ sendInvitation  — 0 tests  ← GAP (optional field untested)
```

**Source:** `shogun spec --endpoint` (request body schema) + test YAML `request.body` or `pre:` script (actual body sent).

**Why it matters:** Optional fields and their defaults are a common source of bugs. Required-field validation is testable per-field.

#### 4.4 Assertion Quality Metrics
**What:** For each endpoint, show the breakdown of assertion types used:

```
POST /api/apikeys (15 tests)
  Status assertions:   15/15 (100%)
  Shape assertions:     3/15  (20%)  ← Only 3 tests verify response structure
  PostScript asserts:  15/15 (100%)
  Snapshot:            0/15  (0%)
  Avg assertions/test: 8.2
```

**Source:** Test YAML (`response.status`, `response.shape`, `response.snapshot`, `post:` presence) + run.json assertion results.

**Why it matters:** A test that only asserts `status == 201` is weak. Coverage should surface assertion density so reviewers can spot thin tests.

#### 4.5 Test-by-HTTP-Status Breakdown
**What:** Show which HTTP status codes the tests actually exercise (from run results).

```
HTTP Status Code Distribution (across 410 tests):
  200: 133 tests
  201:  13 tests
  400:  95 tests   ← strong negative testing
  401:  80 tests   ← strong auth guard coverage
  403:   7 tests
  404:  30 tests
  405:  24 tests   ← method guard coverage
  415:   3 tests   ← content-type validation
  503:   0 tests   ← GAP (health unhealthy path)
```

**Source:** run.json `httpStatus` per test result.

**Why it matters:** Immediately reveals if certain error codes are untested. Currently this data exists only in run.json and requires manual analysis.

---

### Tier 2: Medium-Value, Requires Cross-Referencing

#### 4.6 Spec-Documented vs. Test-Asserted Response Code Reconciliation
**What:** For each endpoint, compare the response codes documented in the OpenAPI spec against the response codes the tests actually assert/expect.

```
POST /api/apikeys                  Spec: 201, 400    Tested: 201, 400  ✅ aligned
GET /api/apikeys/{id}             Spec: 200, 404    Tested: 200, 404  ✅ aligned
GET /health                       Spec: 200, 503    Tested: 200        ⚠️ 503 not tested
```

**Source:** `shogun spec --endpoint` (documented responses) + test YAML `response.status` (asserted codes).

**Why it matters:** Surfaces gaps between what the API documentation promises and what the test suite verifies.

#### 4.7 Per-Tag Coverage Summary
**What:** Group the coverage by OpenAPI spec tag and show per-group stats.

```
Auth (10 endpoints, 34 tests)     100% endpoint coverage, avg 3.4 tests/endpoint
Users (6 endpoints, 65 tests)     100% endpoint coverage, avg 10.8 tests/endpoint
TokenMetrics (7 endpoints, 23 tests) 100% endpoint coverage, avg 3.3 tests/endpoint
```

**Source:** Already available in the data (endpoint `tag` field + test count).

**Why it matters:** Quickly identifies which API domains are thinly tested vs. heavily tested. The flat list makes this hard to see.

#### 4.8 Test Tags Distribution Matrix
**What:** Show how test-level tags (crud, guard, readonly, smoke, validation, behaviors) map to endpoints.

```
                    crud  guard  validation  behaviors  readonly  smoke
POST /api/users      ✅    ✅      ✅          -          ✅        ✅
POST /api/apikeys    ✅    ✅      ✅          -          ✅        ✅
GET /api/udm/summary  -    ✅      -           ✅         ✅        ✅
```

**Source:** Already in coverage JSON (test `tags[]`).

**Why it matters:** Reveals if an endpoint has guard coverage but no CRUD coverage, or validation coverage but no behavior coverage.

#### 4.9 Collection Dependency Graph
**What:** Show which collections share `ctx.vars` dependencies (test A in collection X stashes a var consumed by test B in collection Y).

**Source:** Collection `_collection.yaml` `order:` + test `pre:`/`post:` scripts that read/write `ctx.vars`.

**Why it matters:** If collection A is removed or re-ordered, tests in collection B may break. This is invisible in the current coverage report.

---

### Tier 3: Nice-to-Have, Requires New Data Collection

#### 4.10 Response Schema Field Coverage
**What:** For endpoints where the spec defines a response schema, show which response body fields are verified by shape assertions.

```
POST /api/apikeys Response: ApiKeyResponse (12 fields)
  ✅ id          — shape asserted in 3 tests
  ✅ name        — shape asserted in 3 tests
  ✅ apiKey      — shape asserted in 1 test
  ⬜ keyPrefix   — 0 tests assert shape  ← but postScript checks it
  ...
```

**Source:** `shogun spec --schema` (response schema) + test YAML `response.shape[]` expressions.

**Why it matters:** Shape assertions are the structural contract. Knowing which fields have shape checks vs. only postScript checks reveals where response structure drift would be caught.

#### 4.11 Historical Pass/Fail Trend
**What:** Show pass/fail trends across recent runs per endpoint.

```
POST /api/users (last 5 runs):
  Run 1: 21/21 pass ✅
  Run 2: 21/21 pass ✅
  Run 3: 20/21 pass ❌ (users-create-happy-path failed — 500 instead of 201)
  Run 4: 21/21 pass ✅
  Run 5: 21/21 pass ✅
```

**Source:** Multiple run.json files in `runs/` directory.

**Why it matters:** Identifies flaky endpoints and regression patterns over time.

#### 4.12 Performance Metrics per Endpoint
**What:** Show avg/p95 response times per endpoint from run data.

```
POST /v1/traces     avg: 2340ms  p95: 4500ms  ⚠️ slowest endpoint
GET /health         avg:  550ms  p95:  980ms
GET /api/apikeys    avg: 1010ms  p95: 1800ms
```

**Source:** run.json `timings.curlMs` per test.

**Why it matters:** Performance regressions are a quality issue. Coverage could surface slow endpoints.

#### 4.13 Test Isolation Risk Score
**What:** Flag tests that depend on `ctx.vars` from other tests (non-isolated).

```
⚠️ apikeys-get-by-id depends on ctx.vars.createdKeyId (from apikeys-create-happy-path)
⚠️ apikeys-delete-happy-path depends on ctx.vars.createdKeyId (from apikeys-create-happy-path)
✓ apikeys-list-empty — isolated (no var dependencies)
```

**Source:** Analysis of `pre:`/`post:` scripts for `ctx.vars.*` reads.

**Why it matters:** Non-isolated tests fail in cascade when a dependency fails, producing misleading results.

---

## 5. Structural/Format Improvements

### 5.1 Grouped Output (by spec tag)
The current flat list of 65 endpoints is hard to scan. Grouping by spec tag (Auth, Users, ApiKeys, etc.) with subtotals would be more readable.

### 5.2 `--detail` Flag
A flag that adds the Tier 1 data (response codes, parameters, body fields, assertion metrics) to the default report. The base report stays compact; `--detail` shows the full matrix.

### 5.3 `--last-run` Flag
Incorporate run.json data (actual HTTP statuses hit, pass/fail, durations) into the coverage report. Currently coverage is static (test YAML only) — it doesn't know what actually happened in the last run.

### 5.4 `--compare <run1> <run2>` Flag
Show coverage changes between two runs (new tests added, tests removed, new endpoints covered, regression in coverage).

### 5.5 Markdown Format
The `--format markdown` tip is mentioned but the output seems to be plain text. A proper markdown table format would be useful for embedding in PRs, docs, and notes.

### 5.6 JSON Output Truncation Fix
The JSON output for a large test suite (410 tests) was truncated at ~134KB, producing invalid JSON. This needs to be handled — either streaming, pagination, or a higher buffer limit.

---

## 6. Summary: Priority-Ordered Improvement Requests

| Priority | Improvement | Data Source | Effort | Value |
|----------|------------|------------|--------|-------|
| **P0** | Response Code Coverage Matrix | spec + test YAML + run.json | Medium | 🔴 Critical — reveals untested error paths |
| **P0** | Assertion Quality Metrics | test YAML + run.json | Low | 🔴 Critical — surfaces thin tests |
| **P1** | Parameter Coverage | spec + test YAML | Medium | 🟠 High — reveals untested query/path params |
| **P1** | Request Body Field Coverage | spec + test YAML | Medium | 🟠 High — reveals untested body fields |
| **P1** | Per-Tag Grouped Output | existing data | Low | 🟠 High — readability |
| **P2** | `--detail` flag | all of the above | Low | 🟡 Medium — UX |
| **P2** | `--last-run` integration | run.json | Medium | 🟡 Medium — bridges static/dynamic gap |
| **P2** | Test Tag Distribution Matrix | existing data | Low | 🟡 Medium — quality view |
| **P2** | JSON truncation fix | output handling | Low | 🟡 Medium — scripting reliability |
| **P3** | Response Schema Field Coverage | spec + test YAML | High | 🟢 Nice-to-have |
| **P3** | Historical Trend | multiple run.json | High | 🟢 Nice-to-have |
| **P3** | Performance Metrics | run.json | Medium | 🟢 Nice-to-have |
| **P3** | Test Isolation Risk Score | test YAML scripts | High | 🟢 Nice-to-have |
| **P3** | `--compare` runs | multiple run.json | High | 🟢 Nice-to-have |
| **P3** | Markdown format | output handling | Low | 🟢 Nice-to-have |

---

## 7. Key Insight: "100% Coverage" is Misleading Without Depth

The current report says **100% coverage, 65/65 endpoints, 410 tests** — which sounds excellent. But this analysis reveals:

- **503 on `/health` is documented but untested** (0 tests)
- **352 of 410 tests have no shape assertions** (85% of tests don't verify response structure)
- **408 of 410 tests have no snapshot comparison** (99.5% don't catch response drift)
- **9 query parameters on `/api/tokenmetrics`** — coverage doesn't show which are tested
- **Optional body fields** like `sendInvitation` on `POST /api/users` — coverage doesn't show if tested

The coverage metric should evolve from **"did we touch this endpoint?"** to **"did we exercise this endpoint's documented contract?"**
