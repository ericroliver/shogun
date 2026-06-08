/**
 * src/backends/powershell-backend.ts
 *
 * PowerShell backend — uses PowerShell cmdlets instead of curl/jq/diff.
 *
 * Tools used:
 *   - Invoke-RestMethod  → HTTP execution
 *   - ConvertFrom-Json     → JSON parsing
 *   - Compare-Object       → diff (with Node.js fallback)
 *
 * NOTE: This is a NEW implementation. It does NOT reuse curl/jq/diff.
 *       Assertion syntax is PowerShell-native (not jq).
 */

import { spawn } from 'node:child_process';
import type {
  ShogunRequest,
  ShogunResponse,
  EnvVars,
  ShapeAssertionResult,
  TestDefinition,
  ShogunConfig,
} from '../types.js';

import type {
  BackendExecutor,
  QueryResult,
  ExecutorOptions,
  SnapshotResult,
  DependencyCheck,
  AssertContext,
} from '../backend-interface.js';

// ===========================================================================
// Pure helper functions — exported for unit testing
// ===========================================================================

export function escapeForPowerShell(str: string): string {
  return str.replace(/'/g, "''").replace(/"/g, '`"');
}

export function escapeHereString(str: string): string {
  return str.replace(/'/g, "''");
}

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
        for (const [k, v] of Object.entries(h)) {
          headers[(k as string).toLowerCase()] = String(v);
        }
      } catch { /* ignore */ }
    } else if (line.startsWith('BODY:')) {
      bodyRaw = line.slice(5);
    } else if (line.startsWith('ERROR:')) {
      bodyRaw = line.slice(6);
    }
  }

  let body: unknown = bodyRaw;
  try {
    if (bodyRaw.trim().startsWith('{') || bodyRaw.trim().startsWith('[')) {
      body = JSON.parse(bodyRaw);
    }
  } catch { /* keep as string */ }

  return {
    status,
    headers,
    body,
    raw: bodyRaw,
    duration,
    curlMs: duration,
  };
}

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

export function buildPsHeaders(req: ShogunRequest, env: EnvVars): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...req.headers,
  };
  if (env.AUTH_TOKEN && !headers['Authorization']) {
    const token = env.AUTH_TOKEN;
    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }
  return headers;
}

export function formatHeadersForPowerShell(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `$headers["${k}"] = "${escapeForPowerShell(v)}"`)
    .join('\n      ');
}

export function buildBodyArg(req: ShogunRequest): string {
  if (req.body === undefined || req.body === null) return '';
  const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  return `$splat.Body = '${escapeForPowerShell(bodyStr)}'`;
}

export function convertIgnoreFieldToPowerShell(field: string): string {
  const key = field.startsWith('.') ? field.slice(1) : field;
  return `$json.PSObject.Properties.Remove("${key}")`;
}

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

  // =======================================================================
  // HTTP execution — Invoke-RestMethod
  // =======================================================================

  async executeRequest(
    req: ShogunRequest,
    env: EnvVars,
    opts: ExecutorOptions = {},
  ): Promise<ShogunResponse> {
    const timeout = opts.timeout ?? parseInt(env.TIMEOUT ?? '10', 10);
    const url = this.buildUrl(req);
    const method = req.method;
    const headers = this.buildHeaders(req, env);

    const bodyArg = this.buildBodyArg(req);

    const psScript = `
      $ErrorActionPreference = "Stop"
      
      $headers = @{}
      ${this.formatHeadersForPowerShell(headers)}
      
      $uri = "${this.escapeForPowerShell(url)}"
      $method = "${method}"
      $timeoutSec = ${timeout}
      
      try {
        $splat = @{
          Uri         = $uri
          Method      = $method
          Headers     = $headers
          TimeoutSec  = $timeoutSec
          ResponseHeadersVariable = "responseHeaders"
          StatusCodeVariable       = "statusCode"
          MaximumRedirection      = 5
        }
        
        ${bodyArg}
        
        $response = Invoke-RestMethod @splat
        $bodyJson = $response | ConvertTo-Json -Depth 100 -Compress
        
        Write-Output "STATUS:$statusCode"
        Write-Output "HEADERS:$($responseHeaders | ConvertTo-Json -Compress)"
        Write-Output "BODY:$bodyJson"
      } catch {
        $statusCode = $_.Exception.Response.StatusCode.Value__
        if (-not $statusCode) { $statusCode = 0 }
        
        $errorBody = $_.ErrorDetails.Message
        if (-not $errorBody) { $errorBody = $_.Exception.Message }
        
        Write-Output "STATUS:$statusCode"
        Write-Output "ERROR:$errorBody"
        exit 0
      }
    `;

    const startTime = Date.now();
    const output = await this.spawnPowerShell(psScript);
    const duration = Date.now() - startTime;

    return this.parsePowerShellResponse(output, duration);
  }

  // =======================================================================
  // JSON query / PowerShell shape assertions
  // =======================================================================

  async runJsonQuery(json: string, expression: string): Promise<QueryResult> {
    const psScript = `
      try {
        $json = '${this.escapeForPowerShell(json)}' | ConvertFrom-Json
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
    } catch (err: any) {
      return { passed: false, error: err.message };
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
      .map(f => this.convertIgnoreFieldToPowerShell(f))
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
        $json = '${this.escapeForPowerShell(raw)}' | ConvertFrom-Json
        ${ignoreLines}
        $sorted = Sort-JsonKeys $json
        $output = $sorted | ConvertTo-Json -Depth 100
        Write-Output $output
      } catch {
        Write-Output '${this.escapeForPowerShell(raw)}'
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
${this.escapeHereString(expected)}
'@ -split "\\r?\\n"

      $actualLines = @'
${this.escapeHereString(actual)}
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
      return this.formatSimpleDiff(expected, actual);
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
      await this.writeSnapshot(ctx.response.raw, ctx.test as TestDefinition, ctx.config as ShogunConfig, expectedPath);
      return { passed: true };
    }

    if (!fs.existsSync(expectedPath)) {
      return { passed: false, needsBaseline: true };
    }

    const ignoreFields = [
      ...((ctx.config as ShogunConfig).ignore_fields_global ?? []),
      ...((ctx.test as TestDefinition).response?.ignore_fields ?? []),
    ];

    const normalizedActual = await this.normalizeJson(ctx.response.raw, ignoreFields);
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
      await this.spawnPowerShell('$PSVersionTable.PSVersion.ToString()');
      results.push({
        name: 'powershell.exe',
        found: true,
        version: '7.x',
        optional: false,
      });
    } catch {
      results.push({
        name: 'powershell.exe',
        found: false,
        optional: false,
      });
    }

    results.push({
      name: 'Invoke-RestMethod',
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

  private async spawnPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const trySpawn = (cmd: string) => {
        const proc = spawn(cmd, ['-NoProfile', '-NonInteractive', '-Command', '-']);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.stdin.write(script);
        proc.stdin.end();
        proc.on('close', (code: number) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr || `PowerShell exited ${code}`));
        });
        proc.on('error', reject);
      };
      try { trySpawn('pwsh.exe'); } catch { trySpawn('powershell.exe'); }
    });
  }

  private parsePowerShellResponse(output: string, duration: number): ShogunResponse {
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
          for (const [k, v] of Object.entries(h)) {
            headers[(k as string).toLowerCase()] = String(v);
          }
        } catch { /* ignore */ }
      } else if (line.startsWith('BODY:')) {
        bodyRaw = line.slice(5);
      } else if (line.startsWith('ERROR:')) {
        bodyRaw = line.slice(6);
      }
    }

    let body: unknown = bodyRaw;
    try {
      if (bodyRaw.trim().startsWith('{') || bodyRaw.trim().startsWith('[')) {
        body = JSON.parse(bodyRaw);
      }
    } catch { /* keep as string */ }

    return {
      status,
      headers,
      body,
      raw: bodyRaw,
      duration,
      curlMs: duration,
    };
  }

  private buildUrl(req: ShogunRequest): string {
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

  private buildHeaders(req: ShogunRequest, env: EnvVars): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...req.headers,
    };
    if (env.AUTH_TOKEN && !headers['Authorization']) {
      const token = env.AUTH_TOKEN;
      headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
    return headers;
  }

  private formatHeadersForPowerShell(headers: Record<string, string>): string {
    return Object.entries(headers)
      .map(([k, v]) => `$headers["${k}"] = "${this.escapeForPowerShell(v)}"`)
      .join('\n      ');
  }

  private buildBodyArg(req: ShogunRequest): string {
    if (req.body === undefined || req.body === null) return '';
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    return `$splat.Body = '${this.escapeForPowerShell(bodyStr)}'`;
  }

  private escapeForPowerShell(str: string): string {
    return str.replace(/'/g, "''").replace(/"/g, '`"');
  }

  private escapeHereString(str: string): string {
    return str.replace(/'/g, "''");
  }

  private convertIgnoreFieldToPowerShell(field: string): string {
    const key = field.startsWith('.') ? field.slice(1) : field;
    return `$json.PSObject.Properties.Remove("${key}")`;
  }

  private formatSimpleDiff(expected: string, actual: string): string {
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
    cwd = process.cwd(),
    collectionName?: string,
  ): string {
    const path = require('node:path');
    const loader = require('../loader.js');
    const expectedDir = path.join(cwd, config.paths?.expected ?? 'expected');
    const collection = collectionName ?? test.collection ?? 'default';
    const safeName = loader.sanitizeName(test.request.method, test.request.path);
    return path.join(expectedDir, collection, `${safeName}.json`);
  }
}
