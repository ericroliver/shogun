# Story 16 — `--min-coverage` CI Gate + `--out` Flag + JSON Truncation Fix

**Wave:** 4  
**Status:** Ready for implementation  
**Depends on:** Story 0 (config layer — minCoverage thresholds), Stories 4, 6, 7 (coverage dimensions)  
**Files touched:** `src/commands/coverage/index.ts`, `src/commands/coverage/types.ts`, `src/commands/coverage/reporter/json.ts`, [`src/index.ts`](../../../src/index.ts)

---

## Problem

Three related issues:

1. **No CI gate**: Teams running `shogun coverage` in CI have no way to fail the build when coverage drops below a threshold. The command always exits 0.

2. **No file output**: The report is always written to stdout. For large suites (400+ tests), the JSON output exceeds ~134KB and is silently truncated by the terminal/CI buffer. There is no way to write the report to a file.

3. **JSON truncation bug**: The current `renderJson()` uses `console.log(JSON.stringify(...))` which is subject to stdout buffer limits. For the 410-test suite, this truncates the output and makes JSON format unusable for programmatic analysis.

---

## Goal

1. Add `--min-coverage <n>` (global threshold) and per-dimension thresholds from `coverage.minCoverage` config (Story 0). Exit 1 if any threshold is breached.
2. Add `--out <file>` to write the report to a file instead of (or in addition to) stdout.
3. Fix the JSON truncation bug by using `fs.writeFileSync` instead of `console.log` when writing JSON.

---

## CLI Interface

```bash
# Global threshold — exit 1 if endpoint coverage < 80%
shogun coverage --env local --min-coverage 80

# Per-dimension thresholds from config (coverage.minCoverage in shogun.config.yaml)
# No CLI flag needed — thresholds are read from config automatically

# Write report to file
shogun coverage --env local --format json --out coverage.json

# Both: write to file AND enforce threshold
shogun coverage --env local --format json --out coverage.json --min-coverage 80

# CI pipeline pattern
shogun coverage --env local --format json --out coverage.json --min-coverage 100 && echo "Coverage OK"
```

---

## New Args in `CoverageArgs`

```typescript
export interface CoverageArgs {
  // ... existing fields ...
  minCoverage?: number;   // --min-coverage <n> (global threshold, 0–100)
  out?: string;           // --out <file> (write report to file)
}
```

---

## Threshold Evaluation Logic

After computing all coverage dimensions, evaluate thresholds in this order:

1. **Per-dimension thresholds from config** (`coverage.minCoverage`):
   - `endpoint`: compare against `summary.coveragePct`
   - `responseCode`: compare against `summary.responseCodeCoveragePct`
   - `parameter`: compare against `summary.paramCoveragePct`
   - `bodyField`: compare against `summary.bodyFieldCoveragePct`

2. **Global CLI threshold** (`--min-coverage <n>`): compare against `summary.coveragePct` (endpoint coverage only).

If any threshold is breached, collect all violations and:
- Print a clear violation summary to stderr (not stdout, so it doesn't corrupt `--out` file content)
- Return exit code 1

**Violation output format:**
```
Coverage threshold violations:
  ✗ endpoint coverage: 51.7% < 100% (required)
  ✗ responseCode coverage: 62.3% < 80% (required)

Run `shogun coverage --gaps` to see what needs to be fixed.
```

---

## `--out` Flag Behavior

- When `--out <file>` is given, write the report to the specified file path instead of stdout.
- The file is written using `fs.writeFileSync` — no streaming, no buffer limits.
- If the directory does not exist, create it with `fs.mkdirSync(dir, { recursive: true })`.
- After writing, print a single confirmation line to stdout: `Report written to coverage.json`
- When `--out` is given with `--format pretty` or `--format markdown`, write the text to the file (ANSI color codes stripped for file output).
- When `--out` is NOT given, behavior is unchanged — write to stdout.

---

## JSON Truncation Fix

Replace the current `renderJson()` implementation:

```typescript
// BEFORE (truncates at ~134KB):
console.log(JSON.stringify({ summary, endpoints }, null, 2));

// AFTER (no truncation):
function writeOutput(content: string, outFile?: string): void {
  if (outFile) {
    const dir = dirname(resolve(outFile));
    mkdirSync(dir, { recursive: true });
    writeFileSync(outFile, content, 'utf8');
    console.log(`Report written to ${outFile}`);
  } else {
    // Use process.stdout.write to avoid console.log's implicit newline buffering
    process.stdout.write(content + '\n');
  }
}
```

The `writeOutput()` helper is used by all reporters (pretty, json, markdown, gaps). For pretty/markdown, the content is the full rendered string. For JSON, it is `JSON.stringify(payload, null, 2)`.

---

## Acceptance Criteria

- [ ] `CoverageArgs` gains `minCoverage?: number` and `out?: string`.

- [ ] [`src/index.ts`](../../../src/index.ts) recognizes `--min-coverage <n>` (parses as number) and `--out <file>` (parses as string).

- [ ] Per-dimension thresholds are read from `resolveCoverageConfig(config).minCoverage` (Story 0). They are evaluated automatically whenever `shogun coverage` runs — no CLI flag needed to activate them.

- [ ] `--min-coverage <n>` CLI flag applies as a global endpoint coverage threshold. It does NOT override per-dimension config thresholds — both are evaluated independently.

- [ ] When all thresholds pass, exit code is 0 (unchanged).

- [ ] When any threshold is breached, violation details are printed to **stderr** and exit code is 1.

- [ ] The violation output does not appear in the `--out` file — it goes to stderr only.

- [ ] `writeOutput()` helper is implemented and used by all reporters.

- [ ] JSON output written via `--out` is never truncated regardless of payload size.

- [ ] JSON output written to stdout (no `--out`) uses `process.stdout.write` instead of `console.log` to avoid buffering issues.

- [ ] When `--out` is given with `--format pretty`, ANSI escape codes (color/bold) are stripped from the file content. Stdout output (if any) retains colors. Use a simple regex strip: `content.replace(/\x1b\[[0-9;]*m/g, '')`.

- [ ] The `CoverageSummary` already has `coveragePct`, `responseCodeCoveragePct`, `paramCoveragePct`, `bodyFieldCoveragePct` from previous stories. No new summary fields needed for this story.

---

## Notes for Implementer

- The per-dimension thresholds from config are always evaluated — even without `--min-coverage`. This means a team can configure `coverage.minCoverage.endpoint: 100` in `shogun.config.yaml` and the CI gate activates automatically on every `shogun coverage` run.
- `--min-coverage 0` is a valid value (always passes). Do not special-case it.
- The `--out` path is relative to `cwd`. Resolve it with `resolve(cwd, args.out)`.
- If `--out` write fails (permission error, disk full), print the error to stderr and exit 1.
- The JSON truncation fix is the highest-priority item in this story — it is a bug fix, not a new feature. Implement it first.
