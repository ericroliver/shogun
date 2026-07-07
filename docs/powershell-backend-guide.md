# PowerShell Backend Guide

> **Audience**: Anyone using shogun on Windows, or targeting IIS/ASP.NET applications.
>
> **Related docs**:
> - [Architecture: PowerShell Backend v3](technical/architecture-powershell-backend-v3.md) — design spec
> - [Lessons Learned](technical/powershell-backend-lessons-learned.md) — engineering notes & gotchas
> - [README.md](../README.md) — general shogun usage (Unix-focused)

---

## 1. What Is the PowerShell Backend?

Shogun has two interchangeable backends:

| Backend | HTTP Tool | JSON Tool | Diff Tool | Platform |
|---------|-----------|-----------|-----------|----------|
| **Unix** | `curl` | `jq` | `diff` | Linux, macOS |
| **PowerShell** | `Invoke-WebRequest` | `ConvertFrom-Json` | `Compare-Object` | Windows (cross-platform via pwsh) |

The PowerShell backend lets you run shogun on Windows without installing curl, jq, or
diff. It also provides first-class cookie/session support for testing ASP.NET MVC / IIS
applications like VIBE.

---

## 2. Selecting the PowerShell Backend

### Auto-detection (default)

On Windows, shogun auto-selects the PowerShell backend. On Linux/macOS, it selects Unix.

### Environment variable

```bash
# Force PowerShell backend regardless of OS
set SHOGUN_BACKEND=powershell
shogun run --env local
```

### CLI flag (highest priority)

```bash
shogun run --backend powershell --env local
shogun run --backend unix --env local
```

### Verify which backend is active

```bash
shogun check --backend powershell
```

Output shows the backend name, how it was selected, and dependency checks:

```
Backend:   powershell
Source:    --backend CLI flag

Dependencies:
  ✅ powershell.exe     5.1.26100.18898   (required)
  ✅ Invoke-WebRequest   built-in          (required)
  ⚠️ curl                not found         (not required for this backend)
  ⚠️ jq                  not found         (not required for this backend)

Status: Ready
```

---

## 3. Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 20 | For running shogun itself |
| PowerShell | 5.1+ (Windows) or 7+ (pwsh) | Auto-detected: tries `pwsh.exe` then `powershell.exe` |
| No external tools needed | — | `curl`, `jq`, `diff` are **not** required |

---

## 4. Cookie / Session Persistence

The PowerShell backend automatically persists cookies across requests within a single
`shogun run`. This is essential for testing applications that use cookie-based
authentication (ASP.NET Forms Auth, session cookies, etc.).

### How it works

1. The backend maintains a `CookieEntry[]` cookie jar in memory.
2. Before each request, cookies are injected into a `WebRequestSession` object.
3. `Invoke-WebRequest -WebSession $session` sends and receives cookies automatically.
4. After each response, updated cookies are extracted and stored back in the jar.

### VIBE example

```yaml
# Step 1: Login — server returns .ASPXAUTH cookie
name: Account Login
request:
  method: POST
  path: /Account/AccountLogon
  headers:
    Content-Type: application/x-www-form-urlencoded
    X-Requested-With: XMLHttpRequest
  body:
    inline:
      UserName: "${VIBE_USERNAME}"
      Password: "${VIBE_PASSWORD}"
      RememberMe: "false"
      X-Requested-With: XMLHttpRequest
response:
  status: 200
  post: |
    ctx.assert(ctx.response.body.includes('Comtrya'), 'Login failed');
```

```yaml
# Step 2: Authenticated request — .ASPXAUTH cookie auto-attached
name: Create AR Transaction
dependsOn: auth/login-account
request:
  method: GET
  path: /Accounting/AccountsReceivable/EditPayment
response:
  status: 200
```

No manual cookie management is needed — the backend handles it transparently.

---

## 5. Form-Encoded Bodies

The PowerShell backend detects `Content-Type: application/x-www-form-urlencoded` and
builds a URL-encoded form body automatically:

```yaml
request:
  method: POST
  path: /Account/AccountLogon
  headers:
    Content-Type: application/x-www-form-urlencoded
  body:
    inline:
      UserName: "${VIBE_USERNAME}"
      Password: "${VIBE_PASSWORD}"
```

For JSON bodies, simply set `Content-Type: application/json` (the default) and provide
a JSON body — it will be stringified and passed as a single-quoted PowerShell string.

---

## 6. HTML / Non-JSON Responses

The PowerShell backend fully supports HTML responses (unlike the Unix backend, which
was designed for JSON APIs):

- Response bodies are **base64-encoded** for transport between PowerShell and Node.js,
  ensuring multi-line HTML doesn't break the IPC protocol.
- If the response body starts with `{` or `[`, it's auto-parsed as JSON. Otherwise, it's
  kept as a string.
- In post-scripts, `ctx.response.body` will be a parsed object for JSON responses, or a
  raw string for HTML responses.

### Post-script example for HTML responses

```typescript
post: |
  // Extract a transaction ID from HTML
  const match = ctx.response.body.match(/arTransId=(\d+)/);
  if (match) {
    ctx.vars.arTransId = match[1];
    ctx.log(`Found AR transaction ID: ${match[1]}`);
  } else {
    ctx.assert(false, 'Could not extract arTransId from HTML response');
  }
```

### Post-script example for JSON responses

```typescript
post: |
  // body is already a parsed object — no JSON.parse needed
  ctx.assert(ctx.response.body.recordCount === 27, 'Expected 27 open items');
  ctx.vars.firstItemId = ctx.response.body.records[0].id;
```

---

## 7. Shape Assertions

Shape assertions use PowerShell expressions instead of jq expressions:

| Backend | Syntax | Example |
|---------|--------|---------|
| Unix (jq) | `.field -gt 0` | `has("status")` |
| PowerShell | `$json.field -gt 0` | `$json.PSObject.Properties.Match("status").Count -gt 0` |

```yaml
response:
  status: 200
  shape:
    # PowerShell expressions — evaluated against parsed JSON
    - '$json.records.Count -gt 0'
    - '$json.recordCount -is [int]'
```

> **Tip**: For HTML responses, prefer post-script assertions (`ctx.assert()`) over shape
> assertions, since shape assertions require parseable JSON.

---

## 8. Timeout Configuration

The PowerShell backend respects the timeout from `shogun.config.yaml`:

```yaml
defaults:
  timeout: 30  # seconds
```

Can also be overridden per-environment in your `.env` file:

```
TIMEOUT=30
```

Or per-test:

```yaml
env:
  TIMEOUT: 60
```

> **Important**: VIBE's `CreatePayment` endpoint takes ~12.5 seconds on the test system.
> Ensure your timeout is at least 30 seconds to avoid spurious failures.

---

## 9. Configuring for VIBE

### `shogun.config.yaml`

```yaml
version: 1
defaults:
  env: local
  timeout: 30
auto_inject_auth: false   # VIBE uses cookie auth, not Bearer tokens
paths:
  tests: ./tests
  envs: ./envs
  expected: ./expected
  runs: ./runs
ignore_fields_global:
  - "**.timestamp"
  - "**.requestId"
```

### `envs/local.env`

```
BASE_URL=http://localhost:3071
VIBE_USERNAME=eoliver
VIBE_PASSWORD=3minepoint
TIMEOUT=30
```

> Set `auto_inject_auth: false` in config — VIBE doesn't use Bearer tokens. The
> `Authorization` header would be ignored or cause issues.

---

## 10. Debugging

Enable verbose output with the `SHOGUN_DEBUG` environment variable:

```bash
set SHOGUN_DEBUG=1
shogun run --env local --suite smoke
```

This enables:
- Curl-args debug output (Unix backend)
- Body write/verify size info (Unix backend)
- Script log output to stderr (both backends)
- Script output for passing tests (normally only shown for failures)

### Per-test logs

Each run creates timestamped log files under `runs/<run_id>/`:

```
runs/20260707_085501/
  run.json               # Full run summary
  0000_auth--login.log   # Per-test logs
  0001_home--create.log
  ...
```

---

## 11. Differences from Unix Backend

If you're migrating tests from Unix to PowerShell, here's what changes:

### What stays the same
- YAML test definitions, collections, suites
- Pre/post scripts (TypeScript)
- `ctx.vars`, `ctx.request`, `ctx.response`
- `dependsOn`, `tags`, `snapshot`
- Environment files and `${VAR}` interpolation

### What changes
- **Shape assertions**: jq syntax → PowerShell syntax (see §7)
- **No external dependencies**: curl/jq/diff not needed
- **Cookie persistence**: automatic via WebSession (no `-b`/`-c` flags)
- **Form bodies**: automatic URL-encoding via PowerShell hashtable
- **Response body**: JSON auto-parsed; HTML kept as string (no manual parsing needed)
- **Snapshots**: use `Compare-Object` instead of `diff` (with Node.js fallback)

---

## 12. Common Patterns

### Login → Create → Extract → Verify

```yaml
# 1. Login (sets .ASPXAUTH cookie)
name: Login
request:
  method: POST
  path: /Account/AccountLogon
  headers:
    Content-Type: application/x-www-form-urlencoded
  body:
    inline:
      UserName: "${VIBE_USERNAME}"
      Password: "${VIBE_PASSWORD}"
response:
  status: 200
  post: |
    ctx.assert(!ctx.response.body.includes('validation-summary-errors'), 'Login failed');
```

```yaml
# 2. Create transaction (extract ID from HTML)
name: Create AR Transaction
dependsOn: auth/login-account
request:
  method: GET
  path: /Accounting/AccountsReceivable/EditPayment
response:
  status: 200
  post: |
    const match = ctx.response.body.match(/arTransId=(\d+)/);
    ctx.assert(match, 'Could not extract arTransId');
    ctx.vars.arTransId = match[1];
```

```yaml
# 3. Update customer on transaction
name: Update AR Customer
dependsOn: home/create-ar-transaction
pre: |
  ctx.request.params = {
    arTransId: ctx.vars.arTransId,
    customerId: 'DPS9518'
  };
request:
  method: POST
  path: /Accounting/AccountsReceivable/UpdateAREntryCustomer
response:
  status: 200
```

```yaml
# 4. Verify open items
name: Get Customer Open Items
dependsOn: home/update-ar-customer
pre: |
  ctx.request.params = {
    arTransId: ctx.vars.arTransId
  };
request:
  method: POST
  path: /Accounting/AccountsReceivable/GetAREntryOpenTransactionsForCustomerLite
response:
  status: 200
  post: |
    // body is already parsed JSON
    ctx.assert(ctx.response.body.recordCount === 27, 'Expected 27 open items');
```

---

## 13. Troubleshooting

### Test times out

- Check `shogun.config.yaml` has `defaults.timeout: 30` (or higher)
- Check `envs/local.env` has `TIMEOUT=30`
- VIBE's `CreatePayment` endpoint takes ~12.5s on first call (cold start)

### Cookie not being sent

- Ensure `auto_inject_auth: false` in config (Bearer token can interfere)
- Use `dependsOn` to chain login → authenticated request
- Enable `SHOGUN_DEBUG=1` to see cookie state

### `ctx.response.body` is already an object

- The PowerShell backend auto-parses JSON responses. If your post-script does
  `JSON.parse(ctx.response.body)`, it will fail. Use `ctx.response.body` directly.
- For HTML responses, `ctx.response.body` is a string — use `.match()` / `.includes()`.

### DEP0190 deprecation warnings

- Fixed in current version. The scripter now uses `npx.cmd` on Windows instead of
  `shell: true` in `spawn()`.

### PowerShell script errors

- Enable `SHOGUN_DEBUG=1` to see full stderr from PowerShell
- Check per-test log files in `runs/<run_id>/` for detailed error messages

---

## Further Reading

- [PowerShell Backend Lessons Learned](technical/powershell-backend-lessons-learned.md) — deep technical notes, gotchas, and engineering decisions
- [Architecture: PowerShell Backend v3](technical/architecture-powershell-backend-v3.md) — design specification
- [README.md](../README.md) — general shogun documentation
