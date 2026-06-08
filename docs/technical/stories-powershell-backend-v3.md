# Shogun PowerShell Backend — Technical Stories (v3)

> **Epic**: Add PowerShell Backend (Unix backend unchanged)  
> **Goal**: Support PowerShell as an alternative backend; Unix backend works EXACTLY as before  
> **Status**: Ready for grooming

---

## Story 1: Create Backend Interface + Factory (No Behavior Change)
**As a** developer  
**I want** the backend execution logic abstracted behind an interface  
**So that** I can add PowerShell backend without breaking Unix backend

### Acceptance Criteria
- [ ] `BackendExecutor` interface defined in `src/backend-interface.ts`
- [ ] `UnixBackend` class created in `src/backends/unix-backend.ts`
- [ ] Existing `executor.ts` logic MOVED to `UnixBackend.executeRequest()` (UNCHANGED)
- [ ] Existing `asserter.ts` jq logic MOVED to `UnixBackend.runJsonQuery()` (UNCHANGED)
- [ ] Existing `asserter.ts` normalization logic MOVED to `UnixBackend.normalizeJson()` (UNCHANGED)
- [ ] Existing `asserter.ts` diff logic MOVED to `UnixBackend.runDiff()` (UNCHANGED)
- [ ] `backend-factory.ts` created with `createBackend()` factory function
- [ ] Backend selection hierarchy implemented:
  1. Default: `powershell` if Windows, else `unix`
  2. Override: `SHOGUN_BACKEND` env var (if set)
  3. Override: `--backend` CLI flag (if passed)
- [ ] `executor.ts` and `asserter.ts` become THIN WRAPPERS → delegate to backend
- [ ] **ALL EXISTING TESTS PASS** (Unix backend must be backward-compatible)
- [ ] Unit tests for factory function

### Technical Notes
- **CRITICAL**: This story is REFACTORING ONLY — no behavior changes
- **CRITICAL**: jq, curl, diff logic is MOVED, not CHANGED
- **CRITICAL**: Run `npm run test:local` after EACH commit (regression check)
- File organization: `unix-backend.ts` is a wrapper, not a rewrite

### What "MOVED, NOT CHANGED" Means
```typescript
// BEFORE: executor.ts (existing code)
export async function executeRequest(...) {
  // curl logic (100+ lines)
}

// AFTER: unix-backend.ts (SAME logic, wrapped in class)
export class UnixBackend implements BackendExecutor {
  async executeRequest(...) {
    // curl logic (100+ lines, UNCHANGED)
  }
}
```

### Definition of Done
- `shogun run --env local` works EXACTLY as before (zero regressions)
- Backend selection works: OS default → env var → CLI flag
- UnixBackend uses curl + jq + diff (UNCHANGED)
- Code coverage: new interface/factory files have ≥80% test coverage

---

## Story 2: PowerShell HTTP Executor (Invoke-RestMethod)
**As a** Windows user  
**I want** to run API tests without installing curl  
**So that** I can use shogun natively on Windows

### Acceptance Criteria
- [ ] `PowerShellBackend` class created in `src/backends/powershell-backend.ts`
- [ ] `executeRequest()` spawns `powershell.exe -Command -` with script
- [ ] HTTP methods supported: GET, POST, PUT, PATCH, DELETE
- [ ] Headers passed correctly (including `Authorization: Bearer ...`)
- [ ] Request body (JSON) passed correctly for POST/PUT/PATCH
- [ ] Response captured: status code, headers, body, duration
- [ ] Timeout support (via `-TimeoutSec` parameter)
- [ ] Follow redirects support (via `-MaximumRedirection` parameter)
- [ ] Error handling: PowerShell errors → `ShogunResponse` with status 0
- [ ] PowerShell executed with `-NoProfile -NonInteractive` flags

### Implementation Sketch
```typescript
// src/backends/powershell-backend.ts

export class PowerShellBackend implements BackendExecutor {
  readonly name = 'powershell' as const;

  async executeRequest(
    req: ShogunRequest,
    env: EnvVars,
    opts?: ExecutorOptions
  ): Promise<ShogunResponse> {
    const psScript = `
      $headers = @{}
      $headers["Content-Type"] = "application/json"
      if ("${env.AUTH_TOKEN}") {
        $headers["Authorization"] = "${env.AUTH_TOKEN}"
      }
      
      $uri = "${buildUrl(req, env)}"
      $method = "${req.method}"
      $timeout = ${opts?.timeout ?? 10}
      
      try {
        $response = Invoke-RestMethod -Uri $uri -Method $method `
          -Headers $headers `
          -Body '${JSON.stringify(req.body)}' `
          -TimeoutSec $timeout `
          -ResponseHeadersVariable "responseHeaders" `
          -StatusCodeVariable "statusCode" `
          -MaximumRedirection 5 `
          -ErrorAction Stop
        
        $body = $response | ConvertTo-Json -Depth 100 -Compress
        $headersJson = $responseHeaders | ConvertTo-Json -Compress
        
        Write-Output "STATUS:$statusCode"
        Write-Output "HEADERS:$headersJson"
        Write-Output "BODY:$body"
      } catch {
        $statusCode = $_.Exception.Response.StatusCode.Value__
        $errorBody = $_.ErrorDetails.Message
        
        Write-Output "STATUS:$statusCode"
        Write-Output "ERROR:$errorBody"
        exit 1
      }
    `;

    const output = await this.spawnPowerShell(psScript);
    return this.parsePowerShellResponse(output);
  }

  private async spawnPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '-'
      ]);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.stdin.write(script);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || 'PowerShell execution failed'));
      });
    });
  }

  private parsePowerShellResponse(output: string): ShogunResponse {
    // Parse "STATUS:200", "HEADERS:{...}", "BODY:{...}"
    // Convert to ShogunResponse format
    // ...
  }
}
```

### Risks
- **`Invoke-RestMethod` auto-parses JSON**: Need to capture raw response
  - **Mitigation**: Use `-OutFile` parameter, then read file
- **PowerShell execution policy**: Some systems block scripts
  - **Mitigation**: Use `-ExecutionPolicy Bypass` flag
- **Header casing**: PowerShell lowercases headers
  - **Mitigation**: Normalize header names in `parsePowerShellResponse()`

### Definition of Done
- `shogun run --collection system --backend powershell` passes (smoke test)
- Response time ≤ 2x equivalent curl request
- Headers correctly captured (case-insensitive comparison)
- Error responses (4xx, 5xx) handled correctly

---

## Story 3: PowerShell JSON Query (Assertions)
**As a** test author on Windows  
**I want** to write assertions using PowerShell syntax  
**So that** I can leverage PowerShell's capabilities for testing

### Acceptance Criteria
- [ ] `PowerShellBackend.runJsonQuery()` executes PowerShell expressions against JSON
- [ ] Support basic PowerShell JSON traversal:
  - `$json.field`
  - `$json.field.subfield`
  - `$json.array[0]`
- [ ] Support comparison operators:
  - `-gt`, `-lt`, `-eq`, `-ne`, `-ge`, `-le`
  - `-contains`, `-in`, `-like`
- [ ] Support PowerShell cmdlets:
  - `$json.PSObject.Properties.Name` (get keys)
  - `$json.GetType().IsArray` (type checking)
  - `$json.Count` (array length)
- [ ] Document supported PowerShell assertion syntax
- [ ] Unit tests for common assertion patterns

### Examples

**jq syntax (Unix backend)**:
```yaml
response:
  status: 200
  shape:
    - ".agents | length > 0"
    - "has(\"total\")"
    - ".agents | type == \"array\""
```

**PowerShell syntax (PowerShell backend)**:
```yaml
response:
  status: 200
  shape:
    - "$json.agents.Count -gt 0"
    - "$json.PSObject.Properties.Name -contains 'total'"
    - "$json.agents.GetType().IsArray"
```

### Implementation Sketch
```typescript
// src/backends/powershell-backend.ts

async runJsonQuery(json: string, expression: string): Promise<QueryResult> {
  const psScript = `
    try {
      $json = '${this.escapeJsonForPowerShell(json)}' | ConvertFrom-Json
      $result = ${expression}
      
      # Convert result to boolean
      if ($result -is [bool]) {
        Write-Output $result.ToString().ToLower()
      } elseif ($result -is [int]) {
        # Non-zero = true
        Write-Output ($result -ne 0).ToString().ToLower()
      } else {
        # Truthy check
        Write-Output ($result -eq $true).ToString().ToLower()
      }
    } catch {
      Write-Error "Assertion failed: $_"
      exit 1
    }
  `;

  try {
    const output = await this.spawnPowerShell(psScript);
    const passed = output.trim().ToLowerCase() === 'true';
    return { passed };
  } catch (err) {
    return { passed: false, error: err.message };
  }
}

private escapeJsonForPowerShell(json: string): string {
  // Escape single quotes for PowerShell string literal
  return json.replace(/'/g, "''");
}
```

### Documentation: Supported Syntax

| Category | PowerShell Syntax | Example |
|----------|-------------------|---------|
| Field access | `$json.field` | `$json.agents` |
| Nested field | `$json.field.subfield` | `$json.agents[0].name` |
| Array length | `$json.field.Count` | `$json.agents.Count` |
| Comparison | `-gt`, `-lt`, `-eq` | `$json.agents.Count -gt 0` |
| Contains key | `-contains` | `$json.PSObject.Properties.Name -contains "total"` |
| Type check | `.GetType()` | `$json.agents.GetType().IsArray` |
| Boolean cast | `[bool]` | `[bool]$json.success` |

### Out of Scope (v1)
- Complex pipelines (`Where-Object`, `ForEach-Object`)
- Custom PowerShell functions
- Regular expressions in assertions
- Recursive descent (`..` equivalent)

### Definition of Done
- Top 10 most common assertion patterns work
- Clear error messages for unsupported syntax
- Documentation: "PowerShell Assertion Syntax" guide
- Unit tests: ≥10 PowerShell expressions

---

## Story 4: PowerShell JSON Normalization (for Snapshots)
**As a** Windows user  
**I want** snapshot tests to work correctly  
**So that** I can use `shogun snapshot` and `shogun run` with diff comparison

### Acceptance Criteria
- [ ] `PowerShellBackend.normalizeJson()` implemented
- [ ] Uses PowerShell `ConvertFrom-Json` + recursive key sorting
- [ ] `ignore_fields` processing (convert glob to PowerShell field deletion)
- [ ] Output format matches Unix backend (key order, whitespace)
- [ ] Snapshot diff works (calls `runDiff()`)
- [ ] Performance: normalization ≤ 2x jq speed

### Implementation Sketch
```typescript
// src/backends/powershell-backend.ts

async normalizeJson(json: string, ignoreFields: string[]): Promise<string> {
  const ignoreFieldsPs = ignoreFields.map(f => this.convertIgnoreFieldToPowerShell(f)).join('\n');
  
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

    function Remove-IgnoreFields($obj, $fields) {
      # Recursive field removal logic
      # ...
    }

    $json = '${this.escapeJsonForPowerShell(json)}' | ConvertFrom-Json
    
    # Remove ignore fields
${ignoreFieldsPs}

    # Sort keys
    $sorted = Sort-JsonKeys $json
    
    # Output normalized JSON
    $sorted | ConvertTo-Json -Depth 100
  `;

  const output = await this.spawnPowerShell(psScript);
  return output.trim();
}

private convertIgnoreFieldToPowerShell(field: string): string {
  // "**.timestamp" → recursive delete
  // ".timestamp" → top-level delete
  // "timestamp" → top-level delete
  if (field.startsWith('**.')) {
    const key = field.slice(3);
    return `# TODO: Recursive delete of ${key}`;
  } else {
    const key = field.startsWith('.') ? field.slice(1) : field;
    return `$json.PSObject.Properties.Remove("${key}")`;
  }
}
```

### Alternative: Call jq from PowerShell Backend
If PowerShell's JSON handling is too limited:

```typescript
async normalizeJson(json: string, ignoreFields: string[]): Promise<string> {
  // Check if jq is available on Windows
  try {
    await spawnPromise('jq', ['--version']);
    // Use jq (installed separately on Windows)
    return this.normalizeJsonWithJq(json, ignoreFields);
  } catch {
    // Fall back to PowerShell (limited)
    return this.normalizeJsonWithPowerShell(json, ignoreFields);
  }
}
```

### Risks
- **PowerShell `ConvertTo-Json` doesn't guarantee key order**: Unlike `jq -S`
  - **Mitigation**: Use `[ordered]` dictionary + custom recursive sorting
- **Recursive field deletion is complex in PowerShell**: Unlike jq `del(.. | .field?)`
  - **Mitigation**: Document limitation; suggest using jq on Windows

### Definition of Done
- `shogun snapshot --backend powershell` works (writes normalized JSON to `expected/`)
- Snapshot files are COMPARABLE to Unix backend (same key order)
- `ignore_fields` works correctly
- Performance: ≤ 2x jq speed

---

## Story 5: PowerShell Diff Implementation
**As a** Windows user  
**I want** snapshot diffs to be displayed correctly  
**So that** I can see what changed between runs

### Acceptance Criteria
- [ ] `PowerShellBackend.runDiff()` implemented
- [ ] Uses PowerShell `Compare-Object` cmdlet
- [ ] Output format similar to Unix `diff -u` (unified diff)
- [ ] Fallback to Node.js diff if PowerShell diff fails
- [ ] Unit tests for diff output format

### Implementation Sketch
```typescript
// src/backends/powershell-backend.ts

async runDiff(expected: string, actual: string): Promise<string> {
  const psScript = `
    $expected = @'
${expected}
'@ -split "`n"

    $actual = @'
${actual}
'@ -split "`n"

    $diff = Compare-Object $expected $actual -CaseSensitive
    
    if ($diff) {
      # Format as unified diff
      $lines = @("--- expected", "+++ actual")
      foreach ($d in $diff) {
        if ($d.SideIndicator -eq "<=") {
          $lines += "- " + $d.InputObject
        } else {
          $lines += "+ " + $d.InputObject
        }
      }
      Write-Output ($lines -join "`n")
    } else {
      Write-Output ""
    }
  `;

  try {
    const output = await this.spawnPowerShell(psScript);
    return output.trim();
  } catch {
    // Fallback to Node.js diff
    return this.runDiffNodeJs(expected, actual);
  }
}

private runDiffNodeJs(expected: string, actual: string): string {
  // Use existing Node.js diff implementation (from asserter.ts)
  return formatSimpleDiff(expected, actual);
}
```

### Definition of Done
- `shogun run --backend powershell` shows diff on snapshot failure
- Diff format is readable (similar to `diff -u`)
- Fallback to Node.js diff works
- Unit tests: diff output format correct

---

## Story 6: `check-backend` Command
**As a** user  
**I want** to verify my backend configuration and dependencies  
**So that** I can debug backend-related issues quickly

### Acceptance Criteria
- [ ] `shogun check-backend` implemented in `src/commands/check-backend.ts`
- [ ] Shows current backend (unix or powershell)
- [ ] Shows backend source (OS default, SHOGUN_BACKEND, or --backend flag)
- [ ] Checks backend dependencies:
  - Unix: curl, jq, diff
  - PowerShell: powershell.exe, Invoke-RestMethod
- [ ] Shows version info for dependencies
- [ ] Exit code 0 if backend ready, 1 if not
- [ ] Unit tests for command output

### Example Output

**Unix backend (default)**:
```
$ shogun check-backend

Backend: unix
Source: OS detection (platform: darwin)

Dependencies:
  ✅ curl (v7.88.1)
  ✅ jq (v1.6)
  ✅ diff (v3.8)

Status: Ready
```

**PowerShell backend (env var)**:
```
PS> $env:SHOGUN_BACKEND = "powershell"
PS> shogun check-backend

Backend: powershell
Source: SHOGUN_BACKEND env var

Dependencies:
  ✅ powershell.exe (v7.4.0)
  ✅ Invoke-RestMethod (available)
  ⚠️  curl (not needed for powershell backend)
  ⚠️  jq (not needed for powershell backend)

Status: Ready
```

**Backend not configured**:
```
PS> shogun check-backend --backend unix

Backend: unix
Source: --backend flag

Dependencies:
  ❌ curl (not found on PATH)
  ✅ jq (v1.6)
  ❌ diff (not found on PATH)

Status: Not ready
Error: Missing dependencies: curl, diff
Fix: Install curl and diff, or run with --backend powershell
```

### Implementation Sketch
```typescript
// src/commands/check-backend.ts

export async function checkBackendCommand(opts: { backend?: string }): Promise<void> {
  const backend = createBackend(); // Respects --backend flag
  
  console.log(`Backend: ${backend.name}`);
  console.log(`Source: ${getBackendSource()}`);
  console.log('');  
  console.log('Dependencies:');
  
  try {
    const deps = await backend.checkDependencies();
    for (const dep of deps) {
      const icon = dep.found ? '✅' : '❌';
      const version = dep.version ? ` (v${dep.version})` : '';
      const note = dep.optional ? ' (not required)' : '';
      console.log(`  ${icon} ${dep.name}${version}${note}`);
    }
    
    const requiredDeps = deps.filter(d => !d.optional);
    const allFound = requiredDeps.every(d => d.found);
    
    console.log('');
    console.log(`Status: ${allFound ? 'Ready' : 'Not ready'}`);
    
    if (!allFound) {
      console.log(`Error: Missing dependencies: ${requiredDeps.filter(d => !d.found).map(d => d.name).join(', ')}`);
      console.log(`Fix: Install missing dependencies, or use --backend ${backend.name === 'unix' ? 'powershell' : 'unix'}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Status: Error`);
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function getBackendSource(): string {
  if (process.argv.includes('--backend')) {
    return '--backend flag';
  }
  
  if (process.env.SHOGUN_BACKEND) {
    return 'SHOGUN_BACKEND env var';
  }
  
  const platform = process.platform;
  return `OS detection (platform: ${platform})`;
}
```

### Definition of Done
- `shogun check-backend` works for both backends
- Clear error messages with suggested fixes
- Exit code correct (0 = ready, 1 = not ready)
- Unit tests mock dependencies (found/missing)

---

## Story 7: CLI Changes (`--backend` Flag)
**As a** user  
**I want** to specify the backend via CLI flag  
**So that** I can override the default backend selection

### Acceptance Criteria
- [ ] `--backend` flag added to `shogun run` command
- [ ] `--backend` flag added to `shogun snapshot` command
- [ ] `--backend` flag added to `shogun lint` command
- [ ] Flag validation: only `unix` or `powershell` allowed
- [ ] Flag passed to `createBackend()` factory
- [ ] Help text updated (`shogun run --help`)
- [ ] Unit tests for flag parsing

### Implementation Sketch
```typescript
// src/index.ts

program
  .command('run')
  .option('--backend <type>', 'Backend to use (unix|powershell)')
  .option('--env <env>', 'Environment to use')
  .action(async (opts) => {
    const backend = createBackend(opts.backend);
    await runTests(backend, opts);
  });
```

### Definition of Done
- `shogun run --backend powershell` works
- `shogun run --backend unix` works
- `shogun run --backend invalid` shows error
- Help text shows `--backend` option

---

## Story 8: Documentation and Testing
**As a** user  
**I want** clear documentation on how to use shogun with either backend  
**So that** I can get started without frustration

### Acceptance Criteria
- [ ] `README.md` updated with backend selection documentation
- [ ] PowerShell backend requirements documented (PowerShell 7+)
- [ ] Backend selection hierarchy explained (OS → env var → CLI)
- [ ] "Supported Assertion Syntax" reference table (jq vs PowerShell)
- [ ] "Backend Compatibility" matrix (which features work on which backend)
- [ ] Troubleshooting section (common backend errors)
- [ ] `docs/guides/backend-selection.md` created
- [ ] Cross-platform CI setup (Linux, macOS, Windows)

### Documentation Outline

#### Backend Selection
```bash
# Uses OS default (powershell on Windows, unix on Linux/Mac)
shogun run

# Force PowerShell backend (even on Linux)
SHOGUN_BACKEND=powershell shogun run

# Force Unix backend (even on Windows, if curl/jq installed)
shogun run --backend unix
```

#### Assertion Syntax Comparison

| Assertion | jq (Unix) | PowerShell |
|-----------|------------|------------|
| Field exists | `.agents` | `$json.agents` |
| Array length > 0 | `.agents \| length > 0` | `$json.agents.Count -gt 0` |
| Has key | `has("total")` | `$json.PSObject.Properties.Name -contains "total"` |
| Is array | `.agents \| type == "array"` | `$json.agents.GetType().IsArray` |
| First element | `.agents[0]` | `$json.agents[0]` |

#### Backend Compatibility Matrix

| Feature | Unix (curl+jq) | PowerShell |
|---------|----------------|------------|
| HTTP methods | ✅ | ✅ |
| Status assertions | ✅ | ✅ |
| Shape assertions (basic) | ✅ | ✅ |
| Shape assertions (complex) | ✅ (jq fully supported) | ⚠️ (limited PowerShell syntax) |
| Snapshot tests | ✅ | ✅ |
| TypeScript pre/post scripts | ✅ | ✅ |
| Collection setup/teardown | ✅ | ✅ |

#### Troubleshooting
- **"curl not found" on Windows**: Use `--backend powershell` or install Git Bash
- **"Execution Policy" error**: Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
- **PowerShell not found**: Ensure `powershell.exe` is on PATH
- **Slow tests**: Use `-NoProfile` flag (default in shogun)

### CI Configuration (`.github/workflows/test-cross-platform.yml`)
```yaml
name: Cross-Platform Tests

on: [push, pull_request]

jobs:
  test-unix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - run: shogun check-backend --backend unix
      - run: shogun run --backend unix --suite smoke
  
  test-powershell-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - run: shogun check-backend --backend powershell
      - run: shogun run --backend powershell --suite smoke
```

### Definition of Done
- README has "Backend Selection" section
- `docs/guides/backend-selection.md` created
- Cross-platform CI runs on Linux and Windows
- At least one user successfully runs shogun with PowerShell backend

---

## Epic Definition of Done
- [ ] All stories 1-8 completed
- [ ] `shogun run --backend unix` works EXACTLY as before (zero regressions)
- [ ] `shogun run --backend powershell` works on Windows without WSL
- [ ] Backend selection hierarchy works correctly
- [ ] `shogun check-backend` command implemented and tested
- [ ] CI runs on Linux and Windows
- [ ] Documentation complete (README + guides)
- [ ] Performance: PowerShell backend ≤ 2x Unix backend speed
- [ ] **CRITICAL**: All existing tests pass on Unix backend (no breaking changes)

---

## Estimated Effort

| Story | Effort (days) | Risk |
|-------|---------------|------|
| 1. Backend interface + factory | 2 | Low (refactoring only) |
| 2. PowerShell HTTP executor | 3 | Medium (Invoke-RestMethod quirks) |
| 3. PowerShell assertions | 3 | Medium (PowerShell syntax limitations) |
| 4. PowerShell normalization | 2 | High (key sorting in PS) |
| 5. PowerShell diff | 1 | Low |
| 6. `check-backend` command | 1 | Low |
| 7. CLI changes | 1 | Low |
| 8. Documentation + CI | 3 | Medium (CI setup) |
| **Total** | **16 days** | |

---

## References
- [Invoke-RestMethod docs](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-restmethod)
- [jq manual](https://stedolan.github.io/jq/manual/)
- [PowerShell JSON handling](https://learn.microsoft.com/en-us/powershell/scripting/learn/deep-dives/add-custom-methods-to-objects)
- [PowerShell Cross-Platform](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell)

---

**Next Steps**: Review stories, prioritize, and start with Story 1 (refactoring).
