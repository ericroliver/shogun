---
name: shogun-test-writer
description: Writing, debugging, and maintaining shogun tests for API testing. Shogun replaces tools like Postman or Hoppscotch and goes bare metal on API testing.
---

## Protocol: When Given a Test Run With Failures

**When the user pastes test run output containing failures, the ONLY correct response is:**

1. **Produce a root-cause breakdown table** — grouped by category, not by test:

   | Group | Count | Root Cause |
   |-------|-------|-----------|
   | URL encoding | 7 | `encodeURIComponent(path)` encodes `/` → `%2F` → 404 |
   | Variable collision | 1 | Duplicate `const` in pre-script — compile error |
   | Wrong shape | 2 | `type == "array"` asserted on wrapped-object responses |
   | Missing header | 1 | `ctx.http.get()` missing required header in pre-script |
   | Cascade | 1 | Secondary failure — caused by prior test's broken post-script |

2. **For each ambiguous group** (unexpected status code, wrong shape, missing field) — **verify the API contract** before concluding it's a test bug or API bug:

   ```bash
   # Confirm what the spec says this endpoint should do
   shogun spec --endpoint /api/the/failing/path --method POST
   shogun spec --schema TheRequestBodySchemaName
   ```

   Compare the spec contract against what the test asserts. If they diverge, decide:
   - **Spec matches test, API returned wrong thing** → API bug (keep test, let it fail with a `# BUG:` comment)
   - **Spec differs from test assumptions** → test bug (fix the test to match the spec)
   - **Spec is missing this endpoint entirely** → likely an unreleased or removed endpoint — flag it

3. **For each group**, state:
   - The exact line(s) of code responsible
   - Whether this is a **test bug** (fix the test) or an **API bug** (write test to assert correct behavior and let it fail)
   - The specific fix proposed

4. **Halt and wait for confirmation** — do not modify any file until the user reviews the breakdown and approves the proposed fixes

**Never** start editing files in response to a pasted failure run. Always produce the breakdown first.

---

## Mandatory Pre-Flight (Every Session)

Before touching any test file, complete this checklist:

1. **Read the project's `AGENTS.md`** (if present) — project-specific rules and conventions
2. **Read `_collection.yaml`** for the collection — understand setup/teardown/var init
3. **Read the suite file** being run (e.g., `tests/suites/smoke.yaml`) — understand which `vars:` are injected and whether `validate:` is set
4. **Check the config** — `shogun.config.yaml` for connections, snapshots, and reporting settings

---

## Rule 1 — Read the Entire Script Before Writing One Line

Inline YAML script blocks (`pre: |`, `post: |`, `setup: |`, `teardown: |`) are compiled as a **single TypeScript lexical scope**. A `const ws` at line 2 and another `const ws` at line 31 is a compile error.

**Before adding any code to an existing inline script:**
1. Read the ENTIRE existing block top-to-bottom
2. List every `const`/`let`/`var` name already declared
3. Only then write new code

**Never** edit the middle or end of a script block without reading what came before it.

---

## Rule 2 — Path Params: Encode Per-Segment, Not the Whole Path

If your API uses path parameters that contain `/` (e.g., file paths), `encodeURIComponent(path)` will encode `/` to `%2F` and break routing.

- `encodeURIComponent(filePath)` converts `/` to `%2F` → **breaks routing (404)**
- Bare `${filePath}` skips encoding of spaces, `#`, `?`, `&` etc. → **also wrong**

The correct approach is **per-segment encoding** — encode each path segment individually while preserving the `/` separators. Create a shared helper in your `scripts/` directory:

```javascript
// ✅ CORRECT — per-segment encoding
const { encodeFilePath } = ctx.scripts.url;
ctx.request.path = `/api/files/${encodeFilePath(filePath)}`;

// ❌ WRONG — %2F breaks the route, returns 404
ctx.request.path = `/api/files/${encodeURIComponent(filePath)}`;

// ❌ ALSO WRONG — spaces/# etc. not encoded
ctx.request.path = `/api/files/${filePath}`;
```

For simple identifiers (IDs, slugs) that never contain `/`, use `encodeURIComponent` directly.

---

## Rule 3 — `ctx.http.*` Calls Must Carry Their Own Headers

`ctx.request.headers['Authorization'] = token` only affects the **curl request for this test**. It does NOT propagate to `ctx.http.*` calls. These are two completely separate HTTP mechanisms.

Every `ctx.http.get/post/put/patch/delete` call that needs auth or workspace headers must explicitly pass them:

```javascript
// ✅ CORRECT — headers wired explicitly
const token = ctx.env.AUTH_TOKEN ?? '';
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
const res = await ctx.http.get('/api/something', { headers: authHeaders });

// ❌ WRONG — ctx.request.headers does not carry over to ctx.http calls
ctx.request.headers['Authorization'] = `Bearer ${token}`;
const res = await ctx.http.get('/api/something'); // no auth header
```

---

## Rule 4 — Verify Actual API Response Before Writing Shape Assertions

Never write `shape:` assertions from docs, guesses, or mental models. Always verify against a real response first.

**Before writing any shape assertion:**
```bash
# Run the test once and look at the actual response
shogun run --file tests/collections/agents/get-agents.yaml --verbose

# Or curl the endpoint directly
curl -s "${BASE_URL}/api/agents" -H "Authorization: Bearer ${AUTH_TOKEN}" | jq 'keys'
```

**If the response is `{"agents": [...], "total": 5}` — the shape is NOT `type == "array"`.**

Write the assertion against the actual wrapper structure:
```yaml
shape:
  - 'has("agents")'
  - '.agents | type == "array"'
```

And fix the post-script to match:
```javascript
// Wrong — body is not an array
const items = Array.isArray(body) ? body : [];

// Correct — unwrap the envelope
const items = Array.isArray(body) ? body : (body.agents ?? body.items ?? []);
```

---

## Rule 5 — Snapshot Failures After a Snapshot Run Mean the Test Was Already Failing

`NEEDS BASELINE` after `shogun snapshot` = the test was failing when snapshot ran. Snapshots are only written for passing tests.

**Baseline location in `--file` mode:** baselines resolve to `expected/<collection>/` from (1) the CLI `--collection <name>` flag, then (2) the test YAML's top-level `collection:` field. Only when neither is set do baselines land in `expected/default/`.

```bash
shogun snapshot --file tests/collections/agents/get-agents.yaml --collection agents
```

**Diagnosis flow:**
1. Test shows `NEEDS BASELINE` → the test failed during the snapshot run
2. Look at the test's shape assertions — do they match the actual response?
3. Fix the test first, run snapshot again, then commit the baseline

**Snapshot staleness** (response content changed) is a separate issue from shape assertion failures. Both require different fixes:
- Shape fail → fix the assertion
- Stale snapshot (only volatile fields changed) → add `ignore_fields` for those fields

**Common volatile fields to ignore:**
```yaml
ignore_fields:
  - "**.id"
  - "**.timestamp"
  - "**.createdAt"
  - "**.updatedAt"
```

---

## Rule 6 — Tests Must Assert Correct Behavior, Not Current Behavior

The purpose of tests is to find bugs, not to be green.

| Pattern | What it means |
|---------|--------------|
| `ctx.assert(s === 200, ...)` | "This endpoint must return 200 — fail until it does" |
| `ctx.assert(s === 200 \|\| s === 404, ...)` after a create | Hiding a bug — one of these is wrong |
| `ctx.log('not supported')` with no assert | Guaranteed green checkbox that lies |
| `if (s === 404) { return; }` | Test that passes when the API is broken |

**When you discover an API bug:**
1. Write the test to assert the **correct** behavior (e.g., `ctx.assert(s === 200, ...)`)
2. Let it fail — the failing test IS the bug report
3. Add a `# BUG:` comment at the top of the test file explaining what's wrong

**When a non-2xx is legitimately correct:**
```javascript
// ✅ Confirmed — DELETE returns 405 (no delete endpoint)
ctx.assert(s === 405, `Expected 405 (confirmed API limitation — no DELETE endpoint), got ${s}`);

// ✅ Confirmed — verify-after-delete returns 404
ctx.assert(s === 404, `Expected 404 confirming resource is gone, got ${s}`);
```
The assertion message must explain WHY that code is expected.

---

## Rule 7 — Var Cascade Failures Are Always a Secondary Symptom

When a test fails with "X is not set — prior test must have run first", the root cause is in the **prior test's post-script**, not in this test's pre-script.

**Example:**
- `get-link-by-id` fails: `"firstLinkId is not set — get-links must have run first"`
- Root cause: `get-links` post-script does `Array.isArray(body) ? body : []` but body is `{"links": [...]}`
- So `items` is always empty, `firstLinkId` is never stashed

**Diagnosis:** Trace backward. Find the test that was supposed to set the var. Look at its post-script. Look at what the API actually returned.

---

## Rule 8 — Use `--verbose` for Debugging

When a test fails and the error output isn't enough to diagnose, use `--verbose` to see full request/response details for every test:

```bash
# Full request/response telemetry for all tests (not just failures)
shogun run --verbose

# Verbose for a single file
shogun run --file tests/collections/agents/get-agents.yaml --verbose

# Verbose for a suite
shogun run --suite smoke --verbose
```

Verbose mode attaches `resolvedRequest` and `resolvedResponse` to every test result, writes per-test `.log` files for passing tests, and prints request/response telemetry in the console — including headers (with auth redacted) and response bodies.

You can also set `SHOGUN_DEBUG=1` as an environment variable for debug-level stderr output from the runner internals.

**Debug log security contract:** SHOGUN_DEBUG output is automatically redacted. Sensitive header values (`Authorization`, `Cookie`, API keys, ... — matched case-insensitively), credential-bearing curl options, and sensitive URL query parameters (`token`, `api_key`, `password`, ...) are replaced with `[REDACTED]` before anything is written to stderr. Never rely on debug output to capture real credentials — and never paste unredacted credentials into bug reports.

---

## Rule 9 — Suite Vars and the Fixture Chain

Suite-level vars are seeded into `ctx.vars` before any collection setup runs. Collection vars override suite vars on collision. Both are overridden by runtime script assignments.

**Flow:**
```
suite vars: { WORKSPACE_NAME: "my-workspace" }
  → ctx.vars.WORKSPACE_NAME = "my-workspace"
  → setup_fixtures: [workspace-load]
    → fixture reads ctx.vars.WORKSPACE_NAME
    → sets ctx.vars.workspaceName = "my-workspace"
  → collection setup: reads ctx.vars.workspaceName (already set)
  → test pre-scripts: read ctx.vars.workspaceName
```

If a var is null in a pre-script, check:
1. The suite file — is the var declared in `vars:`?
2. The fixture — did it run and set the expected var?
3. The collection `_collection.yaml` — does it declare its own `vars:` that override the suite?

---

## Rule 10 — After Every Edit: State What You Expect

Before submitting an edit, explicitly state:
1. What status code the test should now assert
2. What shape the response must match
3. Whether any `ctx.vars.*` gets set in the post-script, and what value it should have after a success

This creates a verifiable prediction. If the test output contradicts your prediction, the prediction (and therefore the mental model behind the edit) was wrong.

---

## Quick Reference: Standard Pre-Script Patterns

### Basic GET test with auth
```javascript
const token = ctx.env.AUTH_TOKEN ?? '';
if (token) ctx.request.headers['Authorization'] = `Bearer ${token}`;
```

### Pre-script with a `ctx.http` verification call
```javascript
const token = ctx.env.AUTH_TOKEN ?? '';
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

// Every ctx.http call needs its own authHeaders
const checkRes = await ctx.http.get('/api/resource/check', { headers: authHeaders });
ctx.assert(checkRes.status === 200, `Resource not found: ${checkRes.status}`);
```

### Inline script with multiple HTTP sub-calls — avoid name collisions
```javascript
// Declare variables ONCE at the top of the script
const token = ctx.env.AUTH_TOKEN ?? '';
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

// Reuse authHeaders for all sub-calls — do NOT re-declare
const r1 = await ctx.http.get('/api/something', { headers: authHeaders });
const r2 = await ctx.http.post('/api/other', body, { headers: authHeaders });
```

### Unwrapping envelope responses
```javascript
const body = ctx.response.body as any;
// APIs often wrap arrays in objects — unwrap the envelope
const items = Array.isArray(body)
  ? body
  : (body.items ?? body.data ?? body.results ?? body.agents ?? []);
ctx.log(`Items returned: ${items.length}`);
```

---

## Common Mistakes Cheat Sheet

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| `encodeURIComponent(filePath)` where filePath has `/` | 404 — `%2F` breaks routing | Use per-segment encoding |
| `const ws = ...` twice in same script | TransformError compile fail | Read whole script before adding decls |
| `ctx.http.get(url)` with no auth header | 401 — missing credentials | Always pass `{ headers: authHeaders }` |
| `shape: type == "array"` on wrapped endpoint | Shape fail always | Curl endpoint, write from real response |
| `ctx.assert(s === 200 \|\| s === 404)` on a create | Passes even when API broken | One success code only |
| `if (s === 404) { return; }` | Test always passes | Remove; assert the correct code |
| Snapshot after shape fail | `NEEDS BASELINE` forever | Fix assertions first, snapshot after |
| Not using `--verbose` when debugging | Missing request/response context | Run with `--verbose` to see full details |
