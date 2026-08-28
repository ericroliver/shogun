---
name: shogun
description: agent instructions for coding within the shogun repo.
---

## What Is Shogun?

**Shogun** is a shell-first, TypeScript-enhanced API testing CLI.

The core philosophy: use UNIX tools (curl, jq, diff) for HTTP execution and response comparison, and only bring TypeScript in where logic, scripting, or programmability are genuinely needed. No HTTP client libraries. No heavy test frameworks. Just curl pipes and YAML.

**This repo is the shogun engine** — the CLI tool itself. The test definitions (YAML) live in a separate "test repo" that the user creates. A reference test repo lives at [`test-repo/`](test-repo/) and is the integration target for all shogun development work.

[`test-repo/`](test-repo/) is testing a real repo (Engigma) and we seek to accomplish two goals:
- stretch the limits of shogun to learn where we need to improve and extend
- find legitimate bugs in the Enigma api. It is under rapid development as well. When tests break and you are told that the Engima API team has shipped major updates, we need to be reviewing fails in terms of perhaps there is a break in the Enigma API itself. You can't assume the tests are wrong.


---

## Key Signposts

### Engine Source (`src/`)

| File | Role |
|------|------|
| [`src/index.ts`](src/index.ts) | CLI entrypoint — parses args, dispatches commands |
| [`src/runner.ts`](src/runner.ts) | Test runner loop — discovers, orders, and executes collections |
| [`src/loader.ts`](src/loader.ts) | Loads `shogun.config.yaml`, env files, test YAML, collection YAML |
| [`src/executor.ts`](src/executor.ts) | Spawns curl via `child_process`; captures status, body, headers, duration |
| [`src/asserter.ts`](src/asserter.ts) | Status code checks, jq shape assertions, snapshot diffs |
| [`src/scripter.ts`](src/scripter.ts) | Transpiles and executes inline TypeScript pre/post scripts via `tsx` |
| [`src/logger.ts`](src/logger.ts) | Writes per-test run logs and `summary.json` under `runs/` |
| [`src/reporter.ts`](src/reporter.ts) | Renders pretty/json/tap output to stdout |
| [`src/types.ts`](src/types.ts) | All shared types — `ShogunContext`, `TestDefinition`, `RunSummary`, etc. |
| [`src/commands/`](src/commands/) | One file per CLI command (`run`, `snapshot`, `lint`, `report`) |

### Reference Test Repo (`test-repo/`)

This is the live integration test bed — shogun is run against a real API using this repo.

| Path | Role |
|------|------|
| `test-repo/shogun.config.yaml` | Config for the local test repo |
| `test-repo/envs/local.env` | Local env vars — **gitignored**, copy from `.env.example` |
| `test-repo/tests/collections/` | All test collections (one dir per domain) |
| `test-repo/tests/suites/` | Named suites (`smoke.yaml`, `gets-all.yaml`) |
| `test-repo/expected/` | Snapshot baselines — committed to git |
| `test-repo/testing-plans/` | Human-written plans for each collection (living design docs) |
| `test-repo/specs/` | OpenAPI spec and API summary for the target API |
| `test-repo/specs/enigma-api.json` | Full OpenAPI 3.0.1 spec — **do not read whole file**; use `shogun spec` instead |
| `test-repo/specs/enigma-api-summary.txt` | Generated summary: `METHOD /path` pairs only — for quick listing |

### Documentation (`docs/`)

| File | Role |
|------|------|
| [`docs/technical/architecture.md`](docs/technical/architecture.md) | Deep-dive architecture, execution flow, shell/TS split |
| [`docs/product-stories/shogun-v1.md`](docs/product-stories/shogun-v1.md) | Product stories for v1 scope |
| [`docs/testing-journal.md`](docs/testing-journal.md) | **Tips, tricks, and lessons learned writing shogun tests** (sidecar doc) |
| [`docs/sample-test-repo/`](docs/sample-test-repo/) | Canonical sample of what a user's test repo looks like |

---

## Core Concepts (Quick Reference)

### The `ShogunContext` (`ctx`)

Every pre/post script and collection setup/teardown receives a `ctx` object. Key properties:

```typescript
ctx.env          // env vars (read-only)
ctx.vars         // mutable cross-test store — persists for the entire run
ctx.request      // current request — mutable in pre-script
ctx.response     // populated after curl — available in post-script
ctx.assert(bool, msg)   // throws ShogunAssertionError on false — FAILS the test
ctx.log(msg)            // writes to stdout + run log
ctx.http.get/post/put/patch/delete(...)  // programmatic HTTP (NOT curl)
ctx.scripts      // shared helpers from the test repo's scripts/ dir
```

### Execution Order Per Test

```
collection setup (once)
  └── for each test:
        pre-script → curl → jq shape checks → snapshot diff → post-script → log
collection teardown (once, even on failure)
```

### Snapshot Files

Snapshot baselines live in `expected/` keyed as `{collection}/{METHOD}_{path_sanitized}.json`. They are **committed to git**. Running `shogun snapshot` captures/updates them; running `shogun run` diffs against them.

### Key CLI Commands

```bash
shogun run --env local                   # run all tests
shogun run --collection graph            # single collection
shogun run --suite smoke                 # named suite
shogun snapshot --env local              # capture/update all baselines
shogun lint                              # validate YAML without HTTP
shogun report                            # show last run

# Spec queries — slice the OpenAPI contract without reading the full JSON
# spec.path must be set in shogun.config.yaml (or passed as first positional arg)
shogun spec --list                                       # all endpoints: METHOD /path
shogun spec --endpoint /api/code/checkpoints            # all methods for one path
shogun spec --endpoint /api/workspaces --method GET     # single endpoint+method contract
shogun spec --tag Agents                                # all endpoints in a tag group
shogun spec --schema AgentDefinition                    # resolve a named schema ($refs inlined)
shogun spec --search checkpoint                         # keyword search across summaries
```

---

## Project Conventions

### Naming

- Test files: `{verb}-{resource}-{qualifier}.yaml` — e.g., `create-graph-node-a.yaml`, `get-graph-links.yaml`
- Collections: lowercase, hyphenated domain name matching the API path segment
- Snapshot files: auto-derived from method + path — don't create manually

### Variable Stashing Pattern

Create-then-read tests stash IDs/paths into `ctx.vars` so downstream tests can consume them:

```javascript
// post-script of create test:
ctx.vars.createdNodePathA = body.path ?? ctx.vars.testNodePathA;

// pre-script of read/delete test:
const path = ctx.vars.createdNodePathA as string;
ctx.assert(!!path, 'createdNodePathA is not set — create test must have run and succeeded first');
ctx.request.path = `/api/graph/nodes/${path}`;
```

### Snapshot Policy

- **Write tests** (POST/PATCH/PUT/DELETE): always `snapshot: false` — responses contain volatile IDs and timestamps
- **Read tests** (GET): `snapshot: true` with appropriate `ignore_fields` for volatile fields

### Teardown as Safety Net

Collection teardown should attempt cleanup of any `ctx.vars` pointer that is still non-null. It is a safety net, not the primary cleanup path. Individual delete tests clear their own pointers on success.

### Test Node Path Uniqueness

When creating test data, use a timestamp in the path to prevent collisions between parallel or repeated runs:

```javascript
ctx.vars.testNodePathA = `shogun-test/node-a-${Date.now()}`;
```

### Auth Wiring

Auth is wired in collection `setup`, not per-test:

```javascript
const raw = (ctx.env.AUTH_TOKEN ?? '').trim();
ctx.vars.authHeader = raw ? (raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`) : null;
```

Each test's `pre` script applies it: `if (ctx.vars.authHeader) ctx.request.headers['Authorization'] = ctx.vars.authHeader;`

---

## No Skip — Ever

**`ctx.skip()` does not exist.** A skipped test is a useless test — it provides zero signal.

If a test can't run because a prerequisite failed, **that is a test failure.** Use `ctx.assert(!!value, 'reason')` to surface the dependency explicitly. The run will fail with a clear message pointing to the root cause.

The only valid statuses are `passed`, `failed`, and `needs_baseline`. There is no `skipped`.

---

## Build & Dev

```bash
npm run dev                   # run via tsx (no build)
npm run build                 # tsc + postbuild (makes dist/ executable)
npm run test:local            # run all tests against local env
npm run lint:yaml             # validate all YAML files

# Standalone binary
npm run pkg:macos             # bun compile → bin/shogun-macos-arm64
npm run pkg:linux             # bun compile → bin/shogun-linux-x64
```

---

## Engineering Principles

### Cross-Platform Path Handling

Use `node:path` utilities (`basename`, `join`, `dirname`) — never `String.split('/')`. Backslash paths on Windows will silently break forward-slash splitting. This applies to both server-side code and any code that may run in pre/post scripts on Windows machines.

### Test What You Ship, Not a Copy of It

Unit tests must call the actual implementation. Reimplementing logic inline in a test only verifies the copy, not the code. When methods are private, call them via `(obj as any).methodName(...)` — TypeScript's `private` is compile-time only and should not prevent testing real behavior.

### Guard Against Silent Misclassification

When falling back between execution paths based on error messages, match specific error codes or narrow phrases — never broad substrings. An overly broad match (e.g. `errMsg.includes('procedure')`) will mask legitimate failures and produce confusing secondary errors.

### SQL JOINs Must Match Their Intent

A `LEFT JOIN` captures optional relationships; an inner `JOIN` silently drops them. When querying catalog or dependency tables where the referenced object may be in a different table (e.g. functions in `pg_proc` vs. tables in `pg_class`), always use `LEFT JOIN` so the query doesn't lose rows before the fallback lookup can fire.

---

---

## What To Read Next

- **If working on the engine**: read [`docs/technical/architecture.md`](docs/technical/architecture.md) then the relevant `src/` file
- **If debugging a run**: check `test-repo/runs/{timestamp}/summary.json` and the per-test `.log` files
