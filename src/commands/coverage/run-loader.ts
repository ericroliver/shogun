/**
 * src/commands/coverage/run-loader.ts
 * Run result loading — joins run.json results to test entries.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary, ShogunConfig, TestResult } from '../../types.js';
import type { TestEntry } from './types.js';

export function loadRunForCoverage(
  args: { lastRun?: boolean; runId?: string; suite?: string },
  coverageConfig: { defaultSuite?: string },
  config: ShogunConfig,
  cwd: string,
): RunSummary | null {
  if (!args.lastRun && !args.runId) return null;

  const runsBase = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsBase)) return null;

  if (args.runId) {
    return loadRunById(args.runId, runsBase);
  }

  // --last-run: determine suite filter
  const suiteFilter = args.suite === 'any'
    ? undefined
    : (args.suite ?? coverageConfig.defaultSuite);

  return loadLatestRunForSuite(runsBase, suiteFilter);
}

function loadRunById(runId: string, runsBase: string): RunSummary | null {
  // Prefer summary.json (the canonical shogun run artifact). Fall back to
  // run.json — some test repos / older versions name the file run.json with
  // the same shape (runId, env, suite, results[], …).
  const candidates = [
    join(runsBase, runId, 'summary.json'),
    join(runsBase, runId, 'run.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as RunSummary;
    } catch {
      // Corrupt file — try the next candidate
    }
  }
  return null;
}

function loadLatestRunForSuite(
  runsBase: string,
  suiteFilter: string | undefined,
): RunSummary | null {
  const runDirs = readdirSync(runsBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse(); // newest first

  for (const runId of runDirs) {
    const summary = loadRunById(runId, runsBase);
    if (!summary) continue;
    if (!suiteFilter || summary.suite === suiteFilter) return summary;
  }
  return null;
}

export function joinRunResultsToTests(
  testEntries: TestEntry[],
  runSummary: RunSummary,
): void {
  // Build lookup: "collection/test-name" → TestResult
  const resultMap = new Map<string, TestResult>();
  for (const result of runSummary.results) {
    // result.file is like "tests/collections/graph/get-graph-nodes.yaml"
    // Derive collection from path: segment after "collections/"
    const parts = result.file.replace(/\\/g, '/').split('/');
    const collIdx = parts.indexOf('collections');
    if (collIdx < 0) continue;
    const collection = parts[collIdx + 1] ?? '';
    const key = `${collection}/${result.name}`;
    resultMap.set(key, result);
  }

  // Join to test entries
  for (const test of testEntries) {
    const key = `${test.collection}/${test.name}`;
    const result = resultMap.get(key);
    if (!result) continue;
    test.runResult = {
      httpStatus: result.httpStatus ?? 0,
      durationMs: result.durationMs,
      status: result.status,
      assertionsPassed: result.status === 'passed',
    };
  }
}

// ---------------------------------------------------------------------------
// Compare: load two runs (Story 15)
// ---------------------------------------------------------------------------

export function loadTwoRunsForCompare(
  args: { compare?: boolean; compareRunIds?: [string, string]; suite?: string },
  coverageConfig: { defaultSuite?: string },
  config: ShogunConfig,
  cwd: string,
): [RunSummary, RunSummary] | null {
  const runsBase = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsBase)) return null;

  if (args.compareRunIds) {
    const [id1, id2] = args.compareRunIds;
    const r1 = loadRunById(id1!, runsBase);
    const r2 = loadRunById(id2!, runsBase);
    if (!r1 || !r2) return null;
    return [r1, r2]; // r1 is newer, r2 is older
  }

  const suiteFilter = args.suite === 'any'
    ? undefined
    : (args.suite ?? coverageConfig.defaultSuite);

  const runDirs = readdirSync(runsBase, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();

  const matched: RunSummary[] = [];
  for (const runId of runDirs) {
    if (matched.length >= 2) break;
    const summary = loadRunById(runId, runsBase);
    if (!summary) continue;
    if (!suiteFilter || summary.suite === suiteFilter) matched.push(summary);
  }

  if (matched.length < 2) return null;
  return [matched[0]!, matched[1]!]; // [newer, older]
}
