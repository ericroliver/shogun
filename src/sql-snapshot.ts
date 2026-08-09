/**
 * src/sql-snapshot.ts
 * SQL snapshot baseline write/diff with strict + relaxed modes.
 *
 * Strict mode:  any schema or data difference fails the test.
 * Relaxed mode: extra columns in actual results are ignored; only columns
 *               present in the baseline are compared. Row count and value
 *               changes still fail.
 *
 * Also handles CSV export for output artifacts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ShogunConfig, TestDefinition } from './types.js';
import type { SqlExecResult } from './sql-driver.js';

// ---------------------------------------------------------------------------
// Baseline path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the baseline file path for a SQL test.
 * Format: expected/{collection}/sql_{procName}.json
 */
export function getSqlBaselinePath(
  procName: string,
  config: ShogunConfig,
  cwd: string,
  collectionName?: string,
): string {
  const expectedDir = join(cwd, config.paths?.expected ?? 'expected');
  const collection = collectionName ?? 'default';
  return join(expectedDir, collection, `sql_${procName}.json`);
}

// ---------------------------------------------------------------------------
// Baseline write
// ---------------------------------------------------------------------------

/**
 * Write a SQL baseline file (all parameter set results).
 * Strips ignore_fields from the results before writing.
 */
export async function writeSqlBaseline(
  results: SqlExecResult[],
  baselinePath: string,
  ignoreFields: string[],
): Promise<void> {
  const normalized = normalizeSqlResults(results, ignoreFields);
  const json = JSON.stringify(normalized, null, 2);

  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, json + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Baseline diff
// ---------------------------------------------------------------------------

export interface SqlSnapshotResult {
  passed: boolean;
  diff?: string;
  needsBaseline?: boolean;
  extraColumns?: string[];
}

/**
 * Diff SQL results against a baseline file.
 * Supports strict and relaxed modes.
 */
export function diffSqlBaseline(
  actualResults: SqlExecResult[],
  baselinePath: string,
  ignoreFields: string[],
  diffMode: 'strict' | 'relaxed',
): SqlSnapshotResult {
  // 1. Check baseline exists
  if (!existsSync(baselinePath)) {
    return { passed: false, needsBaseline: true };
  }

  // 2. Normalize actual and expected (strip ignore_fields)
  const normalizedActual = normalizeSqlResults(actualResults, ignoreFields);
  const expectedRaw = readFileSync(baselinePath, 'utf8');
  const normalizedExpected = JSON.parse(expectedRaw) as SqlExecResult[];

  // 3. Strict mode: direct comparison
  if (diffMode === 'strict') {
    const actualJson = JSON.stringify(normalizedActual, null, 2);
    const expectedJson = JSON.stringify(normalizedExpected, null, 2);
    if (actualJson === expectedJson) {
      return { passed: true };
    }
    const diff = generateDiff(normalizedExpected, normalizedActual);
    return { passed: false, diff };
  }

  // 4. Relaxed mode: project both baseline and actual onto baseline columns
  const { projected, extraColumns } = projectOntoBaselineColumns(normalizedActual, normalizedExpected);
  const actualJson = JSON.stringify(projected, null, 2);
  const expectedJson = JSON.stringify(normalizedExpected, null, 2);

  if (actualJson === expectedJson) {
    return { passed: true, extraColumns };
  }
  const diff = generateDiff(normalizedExpected, projected);
  return { passed: false, diff, extraColumns };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize SQL results by stripping ignored fields.
 * ignore_fields patterns use a dot-path syntax:
 *   "executionTime"          — top-level on each result set row
 *   "**.executionTime"       — any depth (glob prefix)
 *   "resultSets.0.executionTime" — specific result set index
 *
 * For SQL, we apply ignore_fields to row-level columns.
 */
function normalizeSqlResults(
  results: SqlExecResult[],
  ignoreFields: string[],
): SqlExecResult[] {
  if (!ignoreFields.length) return results;

  const ignoreSet = new Set(ignoreFields.map(f => f.replace(/\*\*\./g, '')));

  return results.map(result => ({
    ...result,
    resultSets: result.resultSets.map(rs => ({
      columns: rs.columns.filter(c => !ignoreSet.has(c)),
      rows: rs.rows.map(row => {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (!ignoreSet.has(key)) {
            filtered[key] = value;
          }
        }
        return filtered;
      }),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Relaxed mode projection
// ---------------------------------------------------------------------------

/**
 * For each param set's result sets, keep only the columns present in the
 * corresponding baseline result set. Extra columns in actual are dropped.
 *
 * Returns the projected results and a list of extra column names that were
 * found in the actual but not in the baseline.
 */
function projectOntoBaselineColumns(
  actual: SqlExecResult[],
  baseline: SqlExecResult[],
): { projected: SqlExecResult[]; extraColumns: string[] } {
  const extraColumns: string[] = [];

  const projected = actual.map((actResult, i) => {
    const baseResult = baseline[i];
    if (!baseResult) return actResult;  // no baseline for this index — keep as-is

    return {
      ...actResult,
      resultSets: actResult.resultSets.map((rs, rsIdx) => {
        const baseRs = baseResult.resultSets[rsIdx];
        if (!baseRs) return rs;

        const baseColumns = new Set(baseRs.columns);
        const extra = rs.columns.filter(c => !baseColumns.has(c));
        extraColumns.push(...extra);

        return {
          columns: rs.columns.filter(c => baseColumns.has(c)),
          rows: rs.rows.map(row => {
            const proj: Record<string, unknown> = {};
            for (const col of rs.columns) {
              if (baseColumns.has(col)) {
                proj[col] = row[col];
              }
            }
            return proj;
          }),
        };
      }),
    };
  });

  return { projected, extraColumns: [...new Set(extraColumns)] };
}

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------

/**
 * Generate a unified diff between expected and actual SQL results.
 * Produces a human-readable diff showing what changed.
 */
function generateDiff(expected: SqlExecResult[], actual: SqlExecResult[]): string {
  const lines: string[] = [];
  const maxLen = Math.max(expected.length, actual.length);

  for (let i = 0; i < maxLen; i++) {
    const exp = expected[i];
    const act = actual[i];

    if (!exp) {
      lines.push(`+ param ${i}: unexpected result set`);
      continue;
    }
    if (!act) {
      lines.push(`- param ${i}: missing result set`);
      continue;
    }

    // Compare params
    const expParams = JSON.stringify(exp.params);
    const actParams = JSON.stringify(act.params);
    if (expParams !== actParams) {
      lines.push(`  param ${i}: params changed`);
      lines.push(`-   ${expParams}`);
      lines.push(`+   ${actParams}`);
    }

    // Compare result sets
    const maxRs = Math.max(exp.resultSets.length, act.resultSets.length);
    for (let rs = 0; rs < maxRs; rs++) {
      const expRs = exp.resultSets[rs];
      const actRs = act.resultSets[rs];

      if (!expRs) {
        lines.push(`+ param ${i}, result set ${rs}: unexpected`);
        continue;
      }
      if (!actRs) {
        lines.push(`- param ${i}, result set ${rs}: missing`);
        continue;
      }

      // Compare columns
      const expCols = expRs.columns.join(', ');
      const actCols = actRs.columns.join(', ');
      if (expCols !== actCols) {
        lines.push(`  param ${i}, result set ${rs}: columns changed`);
        lines.push(`-   [${expCols}]`);
        lines.push(`+   [${actCols}]`);
      }

      // Compare row counts
      if (expRs.rows.length !== actRs.rows.length) {
        lines.push(`  param ${i}, result set ${rs}: row count changed (${expRs.rows.length} → ${actRs.rows.length})`);
      }

      // Compare row data (only if columns match)
      if (expCols === actCols) {
        const maxRows = Math.max(expRs.rows.length, actRs.rows.length);
        for (let r = 0; r < maxRows; r++) {
          const expRow = expRs.rows[r];
          const actRow = actRs.rows[r];
          const expJson = JSON.stringify(expRow);
          const actJson = JSON.stringify(actRow);
          if (expJson !== actJson) {
            lines.push(`  param ${i}, result set ${rs}, row ${r}:`);
            if (expRow) lines.push(`-   ${expJson}`);
            if (actRow) lines.push(`+   ${actJson}`);
          }
        }
      }
    }
  }

  return lines.length ? lines.join('\n') : 'differences detected but could not generate detailed diff';
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Write CSV artifacts for a SQL test.
 * One CSV per param set per result set.
 * Files are written to the run log directory.
 */
export function writeCsvArtifacts(
  results: SqlExecResult[],
  runDir: string,
  collectionName: string,
  procName: string,
): string[] {
  const writtenFiles: string[] = [];

  for (const result of results) {
    for (let rsIdx = 0; rsIdx < result.resultSets.length; rsIdx++) {
      const rs = result.resultSets[rsIdx];
      const csv = resultSetToCsv(rs);
      const filename = `${collectionName}--sql_${procName}_${result.paramIndex}_${rsIdx}.csv`;
      const filepath = join(runDir, filename);
      writeFileSync(filepath, csv, 'utf8');
      writtenFiles.push(filepath);
    }
  }

  return writtenFiles;
}

/**
 * Convert a single result set to CSV string.
 */
function resultSetToCsv(rs: { columns: string[]; rows: Record<string, unknown>[] }): string {
  const lines: string[] = [];

  // Header
  lines.push(rs.columns.map(escapeCsv).join(','));

  // Rows
  for (const row of rs.rows) {
    lines.push(rs.columns.map(col => escapeCsv(row[col])).join(','));
  }

  return lines.join('\n') + '\n';
}

/**
 * Escape a value for CSV output.
 */
function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}