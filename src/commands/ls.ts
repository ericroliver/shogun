/**
 * src/commands/ls.ts — `shogun ls` command
 *
 * Lists available resources in the test repo: environments, collections,
 * suites, and individual test files.  Useful for discovery and scripting.
 *
 * Usage:
 *   shogun ls                List everything (envs, collections, suites, tests)
 *   shogun ls envs           List environment files only
 *   shogun ls collections    List collections only
 *   shogun ls suites         List suites only
 *   shogun ls tests          List all test files across collections
 *   shogun ls tests --collection agents   List tests in a specific collection
 *   shogun ls --format json  JSON output (for scripting)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { loadConfig, discoverCollections, listEnvFiles } from '../loader.js';
import type { ShogunConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

function getEnvs(config: ShogunConfig, cwd: string): string[] {
  const envsDir = join(cwd, config.paths?.envs ?? 'envs');
  return listEnvFiles(envsDir);
}

function getCollections(config: ShogunConfig, cwd: string): string[] {
  return discoverCollections(config, cwd);
}

function getSuites(config: ShogunConfig, cwd: string): string[] {
  const suitesDir = join(cwd, config.paths?.tests ?? 'tests', 'suites');
  if (!existsSync(suitesDir)) return [];
  return readdirSync(suitesDir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => f.replace(/\.yaml$/, ''))
    .sort();
}

function getTestsInCollection(
  collectionName: string,
  config: ShogunConfig,
  cwd: string,
): string[] {
  const collectionsDir = join(cwd, config.paths?.tests ?? 'tests', 'collections');
  const collectionDir = join(collectionsDir, collectionName);
  if (!existsSync(collectionDir)) return [];
  return readdirSync(collectionDir)
    .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml')
    .map(f => f.replace(/\.yaml$/, ''))
    .sort();
}

interface TestWithType {
  name: string;
  type: string;
}

function getTestsWithType(
  collectionName: string,
  config: ShogunConfig,
  cwd: string,
): TestWithType[] {
  const collectionsDir = join(cwd, config.paths?.tests ?? 'tests', 'collections');
  const collectionDir = join(collectionsDir, collectionName);
  if (!existsSync(collectionDir)) return [];
  const files = readdirSync(collectionDir)
    .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml')
    .sort();

  return files.map(f => {
    let type = 'http';  // default
    try {
      const raw = readFileSync(join(collectionDir, f), 'utf8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      if (parsed?.['type'] === 'sql') type = 'sql';
      else if (parsed?.['type'] === 'agent') type = 'agent';
    } catch {
      // ignore — show as http default
    }
    return { name: f.replace(/\.yaml$/, ''), type };
  });
}

function getAllTests(
  config: ShogunConfig,
  cwd: string,
): Record<string, TestWithType[]> {
  const collections = getCollections(config, cwd);
  const result: Record<string, TestWithType[]> = {};
  for (const col of collections) {
    result[col] = getTestsWithType(col, config, cwd);
  }
  return result;
}

function getRuns(config: ShogunConfig, cwd: string): string[] {
  const runsDir = join(cwd, config.paths?.runs ?? 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse();
}

function getSetupFixtures(config: ShogunConfig, cwd: string): string[] {
  const fixturesDir = join(cwd, config.paths?.setup_fixtures ?? 'tests/setup-fixtures');
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => f.replace(/\.yaml$/, ''))
    .sort();
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

interface LsResult {
  envs: string[];
  collections: string[];
  suites: string[];
  tests: Record<string, TestWithType[]>;
  setupFixtures: string[];
  runs: string[];
}

function gatherAll(config: ShogunConfig, cwd: string): LsResult {
  return {
    envs: getEnvs(config, cwd),
    collections: getCollections(config, cwd),
    suites: getSuites(config, cwd),
    tests: getAllTests(config, cwd),
    setupFixtures: getSetupFixtures(config, cwd),
    runs: getRuns(config, cwd),
  };
}

function printSection(title: string, items: string[]): void {
  console.log(`\n  ${title} (${items.length}):`);
  if (items.length === 0) {
    console.log('    —');
  } else {
    for (const item of items) {
      console.log(`    • ${item}`);
    }
  }
}

function printHuman(result: LsResult): void {
  printSection('Environments', result.envs);
  printSection('Collections', result.collections);
  printSection('Suites', result.suites);
  printSection('Setup Fixtures', result.setupFixtures);

  // Tests are nested under collections
  const totalTests = Object.values(result.tests).reduce((sum, tests) => sum + tests.length, 0);
  console.log(`\n  Tests (${totalTests}):`);
  if (totalTests === 0) {
    console.log('    —');
  } else {
    for (const [col, tests] of Object.entries(result.tests)) {
      if (tests.length === 0) continue;
      console.log(`    ${col}/`);
      for (const t of tests) {
        console.log(`      [${t.type}] ${t.name}`);
      }
    }
  }

  // Recent runs (show last 5)
  const recentRuns = result.runs.slice(0, 5);
  console.log(`\n  Recent Runs (${result.runs.length} total, showing ${recentRuns.length}):`);
  if (recentRuns.length === 0) {
    console.log('    —');
  } else {
    for (const r of recentRuns) {
      console.log(`    • ${r}`);
    }
  }

  console.log('');
}

function printJson(result: LsResult): void {
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export interface LsOptions {
  /** What to list: 'envs' | 'collections' | 'suites' | 'tests' | 'runs' | 'fixtures' | undefined (all) */
  target?: string;
  /** Filter tests by collection (only valid with target='tests') */
  collection?: string;
  /** Output format */
  format?: 'pretty' | 'json';
}

export async function ls(opts: LsOptions): Promise<number> {
  try {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    const format = opts.format ?? 'pretty';

    // Handle single-target modes
    if (opts.target) {
      switch (opts.target) {
        case 'envs': {
          const items = getEnvs(config, cwd);
          if (format === 'json') {
            console.log(JSON.stringify({ envs: items }, null, 2));
          } else {
            printSection('Environments', items);
            console.log('');
          }
          return 0;
        }
        case 'collections': {
          const items = getCollections(config, cwd);
          if (format === 'json') {
            console.log(JSON.stringify({ collections: items }, null, 2));
          } else {
            printSection('Collections', items);
            console.log('');
          }
          return 0;
        }
        case 'suites': {
          const items = getSuites(config, cwd);
          if (format === 'json') {
            console.log(JSON.stringify({ suites: items }, null, 2));
          } else {
            printSection('Suites', items);
            console.log('');
          }
          return 0;
        }
        case 'fixtures': {
          const items = getSetupFixtures(config, cwd);
          if (format === 'json') {
            console.log(JSON.stringify({ setupFixtures: items }, null, 2));
          } else {
            printSection('Setup Fixtures', items);
            console.log('');
          }
          return 0;
        }
        case 'runs': {
          const items = getRuns(config, cwd);
          if (format === 'json') {
            console.log(JSON.stringify({ runs: items }, null, 2));
          } else {
            printSection('Recent Runs', items.slice(0, 10));
            console.log('');
          }
          return 0;
        }
        case 'tests': {
          if (opts.collection) {
            const items = getTestsWithType(opts.collection, config, cwd);
            if (format === 'json') {
              console.log(JSON.stringify({ collection: opts.collection, tests: items }, null, 2));
            } else {
              console.log(`\n  Tests in "${opts.collection}" (${items.length}):`);
              if (items.length === 0) {
                console.log('    —');
              } else {
                for (const t of items) {
                  console.log(`    [${t.type}] ${t.name}`);
                }
              }
              console.log('');
            }
          } else {
            const tests = getAllTests(config, cwd);
            if (format === 'json') {
              console.log(JSON.stringify({ tests }, null, 2));
            } else {
              const total = Object.values(tests).reduce((s, t) => s + t.length, 0);
              console.log(`\n  Tests (${total}):`);
              if (total === 0) {
                console.log('    —');
              } else {
                for (const [col, colTests] of Object.entries(tests)) {
                  if (colTests.length === 0) continue;
                  console.log(`    ${col}/`);
                  for (const t of colTests) {
                    console.log(`      [${t.type}] ${t.name}`);
                  }
                }
              }
              console.log('');
            }
          }
          return 0;
        }
        default: {
          console.error(`Unknown target: "${opts.target}"`);
          console.error('Available targets: envs, collections, suites, tests, runs, fixtures');
          return 1;
        }
      }
    }

    // Default: list everything
    const result = gatherAll(config, cwd);
    if (format === 'json') {
      printJson(result);
    } else {
      printHuman(result);
    }
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
