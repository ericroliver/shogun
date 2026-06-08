/**
 * src/asserter.ts
 *
 * Thin wrapper — delegates assertion logic to the active BackendExecutor.
 *
 *   - Status checks → handled inline (no backend needed)
 *   - jq / PowerShell shape assertions → backend.runShapeAssertions()
 *   - JSON normalization → backend.normalizeJson()
 *   - Snapshot diff → backend.runDiff()
 *
 * The actual implementations live in:
 *   src/backends/unix-backend.ts    (curl + jq + diff)
 *   src/backends/powershell-backend.ts  (Invoke-RestMethod + PS cmdlets)
 */

import type {
  ShogunResponse,
  TestDefinition,
  ShogunConfig,
  AssertionResults,
  ShapeAssertionResult,
} from './types.js';

import type { AssertContext } from './types.js';
import type { BackendExecutor } from './backend-interface.js';

import { getActiveBackend } from './backend-global.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sanitizeName } from './loader.js';

// ---------------------------------------------------------------------------
// Main entry point — runs all assertions for a test
// ---------------------------------------------------------------------------

export async function runAssertions(ctx: AssertContext): Promise<AssertionResults> {
  const results: AssertionResults = {};
  const backend = getActiveBackend();

  // 1. Status code (pure TS — no backend needed)
  if (ctx.test.response?.status !== undefined) {
    results.status = ctx.response.status === ctx.test.response.status;
  }

  // 2. Shape assertions (jq for Unix, PowerShell for PowerShell)
  if (ctx.test.response?.shape?.length) {
    results.shape = await backend.runShapeAssertions(ctx.response.raw, ctx.test.response.shape);
  }

  // 3. Snapshot (normalize + diff)
  if (ctx.test.response?.snapshot) {
    const snapResult = await runSnapshotAssertion(ctx as any, backend);
    results.snapshot = snapResult.passed;
    results.snapshotDiff = snapResult.diff ?? null;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Status assertion (pure TS — no backend needed)
// ---------------------------------------------------------------------------

export function assertStatus(actual: number, expected: number): boolean {
  return actual === expected;
}

// ---------------------------------------------------------------------------
// Snapshot assertion (delegates to backend)
// ---------------------------------------------------------------------------

interface SnapshotResult {
  passed: boolean;
  diff?: string;
  needsBaseline?: boolean;
}

async function runSnapshotAssertion(
  ctx: AssertContext,
  backend: BackendExecutor,
): Promise<SnapshotResult> {
  const expectedPath = getExpectedPath(ctx);

  // Snapshot mode: capture baselines
  if ((ctx as any).snapshotMode) {
    await writeSnapshot(ctx.response.raw, ctx.test, ctx.config, expectedPath, backend);
    return { passed: true };
  }

  // No baseline exists yet
  if (!existsSync(expectedPath)) {
    return { passed: false, needsBaseline: true };
  }

  const ignoreFields = [
    ...(ctx.config.ignore_fields_global ?? []),
    ...(ctx.test.response?.ignore_fields ?? []),
  ];

  const normalizedActual = await backend.normalizeJson(ctx.response.raw, ignoreFields);
  const expectedRaw = readFileSync(expectedPath, 'utf8');
  const normalizedExpected = await backend.normalizeJson(expectedRaw, ignoreFields);

  if (normalizedActual === normalizedExpected) {
    return { passed: true };
  }

  const diff = await backend.runDiff(normalizedExpected, normalizedActual);
  return { passed: false, diff };
}

export async function writeSnapshot(
  raw: string,
  test: TestDefinition,
  config: ShogunConfig,
  expectedPath?: string,
  backend?: BackendExecutor,
): Promise<void> {
  const be = backend ?? getActiveBackend();
  const path = expectedPath ?? getExpectedPathFromTest(test, config);
  const ignoreFields = [
    ...(config.ignore_fields_global ?? []),
    ...(test.response?.ignore_fields ?? []),
  ];
  const normalized = await be.normalizeJson(raw, ignoreFields);

  // Refuse to write a blank baseline
  if (!normalized.trim()) {
    if (process.env.SHOGUN_DEBUG) {
      console.warn(`[asserter] writeSnapshot suppressed for "${path}" — normalized content is empty`);
    }
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalized + '\n', 'utf8');
}

function getExpectedPath(ctx: AssertContext): string {
  return getExpectedPathFromTest(ctx.test, ctx.config, ctx.cwd, ctx.collectionName);
}

export function getExpectedPathFromTest(
  test: TestDefinition,
  config: ShogunConfig,
  cwd = process.cwd(),
  collectionName?: string,
): string {
  const expectedDir = join(cwd, config.paths?.expected ?? 'expected');
  const collection = collectionName ?? test.collection ?? 'default';
  const safeName = sanitizeName(test.request.method, test.request.path);
  return join(expectedDir, collection, `${safeName}.json`);
}

// ---------------------------------------------------------------------------
// Aggregate helper (pure TS — no backend needed)
// ---------------------------------------------------------------------------

export function assertionsAllPassed(results: AssertionResults): boolean {
  if (results.status === false) return false;
  if (results.shape?.some(s => !s.passed)) return false;
  if (results.snapshot === false) return false;
  if (results.postScript === false) return false;
  return true;
}
