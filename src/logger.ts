/**
 * src/logger.ts
 * Manages run log directories and writes run artifacts:
 *   run.json  — full machine-readable detail (replaces summary.json)
 *   run.txt   — human/agent-readable: one line per test, failure index, totals footer
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary, TestResult, AssertionResults, ShogunConfig } from './types.js';

export class RunLogger {
  private readonly runId: string;
  private readonly runDir: string;
  private readonly results: TestResult[] = [];
  private readonly collectionNames: string[] = [];
  private startedAt: string;
  private logSerial = 0;

  constructor(private readonly config: ShogunConfig, private readonly cwd: string = process.cwd()) {
    this.startedAt = new Date().toISOString();
    this.runId = formatRunId(new Date());
    const runsBase = join(cwd, config.paths?.runs ?? 'runs');
    this.runDir = join(runsBase, this.runId);
    mkdirSync(this.runDir, { recursive: true });
  }

  get id(): string {
    return this.runId;
  }

  /** Write a per-test log file and record the result. */
  recordTest(result: TestResult, collectionName: string): void {
    this.results.push(result);
    this.collectionNames.push(collectionName);

    // Don't write a log file for passing tests (unless explicitly requested)
    // or for dependency_failed — those are secondary signals, not root causes.
    // The root-cause failing test already has its own log.
    if (result.status === 'dependency_failed') return;
    if (!this.config.reporting?.save_passing_logs && result.status === 'passed') {
      return;
    }

    this.logSerial += 1;
    const serial = String(this.logSerial).padStart(4, '0');
    const logName = `${serial}_${collectionName}--${safeFileName(result.name)}.log`;
    const logPath = join(this.runDir, logName);
    writeFileSync(logPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }

  /** Write run.json and run.txt for this run. */
  finalize(opts: {
    env: string;
    collection?: string | string[];
    suite?: string;
    startedAt?: string;
  }): RunSummary {
    const finishedAt = new Date().toISOString();
    const startedAt = opts.startedAt ?? this.startedAt;

    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;
    const needsBaseline = this.results.filter(r => r.status === 'needs_baseline').length;
    const dependencyFailed = this.results.filter(r => r.status === 'dependency_failed').length;

    const summary: RunSummary = {
      runId: this.runId,
      env: opts.env,
      collection: opts.collection,
      suite: opts.suite,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      total: this.results.length,
      passed,
      failed,
      needsBaseline,
      dependencyFailed,
      results: this.results,
    };

    // run.json — full machine-readable detail
    const jsonPath = join(this.runDir, 'run.json');
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

    // run.txt — human/agent-readable one-liner format
    const txtPath = join(this.runDir, 'run.txt');
    writeFileSync(txtPath, buildRunTxt(summary, this.collectionNames, this.runDir), 'utf8');

    return summary;
  }
}

/** Load the latest run summary from the runs directory. */
export function loadLatestRun(config: ShogunConfig, cwd = process.cwd()): RunSummary | null {
  const runsBase = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsBase)) return null;

  const runs = readdirSync(runsBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();

  if (runs.length === 0) return null;
  return loadRunById(runs[0], config, cwd);
}

/** Load a specific run by ID (timestamp string). */
export function loadRunById(runId: string, config: ShogunConfig, cwd = process.cwd()): RunSummary | null {
  const runsBase = join(cwd, config.paths?.runs ?? 'runs', runId);

  // Prefer run.json; fall back to legacy summary.json for backward compatibility
  const jsonPath = join(runsBase, 'run.json');
  const legacyPath = join(runsBase, 'summary.json');
  const filePath = existsSync(jsonPath) ? jsonPath : existsSync(legacyPath) ? legacyPath : null;

  if (!filePath) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as RunSummary;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// run.txt builder
// ---------------------------------------------------------------------------

function buildRunTxt(summary: RunSummary, collectionNames: string[], runDir: string): string {
  const lines: string[] = [];

  // Header line
  const durationSec = (summary.durationMs / 1000).toFixed(2);
  lines.push(`Run: ${summary.runId}  env: ${summary.env}  ${durationSec}s`);
  lines.push('');

  // One line per test; failures get a second indented reason line
  const failures: Array<{ index: number; label: string; reason: string; logPath: string }> = [];
  let failIndex = 0;
  let logSerial = 0;

  for (let i = 0; i < summary.results.length; i++) {
    const result = summary.results[i];
    const collection = collectionNames[i] ?? '';
    const label = collection ? `${collection} / ${result.name}` : result.name;
    const dur = `${result.durationMs}ms`;

    switch (result.status) {
      case 'passed':
        lines.push(`PASS           ${dur.padEnd(8)}  ${label}`);
        break;

      case 'failed': {
        failIndex += 1;
        logSerial += 1;
        const serial = String(logSerial).padStart(4, '0');
        const logName = `${serial}_${collection}--${safeFileName(result.name)}.log`;
        const logPath = join(runDir, logName);
        const reason = getFirstFailureReason(result.assertions, result.error);
        failures.push({ index: failIndex, label, reason, logPath });
        lines.push(`FAIL           ${dur.padEnd(8)}  ${label}`);
        lines.push(`               ${' '.repeat(8)}  → ${reason}`);
        break;
      }

      case 'needs_baseline':
        lines.push(`NEEDS_BASELINE ${dur.padEnd(8)}  ${label}`);
        break;

      case 'dependency_failed': {
        const dep = result.failedDependency ? ` (blocked by: ${result.failedDependency})` : '';
        lines.push(`SKIPPED        ${dur.padEnd(8)}  ${label}${dep}`);
        break;
      }
    }
  }

  // Footer separator
  lines.push('');
  lines.push('─'.repeat(60));

  // Failed index (only when there are failures)
  if (failures.length > 0) {
    lines.push(`FAILED (${failures.length}):`);
    for (const f of failures) {
      lines.push(`  [${f.index}] ${f.label} — ${f.reason}`);
      lines.push(`       log: ${f.logPath}`);
    }
    lines.push('');
  }

  // Totals — always last, tail-friendly
  const parts: string[] = [
    `Total: ${summary.total}`,
    `Passed: ${summary.passed}`,
    `Failed: ${summary.failed}`,
  ];
  if (summary.needsBaseline > 0) parts.push(`NeedsBaseline: ${summary.needsBaseline}`);
  if (summary.dependencyFailed > 0) parts.push(`Skipped: ${summary.dependencyFailed}`);
  parts.push(`Duration: ${durationSec}s`);
  lines.push(parts.join('  '));
  lines.push('');

  return lines.join('\n');
}

function getFirstFailureReason(assertions: AssertionResults, error?: string): string {
  if (assertions.status === false) return 'Status code mismatch';

  const failedShape = assertions.shape?.find(s => !s.passed);
  if (failedShape) {
    return `Shape assertion failed: ${failedShape.expr}${failedShape.error ? ` — ${failedShape.error}` : ''}`;
  }

  if (assertions.snapshot === false) return 'Snapshot mismatch';

  if (assertions.postScript === false) {
    return `Post-script: ${assertions.postScriptError ?? 'assertion failed'}`;
  }

  if (error) return error;

  return 'Unknown failure';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRunId(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function safeFileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
