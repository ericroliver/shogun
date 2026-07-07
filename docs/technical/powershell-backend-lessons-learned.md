# PowerShell Backend: Lessons Learned & Engineering Notes

> **Purpose**: Capture mistakes, discoveries, and PowerShell-specific engineering facts
> encountered during the development of shogun's PowerShell backend and the VIBE test
> integration. This document exists so we don't repeat the same hard-won lessons.
>
> **Audience**: Anyone working on the shogun engine, writing PowerShell backend code,
> or writing shogun tests that target Windows/IIS/ASP.NET applications.
>
> **Last updated**: 2026-07-07

---

## Table of Contents

1. [Mistakes Made](#1-mistakes-made)
2. [PowerShell Escaping: The Three Contexts](#2-powershell-escaping-the-three-contexts)
3. [Session & Cookie Persistence](#3-session--cookie-persistence)
4. [Windows Path Separators](#4-windows-path-separators)
5. [`spawn()` and `.cmd` Resolution on Windows](#5-spawn-and-cmd-resolution-on-windows)
6. [Form-Encoded Bodies](#6-form-encoded-bodies)
7. [HTML / Non-JSON Response Handling](#7-html--non-json-response-handling)
8. [PowerShell vs Unix Backend: Key Differences](#8-powershell-vs-unix-backend-key-differences)
9. [VIBE Application Facts](#9-vibe-application-facts)
10. [PowerShell Process Management](#10-powershell-process-management)
11. [Gotchas & Sharp Edges](#11-gotchas--sharp-edges)
12. [Recommendations for Future Work](#12-recommendations-for-future-work)

---

## 1. Mistakes Made

### 1.1 `$` Not Escaped in Double-Quoted Strings (Security)

**What happened**: The original `escapeForPowerShell` only escaped single quotes. It was
used for both single-quoted and double-quoted PowerShell strings. In double-quoted
strings, `$` is an interpolation character — unescaped `$` in user-controlled data (like
header values or URLs) could inject PowerShell variables.

**Impact**: Potential PowerShell injection via header values, URLs, or any string placed
inside a double-quoted PowerShell context.

**Fix**: Split into two functions:
- `escapeForPowerShell(str)` — for single-quoted strings. Only escapes `'` → `''`. `$` is
  literal in single-quoted strings, no escaping needed.
- `escapeForDoubleQuoted(str)` — for double-quoted strings. Escapes `"` → `` `" `` and
  `$` → `` `$ `` using backtick.

**Lesson**: PowerShell has **three** string contexts (single-quoted, double-quoted,
here-string), each with different escaping rules. Always know which context your string
will be placed into and use the correct escaper. Never use a single escape function for
all contexts.

### 1.2 Used `Invoke-RestMethod` Instead of `Invoke-WebRequest`

**What happened**: The initial implementation used `Invoke-RestMethod` for HTTP execution.
This cmdlet is designed for REST/JSON APIs and has limited control over session state,
error responses, and raw body access.

**Impact**: Could not properly capture cookies, handle non-JSON responses (HTML), or read
error response bodies when HTTP status was 4xx/5xx.

**Fix**: Switched to `Invoke-WebRequest`, which:
- Supports `-WebSession` for cookie persistence
- Provides raw `.Content` access (not auto-parsed JSON)
- Exposes `.Headers` as a dictionary
- Allows reading error response bodies from `$_.Exception.Response`

**Lesson**: `Invoke-RestMethod` is for simple JSON API calls. For anything involving
sessions, cookies, HTML, or error handling, `Invoke-WebRequest` is the right tool.

### 1.3 No Session/Cookie Persistence Across Requests

**What happened**: The initial implementation made each HTTP request independently with
no shared session. There was no way to carry authentication cookies from a login request
to subsequent requests.

**Impact**: Could not test any application that uses cookie-based authentication (which
is what most ASP.NET MVC / IIS applications use, including VIBE).

**Fix**: Added a `cookies: CookieEntry[]` field on the `PowerShellBackend` class.
- Before each request, reconstruct a `WebRequestSession` from stored cookies
- After each request, extract cookies from the session and update the jar
- Cookies persist for the lifetime of the backend instance (one full run)

**Lesson**: Session persistence is not optional for testing real web applications.
Bearer token auth is the exception, not the norm, in enterprise/IIS environments.

### 1.4 Windows Path Separators in `runner.ts`

**What happened**: `path.relative()` on Windows returns paths with `\` separators (e.g.,
`auth\login-account`). Downstream code in `loader.ts` and `runner.ts` split on `/` or
used string operations that assumed forward slashes.

**Impact**: Dependency resolution failed with `Test file not found for dep resolution:
"auth\login-account"`. Tests were marked as `dependency_failed` and skipped.

**Fix**: Added `.replace(/\\/g, '/')` after every `relative()` call that feeds into
canonical ID logic.

**Known remaining instance**: `runner.ts` line 620 (`_failures_` collection generation)
has the same pattern and may need the same fix.

**Lesson**: On Windows, **always** normalize path separators to `/` after calling
`path.relative()` or `path.join()` if the result will be used as a string key or compared
against forward-slash patterns. Consider centralizing this in a utility function.

### 1.5 `spawn('npx', ...)` Without `shell: true` on Windows

**What happened**: `scripter.ts` used `spawn('npx', ['tsx', scriptFile])` without
`shell: true`. On Windows, `npx` is `npx.cmd`, and Node.js `spawn` does not resolve `.cmd`
extensions without the `shell` option.

**Impact**: `ENOENT: no such file or directory, uv_spawn 'npx'` — pre/post scripts could
not execute.

**Fix**: Use `spawn('npx.cmd', [...])` on Windows (with `process.platform === 'win32'`
guard). This resolves the `.cmd` shim without needing `shell: true`, which avoids the
`DEP0190` deprecation warning introduced in Node.js 22+.

**Lesson**: On Windows, any `spawn()` call that invokes a `.cmd` or `.bat` shim (npx,
npm, tsc, etc.) needs either `shell: true` (deprecated, triggers DEP0190) or the explicit
`.cmd` extension. The platform-guarded `.cmd` approach is the current best practice.

### 1.6 Used Stale `shogun.exe` Binary After Engine Changes

**What happened**: After modifying `scripter.ts` and `runner.ts`, ran tests using the
pre-built `shogun.exe` from `.agents/skills/shogun-test-writer/shogun.exe` instead of the
freshly built `dist/index.js`.

**Impact**: Changes appeared to have no effect. Debugging went in circles until the
correct binary was used.

**Fix**: After engine changes, always run via `node dist/index.js` (or rebuild the
standalone binary) before testing.

**Lesson**: After engine changes, rebuild and use the fresh binary. The pre-built
`shogun.exe` in `.agents/skills/` is a snapshot — it doesn't pick up source changes
until recompiled. When debugging, first verify which binary you're actually running.

### 1.7 Multi-Line Response Bodies Broke Parsing

**What happened**: The original protocol used `BODY:<raw>` to transport response bodies
from PowerShell back to Node.js. VIBE returns HTML responses with newlines, which broke
the line-by-line parsing protocol.

**Impact**: HTML responses were truncated at the first newline, causing assertions to
fail with misleading error messages.

**Fix**: Changed body transport to base64 encoding: `B64BODY:<base64>`. Base64 has no
newlines, so it's safely transportable in the line-based protocol. Node.js decodes it
back to UTF-8.

**Lesson**: When designing a line-based IPC protocol between processes, **never** put
arbitrary text (which may contain newlines) on a single line. Either base64-encode it,
use a length-prefixed binary protocol, or use a delimiter that cannot appear in the data.

---

## 2. PowerShell Escaping: The Three Contexts

PowerShell has three string contexts, each with different escaping rules. Getting this
wrong leads to either broken scripts or security vulnerabilities.

### Single-Quoted Strings (`'...'`)

- **Behavior**: Literal strings. No interpolation. `$var` is the literal text `$var`.
- **Escape rule**: Only `'` needs escaping — double it: `'` → `''`.
- **Use for**: JSON bodies, URLs, cookie JSON, any arbitrary text that doesn't need
  interpolation.
- **Function**: `escapeForPowerShell(str)`

```typescript
// Example: JSON body
const bodyStr = JSON.stringify({ name: "O'Brien", price: 9.99 });
// bodyStr = {"name":"O'Brien","price":9.99}
const ps = `$splat.Body = '${escapeForPowerShell(bodyStr)}'`;
// Result: $splat.Body = '{"name":"O''Brien","price":9.99}'
```

### Double-Quoted Strings (`"..."`)

- **Behavior**: Interpolated strings. `$var` resolves to the variable's value. Backtick
  is the escape character.
- **Escape rules**: `"` → `` `" `` and `$` → `` `$ ``.
- **Use for**: Header values (where you need interpolation of PowerShell variables like
  `$headers`), or any context where the string is inside double quotes.
- **Function**: `escapeForDoubleQuoted(str)`

```typescript
// Example: Header value
const headerValue = 'value with "quotes" and $vars';
const ps = `$headers["X-Custom"] = "${escapeForDoubleQuoted(headerValue)}"`;
// Result: $headers["X-Custom"] = "value with `"quotes`" and `$vars"
```

### Here-Strings (`@'...'@` and `@"..."@`)

- **Behavior**: Multi-line strings. `@'...'@` is literal (no interpolation). `@"..."@"`
  is interpolated.
- **Escape rule**: For `@'...'@`, only `'` needs escaping (doubled). For `@"..."@`,
  same rules as double-quoted strings.
- **Use for**: Diff content (expected/actual text with newlines).
- **Function**: `escapeHereString(str)` (for single-quoted here-strings)

```typescript
// Example: Diff expected text
const ps = `
$expectedLines = @'
${escapeHereString(expectedText)}
'@ -split "\r?\n"
`;
```

### Decision Matrix

| String Context | Function | Characters Escaped | Escape Char |
|---------------|----------|-------------------|-------------|
| Single-quoted `'...'` | `escapeForPowerShell` | `'` only | `'` (doubled) |
| Double-quoted `"..."` | `escapeForDoubleQuoted` | `"`, `$` | `` ` `` (backtick) |
| Here-string `@'...'@` | `escapeHereString` | `'` only | `'` (doubled) |
| Here-string `@"..."@` | (not implemented) | `"`, `$` | `` ` `` (backtick) |

---

## 3. Session & Cookie Persistence

### How It Works

The `PowerShellBackend` class maintains a `cookies: CookieEntry[]` array that persists
for the lifetime of the backend instance (one full `shogun run`).

**Request flow**:
1. Before each request, the stored cookies are serialized to JSON and injected into the
   PowerShell script.
2. The PowerShell script reconstructs a `WebRequestSession` and populates it with the
   stored cookies:
   ```powershell
   $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
   $cookieList = $cookiesJson | ConvertFrom-Json
   foreach ($c in $cookieList) {
     $domain = if ($c.domain) { $c.domain } else { ([System.Uri]$uri).Host }
     $cookie = [System.Net.Cookie]::new($c.name, $c.value, $c.path, $domain)
     $session.Cookies.Add($cookie)
   }
   ```
3. The request is made with `-WebSession $session`.
4. After the response, cookies are extracted from the session and serialized back:
   ```powershell
   foreach ($c in $session.Cookies.GetCookies($uriObj)) {
     $cookieArray += @{ name = $c.Name; value = $c.Value; domain = $c.Domain; path = $c.Path }
   }
   $cookieJson = $cookieArray | ConvertTo-Json -Compress
   Write-Output "COOKIES:$cookieJson"
   ```
5. Node.js parses the `COOKIES:` line and updates `this.cookies`.

### Why This Design

- **No global PowerShell state**: Each request spawns a fresh PowerShell process. We
  can't rely on a persistent `$session` variable across invocations. Cookies must be
  serialized/deserialized between Node.js and PowerShell.
- **Single-quoted JSON**: The cookie JSON is injected into a single-quoted PowerShell
  string, so `escapeForPowerShell` is used (only `'` needs escaping).
- **Domain fallback**: If a cookie's domain is empty (which happens with some servers),
  we fall back to the request URI's host. Without this, `Cookie.Add` throws.

### CookieEntry Type

```typescript
export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
}
```

### VIBE `.ASPXAUTH` Cookie

VIBE uses standard ASP.NET forms authentication. On successful login, the server returns
an `.ASPXAUTH` cookie. This cookie is automatically captured by the session mechanism
and carried on all subsequent requests. No special handling is needed — the PowerShell
backend's cookie jar handles it transparently.

---

## 4. Windows Path Separators

### The Problem

Node.js `path.relative()` and `path.join()` use the OS-native separator:
- On Linux/macOS: `/`
- On Windows: `\`

Shogun's canonical ID system uses forward slashes as the separator (e.g.,
`auth/login-account`). On Windows, `path.relative()` produces `auth\login-account`,
which doesn't match any forward-slash-based lookups.

### Where It Bit Us

1. **`runner.ts` line 164** (dependency resolution): `canonicalId` was used to look up
   tests in maps keyed by forward-slash IDs. Fixed with `.replace(/\\/g, '/')`.
2. **`runner.ts` line 620** (`_failures_` collection generation): Same pattern, not yet
   fixed. Will produce incorrect YAML on Windows.
3. **`loader.ts`**: May have similar patterns — needs audit.

### The Fix Pattern

```typescript
// BAD — produces backslashes on Windows
const canonicalId = relative(collectionsDir, file).replace(/\.yaml$/, '');

// GOOD — normalize to forward slashes
const canonicalId = relative(collectionsDir, file)
  .replace(/\.yaml$/, '')
  .replace(/\\/g, '/');
```

### Recommendation

Create a utility function:
```typescript
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}
```
And use it everywhere a path is used as a string key or compared against patterns.
Alternatively, use `path.posix.relative()` which always uses `/` regardless of platform
— but this requires both inputs to already use the same separator.

---

## 5. `spawn()` and `.cmd` Resolution on Windows

### The Problem

On Windows, executables like `npx`, `npm`, `tsc` are actually `.cmd` batch files
(`npx.cmd`, `npm.cmd`). Node.js `child_process.spawn()` does not resolve `.cmd`
extensions by default — it looks for the exact filename.

### The Fix (v2 — DEP0190-safe)

Node.js 22+ emits `DEP0190` deprecation warnings when `spawn()` is called with
`shell: true`. The fix uses platform-aware binary names instead:

```typescript
const isWin = process.platform === 'win32';
const proc = spawn(isWin ? 'npx.cmd' : 'npx', ['tsx', scriptFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
  // No shell: true — avoids DEP0190 deprecation warning
});
```

By using `npx.cmd` directly on Windows, we sidestep the need for `shell: true` entirely
while still resolving the `.cmd` shim that Windows uses for npm-installed CLIs.

### Historical note (v1 fix)

The original fix used `shell: process.platform === 'win32'`. This works but triggers
`DEP0190` in Node.js 22+. The `npx.cmd` approach above is the current preferred fix.

### When This Matters

Any `spawn()` call on Windows that targets:
- `npx` (always `.cmd` on Windows)
- `npm` (always `.cmd` on Windows)
- `tsc` (if installed globally, may be `.cmd`)
- Any other npm-installed CLI binary

---

## 6. Form-Encoded Bodies

### The Problem

The initial `buildBodyArg` assumed all request bodies were JSON. VIBE's login endpoint
expects `application/x-www-form-urlencoded` data.

### The Fix

`buildBodyArg` now checks the `Content-Type` header:

```typescript
const isFormEncoded = contentType.toLowerCase()
  .includes('application/x-www-form-urlencoded');

if (isFormEncoded && typeof body === 'object' && body !== null) {
  // Build PowerShell hashtable — Invoke-WebRequest auto URL-encodes it
  const pairs = Object.entries(body)
    .map(([k, v]) => `${k} = '${escapeForPowerShell(String(v))}'`)
    .join('; ');
  return `$splat.Body = @{ ${pairs} }`;
}

// Otherwise: JSON body in a single-quoted string
const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
return `$splat.Body = '${escapeForPowerShell(bodyStr)}'`;
```

### Why a Hashtable?

When you pass a PowerShell hashtable (`@{ key='value' }`) as the `-Body` parameter to
`Invoke-WebRequest` with `Content-Type: application/x-www-form-urlencoded`, PowerShell
automatically URL-encodes the key-value pairs into the correct format. This is cleaner
and more reliable than manually URL-encoding in TypeScript.

### RequestBody Schema Resolution

The YAML body field can be either:
```yaml
body:
  inline:
    UserName: "${VIBE_USERNAME}"
    Password: "${VIBE_PASSWORD}"
```
or:
```yaml
body:
  file: ./fixtures/login-body.json
```

`buildBodyArg` resolves both forms before deciding how to format the PowerShell body.

---

## 7. HTML / Non-JSON Response Handling

### The Problem

VIBE returns HTML pages, not JSON. The original PowerShell backend assumed JSON
responses and tried to parse them with `ConvertFrom-Json`, which fails on HTML.

### The Fix (Base64 Body Transport)

Response bodies are base64-encoded in the PowerShell output protocol:

```powershell
# In the PowerShell script:
$bodyB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bodyContent))
Write-Output "B64BODY:$bodyB64"
```

```typescript
// In Node.js parsing:
if (line.startsWith('B64BODY:')) {
  const b64 = line.slice(8);
  bodyRaw = Buffer.from(b64, 'base64').toString('utf8');
}
```

### Why Base64?

- HTML responses contain newlines, quotes, and special characters that break the
  line-based IPC protocol.
- Base64 is a single line of `[A-Za-z0-9+/=]` characters — no newlines, no special
  characters to escape.
- The `BODY:<raw>` legacy protocol is kept for backward compatibility but should not be
  used for multi-line content.

### JSON Auto-Detection

After decoding the base64 body, `parsePowerShellResponse` attempts to parse it as JSON.
If it starts with `{` or `[`, it's parsed as an object. Otherwise, it stays as a string.

```typescript
let body: unknown = bodyRaw;
try {
  if (bodyRaw.trim().startsWith('{') || bodyRaw.trim().startsWith('[')) {
    body = JSON.parse(bodyRaw);
  }
} catch { /* keep as string */ }
```

### Snapshot Normalization for Non-JSON

`normalizeJson` wraps JSON parsing in a try/catch. If the body is not valid JSON (e.g.,
HTML), it returns the raw string unchanged. This means snapshots can theoretically work
with HTML, but it's not recommended — HTML is too volatile for snapshot testing.

---

## 8. PowerShell vs Unix Backend: Key Differences

| Aspect | Unix Backend | PowerShell Backend |
|--------|-------------|-------------------|
| HTTP execution | `curl` | `Invoke-WebRequest` |
| JSON parsing | `jq` | `ConvertFrom-Json` |
| JSON querying | `jq` expressions | PowerShell expressions |
| Diffing | `diff` | `Compare-Object` (with Node.js fallback) |
| Session/cookies | curl `-b`/`-c` cookie jar | `WebRequestSession` (serialized via JSON) |
| Form-encoded body | `--data-urlencode` | PowerShell hashtable (`@{ k='v' }`) |
| Body transport | Raw stdout | Base64-encoded (`B64BODY:`) |
| Process spawning | `spawn('curl', ...)` | `spawn('pwsh.exe', ...)` or `powershell.exe` |
| Escaping | Shell escaping (single quotes) | Three contexts (see §2) |
| Redirects | `curl -L` | `Invoke-WebRequest -MaximumRedirection` |
| Error handling | curl exit codes + stderr | `$_.Exception.Response` |
| Non-JSON responses | Raw body (no issue) | Base64 transport (solves newline issue) |
| Auth | Bearer token via `Authorization` header | Cookie-based via WebSession (or Bearer) |

---

## 9. VIBE Application Facts

### Application Type
- ASP.NET MVC application (not a REST API)
- Runs on IIS / Kestrel at `http://localhost:3071/`
- Returns HTML by default (not JSON)

### Authentication
- Uses ASP.NET Forms Authentication
- Login endpoint: `POST /Account/AccountLogon`
- Body format: `application/x-www-form-urlencoded`
- Required form fields:
  - `UserName`
  - `Password`
  - `RememberMe` (`"true"` or `"false"`)
  - `X-Requested-With` (`XMLHttpRequest`)
- Required headers:
  - `Content-Type: application/x-www-form-urlencoded`
  - `X-Requested-With: XMLHttpRequest`
  - `Origin: http://localhost:3071`
  - `Referer: http://localhost:3071/`

### Login Response
- **Success**: HTTP 200, body is `"Comtrya!"`, `.ASPXAUTH` cookie is set
- **Failure**: HTTP 200, body contains `validation-summary-errors` with
  "The user name or password provided is incorrect."

### Confirmed Credentials
- `eoliver` / `3minepoint` — works
- `blove` / `2minepoint` — does NOT work (incorrect password)

### Unauthenticated Behavior
- GET `/` without a valid session cookie returns the login page containing
  "You must Log On"
- With a valid session cookie, GET `/` returns the authenticated home page

### Important Note
VIBE is **not** a REST API. It's a traditional MVC web application. This means:
- Most responses are HTML, not JSON
- Authentication is cookie-based, not token-based
- `auto_inject_auth: false` must be set in `shogun.config.yaml` (no Bearer token)
- Assertions should check HTML content (string includes), not JSON shapes
- Snapshots are not useful for HTML pages (too volatile)

---

## 10. PowerShell Process Management

### How shogun Spawns PowerShell

The `spawnPowerShell` method tries `pwsh.exe` (PowerShell Core / 7+) first, then falls
back to `powershell.exe` (Windows PowerShell 5.1):

```typescript
private async spawnPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const trySpawn = (cmd: string) => {
      const proc = spawn(cmd, ['-NoProfile', '-NonInteractive', '-Command', '-']);
      // ... capture stdout/stderr ...
      proc.stdin.write(script);
      proc.stdin.end();
      // ...
    };
    try { trySpawn('pwsh.exe'); } catch { trySpawn('powershell.exe'); }
  });
}
```

### Key Flags

- `-NoProfile`: Skips loading the user's PowerShell profile. Critical for speed and
  reproducibility — profiles can contain slow scripts or modify environment.
- `-NonInteractive`: Prevents PowerShell from prompting for input (which would hang
  forever in a non-interactive process).
- `-Command -`: Reads the script from stdin. This avoids command-line length limits
  (Windows has a 32,767 character limit for command-line arguments).

### Why stdin Instead of `-Command <script>`?

PowerShell command-line arguments have a length limit. Complex scripts with large JSON
bodies or many headers can exceed it. Piping the script via stdin avoids this limit
entirely.

### Performance Considerations

Each `executeRequest` call spawns a new PowerShell process. This is slow (~200-500ms
per spawn on Windows). For test suites with many tests, this adds up. Future
optimization: a persistent PowerShell process that stays alive and receives scripts via
stdin, responding with structured output. This would eliminate the process spawn
overhead.

---

## 11. Gotchas & Sharp Edges

### `ConvertTo-Json` Depth Limit

PowerShell's `ConvertTo-Json` has a default depth of 2. Deeply nested objects get
truncated. Always use `-Depth 100` (or higher) when serializing:

```powershell
$json | ConvertTo-Json -Depth 100
```

### `ConvertTo-Json` Single-Element Arrays

When a PowerShell array has exactly one element, `ConvertTo-Json` serializes it as a
single object, not an array:

```powershell
@( @{ name = 'test' } ) | ConvertTo-Json
# Produces: { "name": "test" }
# NOT: [ { "name": "test" } ]
```

This is why the cookie serialization has special handling:
```powershell
if ($cookieArray.Count -eq 1) {
  $cookieJson = '[' + ($cookieArray[0] | ConvertTo-Json -Compress) + ']'
}
```

### `Invoke-WebRequest` Throws on Non-2xx

By default, `Invoke-WebRequest` throws an exception for HTTP status codes >= 400. The
response object is not returned — it's in `$_.Exception.Response`. You must catch and
extract the status code and body from the exception:

```powershell
try {
  $response = Invoke-WebRequest @splat
  $statusCode = [int]$response.StatusCode
} catch {
  if ($null -ne $_.Exception.Response) {
    $statusCode = [int]$_.Exception.Response.StatusCode
    $bodyContent = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  }
}
```

### `$ErrorActionPreference = "Stop"`

Setting this at the top of the script makes all cmdlets throw on error. Without it,
PowerShell may silently continue on non-terminating errors, producing empty or
incomplete output that's hard to debug.

### Cookie Domain Mismatch

When reconstructing cookies, if the domain doesn't match the request URI's host,
`WebRequestSession` may not send the cookie. The domain fallback to `([System.Uri]$uri).Host`
handles this, but it's worth watching for.

### `Select-Object -First N` vs `head`

On Windows, Unix tools like `head`, `tail`, `grep` are not available (unless WSL or Git
Bash is installed). Use PowerShell equivalents:
- `head -n 20` → `Select-Object -First 20`
- `grep "pattern"` → `Select-String -Pattern "pattern"`
- `tail -n 20` → `Select-Object -Last 20`

### PowerShell on Windows Uses `\r\n` Line Endings

PowerShell output uses `\r\n` (CRLF) on Windows. When splitting lines in Node.js, always
split on `\n` and trim, or split on `/\r?\n/` to handle both.

---

## 12. Recommendations for Future Work

### 12.1 Persistent PowerShell Process

Spawning a new PowerShell process per request is the biggest performance bottleneck.
Consider a persistent process that reads scripts from stdin and writes structured output
to stdout. This would reduce per-request latency from ~300ms to ~50ms.

### 12.2 HTML Assertion Mode

Currently, assertions on HTML responses must be done in `post` scripts using string
operations (`body.includes('text')`). Consider adding a built-in `contains_text`
assertion type in the YAML test definition:

```yaml
response:
  status: 200
  contains:
    - "Comtrya"
    - "Welcome"
```

### 12.3 Path Normalization Utility

Create a centralized `toForwardSlash()` utility and use it everywhere `path.relative()`
or `path.join()` results are used as string keys or compared against patterns. Audit
all files, not just `runner.ts`.

### 12.4 Cross-Platform CI Testing

The Windows path separator bugs were only caught because we ran on Windows. Set up CI
that runs the test suite on both Windows and Linux to catch these issues early.

### 12.5 PowerShell Error Detail in Logs

When a PowerShell script fails (non-zero exit), the stderr is captured but may not
surface clearly in test logs. Consider writing the full PowerShell script and its
stderr to the per-test log file when `SHOGUN_DEBUG` is set.

### 12.6 Session Reset Between Suites

Currently, cookies persist for the entire run. If a suite intentionally tests
unauthenticated behavior, there's no way to clear cookies mid-run. Consider adding a
`ctx.clearSession()` method or a collection-level `clear_session: true` option.

### 12.7 Fix `runner.ts` Line 620

The `_failures_` collection generation at line 620 uses `relative()` without path
normalization. On Windows, this will produce backslash-separated names in the YAML.
Apply the same `.replace(/\\/g, '/')` fix.

### 12.8 PowerShell Version Detection

The backend tries `pwsh.exe` first, then falls back to `powershell.exe`. But it doesn't
log which one was found. Consider logging the PowerShell version at startup for
debugging purposes.

---

## Appendix: IPC Protocol

The communication protocol between Node.js and the PowerShell subprocess uses structured
text lines:

```
STATUS:<http_status_code>
HEADERS:<compressed_json>
B64BODY:<base64_encoded_body>
COOKIES:<compressed_json_array>
ERROR:<message>
```

- All lines are single-line (no embedded newlines).
- `B64BODY:` is the primary body transport. `BODY:` is a legacy fallback for single-line
  content.
- `COOKIES:` is a JSON array of `{ name, value, domain, path }` objects.
- `HEADERS:` is a compressed JSON object of response headers.
- `ERROR:` appears when the PowerShell script itself errored (not HTTP errors — those
  are captured in `STATUS:` and `B64BODY:`).

---

## Appendix: File Reference

| File | Role |
|------|------|
| `src/backends/powershell-backend.ts` | PowerShell backend implementation |
| `src/backends/backend-interface.ts` | `BackendExecutor` interface |
| `src/backends/backend-factory.ts` | Backend selection factory |
| `src/backends/backend-global.ts` | Global backend instance |
| `src/tests/powershell-helpers.test.ts` | Unit tests for PowerShell helpers |
| `src/executor.ts` | Thin wrapper delegating to backend |
| `src/asserter.ts` | Thin wrapper delegating to backend |
| `src/runner.ts` | Test runner (has path separator fix at line 164) |
| `src/scripter.ts` | Script executor (has `shell: true` fix for Windows) |
| `shogun-tests/shogun.config.yaml` | VIBE test repo config |
| `shogun-tests/envs/local.env` | VIBE credentials and base URL |
| `shogun-tests/tests/collections/auth/` | VIBE login test |
| `shogun-tests/tests/collections/home/` | VIBE authenticated GET test |
| `shogun-tests/tests/suites/smoke.yaml` | Smoke suite (auth → home) |
