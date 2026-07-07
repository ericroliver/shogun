# Shogun Testing Journal

> Tips, tricks, patterns, and hard-won lessons for writing shogun tests.
> Add to this as you discover things — don't let the knowledge die in Slack or a terminal window.

---

## Table of Contents

1. [Auth Wiring](#1-auth-wiring)
2. [Variable Stashing (the create→read→delete chain)](#2-variable-stashing-the-createreaddelete-chain)
3. [Snapshot Policy](#3-snapshot-policy)
4. [Write Test Shape Assertions](#4-write-test-shape-assertions)
5. [Teardown as Safety Net](#5-teardown-as-safety-net)
6. [Test Data Uniqueness](#6-test-data-uniqueness)
7. [Workspace Loading](#7-workspace-loading)
8. [URL Path Encoding Gotcha](#8-url-path-encoding-gotcha)
9. [Status Code Surprises](#9-status-code-surprises)
10. [jq Shape Assertion Tips](#10-jq-shape-assertion-tips)
11. [Debugging Failed Runs](#11-debugging-failed-runs)
12. [Collection Order Matters](#12-collection-order-matters)
13. [ctx.http vs curl](#13-ctxhttp-vs-curl)
14. [Testing Plans as Living Docs](#14-testing-plans-as-living-docs)
15. [Tests Must Surface Bugs, Not Hide Them](#15-tests-must-surface-bugs-not-hide-them)
16. [Unauthenticated Guard Tests](#16-unauthenticated-guard-tests)

---

## 1. Auth Wiring

**Never wire auth per-test.** Do it once in collection `setup` and stash the resolved header in `ctx.vars`:

```javascript
// _collection.yaml setup:
const raw = (ctx.env.AUTH_TOKEN ?? '').trim();
if (raw) {
  ctx.vars.authHeader = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  ctx.log(`Auth token loaded (${ctx.vars.authHeader.length} chars)`);
} else {
  ctx.vars.authHeader = null;
  ctx.log('AUTH_TOKEN not set — running unauthenticated');
}
```

Then in every test's `pre`:

```javascript
if (ctx.vars.authHeader) {
  ctx.request.headers['Authorization'] = ctx.vars.authHeader;
}
```

**Why:** If the token format changes (e.g. bare token vs. `Bearer` prefix), you fix it in one place.

**Why the null guard:** `ctx.http.*` calls inside setup/teardown also need the auth header. Build it once, use everywhere.

---

## 2. Variable Stashing (the create→read→delete chain)

CRUD test chains work by stashing created resource identifiers in `ctx.vars` and consuming them downstream.

### Pattern

```javascript
// post-script of CREATE test:
const body = ctx.response.body as any;
ctx.vars.createdNodePathA = body.path ?? ctx.vars.testNodePathA;
ctx.log(`Node A created — path: ${ctx.vars.createdNodePathA}`);

// pre-script of READ / DELETE test:
const path = ctx.vars.createdNodePathA as string;
ctx.assert(!!path, 'createdNodePathA is not set — create test must have run and succeeded first');
ctx.request.path = `/api/graph/nodes/${path}`;
```

### Important: initialize vars to null in setup

Always initialize your expected vars in `setup` so downstream tests don't accidentally consume stale values from a previous run:

```javascript
// _collection.yaml setup:
ctx.vars.createdNodePathA = null;
ctx.vars.createdNodePathB = null;
ctx.vars.createdLinkId    = null;
```

### Important: clear vars on successful delete

When a delete test succeeds, clear the var so teardown knows it doesn't need to clean up:

```javascript
// post-script of DELETE test:
ctx.assert(ctx.response.status === 200, `Expected 200 on delete, got ${ctx.response.status}`);
ctx.vars.createdNodePathA = null;  // ← prevents teardown from double-deleting
ctx.log('Node A deleted and var cleared');
```

---

## 3. Snapshot Policy

The rule is simple:

| Method | `snapshot` |
|--------|-----------|
| GET | `true` |
| POST / PUT / PATCH / DELETE | `false` |

**Why write tests don't snapshot:** Response bodies from write operations contain volatile data (IDs, timestamps, auto-generated paths). The snapshot would fail on every run.

**ignore_fields for GET snapshots:** Even read endpoints often include timestamps. Always check the actual response and strip the volatile fields:

```yaml
response:
  snapshot: true
  ignore_fields:
    - "**.createdAt"
    - "**.updatedAt"
    - "**.timestamp"
    - "**.requestId"
```

**When baseline doesn't exist yet:** The test is marked `needs_baseline` — not a failure. Run `shogun snapshot` to capture it, commit the `expected/` file, then subsequent runs will diff against it.

---

## 4. Write Test Shape Assertions

Since write tests don't snapshot, shape assertions are your only structural verification. Make them meaningful:

```yaml
# Good — verifies the response has the expected fields
shape:
  - 'has("path")'
  - 'has("contentType")'
  - 'has("persist")'

# For create responses that may or may not return an id vs path:
shape:
  - '(has("path") or has("id"))'
  - '(has("type") or has("label") or has("contentType"))'
```

**Tip:** If you don't know the exact shape yet, probe the endpoint with curl first, inspect the response, then write assertions.

```bash
curl -s -X POST "${BASE_URL}/api/graph/nodes" \
  -H "Content-Type: application/json" \
  -d '{"path":"probe/test","contentType":"text/plain","content":"test","persist":"file"}' | jq .
```

---

## 5. Teardown as Safety Net

Teardown exists to clean up test data even if mid-suite tests fail. Write it defensively:

```javascript
// _collection.yaml teardown:
const headers = {};
if (ctx.vars.authHeader) headers['Authorization'] = ctx.vars.authHeader;

if (ctx.vars.createdNodePathA) {
  ctx.log(`Teardown: deleting node A "${ctx.vars.createdNodePathA}"`);
  try {
    const res = await ctx.http.delete(`/api/graph/nodes/${ctx.vars.createdNodePathA}`, { headers });
    ctx.log(`Node A delete response: ${res.status}`);
  } catch (err) {
    ctx.log(`Teardown node A delete failed (non-fatal): ${err.message}`);
  }
} else {
  ctx.log('No node A to clean up');
}
```

Key principles:
- Always wrap teardown HTTP calls in `try/catch` — teardown errors must not mask test failures
- Check `if (ctx.vars.X)` before attempting delete — if the var was cleared by a successful delete test, don't double-delete
- Log what teardown does so you can trace cleanup in run logs

---

## 6. Test Data Uniqueness

Any test data your suite creates should use a timestamp-based unique key. This prevents:
- Collisions between repeated runs (e.g., leftover data from a previous failed run)
- Collisions between parallel runs (e.g., CI running two environments simultaneously)

```javascript
// _collection.yaml setup:
const ts = Date.now();
ctx.vars.testNodePathA = `shogun-test/node-a-${ts}`;
ctx.vars.testNodePathB = `shogun-test/node-b-${ts}`;
```

**Namespace your test data.** Use a consistent prefix like `shogun-test/` so you can identify and manually purge test data if needed.

---

## 7. Workspace Loading

For APIs that require a workspace context, load it in collection `setup` — not per-test:

```javascript
// _collection.yaml setup:
const wsName = (ctx.env.WORKSPACE_NAME ?? '').trim();
if (wsName) {
  const headers = { 'Content-Type': 'application/json' };
  if (ctx.vars.authHeader) headers['Authorization'] = ctx.vars.authHeader;
  const res = await ctx.http.post(`/api/workspace/load/${wsName}`, null, { headers });
  if (res.status === 200) {
    ctx.log(`Workspace "${wsName}" loaded successfully`);
  } else {
    ctx.log(`WARNING: Workspace load returned ${res.status} — data may not resolve correctly`);
  }
  ctx.vars.workspaceName = wsName;
}
```

**Why `null` body for POST with no body:** `ctx.http.post(path, null, opts)` — pass `null` as the body if the endpoint takes no request body. Passing `{}` may cause issues on some APIs.

---

## 8. URL Path Encoding Gotcha

### Don't encode path separators

If the API uses real path segments as resource identifiers (e.g., `shogun-test/node-a-123`), do **not** `encodeURIComponent` the full thing — that would encode the `/` and break the route:

```javascript
// ✅ Correct — real slashes preserved
ctx.request.path = `/api/graph/nodes/${ctx.vars.createdNodePathA}`;

// ❌ Wrong — encodes '/' as '%2F', API returns 404
ctx.request.path = `/api/graph/nodes/${encodeURIComponent(ctx.vars.createdNodePathA)}`;
```

**Lesson learned from the graph API:** the node path `shogun-test/node-a-123` is used as-is in the URL, e.g. `GET /api/graph/nodes/shogun-test/node-a-123`.

---

## 9. Status Code Surprises

APIs don't always follow REST conventions. Document quirks in testing plans and collection descriptions — never silently swallow unexpected codes.

Known surprises in the local-dev-test-repo target API:

| Endpoint | Expected | Actual | Notes |
|----------|---------|--------|-------|
| `POST /api/graph/nodes` | 201 | **200** | Returns 200 on successful creation |
| `DELETE /api/graph/links/{id}` | 200 | **405** | Links cannot be deleted via API |
| `PATCH /api/graph/nodes/{path}` | 200 or 204 | **200** | Returns updated object |

**Pattern for tests that accept multiple valid codes:**

```javascript
// post-script:
const s = ctx.response.status;
ctx.assert(s === 200 || s === 201, `Expected 200 or 201 on node create, got ${s}`);
```

**For known 405s (delete that can't delete):**

```yaml
response:
  status: 405
  snapshot: false
```

---

## 10. jq Shape Assertion Tips

Shape assertions use `jq` boolean expressions. A few patterns:

```yaml
shape:
  # Check top-level key exists
  - 'has("agents")'

  # Check value type
  - '.agents | type == "array"'

  # Conditional — only assert on non-empty arrays
  - 'if (.agents | length) > 0 then .agents[0] | has("id") else true end'

  # Check response is an object (not null, not array)
  - 'type == "object"'

  # Multiple field alternatives (API may use different field names)
  - '(has("sourcePath") or has("source") or has("from"))'
```

**Tip:** Test your jq expressions against a real response before committing:

```bash
echo '{"agents":[],"total":0}' | jq 'has("agents")'
echo '{"agents":[],"total":0}' | jq '.agents | type == "array"'
```

**Tip:** If the response could be an array OR an object wrapping an array, use:

```javascript
// post-script pattern for extracting items regardless of wrapper:
const items = Array.isArray(ctx.response.body) 
  ? ctx.response.body 
  : (ctx.response.body as any).nodes ?? (ctx.response.body as any).items ?? [];
```

---

## 11. Debugging Failed Runs

### Check the run logs first

Every run writes to `runs/{timestamp}/`:

```bash
# See the summary
cat local-dev-test-repo/runs/$(ls -t local-dev-test-repo/runs | head -1)/summary.json | jq .

# See a specific test's full log
cat local-dev-test-repo/runs/$(ls -t local-dev-test-repo/runs | head -1)/graph--create-graph-node-a.log
```

### Probe the API directly with curl

Before writing (or debugging) a test, verify the endpoint manually:

```bash
BASE_URL=$(grep BASE_URL local-dev-test-repo/envs/local.env | cut -d= -f2)

# GET
curl -s "${BASE_URL}/api/graph/nodes" | jq .

# POST
curl -s -X POST "${BASE_URL}/api/graph/nodes" \
  -H "Content-Type: application/json" \
  -d '{"path":"shogun-test/probe","contentType":"text/plain","content":"test","persist":"file"}' | jq .

# PATCH
curl -s -X PATCH "${BASE_URL}/api/graph/nodes/shogun-test/probe" \
  -H "Content-Type: application/json" \
  -d '{"title":"Updated"}' | jq .
```

### Run a single collection

```bash
cd local-dev-test-repo
npx tsx ../src/index.ts run --collection graph --env local
```

### Run a single test file

```bash
cd local-dev-test-repo
npx tsx ../src/index.ts run --file tests/collections/graph/create-graph-node-a.yaml --env local
```

---

## 12. Collection Order Matters

The `order` array in `_collection.yaml` is not optional for CRUD collections — it controls execution sequence. If you add a test file, add it to `order` in the right position:

```yaml
order:
  - get-graph-nodes         # baseline read (smoke)
  - create-graph-node-a     # creates data needed by later tests
  - create-graph-node-b
  - get-graph-node          # reads created data
  - modify-graph-node       # mutates data
  - create-graph-link       # creates relationship
  - get-graph-links         # smoke read
  - get-graph-link          # reads created link
  - delete-graph-link       # cleanup (405 — leaves link in place)
  - delete-graph-node-a     # cleanup
  - delete-graph-node-b     # cleanup
```

Tests not listed in `order` still run, but at an unspecified position after the ordered tests. Don't rely on that — always add to `order`.

---

## 13. ctx.http vs curl

`ctx.http.*` and `curl` serve different purposes:

| | `ctx.http.*` | `curl` (via request) |
|---|---|---|
| Used in | `pre`, `post`, `setup`, `teardown` scripts | The actual test request |
| Returns | `ShogunResponse` object | Captured by executor |
| Assertions run | No | Yes (status, shape, snapshot) |
| Shows in report | No (side effect only) | Yes |
| Use for | Setup calls, teardown cleanup, data seeding | The thing you're testing |

**Example:** In `setup`, use `ctx.http.post` to load a workspace. In the test itself, use the `request:` block with `method: GET` — that fires curl and runs assertions.

---

## 14. Testing Plans as Living Docs

The `local-dev-test-repo/testing-plans/` directory contains one Markdown file per collection. These are **living documents** — update them as you learn things about the API.

A testing plan records:
- Which endpoints to test and the target test file names
- Snapshot policy decisions
- Shape assertion patterns (so future tests are consistent)
- Known API quirks specific to that collection
- Suite membership (`smoke.yaml`, `gets-all.yaml`)

**Read `testing-plans/README.md` before writing a new collection.** It contains shared conventions for auth wiring, workspace loading, stash patterns, etc.

---

## 15. Tests Must Surface Bugs, Not Hide Them

**The entire purpose of API tests is to find bugs in the API.**

A test that silently accepts error codes — 404, 405, 501, "known limitation" — is not a test. It is a green checkbox that lies to you. If you encounter a situation where you are tempted to write `if (s === 404) { ctx.log('acceptable'); return; }`, stop and ask: **is this actually acceptable, or is this a bug?**

### The Smell

These patterns all indicate a test that is masking a bug rather than catching one:

```javascript
// ❌ Silently swallowing a missing endpoint
if (s === 404 || s === 405) {
  ctx.log('endpoint not implemented — known limitation');
  ctx.vars.thingId = null;
  return; // test "passes"
}

// ❌ Logging instead of asserting
ctx.log(`Unexpected status: ${s}`); // no ctx.assert = no failure

// ❌ Accepting both success and failure as "OK"
ctx.assert(s === 200 || s === 404, '...');
// (after a CREATE that must have succeeded — 404 here IS a bug)
```

### The Rule

**Every test must have exactly one definition of success, expressed with `ctx.assert`.**

If an endpoint is genuinely not implemented yet, the test must **fail** until it is. A failing test is a standing bug report. A passing test with a `ctx.log('not supported')` is a lie that gets committed to the repo and forgotten.

### When 4xx/5xx IS the correct expected status

There are legitimate cases where a non-2xx code is the right assertion — but it must be **explicit and intentional**:

```javascript
// ✅ Confirmed API limitation — 405 is asserted, not swallowed
ctx.assert(s === 405, `Expected 405 on DELETE /api/graph/links (confirmed API limitation — no DELETE endpoint), got ${s}`);

// ✅ Post-delete confirmation — 404 is the proof the delete worked
ctx.assert(s === 404, `Expected 404 confirming node is deleted, got ${s} — node may still exist`);
```

The difference: the assertion message explains **why** that code is expected, and any deviation **fails the test**.

### When You Find a Missing Endpoint

If you discover an endpoint is missing (e.g., no DELETE for a resource that should have one):

1. **Write the test anyway** — assert 200/204, let it fail
2. **Add a comment** at the top of the test: `# BUG: DELETE endpoint not yet implemented — see [ticket/issue ref]`
3. **File a bug** with the API team
4. **Do not** change the assertion to accept 404/405 — the failing test IS the bug report

### Real Examples Fixed in This Repo

| File | What was wrong | Fix |
|------|---------------|-----|
| `code/delete-pattern.yaml` | Accepted 404/405 as "known limitation" — masked missing DELETE endpoint | Now asserts 200/204 only |
| `code/post-pattern-find.yaml` | Accepted 404 after pattern was just defined — masked a find bug | Now asserts 200 only |
| `graph/modify-graph-node.yaml` | Hardcoded 405 as "expected" when PATCH is actually supported | Now asserts 200 with body inspection |
| `graph/delete-graph-link.yaml` | No `ctx.assert` at all — any status code silently passed | Now asserts exactly 405 (confirmed limitation) |
| `fs/get-fs-verify.yaml` | Post-script had dead `if (status === 404) { return; }` path that contradicted `status: 200` | Removed dead path; assert 200 only |

---

## 16. Unauthenticated Guard Tests

Guard tests verify that an endpoint correctly rejects requests with no credentials (expected 401) or insufficient credentials (expected 403). These tests **must not** carry an auth header.

### The Problem: AUTH_TOKEN Auto-Injection

By default, shogun auto-injects `AUTH_TOKEN` from the env file as `Authorization: Bearer <token>` on every request that doesn't already have an `Authorization` header. This means a guard test written without any auth header will silently receive a valid token and pass for the wrong reason.

### Solution A — Disable Auto-Injection in Config (Recommended)

Set `auto_inject_auth: false` in `shogun.config.yaml`. Auth is then **never** injected automatically — every collection that needs auth must wire it explicitly in `setup` + `pre` scripts (see [Section 1](#1-auth-wiring)).

```yaml
# shogun.config.yaml
defaults:
  auto_inject_auth: false
```

This is the correct long-term approach for any test suite that includes guard tests. It makes auth explicit and auditable — you can see exactly which tests carry credentials.

### Solution B — Explicit Empty Override in Pre-Script (Per-Test)

If you cannot change the global config (e.g. another team depends on auto-injection), suppress injection for a specific test by setting `Authorization` to an empty string in the `pre` script:

```javascript
// pre-script for an unauthenticated guard test:
// Explicitly set Authorization to '' — hasOwnProperty check in executor
// sees the key exists and skips auto-injection.
ctx.request.headers['Authorization'] = '';
```

> **Why this works now:** The executor uses `Object.prototype.hasOwnProperty.call(headers, 'Authorization')` to check for an existing header. An empty string `''` is falsy, but the key *exists* — so injection is skipped. Prior to this fix, the check was `!headers['Authorization']`, which treated `''` as absent and injected anyway.

### What Does NOT Work

```javascript
// ❌ This does NOT suppress injection — delete removes the key entirely,
//    so hasOwnProperty returns false and injection fires.
delete ctx.request.headers['Authorization'];

// ❌ This also does NOT work — null is not a string, the key won't be
//    present in the Record<string, string> headers map.
ctx.request.headers['Authorization'] = null;
```

### Guard Test Pattern

```yaml
# guard-unauthenticated.yaml
name: Reject unauthenticated request
request:
  method: GET
  path: /api/protected-resource
response:
  status: 401
  snapshot: false
pre: |
  // Suppress auto-injection for this guard test
  ctx.request.headers['Authorization'] = '';
```

For authenticated tests in the same collection, apply auth normally in the pre-script:

```javascript
// pre-script for an authenticated test:
if (ctx.vars.authHeader) {
  ctx.request.headers['Authorization'] = ctx.vars.authHeader;
}
```

---

## Appendix: Quick Reference Patterns

### Standard pre-script (GET test with auth + var-based path)

```javascript
if (ctx.vars.authHeader) ctx.request.headers['Authorization'] = ctx.vars.authHeader;
const id = ctx.vars.createdResourceId as string;
ctx.assert(!!id, 'createdResourceId is not set — create test must have run and succeeded first');
ctx.request.path = `/api/resource/${id}`;
```

### Standard post-script (stash from list response)

```javascript
const body = ctx.response.body as any;
const items = Array.isArray(body) ? body : (body.items ?? body.results ?? []);
ctx.log(`Got ${items.length} items`);
if (items.length > 0) {
  ctx.vars.firstItemId = items[0].id;
  ctx.log(`Stashed first item id: ${ctx.vars.firstItemId}`);
}
```

### Standard post-script (stash from create response)

```javascript
const s = ctx.response.status;
ctx.assert(s === 200 || s === 201, `Expected 200/201 on create, got ${s}`);
const body = ctx.response.body as any;
ctx.vars.createdItemId = body.id ?? body.path;
ctx.log(`Created: ${ctx.vars.createdItemId}`);
```

### Standard post-script (delete with var clear)

```javascript
ctx.assert(ctx.response.status === 200, `Expected 200 on delete, got ${ctx.response.status}`);
ctx.vars.createdItemId = null;
ctx.log('Resource deleted and var cleared');
```

### Teardown cleanup block

```javascript
const headers = {};
if (ctx.vars.authHeader) headers['Authorization'] = ctx.vars.authHeader;

if (ctx.vars.createdItemId) {
  ctx.log(`Teardown: cleaning up item "${ctx.vars.createdItemId}"`);
  try {
    const res = await ctx.http.delete(`/api/resource/${ctx.vars.createdItemId}`, { headers });
    ctx.log(`Delete response: ${res.status}`);
  } catch (err) {
    ctx.log(`Teardown cleanup failed (non-fatal): ${err.message}`);
  }
}
```

---

## 20. Coverage v0.5 — Prototype Feedback Fixes (2026-07-04)

The test team (ab-shield) took the v0.4.0 coverage report for a spin and filed 7 issues. Here's what broke, why, and the lessons for future coverage work.

### Issue 2 (P0): Body field coverage showed 0% — dynamic body parsing gap

**Root cause:** The coverage tool only parsed the static YAML `request.body.inline` / `request.body.file` fields. But ~all real tests set the body dynamically in `pre:` scripts via `ctx.request.body = JSON.stringify({…})` or `ctx.request.body = {…}`. The static field was empty, so coverage was 0%.

**Fix:** [`extractBodyFieldsFromScript()`](src/commands/coverage/test-collector.ts:193) now scans pre-scripts for `ctx.request.body = <object-literal>` assignments, balances braces to extract the literal, normalises shorthand/unquoted keys, and `JSON.parse`s it for top-level field names. `JSON.stringify(…)` wrappers are stripped first. Variable references (`ctx.request.body = requestBody`) are skipped — can't resolve statically.

**Result:** Body field coverage went from `0 / 230 (0%)` → `38 / 230 (16.5%)` against the local-dev-test-repo.

**Lesson:** Static YAML analysis is insufficient for shogun — the pre/post scripts are where the real request shaping happens. Any coverage dimension that depends on request shape must scan pre-scripts. The same applies to query params set via `ctx.request.path = '…?key=value'` (now handled by [`extractParamsFromScript()`](src/commands/coverage/test-collector.ts:282)).

### Issue 1 (P1): `--last-run` returned "No runs found"

**Root cause (two bugs):**
1. The coverage run-loader's [`loadRunById()`](src/commands/coverage/run-loader.ts:34) only looked for `summary.json`, but the team's test repo names the file `run.json` (same shape). The logger's own `loadRunById` already preferred `run.json` — the coverage module was inconsistent.
2. The CLI arg parser had a **duplicate `case '--run'`** — the second case (which sets `runId`) was dead code, so `--run <id>` never worked for coverage.

**Fix:** Coverage `loadRunById` now tries `summary.json` then `run.json`. The duplicate `case '--run'` was removed (the first one set `result.run`, used by `shogun report`; the second set `result.runId`, used by coverage — both now coexist correctly).

**Lesson:** When two commands share a flag name (`--run`), a single `switch` case can't serve both. Keep flag parsing in one place and map to distinct result fields.

### Issue 4 (P1): `--format json` output failed JSON parsing

**Root cause:** `writeOutput` used `process.stdout.write()`, which is **asynchronous when stdout is a pipe**. The CLI calls `process.exit()` immediately after the command returns, truncating any buffered data at the stream's highWaterMark (65536 bytes). Large specs produce >500KB JSON.

**Fix:** [`writeOutput()`](src/commands/coverage/reporter/output.ts:14) now uses `writeSync(1, …)` for stdout — synchronous writes flush before exit.

**Lesson:** Any CLI that emits large payloads to stdout and then calls `process.exit()` must write synchronously. `process.stdout.write` is only synchronous when stdout is a TTY; when piped, it's async and gets cut off. This is invisible in interactive testing (TTY = sync) and only bites in CI/pipe contexts.

### Issue 3 (P2): 401 spec drift was noise, not signal

**Root cause:** JWT auth middleware returns 401 for every authenticated endpoint, but the OpenAPI spec doesn't document 401 per-endpoint (it's cross-cutting). This produced ~40 identical drift warnings that buried real drift (like 405).

**Fix:** New `coverage.suppressDrift` config (default `['401']`) + `--suppress-drift <code,code>` CLI flag (augments config). Suppressed codes are hidden from per-endpoint output and summarised once as a global note: `Suppressed drift: 3 occurrences of [401, 404] across 3 endpoints hidden`. Test-vs-reality mismatches are never suppressed (always actionable).

**Lesson:** Cross-cutting concerns (auth, rate-limiting, CORS) produce uniform per-endpoint noise. Give users a way to acknowledge them globally without losing per-endpoint signal for real drift.

### Issue 5 (P2): Quality score formula was undocumented

**Fix:** The formula is now shown in the summary header (`per test: status 1 + shape 2×n + snapshot 3 + postScript asserts; ÷ 10 × 100`) and as a per-test breakdown in `--detail` mode: `· TestName: status ✓  shape 2  snapshot ✗  postScript 3  → 6`.

**Formula:** `rawScore = status(1 if response.status set) + shape(2 × shapeAssertions.length) + snapshot(3 if enabled) + postScript(count of assert() calls)`. Endpoint score = `min(100, Σ rawScores / (tests × 10) × 100)`. A test is "thin" when `rawScore ≤ 1`.

### Issue 6 (P3): `--gaps` output too long (304+ gaps)

**Fix:** New `--top N` flag limits to the N highest-priority gaps (severity first, then endpoint risk score descending). Shows `Showing top 5 of 522 gaps (517 hidden). Use --top 522 to see all.`

### Issue 7 (P3): `--gaps` ignored `--collection`

**Fix:** When `--collection` is set with `--gaps`, gaps are now scoped to endpoints that have at least one test from that collection. Uncovered endpoints with no tests from the collection are excluded (not actionable in a collection-focused review). Result: `--gaps --collection code` → 170 gaps (down from 522).
