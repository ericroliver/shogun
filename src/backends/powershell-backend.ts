/**
 * src/backends/powershell-backend.ts
 *
 * PowerShell backend — uses PowerShell cmdlets instead of curl/jq/diff.
 *
 * Tools used:
 *   - Invoke-WebRequest  → HTTP execution (with session/cookie support)
 *   - ConvertFrom-Json   → JSON parsing
 *   - Compare-Object     → diff (with Node.js fallback)
 *
 * Key features:
 *   - Cookie/session persistence across requests via WebSession
 *   - Form-encoded body support (hashtable → URL-encoded)
 *   - HTML/non-JSON response handling (base64 body transport)
 *   - Proper escaping for single-quoted and double-quoted PS strings
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type {
  ShogunRequest,
  ShogunResponse,
  EnvVars,
  ShapeAssertionResult,
  TestDefinition,
  ShogunConfig,
  SseEvent,
} from '../types.js';

import type {
  BackendExecutor,
  QueryResult,
  ExecutorOptions,
  SnapshotResult,
  DependencyCheck,
  AssertContext,
} from '../backend-interface.js';

import { parseSseResponse, isSseContentType, getAssertionBody } from '../sse.js';

// ===========================================================================
// Types
// ===========================================================================

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
}

// ===========================================================================
// Pure helper functions — exported for unit testing
// ===========================================================================

/**
 * Escape a string for use in a PowerShell single-quoted string.
 * Only single quotes need escaping (doubled: ' → '').
 * Double quotes and $ are literal in single-quoted strings — no escaping needed.
 */
export function escapeForPowerShell(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Escape a string for use in a PowerShell double-quoted string.
 * Escapes " (→ `") and $ (→ `$) which are interpolation characters.
 * Single quotes are literal in double-quoted strings — no escaping needed.
 */
export function escapeForDoubleQuoted(str: string): string {
  return str.replace(/"/g, '`"').replace(/\$/g, '`$');
}

/**
 * Escape a string for use in a PowerShell here-string (@' ... '@).
 * Only single quotes need escaping (doubled: ' → '').
 */
export function escapeHereString(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Parse the structured output from the PowerShell script.
 *
 * Protocol lines:
 *   STATUS:<code>       — HTTP status code
 *   HEADERS:<json>      — Response headers as compressed JSON
 *   B64BODY:<base64>    — Response body, base64-encoded (handles multi-line HTML)
 *   COOKIES:<json>      — Cookie jar as JSON array
 *   ERROR:<message>     — Error message (when status is 0 or error occurred)
 *
 * Also supports legacy BODY:<raw> for backward compatibility (single-line only).
 */
export function parsePowerShellResponse(output: string, duration: number): ShogunResponse {
  const lines = output.split('\n');
  let status = 0;
  const headers: Record<string, string> = {};
  let bodyRaw = '';

  for (const line of lines) {
    if (line.startsWith('STATUS:')) {
      status = parseInt(line.slice(7), 10) || 0;
    } else if (line.startsWith('HEADERS:')) {
      try {
        const h = JSON.parse(line.slice(8));
        if (h && typeof h === 'object') {
          for (const [k, v] of Object.entries(h)) {
            headers[(k as string).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          }
        }
      } catch { /* ignore */ }
    } else if (line.startsWith('B64BODY:')) {
      const b64 = line.slice(8);
      try {
        bodyRaw = Buffer.from(b64, 'base64').toString('utf8');
      } catch {
        bodyRaw = '';
      }
    } else if (line.startsWith('BODY:')) {
      // Legacy: raw body (single line only, for backward compat)
      bodyRaw = line.slice(5);
    } else if (line.startsWith('ERROR:')) {
      bodyRaw = line.slice(6);
    }
  }

  let body: unknown = bodyRaw;
  let events: SseEvent[] | undefined;

  // SSE auto-parsing: when Content-Type is text/event-stream, parse the SSE
  // events so that body/events are structured data instead of raw SSE text.
  const ct = headers['content-type'] ?? '';
  if (isSseContentType(ct)) {
    const parsed = parseSseResponse(bodyRaw);
    body = parsed.body;
    events = parsed.events;
  } else {
    try {
      if (bodyRaw.trim().startsWith('{') || bodyRaw.trim().startsWith('[')) {
        body = JSON.parse(bodyRaw);
      }
    } catch { /* keep as string */ }
  }

  return {
    status,
    headers,
    body,
    raw: bodyRaw,
    duration,
    curlMs: duration,
    events,
  };
}

/**
 * Parse cookies from the PowerShell output's COOKIES: line.
 * Returns an empty array if no COOKIES line or invalid JSON.
 */
export function parseCookies(output: string): CookieEntry[] {
  for (const line of output.split('\n')) {
    if (line.startsWith('COOKIES:')) {
      try {
        const parsed = JSON.parse(line.slice(8));
        if (Array.isArray(parsed)) {
          return parsed as CookieEntry[];
        }
      } catch { /* ignore */ }
    }
  }
  return [];
}

/**
 * Build the full URL including query params.
 */
export function buildPsUrl(req: ShogunRequest): string {
  let url = req.url;
  const params = req.params;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

/**
 * Build the headers object, merging defaults, request headers, and optional auth.
 */
export function buildPsHeaders(
  req: ShogunRequest,
  env: EnvVars,
  autoInjectAuth: boolean = true,
  contentType: string = 'application/json',
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept': 'application/json',
    ...req.headers,
  };
  if (autoInjectAuth && env.AUTH_TOKEN && !headers['Authorization']) {
    const token = env.AUTH_TOKEN;
    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }
  return headers;
}

/**
 * Format headers as PowerShell assignments using double-quoted strings.
 * Uses escapeForDoubleQuoted to properly escape " and $ in header values.
 */
export function formatHeadersForPowerShell(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `$headers["${k}"] = "${escapeForDoubleQuoted(v)}"`)
    .join('\n      ');
}

/**
 * Build the PowerShell body assignment for the request.
 *
 * Resolution:
 *   1. If body is a RequestBody object ({ inline: ... } or { file: ... }), resolve it
 *   2. If Content-Type is form-encoded and body is an object, build a PS hashtable
 *   3. Otherwise, JSON-stringify and use single-quoted string
 */
export function buildBodyArg(req: ShogunRequest): string {
  if (req.body === undefined || req.body === null) return '';

  // Resolve body from inline/file wrapper (RequestBody schema from YAML)
  let body: unknown = req.body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const rb = body as { inline?: unknown; file?: string };
    if (rb.inline !== undefined) {
      body = rb.inline;
    } else if (rb.file !== undefined) {
      try {
        body = readFileSync(rb.file, 'utf8');
      } catch {
        body = '';
      }
    }
  }

  if (body === undefined || body === null || body === '') return '';

  // Check Content-Type for form-encoded
  const contentType = req.headers?.['Content-Type'] ?? req.headers?.['content-type'] ?? '';
  const isFormEncoded = contentType.toLowerCase().includes('application/x-www-form-urlencoded');

  if (isFormEncoded && typeof body === 'object' && body !== null && !Array.isArray(body)) {
    // Build URL-encoded form body string for HttpWebRequest
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) return '';
    const pairs = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    // $bodyStr is used later in the HttpWebRequest script
    return `$bodyStr = '${escapeForPowerShell(pairs)}'`;
  }

  // JSON body (string or object) — single-quoted string
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return `$bodyStr = '${escapeForPowerShell(bodyStr)}'`;
}

/**
 * Convert an ignore field spec to PowerShell property removal.
 */
export function convertIgnoreFieldToPowerShell(field: string): string {
  const key = field.startsWith('.') ? field.slice(1) : field;
  return `$json.PSObject.Properties.Remove("${key}")`;
}

/**
 * Node.js-based diff (fallback or primary). Produces unified-diff-like output.
 */
export function formatSimpleDiff(expected: string, actual: string): string {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const maxLen = Math.max(expLines.length, actLines.length);
  const diffLines: string[] = ['--- expected', '+++ actual'];
  let hasDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const e = expLines[i];
    const a = actLines[i];
    if (e !== a) {
      hasDiff = true;
      if (e !== undefined) diffLines.push(`- ${e}`);
      if (a !== undefined) diffLines.push(`+ ${a}`);
    } else {
      diffLines.push(`  ${e}`);
    }
  }
  return hasDiff ? diffLines.join('\n') : '';
}

// ===========================================================================
// PowerShell Backend class
// ===========================================================================

export class PowerShellBackend implements BackendExecutor {
  readonly name = 'powershell' as const;

  /** Cookie jar — persisted across requests within a single run */
  private cookies: CookieEntry[] = [];

  /** Clear all stored cookies (for teardown/reset) */
  clearCookies(): void {
    this.cookies = [];
  }

  /** Get current cookies (for inspection/debugging) */
  getCookies(): CookieEntry[] {
    return [...this.cookies];
  }

  // =======================================================================
  // HTTP execution — Invoke-WebRequest with -WebSession for cookie persistence
  // (Proven pattern from reference capture-customer-openitems.ps1 script.
  //  WebSession is reconstructed from the cookie jar on each call since
  //  each PowerShell invocation is a separate process.)
  // =======================================================================

  async executeRequest(
    req: ShogunRequest,
    env: EnvVars,
    opts: ExecutorOptions = {},
  ): Promise<ShogunResponse> {
    const timeout = opts.timeout ?? parseInt(env.TIMEOUT ?? '10', 10);
    const maxRedirs = opts.followRedirects === false ? 0 : 5;
    const url = buildPsUrl(req);
    const method = req.method.toUpperCase();
    const headers = buildPsHeaders(req, env, opts.autoInjectAuth !== false, opts.contentType);
    const bodyArg = buildBodyArg(req);
    const cookiesJson = JSON.stringify(this.cookies);

    const psScript = `
$ErrorActionPreference = "Stop"

# Build headers hashtable
$headers = @{}
${formatHeadersForPowerShell(headers)}

# Reconstruct WebSession from stored cookies (each PS call is a separate process)
$cookiesJson = '${escapeForPowerShell(cookiesJson)}'
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
if ($cookiesJson -ne '[]' -and $cookiesJson -ne '') {
  try {
    $cookieList = $cookiesJson | ConvertFrom-Json
    foreach ($c in $cookieList) {
      try {
        $session.Cookies.Add([System.Net.Cookie]::new([string]$c.name, [string]$c.value, [string]$c.path, [string]$c.domain))
      } catch {}
    }
  } catch {}
}

$uri = '${escapeForPowerShell(url)}'
$method = '${method}'
$timeoutSec = ${timeout}
$maxRedirs = ${maxRedirs}

${bodyArg}

# Extract Content-Type from headers (Invoke-WebRequest prefers -ContentType parameter)
$contentType = $null
$ctKey = $null
foreach ($key in @($headers.Keys)) {
  if ($key -ieq 'Content-Type') {
    $contentType = [string]$headers[$key]
    $ctKey = $key
  }
}
if ($ctKey) { $headers.Remove($ctKey) }

# Build Invoke-WebRequest parameters (splatting)
$params = @{
  Uri = $uri
  Method = $method
  WebSession = $session
  TimeoutSec = $timeoutSec
  UseBasicParsing = $true
  Headers = $headers
  MaximumRedirection = $maxRedirs
}

if ($contentType) {
  $params.ContentType = $contentType
}

# Add body if present
if ($bodyStr) {
  $params.Body = $bodyStr
}

$statusCode = 0
$bodyContent = ''
$responseHeaders = @{}

try {
  $response = Invoke-WebRequest @params
  $statusCode = [int]$response.StatusCode
  $bodyContent = $response.Content

  # Collect response headers
  foreach ($key in $response.Headers.Keys) {
    $responseHeaders[$key] = ($response.Headers[$key] -join ', ')
  }
} catch {
  # PowerShell throws on non-2xx status codes (both 5.1 and 7.x)
  $err = $_
  if ($err.Exception.Response) {
    try { $statusCode = [int]$err.Exception.Response.StatusCode } catch {}
    # ErrorDetails.Message works in both PS 5.1 and PS 7 — contains response body as string
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) {
      $bodyContent = $err.ErrorDetails.Message
    } else {
      # PS 5.1 fallback: GetResponseStream() on HttpWebResponse
      try {
        $stream = $err.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $bodyContent = $reader.ReadToEnd()
        $reader.Close()
      } catch {
        $bodyContent = $err.Exception.Message
      }
    }
    # Headers: PS 7 uses HttpResponseMessage headers, PS 5.1 uses WebHeaderCollection
    try {
      $respHeaders = $err.Exception.Response.Headers
      if ($respHeaders -is [System.Net.Http.Headers.HttpResponseHeaders]) {
        foreach ($h in $respHeaders) {
          $responseHeaders[$h.Key] = ($h.Value -join ', ')
        }
      } else {
        foreach ($key in $respHeaders.AllKeys) {
          $responseHeaders[$key] = ($respHeaders.GetValues($key) -join ', ')
        }
      }
    } catch {}
  } else {
    $bodyContent = $err.Exception.Message
  }
}

# Extract cookies from session (updated by Invoke-WebRequest automatically)
$cookieArray = @()
try {
  $uriObj = [System.Uri]$uri
  $sessionCookies = $session.Cookies.GetCookies($uriObj)
  foreach ($c in $sessionCookies) {
    $cookieArray += @{ name = $c.Name; value = $c.Value; domain = $c.Domain; path = $c.Path }
  }
} catch {}

# Also carry forward existing cookies not returned in this response
if ($cookiesJson -ne '[]' -and $cookiesJson -ne '') {
  try {
    $existing = $cookiesJson | ConvertFrom-Json
    foreach ($c in $existing) {
      $alreadyHave = $false
      foreach ($nc in $cookieArray) {
        if ($nc.name -eq $c.name) { $alreadyHave = $true; break }
      }
      if (-not $alreadyHave) {
        $cookieArray += @{ name = [string]$c.name; value = [string]$c.value; domain = [string]$c.domain; path = [string]$c.path }
      }
    }
  } catch {}
}

if ($cookieArray.Count -eq 0) {
  $cookieJson = '[]'
} elseif ($cookieArray.Count -eq 1) {
  $cookieJson = '[' + ($cookieArray[0] | ConvertTo-Json -Compress) + ']'
} else {
  $cookieJson = $cookieArray | ConvertTo-Json -Compress
}

# Base64 encode body for safe transport (handles multi-line HTML)
$bodyB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bodyContent))

# Serialize headers
$headersJson = '{}'
try {
  if ($responseHeaders -and $responseHeaders.Count -gt 0) {
    $headersJson = $responseHeaders | ConvertTo-Json -Compress
    if ($headersJson -isnot [string]) { $headersJson = '{}' }
  }
} catch {}

Write-Output "STATUS:$statusCode"
Write-Output "HEADERS:$headersJson"
Write-Output "B64BODY:$bodyB64"
Write-Output "COOKIES:$cookieJson"
`;

    const startTime = Date.now();
    const output = await this.spawnPowerShell(psScript);
    const duration = Date.now() - startTime;

    // Parse response
    const response = parsePowerShellResponse(output, duration);

    // Update cookie jar from response
    this.cookies = parseCookies(output);

    return response;
  }

  // =======================================================================
  // JSON query / PowerShell shape assertions
  // =======================================================================

  async runJsonQuery(json: string, expression: string): Promise<QueryResult> {
    const psScript = `
      try {
        $json = '${escapeForPowerShell(json)}' | ConvertFrom-Json
        $result = ${expression}
        
        if ($result -is [bool]) {
          Write-Output $result.ToString().ToLower()
        } elseif ($null -eq $result) {
          Write-Output "false"
        } elseif ($result -is [int] -or $result -is [long]) {
          Write-Output ($result -ne 0).ToString().ToLower()
        } else {
          $asBool = [bool]$result
          Write-Output $asBool.ToString().ToLower()
        }
      } catch {
        Write-Error "Assertion failed: $_"
        exit 1
      }
    `;

    try {
      const output = await this.spawnPowerShell(psScript);
      const passed = output.trim().toLowerCase() === 'true';
      return { passed };
    } catch (err: unknown) {
      return { passed: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async runShapeAssertions(
    rawBody: string,
    expressions: string[],
  ): Promise<ShapeAssertionResult[]> {
    const results: ShapeAssertionResult[] = [];
    for (const expr of expressions) {
      const result = await this.runJsonQuery(rawBody, expr);
      results.push({
        expr,
        passed: result.passed,
        error: result.error,
      });
    }
    return results;
  }

  // =======================================================================
  // JSON normalization for snapshots
  // =======================================================================

  async normalizeJson(raw: string, ignoreFields: string[]): Promise<string> {
    if (!raw.trim()) return '';

    const ignoreLines = ignoreFields
      .map(f => convertIgnoreFieldToPowerShell(f))
      .join('\n');

    const psScript = `
      function Sort-JsonKeys($obj) {
        if ($obj -is [PSCustomObject]) {
          $sorted = [ordered]@{}
          $obj.PSObject.Properties | Sort-Object Name | ForEach-Object {
            $sorted[$_.Name] = Sort-JsonKeys $_.Value
          }
          return [PSCustomObject]$sorted
        } elseif ($obj -is [Array]) {
          return $obj | ForEach-Object { Sort-JsonKeys $_ }
        } else {
          return $obj
        }
      }

      try {
        $json = '${escapeForPowerShell(raw)}' | ConvertFrom-Json
        ${ignoreLines}
        $sorted = Sort-JsonKeys $json
        $output = $sorted | ConvertTo-Json -Depth 100
        Write-Output $output
      } catch {
        Write-Output '${escapeForPowerShell(raw)}'
      }
    `;

    try {
      const output = await this.spawnPowerShell(psScript);
      return output.trim();
    } catch {
      return raw.trim();
    }
  }

  // =======================================================================
  // Diff — Compare-Object (with Node.js fallback)
  // =======================================================================

  async runDiff(expected: string, actual: string): Promise<string> {
    const psScript = `
      $expectedLines = @'
${escapeHereString(expected)}
'@ -split "\\r?\\n"

      $actualLines = @'
${escapeHereString(actual)}
'@ -split "\\r?\\n"

      $diff = Compare-Object $expectedLines $actualLines -CaseSensitive

      if ($diff) {
        $lines = @("--- expected", "+++ actual")
        foreach ($d in $diff) {
          if ($d.SideIndicator -eq "<=") {
            $lines += "- " + $d.InputObject
          } else {
            $lines += "+ " + $d.InputObject
          }
        }
        Write-Output ($lines -join "\n")
      } else {
        Write-Output ""
      }
    `;

    try {
      const output = await this.spawnPowerShell(psScript);
      const result = output.trim();
      return result;
    } catch {
      return formatSimpleDiff(expected, actual);
    }
  }

  // =======================================================================
  // Snapshot assertion
  // =======================================================================

  async runSnapshotAssertion(ctx: AssertContext): Promise<SnapshotResult> {
    const fs = require('node:fs');
    const path = require('node:path');

    const expectedPath = this.getExpectedPath(ctx);

    if (ctx.snapshotMode) {
      await this.writeSnapshot(getAssertionBody(ctx.response), ctx.test as TestDefinition, ctx.config as ShogunConfig, expectedPath);
      return { passed: true };
    }

    if (!fs.existsSync(expectedPath)) {
      return { passed: false, needsBaseline: true };
    }

    const ignoreFields = [
      ...((ctx.config as ShogunConfig).ignore_fields_global ?? []),
      ...((ctx.test as TestDefinition).response?.ignore_fields ?? []),
    ];

    const normalizedActual = await this.normalizeJson(getAssertionBody(ctx.response), ignoreFields);
    const expectedRaw = fs.readFileSync(expectedPath, 'utf8');
    const normalizedExpected = await this.normalizeJson(expectedRaw, ignoreFields);

    if (normalizedActual === normalizedExpected) {
      return { passed: true };
    }

    const diff = await this.runDiff(normalizedExpected, normalizedActual);
    return { passed: false, diff };
  }

  async writeSnapshot(
    raw: string,
    test: TestDefinition,
    config: ShogunConfig,
    expectedPath?: string,
  ): Promise<void> {
    const fs = require('node:fs');
    const path = require('node:path');

    const p = expectedPath ?? this.getExpectedPathFromTest(test, config);
    const ignoreFields = [
      ...(config.ignore_fields_global ?? []),
      ...(test.response?.ignore_fields ?? []),
    ];
    const normalized = await this.normalizeJson(raw, ignoreFields);

    if (!normalized.trim()) {
      if (process.env.SHOGUN_DEBUG) {
        console.warn(`[powershell-backend] writeSnapshot suppressed — normalized content is empty`);
      }
      return;
    }

    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, normalized + '\n', 'utf8');
  }

  // =======================================================================
  // Dependency checks
  // =======================================================================

  async checkDependencies(): Promise<DependencyCheck[]> {
    const results: DependencyCheck[] = [];

    try {
      const version = await this.spawnPowerShell('$PSVersionTable.PSVersion.ToString()');
      results.push({
        name: 'powershell.exe',
        found: true,
        version: version.trim(),
        optional: false,
      });
    } catch {
      results.push({
        name: 'powershell.exe',
        found: false,
        optional: false,
      });
    }

    // Invoke-WebRequest is a built-in cmdlet — always available
    results.push({
      name: 'Invoke-WebRequest',
      found: true,
      optional: false,
    });

    results.push({ name: 'curl', found: false, optional: true });
    results.push({ name: 'jq', found: false, optional: true });

    return results;
  }

  // =======================================================================
  // Private helpers
  // =======================================================================

  /**
   * Spawn PowerShell, trying pwsh.exe (PowerShell 7) first, then falling back
   * to powershell.exe (Windows PowerShell 5.1).
   *
   * CRITICAL: The fallback must handle the async ENOENT error from spawn().
   * The previous try/catch pattern was broken — spawn() never throws
   * synchronously, so the catch block was dead code. The ENOENT error arrives
   * asynchronously via the 'error' event.
   */
  private async spawnPowerShell(script: string): Promise<string> {
    // On Windows, try pwsh.exe (PS7) then powershell.exe (PS5.1).
    // On Unix, try pwsh then powershell (no .exe).
    const cmds = process.platform === 'win32'
      ? ['pwsh.exe', 'powershell.exe']
      : ['pwsh', 'powershell'];

    let lastError: Error | undefined;

    for (const cmd of cmds) {
      try {
        return await this.trySpawnPS(cmd, script);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // ENOENT means the command wasn't found — try next command
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') continue;
        // Other errors (non-zero exit, etc.) should propagate immediately
        throw err;
      }
    }

    throw new Error(
      `PowerShell not found. Tried: ${cmds.join(', ')}. ` +
      `Last error: ${lastError?.message ?? 'unknown'}`
    );
  }

  /**
   * Spawn a single PowerShell command, writing the script to stdin.
   * Returns the stdout output on success (exit code 0).
   * Rejects on spawn error (e.g., ENOENT) or non-zero exit code.
   */
  private trySpawnPS(cmd: string, script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, ['-NoProfile', '-NonInteractive', '-Command', '-']);
      let stdout = '';
      let stderr = '';
      let settled = false;

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      // Write script to stdin (safe even before process is fully started —
      // Node buffers stdin internally)
      proc.stdin.write(script);
      proc.stdin.end();

      proc.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      proc.on('close', (code: number) => {
        if (settled) return; // already rejected via 'error' event
        if (code === 0) { settled = true; resolve(stdout); }
        else { settled = true; reject(new Error(stderr || `PowerShell exited ${code}`)); }
      });
    });
  }

  private getExpectedPath(ctx: AssertContext): string {
    return this.getExpectedPathFromTest(
      ctx.test as TestDefinition,
      ctx.config as ShogunConfig,
      ctx.cwd,
      ctx.collectionName,
    );
  }

  private getExpectedPathFromTest(
    test: TestDefinition,
    config: ShogunConfig,
    cwd: string = process.cwd(),
    collectionName?: string,
  ): string {
    const path = require('node:path');
    const loader = require('../loader.js');
    const expectedDir = path.join(cwd, config.paths?.expected ?? 'expected');
    const collection = collectionName ?? test.collection ?? 'default';
    const safeName = loader.sanitizeName(test.request?.method ?? 'GET', test.request?.path ?? '/');
    return path.join(expectedDir, collection, `${safeName}.json`);
  }
}
