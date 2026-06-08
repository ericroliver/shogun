# Shogun Backend Architecture (Unix + PowerShell)

> **Status**: Design v0.3 — 2026-06-06  
> **Decision**: Two Separate Backends (Unix stays unchanged, PowerShell new)  
> **Context**: Add PowerShell backend as an option; Unix backend continues working exactly as today

---

## 1. Executive Summary

Shogun currently uses Unix tools (curl, jq, diff). We need to ADD a PowerShell backend as an option for Windows users (and cross-platform PowerShell usage).

**Critical Constraints**:
- ✅ **Unix backend (curl + jq + diff) stays EXACTLY as it is today**
- ✅ **No breaking changes** to existing functionality
- ✅ **No removing jq** — it stays for Unix backend
- ✅ **No migration needed** — existing tests continue working unchanged
- ✅ **No "hybrid".shared code** — each backend uses its own native tools

### Backend Selection Hierarchy
1. **Default**: `powershell` if Windows, else `unix`
2. **Override 1**: Environment variable `SHOGUN_BACKEND` (if set)
3. **Override 2**: CLI flag `--backend <unix|powershell>` (if passed)

```bash
# Examples
shogun run                          # Uses OS default
SHOGUN_BACKEND=powershell shogun run  # Force PowerShell on Linux
shogun run --backend unix           # Force Unix backend
```

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Entrypoint                            │
│                      (index.ts)                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend Selection (startup)                     │
│         1. Detect OS (default)                             │
│         2. Check SHOGUN_BACKEND env var                    │
│         3. Check --backend CLI flag                        │
└────────────────────┬────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
┌──────────────────┐    ┌──────────────────────┐
│  Unix Backend     │    │  PowerShell Backend   │
│  (UNCHANGED)     │    │  (NEW)               │
│                  │    │                      │
│  - curl          │    │  - Invoke-RestMethod │
│  - jq            │    │  - ConvertFrom-Json  │
│  - diff          │    │  - Compare-Object    │
│                  │    │                      │
│  Assertions:     │    │  Assertions:         │
│  jq syntax       │    │  PowerShell syntax    │
│  ".x > 0"       │    │  "$x -gt 0"         │
└──────────────────┘    └──────────────────────┘
```

**Key Points**:
- Unix backend code is **NOT touched** (except wrapping in a class for abstraction)
- PowerShell backend is **completely new** (separate files)
- **No shared logic** between backends for HTTP/assertions/diff (each uses native tools)

---

## 3. Backend Interface (Thin Abstraction)

### 3.1 Interface Definition (`src/backend-interface.ts`)

```typescript
/**
 * Abstraction for backend execution.
 * UnixBackend: wraps existing curl/jq/diff logic (UNCHANGED)
 * PowerShellBackend: new Invoke-RestMethod/PS cmdlets implementation
 */

export interface BackendExecutor {
  // Backend name (for logging/debugging)
  readonly name: 'unix' | 'powershell';

  // HTTP execution
  executeRequest(
    req: ShogunRequest,
    env: EnvVars,
    opts?: ExecutorOptions
  ): Promise<ShogunResponse>;

  // JSON query/assertion
  runJsonQuery(json: string, expression: string): Promise<QueryResult>;

  // JSON normalization (backend-specific: jq -S vs PowerShell)
  normalizeJson(json: string, ignoreFields: string[]): Promise<string>;

  // Diff production (backend-specific: diff -u vs Compare-Object)
  runDiff(expected: string, actual: string): Promise<string>;

  // Health check: verify backend tools are available
  checkDependencies(): Promise<void>;
}

export interface QueryResult {
  passed: boolean;
  error?: string;
}
```

### 3.2 Backend Selection (Factory)

```typescript
// src/backend-factory.ts

import { BackendExecutor } from './backend-interface.js';
import { UnixBackend } from './backends/unix-backend.js';
import { PowerShellBackend } from './backends/powershell-backend.js';

export function createBackend(): BackendExecutor {
  // 1. Check CLI flag (highest priority)
  const cliFlag = parseCliFlag('--backend');
  if (cliFlag) {
    return cliFlag === 'powershell' 
      ? new PowerShellBackend() 
      : new UnixBackend();
  }

  // 2. Check SHOGUN_BACKEND env var
  const envVar = process.env.SHOGUN_BACKEND?.toLowerCase();
  if (envVar === 'powershell' || envVar === 'unix') {
    return envVar === 'powershell' 
      ? new PowerShellBackend() 
      : new UnixBackend();
  }

  // 3. Default: OS detection
  const defaultBackend = process.platform === 'win32' ? 'powershell' : 'unix';
  return defaultBackend === 'powershell' 
    ? new PowerShellBackend() 
    : new UnixBackend();
}
```

---

## 4. Implementation Details

### 4.1 Unix Backend (EXISTING CODE, WRAPPED)

**File**: `src/backends/unix-backend.ts`

**CRITICAL**: This is **WRAPPER ONLY** — existing logic from `executor.ts` and `asserter.ts` is **MOVED**, not **CHANGED**.

```typescript
export class UnixBackend implements BackendExecutor {
  readonly name = 'unix' as const;

  async executeRequest(...): Promise<ShogunResponse> {
    // MOVED FROM executor.ts (UNCHANGED)
    // spawn('curl', [...])
  }

  async runJsonQuery(json: string, expression: string): Promise<QueryResult> {
    // MOVED FROM asserter.ts (UNCHANGED)
    // spawn('jq', ['-e', expression])
    // jq syntax: ".agents | length > 0"
  }

  async normalizeJson(json: string, ignoreFields: string[]): Promise<string> {
    // MOVED FROM asserter.ts (UNCHANGED)
    // Uses jq -S for key sorting + field deletion
  }

  async runDiff(expected: string, actual: string): Promise<string> {
    // MOVED FROM asserter.ts (UNCHANGED)
    // Uses diff -u for unified diff
  }

  async checkDependencies(): Promise<void> {
    // MOVED FROM executor.ts (UNCHANGED)
    // verify curl, jq, diff on PATH
  }
}
```

**What Changes**:
- ❌ **NOTHING** in the curl/jq/diff logic
- ✅ Only **file organization**: code moved from `executor.ts`/`asserter.ts` to `unix-backend.ts`
- ✅ **Interface compliance**: methods match `BackendExecutor` interface

### 4.2 PowerShell Backend (NEW)

**File**: `src/backends/powershell-backend.ts`

**All new code** — uses PowerShell cmdlets:

```typescript
export class PowerShellBackend implements BackendExecutor {
  readonly name = 'powershell' as const;

  async executeRequest(...): Promise<ShogunResponse> {
    // NEW: Use Invoke-RestMethod
    const psScript = `
      $response = Invoke-RestMethod -Uri "{url}" -Method {method} ...
      # Capture status, headers, body
    `;
    return spawnPowerShell(psScript);
  }

  async runJsonQuery(json: string, expression: string): Promise<QueryResult> {
    // NEW: Use PowerShell syntax
    // expression: "$json.agents.Count -gt 0"
    const psScript = `
      $json = '${json}' | ConvertFrom-Json
      $result = ${expression}
      Write-Output $result
    `;
    return spawnPowerShell(psScript);
  }

  async normalizeJson(json: string, ignoreFields: string[]): Promise<string> {
    // NEW: Use PowerShell ConvertTo-Json with custom sorting
    // (or call jq if available on Windows)
  }

  async runDiff(expected: string, actual: string): Promise<string> {
    // NEW: Use Compare-Object
    // (or Node.js implementation as fallback)
  }

  async checkDependencies(): Promise<void> {
    // NEW: Verify powershell.exe is available
  }
}
```

---

## 5. File Structure (CLEAN)

```
src/
├── backend-interface.ts           # BackendExecutor interface (NEW)
├── backend-factory.ts             # Backend selection + factory (NEW)
├── backends/
│   ├── unix-backend.ts            # WRAPPER for existing curl/jq logic (MOVED, NOT CHANGED)
│   └── powershell-backend.ts      # NEW PowerShell implementation
├── index.ts                       # CLI entrypoint (ADD --backend flag)
├── commands/
│   ├── check-backend.ts           # NEW: shogun check-backend command
│   └── ... (existing commands)
├── executor.ts                    # NOW: thin wrapper → delegates to backend
├── asserter.ts                   # NOW: thin wrapper → delegates to backend
└── ... (other existing files)
```

**Key**:
- `unix-backend.ts` = **MOVED** code from `executor.ts`/`asserter.ts` (functionality unchanged)
- `powershell-backend.ts` = **NEW** code (no relation to existing logic)
- `executor.ts` and `asserter.ts` become **thin wrappers** that call `backend.executeRequest()` etc.

---

## 6. What Does NOT Change

1. **Existing test behavior** — Unix backend works EXACTLY as before
2. **jq** — stays as-is for Unix backend
3. **curl** — stays as-is for Unix backend
4. **diff** — stays as-is for Unix backend
5. **Test YAML format** — same structure for both backends
6. **Assertion syntax** — jq for Unix, PowerShell for PowerShell (different VALUES, same FIELD)

Example:
```yaml
# Unix backend test
response:
  shape:
    - ".agents | length > 0"  # jq syntax

# PowerShell backend test
response:
  shape:
    - "$json.agents.Count -gt 0"  # PowerShell syntax
```

---

## 7. CLI Changes

### 7.1 New Flag: `--backend`

```bash
shogun run --backend powershell
shogun run --backend unix
shogun snapshot --backend powershell
```

**Implementation**:
- Add `--backend` flag to CLI argument parsing
- Pass to `createBackend()` factory
- Default behavior: OS detection (Windows → powershell, else unix)

### 7.2 New Command: `check-backend`

```bash
shogun check-backend
```

**Output**:
```
Backend: unix
Source: OS detection (platform: darwin)

Dependencies:
  ✅ curl (v7.88.1)
  ✅ jq (v1.6)
  ✅ diff (v3.8)

Status: Ready
```

---

## 8. Test Repo Organization

### Key Principle: Test Repos Are Backend-Specific

**Unix Repo** (uses jq syntax):
```
tests/collections/agents/get-agents.yaml
response:
  shape:
    - ".agents | length > 0"  # jq syntax
```

**PowerShell Repo** (uses PowerShell syntax):
```
tests/collections/agents/get-agents.yaml
response:
  shape:
    - "$json.agents.Count -gt 0"  # PowerShell syntax
```

**Same file structure, different assertion values.**

### No Mixing Backends

- A test repo targets ONE backend
- Suites/collections/tests within a repo don't mix backends
- To support both backends: create TWO test repos

---

## 9. Implementation Plan (Stories)

### Phase 1: Refactoring (NO Behavior Change)
1. Create `BackendExecutor` interface
2. Create `backend-factory.ts` (selection logic)
3. Wrap existing curl/jq logic in `UnixBackend` class
4. Update `executor.ts` and `asserter.ts` to use backend interface
5. **VALIDATION**: All existing tests pass (EXACTLY as before)

### Phase 2: PowerShell Backend (New Implementation)
1. Implement `PowerShellBackend.executeRequest()` (Invoke-RestMethod)
2. Implement `PowerShellBackend.runJsonQuery()` (PowerShell syntax)
3. Implement `PowerShellBackend.normalizeJson()` (PS JSON cmdlets)
4. Implement `PowerShellBackend.runDiff()` (Compare-Object)
5. **VALIDATION**: PowerShell backend works on Windows without WSL

### Phase 3: Polish
1. Add `check-backend` command
2. Add `--backend` CLI flag
3. Documentation updates
4. Cross-platform testing (CI)

---

## 10. Risks (Minimized by Design)

| Risk | Mitigation |
|------|-------------|
| **Breaking Unix backend** | Phase 1 validation: ALL existing tests must pass |
| **jq removal** | ❌ NOT HAPPENING. jq stays for Unix backend |
| **Migration complexity** | ❌ NO MIGRATION NEEDED. Unix backend unchanged |
| **Two backends = 2x bugs** | Separate CI for each backend |

---

## 11. Success Criteria

- [ ] `shogun run --backend unix` works EXACTLY as before (zero regressions)
- [ ] `shogun run --backend powershell` works on Windows (no WSL)
- [ ] `shogun check-backend` shows backend info and dependencies
- [ ] Backend selection works: OS → env var → CLI flag
- [ ] jq NOT removed (stays for Unix backend)
- [ ] curl NOT removed (stays for Unix backend)
- [ ] diff NOT removed (stays for Unix backend)

---

**Next Steps**: Review this architecture (FINALLY correct), then start Story 1 (refactoring).
