# PowerShell Backend: Progress Report

> **Date**: 2026-07-07
> **Branch**: `blue-too/add-powershell-backend` (not yet committed)
> **Status**: Engine work complete, integration testing pending

---

## Summary

The PowerShell backend for shogun has been substantially rewritten and hardened.
All engine-level work is done — 74 unit tests pass, TypeScript compiles clean, and the
build succeeds. A VIBE test repo has been scaffolded with auth and home page collections.

The remaining work is **end-to-end integration testing** (running the smoke suite against
the live VIBE application) and **polish** (cleanup, commit, push).

---

## What Has Been Accomplished

### 1. PowerShell Backend Rewrite (`powershell-backend.ts`)

**626 lines** of engine code, replacing the original first-pass implementation.

#### Session & Cookie Persistence (Phase 1)
- Added `CookieEntry` type and `cookies: CookieEntry[]` field on `PowerShellBackend`
- `executeRequest` now reconstructs a `WebRequestSession` from stored cookies before
  each request, and captures cookies from the response session afterward
- Cookies persist for the lifetime of the backend instance (one full `shogun run`)
- `clearCookies()` and `getCookies()` methods for inspection/reset
- `parseCookies()` helper extracts cookies from the `COOKIES:` IPC protocol line
- This enables testing cookie-based auth applications (VIBE uses `.ASPXAUTH`)

#### Form-Encoded Body Support (Phase 2)
- `buildBodyArg` now detects `Content-Type: application/x-www-form-urlencoded`
- For form-encoded bodies, generates a PowerShell hashtable (`@{ key='value' }`) which
  `Invoke-WebRequest` automatically URL-encodes
- For JSON bodies, generates a single-quoted PowerShell string with proper escaping
- Resolves `RequestBody` schema from YAML (`inline` or `file` content)

#### HTML / Non-JSON Response Handling (Phase 3)
- Changed body transport from raw `BODY:<text>` to base64-encoded `B64BODY:<base64>`
- This solves the multi-line HTML problem — base64 has no newlines, so it's safely
  transportable in the line-based IPC protocol
- `parsePowerShellResponse` auto-detects JSON (if body starts with `{` or `[`) and
  parses it; otherwise keeps the body as a string
- Legacy `BODY:` protocol kept for backward compatibility

#### Escaping Security Fix (Phase 4)
- Split escaping into two functions:
  - `escapeForPowerShell(str)` — for single-quoted strings, escapes `'` → `''`
  - `escapeForDoubleQuoted(str)` — for double-quoted strings, escapes `"` → `` `" ``
    and `$` → `` `$ `` (prevents PowerShell variable injection)
- `escapeHereString(str)` — for here-strings, escapes `'` → `''`
- Audited all call sites: headers use `escapeForDoubleQuoted`, body/URL/JSON use
  `escapeForPowerShell`

#### Other Engine Changes
- Switched from `Invoke-RestMethod` to `Invoke-WebRequest` (better session control,
  error handling, raw body access)
- `buildPsHeaders` now accepts `autoInjectAuth` parameter (VIBE uses cookies, not
  Bearer tokens, so `auto_inject_auth: false` in config)
- `formatHeadersForPowerShell` uses `escapeForDoubleQuoted` for header values

### 2. Unit Tests (`powershell-helpers.test.ts`)

**540 lines**, **74 tests**, all passing.

Covers:
- `escapeForPowerShell` — single-quote escaping
- `escapeForDoubleQuoted` — double-quote and `$` escaping
- `escapeHereString` — here-string escaping
- `parsePowerShellResponse` — status, headers, B64BODY, legacy BODY, error lines,
  multi-line HTML, array header values
- `parseCookies` — cookie extraction, empty/malformed handling
- `buildPsUrl` — URL construction with query params
- `buildPsHeaders` — header merging, `autoInjectAuth` true/false
- `formatHeadersForPowerShell` — double-quoted escaping
- `buildBodyArg` — JSON bodies, form-encoded bodies, `RequestBody` schema resolution
  (inline/file), empty/null handling
- `convertIgnoreFieldToPowerShell` — field removal
- `formatSimpleDiff` — diff output

### 3. Windows Platform Fixes (Phase 4.5)

#### `scripter.ts` — `spawn('npx')` Fix
- Added `shell: process.platform === 'win32'` to `spawn()` options
- Without this, Node.js cannot find `npx.cmd` on Windows, causing `ENOENT` errors
  when executing pre/post scripts

#### `runner.ts` — Path Separator Fixes
- **Line 164** (`canonicalId`): Added `.replace(/\\/g, '/')` after `relative()` —
  fixes dependency resolution on Windows
- **Line 620** (`_failures_` collection): Same fix — prevents backslash-separated
  names in auto-generated `_failures_` collection YAML

### 4. VIBE Test Repo (`shogun-tests/`)

Created from scratch:

| File | Purpose |
|------|---------|
| `shogun.config.yaml` | Config with `auto_inject_auth: false`, timeout 15s, VIBE base URL |
| `envs/local.env` | `BASE_URL=http://localhost:3071`, `VIBE_USERNAME=eoliver`, `VIBE_PASSWORD=3minepoint` |
| `envs/local.env.example` | Placeholder template |
| `tests/collections/auth/_collection.yaml` | Auth collection with setup script |
| `tests/collections/auth/login-account.yaml` | Login test: POST `/Account/AccountLogon`, asserts `"Comtrya!"` in body |
| `tests/collections/home/_collection.yaml` | Home collection with setup script |
| `tests/collections/home/home-page-loads.yaml` | GET `/`, asserts no "You must Log On" in body |
| `tests/suites/smoke.yaml` | Smoke suite: runs auth → home |

### 5. Documentation

| Document | Lines | Content |
|----------|-------|---------|
| `docs/technical/powershell-backend-lessons-learned.md` | 577 | 7 mistakes documented, PowerShell escaping contexts, session/cookie design, Windows path issues, IPC protocol, VIBE app facts, gotchas, recommendations |

### 6. VIBE Application Investigation

- Confirmed VIBE is an ASP.NET MVC app (not a REST API) running on `http://localhost:3071/`
- Login endpoint: `POST /Account/AccountLogon` with form-encoded body
- Success response: HTTP 200, body `"Comtrya!"`, `.ASPXAUTH` cookie set
- Failure response: HTTP 200, body contains `validation-summary-errors`
- Confirmed credentials: `eoliver` / `3minepoint` (verified via manual `Invoke-WebRequest`)
- `blove` / `2minepoint` does NOT work (incorrect password)

---

## What Remains To Be Done

### Phase 6: End-to-End Integration Testing (BLOCKED)

This is the critical next step. The engine code is complete but has **not yet been
verified end-to-end** against the live VIBE application.

#### Last Known State
The most recent smoke suite run (run ID `20260707_075227`) failed with:
```
Test file not found for dep resolution: "auth\login-account"
```

This was caused by the Windows path separator bug in `runner.ts` line 164, which has
**since been fixed** but **not yet re-tested**.

#### Tasks
- [ ] 6a. Rebuild `shogun` (`npm run build`) with all fixes applied
- [ ] 6b. Run `shogun run --env local --suite smoke` using the fresh build
      (`node dist/index.js`, not the stale `shogun.exe`)
- [ ] 6c. Fix any remaining integration issues
- [ ] 6d. Verify that the `.ASPXAUTH` cookie is carried from the auth collection to
      the home collection (session persistence across collections)
- [ ] 6e. Verify the home page test passes (authenticated GET returns the app, not
      the login page)
- [ ] 6f. Run full unit test suite + build — confirm zero regressions

#### Known Risks
- **Variable substitution in YAML**: The login test uses `${VIBE_USERNAME}` and
  `${VIBE_PASSWORD}` in the `body.inline` section. It's unclear whether the shogun
  loader performs env var substitution inside YAML body values (it does for `path`
  and headers, but body inline objects may need different handling).
- **Cross-collection session persistence**: The PowerShell backend stores cookies on
  the backend instance. The runner creates one backend instance per run, so cookies
  should persist across collections. But this has not been verified.
- **Env var loading**: The `local.env` file format and parsing path need to be
  verified — shogun may expect a different env file format.

### Phase 7: Polish

- [ ] 7a. Clean up any debug logging in `powershell-backend.ts`
- [ ] 7b. Update `docs/technical/architecture-powershell-backend-v3.md` to reflect
      the actual implementation (the design doc is outdated)
- [ ] 7c. Update `docs/testing-journal.md` with PowerShell-specific testing tips
- [ ] 7d. Stage and commit all changes (4 modified files + 1 new doc + test repo)
- [ ] 7e. Push to `blue-too/add-powershell-backend` branch

### Future Enhancements (Not Blocking)

- **Persistent PowerShell process**: Eliminate per-request process spawn overhead
  (~300ms → ~50ms) by keeping a PowerShell process alive for the entire run
- **HTML assertion mode**: Add `contains_text` assertion type for non-JSON responses
- **Session reset**: `ctx.clearSession()` or collection-level `clear_session: true`
- **Path normalization utility**: Centralize `toForwardSlash()` instead of inline
  `.replace(/\\/g, '/')` calls
- **Cross-platform CI**: Run test suite on both Windows and Linux

---

## Files Modified (Uncommitted)

```
Modified:
  src/backends/powershell-backend.ts   (+464 / -211 net change)
  src/runner.ts                        (2 path separator fixes)
  src/scripter.ts                      (1 line: shell option for Windows)
  src/tests/powershell-helpers.test.ts  (+298 / -67 net change)

New (untracked):
  docs/technical/powershell-backend-lessons-learned.md  (577 lines)
```

## Files Created (Test Repo — outside git)

```
shogun-tests/
  shogun.config.yaml
  envs/local.env
  envs/local.env.example
  tests/collections/auth/_collection.yaml
  tests/collections/auth/login-account.yaml
  tests/collections/home/_collection.yaml
  tests/collections/home/home-page-loads.yaml
  tests/suites/smoke.yaml
```

---

## Architecture Summary

```
                        shogun run --env local --suite smoke
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │    runner.ts        │
                         │  (test discovery,   │
                         │   dependency order,  │
                         │   path normalization)│
                         └────────┬────────────┘
                                  │
                                  ▼
                         ┌─────────────────────┐
                         │   scripter.ts       │
                         │  (pre/post scripts  │
                         │   via npx tsx,      │
                         │   shell:true on Win) │
                         └────────┬────────────┘
                                  │
                                  ▼
                         ┌─────────────────────┐
                         │ PowerShellBackend   │
                         │                     │
                         │  executeRequest()   │
                         │    ├─ buildPsUrl    │
                         │    ├─ buildPsHeaders │
                         │    ├─ buildBodyArg   │
                         │    ├─ spawn pwsh.exe │
                         │    │   └─ Invoke-    │
                         │    │      WebRequest │
                         │    │         with     │
                         │    │      WebSession  │
                         │    ├─ parseResponse   │
                         │    │   (B64BODY,      │
                         │    │    COOKIES)      │
                         │    └─ update cookies  │
                         └─────────────────────┘
```

**IPC Protocol** (Node.js ↔ PowerShell):
```
STATUS:200
HEADERS:{"Content-Type":"text/html"}
B64BASE64ENCODEDBODY==
COOKIES:[{"name":".ASPXAUTH","value":"...","domain":"localhost","path":"/"}]
```
