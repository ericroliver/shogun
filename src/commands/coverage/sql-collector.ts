/**
 * src/commands/coverage/sql-collector.ts
 * Collect SQL test entries from YAML files — static analysis (no DB connection).
 *
 * Scans all collection directories for `type: sql` test YAML files and extracts
 * metadata: proc name, connection, parameter sets, baseline existence, scripts.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import * as yaml from 'js-yaml';
import {
  loadSuite,
  discoverCollections,
  loadSqlParameters,
} from '../../loader.js';
import { getSqlBaselinePath } from '../../sql-snapshot.js';
import type { ShogunConfig, SqlConnectionConfig } from '../../types.js';
import type { SqlTestEntry } from './types.js';

export async function collectSqlTestEntries(
  config: ShogunConfig,
  cwd: string,
  collectionFilter?: string | string[],
  suiteFilter?: string,
  env?: Record<string, string>,
): Promise<SqlTestEntry[]> {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');

  // Determine which collections to scan (same logic as test-collector.ts)
  let collectionNames: string[];

  if (suiteFilter) {
    const suite = loadSuite(suiteFilter, config, cwd);
    collectionNames = suite.collections;
  } else if (collectionFilter) {
    collectionNames = Array.isArray(collectionFilter) ? collectionFilter : [collectionFilter];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  const entries: SqlTestEntry[] = [];
  const envVars = env ?? {};

  for (const collectionName of collectionNames) {
    const collectionDir = join(collectionsDir, collectionName);
    if (!existsSync(collectionDir)) continue;

    const yamlFiles = readdirSync(collectionDir)
      .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml');

    for (const file of yamlFiles) {
      const filePath = join(collectionDir, file);
      const relPath = relative(cwd, filePath);

      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(filePath, 'utf8'));
      } catch {
        continue; // Skip unreadable — lint handles validation
      }

      const p = parsed as Record<string, unknown>;
      // Only collect type: sql tests
      if (p['type'] !== 'sql') continue;

      const sql = p['sql'] as Record<string, unknown> | undefined;
      if (!sql) continue;

      const proc = typeof sql['proc'] === 'string' ? sql['proc'] as string : '';
      const connection = typeof sql['connection'] === 'string' ? sql['connection'] as string : '';
      if (!proc || !connection) continue;

      const name = typeof p['name'] === 'string' ? p['name'] : file.replace(/\.yaml$/, '');

      // --- Parameter sets ---
      let paramSetCount = 0;
      let paramKeys: string[] = [];
      const parameters = sql['parameters'] as Record<string, unknown> | undefined;
      if (parameters) {
        try {
          const paramSets = loadSqlParameters(
            parameters as { inline: Record<string, unknown>[] } | { file: string },
            filePath,
            envVars,
          );
          paramSetCount = paramSets.length;
          const keySet = new Set<string>();
          for (const ps of paramSets) {
            for (const key of Object.keys(ps)) {
              keySet.add(key);
            }
          }
          paramKeys = [...keySet].sort();
        } catch {
          // Parameter file missing or invalid — record 0 sets
          paramSetCount = 0;
        }
      }

      // --- Baseline existence ---
      const baselinePath = getSqlBaselinePath(proc, config, cwd, collectionName);
      const baselineExists = existsSync(baselinePath);
      const baselineRel = relative(cwd, baselinePath);

      // --- Response config ---
      const response = p['response'] as Record<string, unknown> | undefined;
      const rawIgnoreFields = response?.['ignore_fields'];
      const ignoreFields = Array.isArray(rawIgnoreFields) ? (rawIgnoreFields as string[]) : [];
      const diffMode = (response?.['diff_mode'] as 'strict' | 'relaxed') ?? 'strict';

      // --- Scripts ---
      const preScript = p['pre'];
      const postScript = p['post'];
      const hasPreScript = typeof preScript === 'string' && preScript.trim().length > 0;
      const hasPostScript = typeof postScript === 'string' && postScript.trim().length > 0;

      // --- Output format ---
      const outputFormat = (sql['outputFormat'] as 'json' | 'csv' | 'both') ?? 'json';
      const timeout = typeof sql['timeout'] === 'number' ? sql['timeout'] as number : undefined;

      // --- Tags ---
      const rawTags = p['tags'];
      const tags = Array.isArray(rawTags) ? (rawTags as string[]) : [];

      // --- Driver from config connections ---
      const driver = resolveDriver(connection, config);

      entries.push({
        name,
        file: relPath,
        collection: collectionName,
        proc,
        connection,
        driver,
        paramSetCount,
        paramKeys,
        baselineExists,
        baselinePath: baselineRel,
        hasPreScript,
        hasPostScript,
        ignoreFields,
        diffMode,
        outputFormat,
        timeout,
        tags,
      });
    }
  }

  return entries;
}

/**
 * Look up the driver type for a named connection from config.connections.
 */
function resolveDriver(connectionName: string, config: ShogunConfig): string | undefined {
  const connections = config.connections;
  if (!connections || !connections[connectionName]) return undefined;
  return connections[connectionName]!.driver;
}
