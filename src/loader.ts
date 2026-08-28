/**
 * src/loader.ts
 * Loads and validates environment files, shogun.config.yaml,
 * test definition YAML files, and collection definitions.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import type {
  ShogunConfig,
  EnvVars,
  TestDefinition,
  CollectionDefinition,
  SuiteDefinition,
  SetupFixtureDefinition,
  CoverageConfig,
  CoverageRiskWeights,
  CoverageMinThresholds,
  SqlConnectionConfig,
  SqlTestConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

const CoverageRiskWeightsSchema = z.object({
  responseCodeGap: z.number().optional(),
  parameterGap: z.number().optional(),
  bodyFieldGap: z.number().optional(),
  assertionQuality: z.number().optional(),
  runResults: z.number().optional(),
}).optional();

const CoverageMinThresholdsSchema = z.object({
  endpoint: z.number().optional(),
  responseCode: z.number().optional(),
  parameter: z.number().optional(),
  bodyField: z.number().optional(),
}).optional();

const CoverageConfigSchema = z.object({
  defaultSuite: z.string().optional(),
  riskWeights: CoverageRiskWeightsSchema,
  expectedTagsByMethod: z.record(z.array(z.string())).optional(),
  minCoverage: CoverageMinThresholdsSchema,
  suppressDrift: z.array(z.string()).optional(),
}).passthrough();

const ShogunConfigSchema = z.object({
  version: z.number(),
  defaults: z.object({
    env: z.string().optional(),
    timeout: z.number().optional(),
    follow_redirects: z.boolean().optional(),
    content_type: z.string().optional(),
    auto_inject_auth: z.boolean().optional(),
  }).optional(),
  paths: z.object({
    tests: z.string().optional(),
    envs: z.string().optional(),
    expected: z.string().optional(),
    runs: z.string().optional(),
    scripts: z.string().optional(),
    setup_fixtures: z.string().optional(),
  }).optional(),
  ignore_fields_global: z.array(z.string()).optional(),
  reporting: z.object({
    format: z.enum(['pretty', 'json', 'tap']).optional(),
    on_fail: z.enum(['diff', 'body', 'silent']).optional(),
    save_passing_logs: z.boolean().optional(),
  }).optional(),
  spec: z.object({
    path: z.string().min(1),
  }).optional(),
  connections: z.record(
    z.object({
      driver: z.enum(['mssql', 'postgres', 'sqlite']),
      connectionString: z.string().min(1),
      timeout: z.number().optional(),
    })
  ).optional(),
  coverage: CoverageConfigSchema.optional(),
});

export function loadConfig(cwd: string = process.cwd()): ShogunConfig {
  // Support both spellings: "shogun.config.yaml" (canonical) and
  // "shotgun.config.yaml" (legacy name used in existing test repos)
  const candidateNames = ['shogun.config.yaml', 'shotgun.config.yaml'];
  const configPath = candidateNames.map(n => join(cwd, n)).find(p => existsSync(p));
  if (!configPath) {
    // Return sensible defaults when no config file is present
    return { version: 1 };
  }
  const raw = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

  // Warn on unknown keys inside coverage: (forward-compatibility)
  if (raw && typeof raw === 'object' && raw.coverage && typeof raw.coverage === 'object') {
    const knownCoverageKeys = new Set([
      'defaultSuite',
      'riskWeights',
      'expectedTagsByMethod',
      'minCoverage',
      'suppressDrift',
    ]);
    const knownRiskKeys = new Set([
      'responseCodeGap',
      'parameterGap',
      'bodyFieldGap',
      'assertionQuality',
      'runResults',
    ]);
    const cov = raw.coverage as Record<string, unknown>;
    for (const key of Object.keys(cov)) {
      if (!knownCoverageKeys.has(key)) {
        console.warn(`[shogun] Unknown coverage key "${key}" in shogun.config.yaml — ignored.`);
      }
    }
    if (cov.riskWeights && typeof cov.riskWeights === 'object') {
      for (const key of Object.keys(cov.riskWeights as Record<string, unknown>)) {
        if (!knownRiskKeys.has(key)) {
          console.warn(`[shogun] Unknown coverage.riskWeights key "${key}" — ignored.`);
        }
      }
    }
  }

  const result = ShogunConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid shogun.config.yaml:\n${result.error.toString()}`);
  }
  return result.data as ShogunConfig;
}

// ---------------------------------------------------------------------------
// Coverage config resolution
// ---------------------------------------------------------------------------

export const DEFAULT_RISK_WEIGHTS: CoverageRiskWeights = {
  responseCodeGap: 0.35,
  parameterGap: 0.15,
  bodyFieldGap: 0.15,
  assertionQuality: 0.20,
  runResults: 0.15,
};

export const DEFAULT_EXPECTED_TAGS_BY_METHOD: Record<string, string[]> = {
  GET: ['readonly'],
  POST: ['crud', 'validation'],
  PATCH: ['crud'],
  PUT: ['crud', 'validation'],
  DELETE: ['crud', 'guard'],
};

/**
 * Merges user-supplied coverage config over hardcoded defaults.
 * Returns a fully-resolved object with no optional fields — every downstream
 * consumer can read values directly without null-checking.
 */
export function resolveCoverageConfig(config: ShogunConfig): {
  defaultSuite: string | undefined;
  riskWeights: CoverageRiskWeights;
  expectedTagsByMethod: Record<string, string[]>;
  minCoverage: CoverageMinThresholds;
  suppressDrift: string[];
} {
  const c: CoverageConfig = config.coverage ?? {};

  // Normalize expectedTagsByMethod keys to uppercase
  let expectedTagsByMethod: Record<string, string[]> = DEFAULT_EXPECTED_TAGS_BY_METHOD;
  if (c.expectedTagsByMethod) {
    expectedTagsByMethod = {};
    for (const [method, tags] of Object.entries(c.expectedTagsByMethod)) {
      expectedTagsByMethod[method.toUpperCase()] = tags;
    }
  }

  return {
    defaultSuite: c.defaultSuite,
    riskWeights: { ...DEFAULT_RISK_WEIGHTS, ...(c.riskWeights ?? {}) },
    expectedTagsByMethod,
    minCoverage: c.minCoverage ?? {},
    // Default: suppress 401 drift (JWT middleware is a cross-cutting concern
    // that applies to every authenticated endpoint — per-endpoint noise hides
    // real drift). Config can override; CLI --suppress-drift augments.
    suppressDrift: c.suppressDrift ?? ['401'],
  };
}

// ---------------------------------------------------------------------------
// Environment files
// ---------------------------------------------------------------------------

export function loadEnv(envName: string, config: ShogunConfig, cwd: string = process.cwd()): EnvVars {
  const envsDir = join(cwd, config.paths?.envs ?? 'envs');
  const envFile = join(envsDir, `${envName}.env`);

  if (!existsSync(envFile)) {
    throw new Error(`Environment file not found: ${envFile}\nAvailable: ${listEnvFiles(envsDir).join(', ')}`);
  }

  const result = dotenvConfig({ path: envFile, override: true });
  if (result.error) {
    throw new Error(`Failed to parse env file ${envFile}: ${result.error.message}`);
  }

  // Return only the vars from this file (dotenv merges into process.env)
  return result.parsed ?? {};
}

export function listEnvFiles(envsDir: string): string[] {
  if (!existsSync(envsDir)) return [];
  return readdirSync(envsDir)
    .filter(f => f.endsWith('.env') && !f.endsWith('.env.example'))
    .map(f => f.replace('.env', ''));
}

// ---------------------------------------------------------------------------
// Test definition YAML schema (Zod)
// ---------------------------------------------------------------------------

const FormFileSchema = z.object({
  path: z.string().min(1, 'form_files.*.path is required'),
  content_type: z.string().optional(),
  filename: z.string().optional(),
});

const RequestBodySchema = z.object({
  inline: z.record(z.unknown()).optional(),
  file: z.string().optional(),
  form_fields: z.record(z.string()).optional(),
  form_files: z.record(FormFileSchema).optional(),
}).optional();

const RequestDefSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1, 'request.path is required'),
  headers: z.record(z.string()).optional(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  content_type: z.string().optional(),
  body: RequestBodySchema,
}).refine(
  (data) => {
    // If body has form_fields or form_files, content_type should be multipart/form-data
    const body = data.body ?? {};
    if ((body.form_fields || body.form_files) && data.content_type !== 'multipart/form-data') {
      return false;
    }
    return true;
  },
  { message: 'request.content_type must be "multipart/form-data" when form_fields or form_files are used' },
);

const ResponseDefSchema = z.object({
  status: z.number().int().min(100).max(599).optional(),
  snapshot: z.boolean().optional(),
  ignore_fields: z.array(z.string()).optional(),
  shape: z.array(z.string()).optional(),
  diff_mode: z.enum(['strict', 'relaxed']).optional(),
}).optional();

// SQL test configuration schema
const SqlTestConfigSchema = z.object({
  connection: z.string().min(1, 'sql.connection is required'),
  proc: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  baseline: z.string().optional(),
  parameters: z.union([
    z.object({
      inline: z.array(z.record(z.unknown())),
    }),
    z.object({
      file: z.string().min(1, 'sql.parameters.file is required'),
    }),
  ]).optional(),
  outputFormat: z.enum(['json', 'csv', 'both']).optional(),
  timeout: z.number().optional(),
  pre: z.string().optional(),
  post: z.string().optional(),
}).refine(
  (data) => data.proc || data.query,
  { message: 'Either sql.proc or sql.query is required' },
).optional();

export const TestDefinitionSchema = z.object({
  name: z.string().min(1, 'name is required'),
  type: z.enum(['http', 'sql']).optional(),
  description: z.string().optional(),
  collection: z.string().optional(),
  tags: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  pre: z.string().optional(),
  request: RequestDefSchema.optional(),
  response: ResponseDefSchema,
  post: z.string().optional(),
  sql: SqlTestConfigSchema,
}).refine(
  // request is required when type is 'http' or undefined
  (data) => (data.type === 'sql') || (data.request !== undefined),
  { message: 'request is required for HTTP tests (type is http or omitted)' },
);

// ---------------------------------------------------------------------------
// Test definition loader
// ---------------------------------------------------------------------------

export function loadTestFile(filePath: string, env: EnvVars): TestDefinition {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Test file not found: ${absPath}`);
  }

  const raw = readFileSync(absPath, 'utf8');
  const interpolated = interpolateEnv(raw, env);
  const parsed = yaml.load(interpolated);

  const result = TestDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid test file ${absPath}:\n${formatZodError(result.error)}`);
  }

  return result.data as TestDefinition;
}

// ---------------------------------------------------------------------------
// Collection definition loader
// ---------------------------------------------------------------------------

const CollectionDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  order: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  setup_fixtures: z.array(z.string()).optional(),
  setup: z.string().optional(),
  teardown: z.string().optional(),
  vars: z.record(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Setup fixture loader
// ---------------------------------------------------------------------------

const SetupFixtureSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  script: z.string().min(1, 'script is required'),
});

export function loadSetupFixture(
  fixtureName: string,
  config: ShogunConfig,
  cwd: string = process.cwd(),
): SetupFixtureDefinition {
  const fixturesDir = join(cwd, config.paths?.setup_fixtures ?? 'tests/setup-fixtures');
  const fixturePath = join(fixturesDir, `${fixtureName}.yaml`);

  if (!existsSync(fixturePath)) {
    throw new Error(
      `Setup fixture not found: "${fixtureName}"\n` +
      `  Expected: ${fixturePath}\n` +
      `  Available fixtures in ${fixturesDir}:\n` +
      listYamlBasenames(fixturesDir).map(n => `    - ${n}`).join('\n')
    );
  }

  const raw = yaml.load(readFileSync(fixturePath, 'utf8'));
  const result = SetupFixtureSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid fixture file ${fixturePath}:\n${formatZodError(result.error)}`);
  }
  return result.data as SetupFixtureDefinition;
}

function listYamlBasenames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => f.replace(/\.yaml$/, ''));
}

export function loadCollection(
  collectionName: string,
  config: ShogunConfig,
  cwd: string = process.cwd(),
): { definition: CollectionDefinition; testFiles: string[] } {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');
  const collectionDir = join(collectionsDir, collectionName);

  if (!existsSync(collectionDir)) {
    throw new Error(`Collection directory not found: ${collectionDir}`);
  }

  const collectionFile = join(collectionDir, '_collection.yaml');
  let definition: CollectionDefinition = { name: collectionName };

  if (existsSync(collectionFile)) {
    const raw = yaml.load(readFileSync(collectionFile, 'utf8'));
    const result = CollectionDefSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Invalid _collection.yaml in ${collectionName}:\n${formatZodError(result.error)}`);
    }
    definition = result.data as CollectionDefinition;
  }

  // Discover test files local to this collection
  const localTestFiles = readdirSync(collectionDir)
    .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml')
    .map(f => basename(f, '.yaml'));

  // Resolve ordered entries — supports cross-collection refs: "other-collection/test-name"
  const orderedEntries = definition.order ?? [];
  const resolvedOrdered: string[] = [];
  const resolvedOrderedKeys = new Set<string>(); // "collection/test" keys already added

  for (const entry of orderedEntries) {
    if (entry.includes('/')) {
      // Cross-collection reference: "other-collection/test-name" or "other-collection/test-name.yaml"
      const slashIdx = entry.indexOf('/');
      const refCollection = entry.slice(0, slashIdx);
      const refTestRaw = entry.slice(slashIdx + 1);
      const refTestBase = refTestRaw.endsWith('.yaml') ? refTestRaw.slice(0, -5) : refTestRaw;
      const refFile = join(collectionsDir, refCollection, `${refTestBase}.yaml`);
      if (!existsSync(refFile)) {
        throw new Error(
          `Cross-collection test reference not found: "${entry}" → ${refFile}\n` +
          `Referenced from collection "${collectionName}" _collection.yaml`
        );
      }
      resolvedOrdered.push(refFile);
      resolvedOrderedKeys.add(entry);
    } else {
      // Local reference — strip .yaml extension if present (order entries may or may not include it)
      const localBase = entry.endsWith('.yaml') ? entry.slice(0, -5) : entry;
      if (localTestFiles.includes(localBase)) {
        resolvedOrdered.push(join(collectionDir, `${localBase}.yaml`));
        resolvedOrderedKeys.add(localBase);
      } else {
        // Warn loudly — a bare name that matches nothing is almost certainly a mistake
        // (common cause: forgot the "collection/" prefix for a cross-collection ref)
        throw new Error(
          `Order entry not found: "${entry}" in collection "${collectionName}"\n` +
          `  Expected file: ${join(collectionDir, `${localBase}.yaml`)}\n` +
          `  If this is a cross-collection reference, use the form "other-collection/${localBase}" instead.`
        );
      }
    }
  }

  // When order: is explicitly defined in _collection.yaml, treat it as the
  // authoritative and complete list.  Files present on disk but absent from
  // order: are intentionally excluded (e.g. temporarily disabled tests).
  //
  // When order: is absent entirely (undefined), fall back to scanning the
  // directory so collections without an order: still work as before.
  let testFiles: string[];

  if (definition.order !== undefined) {
    // order: was explicitly set — honour it as the full list, no extras
    testFiles = resolvedOrdered;
  } else {
    // No order: at all — run every YAML file in the directory, sorted
    testFiles = localTestFiles
      .sort()
      .map(f => join(collectionDir, `${f}.yaml`));
  }

  return { definition, testFiles };
}

// ---------------------------------------------------------------------------
// Dependency graph builder
// ---------------------------------------------------------------------------

/**
 * Resolves a test reference string into a canonical "collection/test-name" ID
 * and an absolute file path. If `ownerCollection` is provided, bare names
 * (no slash) are resolved relative to that collection.
 */
export function resolveTestRef(
  ref: string,
  ownerCollection: string | undefined,
  collectionsDir: string,
): { canonicalId: string; filePath: string } {
  let collectionName: string;
  let testName: string;

  if (ref.includes('/')) {
    const slashIdx = ref.indexOf('/');
    collectionName = ref.slice(0, slashIdx);
    const raw = ref.slice(slashIdx + 1);
    testName = raw.endsWith('.yaml') ? raw.slice(0, -5) : raw;
  } else {
    if (!ownerCollection) {
      throw new Error(
        `dependsOn ref "${ref}" is a bare test name but no ownerCollection was provided. ` +
        `Use the "collection/test-name" form for cross-collection references.`
      );
    }
    collectionName = ownerCollection;
    testName = ref.endsWith('.yaml') ? ref.slice(0, -5) : ref;
  }

  const filePath = join(collectionsDir, collectionName, `${testName}.yaml`);
  const canonicalId = `${collectionName}/${testName}`;
  return { canonicalId, filePath };
}

/**
 * Builds a topologically ordered list of canonical test IDs that must run
 * before `startTestId`. Detects cycles and throws on first discovery.
 *
 * Returns the list in execution order (dependencies first, target last).
 * The target itself is NOT included in the returned list — callers handle that.
 */
export function buildDependencyOrder(
  startTestId: string,        // "collection/test-name"
  collectionsDir: string,
  env: EnvVars,
): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // cycle detection

  function visit(testId: string): void {
    if (visited.has(testId)) return; // already fully processed
    if (visiting.has(testId)) {
      throw new Error(
        `Circular dependency detected involving "${testId}".\n` +
        `  Current chain: ${[...visiting].join(' → ')} → ${testId}`
      );
    }

    visiting.add(testId);

    // Load this test's dependsOn list
    const slashIdx = testId.indexOf('/');
    const collectionName = testId.slice(0, slashIdx);
    const testName = testId.slice(slashIdx + 1);
    const filePath = join(collectionsDir, collectionName, `${testName}.yaml`);

    if (!existsSync(filePath)) {
      throw new Error(
        `dependsOn references a test that does not exist: "${testId}"\n` +
        `  Expected: ${filePath}`
      );
    }

    const raw = readFileSync(filePath, 'utf8');
    const parsed = yaml.load(interpolateEnv(raw, env)) as Record<string, unknown>;
    const deps = (parsed?.dependsOn as string[] | undefined) ?? [];

    for (const depRef of deps) {
      const { canonicalId } = resolveTestRef(depRef, collectionName, collectionsDir);
      visit(canonicalId);
    }

    visiting.delete(testId);
    visited.add(testId);
    order.push(testId);
  }

  // Process direct deps of the start test (not the start test itself)
  const slashIdx = startTestId.indexOf('/');
  const ownerCollection = startTestId.slice(0, slashIdx);
  const testName = startTestId.slice(slashIdx + 1);
  const filePath = join(collectionsDir, ownerCollection, `${testName}.yaml`);

  if (!existsSync(filePath)) {
    throw new Error(`Test file not found for dep resolution: "${startTestId}" → ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const parsed = yaml.load(interpolateEnv(raw, env)) as Record<string, unknown>;
  const deps = (parsed?.dependsOn as string[] | undefined) ?? [];

  for (const depRef of deps) {
    const { canonicalId } = resolveTestRef(depRef, ownerCollection, collectionsDir);
    visit(canonicalId);
  }

  return order; // execution order, target is excluded
}

// ---------------------------------------------------------------------------
// Collection discovery
// ---------------------------------------------------------------------------

export function discoverCollections(config: ShogunConfig, cwd: string = process.cwd()): string[] {
  const collectionsDir = join(cwd, config.paths?.tests ?? 'tests', 'collections');
  if (!existsSync(collectionsDir)) return [];

  return readdirSync(collectionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Helpers (additions)
// ---------------------------------------------------------------------------

/** Resolve a canonical test ID to the collection name portion */
export function collectionFromCanonicalId(canonicalId: string): string {
  const slashIdx = canonicalId.indexOf('/');
  if (slashIdx < 0) throw new Error(`Invalid canonical test ID (no slash): "${canonicalId}"`);
  return canonicalId.slice(0, slashIdx);
}

// ---------------------------------------------------------------------------
// Suite loader
// ---------------------------------------------------------------------------

const SuiteSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  collections: z.array(z.string()),
  tags: z.array(z.string()).optional(),
  vars: z.record(z.string()).optional(),
});

export function loadSuite(suiteName: string, config: ShogunConfig, cwd: string = process.cwd()): SuiteDefinition {
  const suitesDir = join(cwd, config.paths?.tests ?? 'tests', 'suites');
  const suiteFile = join(suitesDir, `${suiteName}.yaml`);

  if (!existsSync(suiteFile)) {
    throw new Error(`Suite file not found: ${suiteFile}`);
  }

  const raw = yaml.load(readFileSync(suiteFile, 'utf8'));
  const result = SuiteSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid suite file ${suiteFile}:\n${formatZodError(result.error)}`);
  }
  return result.data as SuiteDefinition;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace ${VAR_NAME} tokens in a string with env var values. */
export function interpolateEnv(text: string, env: EnvVars): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    return env[key] ?? process.env[key] ?? `\${${key}}`;
  });
}

// ---------------------------------------------------------------------------
// SQL connection resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a named connection from the config, interpolating ${VAR} tokens
 * in the connection string from env vars.
 */
export function resolveSqlConnection(
  connectionName: string,
  config: ShogunConfig,
  env: EnvVars,
): SqlConnectionConfig | null {
  const connections = config.connections;
  if (!connections || !connections[connectionName]) {
    return null;
  }

  const conn = connections[connectionName];
  return {
    driver: conn.driver,
    connectionString: interpolateEnv(conn.connectionString, env),
    timeout: conn.timeout,
  };
}

// ---------------------------------------------------------------------------
// SQL parameter file loader
// ---------------------------------------------------------------------------

/**
 * Load parameter sets from either inline array or external file.
 * Parameter files are relative to the test YAML file location.
 */
export function loadSqlParameters(
  parameters: { inline: Record<string, unknown>[] } | { file: string },
  testFilePath: string,
  env: EnvVars,
): Record<string, unknown>[] {
  if ('inline' in parameters) {
    return parameters.inline;
  }

  // File-based parameters — resolve relative to the test YAML file
  const testDir = dirname(resolve(testFilePath));
  const paramPath = resolve(testDir, parameters.file);

  if (!existsSync(paramPath)) {
    throw new Error(
      `SQL parameter file not found: ${paramPath}\n` +
      `  Referenced from: ${testFilePath}\n` +
      `  Resolved from: ${parameters.file}`
    );
  }

  const raw = readFileSync(paramPath, 'utf8');
  const interpolated = interpolateEnv(raw, env);
  const parsed = yaml.load(interpolated) as Record<string, unknown>;

  if (!parsed || !Array.isArray(parsed.parameters)) {
    throw new Error(
      `Invalid parameter file ${paramPath}:\n` +
      `  Expected a YAML object with a "parameters" key containing an array.`
    );
  }

  return parsed.parameters as Record<string, unknown>[];
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map(i => `  [${i.path.join('.')}] ${i.message}`)
    .join('\n');
}

/** Sanitize a method + path into a safe filename prefix. */
export function sanitizeName(method: string, path: string): string {
  return `${method}_${path}`
    .replace(/\//g, '_')
    .replace(/[{}]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

// ---------------------------------------------------------------------------
// Spec fetcher
// ---------------------------------------------------------------------------

export type SpecSourceType = 'full-url' | 'relative-url' | 'local-file';

/**
 * Resolves how the spec source string should be treated and fetches/reads it.
 *
 * Priority:
 *   1. `specSource` positional arg (overrides everything)
 *   2. `config.spec.path` from shogun.config.yaml
 *   3. Error — exit 1
 *
 * Detection:
 *   - Starts with "http://" or "https://"   → full URL, fetch directly
 *   - Local file exists at resolved path     → readFileSync
 *   - Otherwise                              → relative URL, prepend BASE_URL from env
 */
export async function fetchSpec(
  specSource: string | undefined,
  config: ShogunConfig,
  env: EnvVars,
  cwd: string = process.cwd(),
): Promise<{ raw: string; sourceType: SpecSourceType; resolvedUrl: string }> {
  // 1. Determine the raw source string
  const rawSource = specSource ?? config.spec?.path;

  if (!rawSource) {
    throw new Error(
      'No spec source. Set spec.path in shogun.config.yaml or pass a source as the first argument.\n' +
      '  Examples:\n' +
      '    shogun spec --env local --endpoint /api/workspaces\n' +
      '    shogun spec http://localhost:5000/swagger/v1/swagger.json --endpoint /api/workspaces\n' +
      '    shogun spec specs/enigma-api.json --endpoint /api/workspaces   # local file fallback',
    );
  }

  // 2. Determine source type
  if (rawSource.startsWith('http://') || rawSource.startsWith('https://')) {
    // Full URL — fetch directly
    const text = await httpGet(rawSource);
    return { raw: text, sourceType: 'full-url', resolvedUrl: rawSource };
  }

  // Check if it resolves to a local file
  const localPath = isAbsolute(rawSource)
    ? rawSource
    : resolve(cwd, rawSource);

  if (existsSync(localPath)) {
    const text = readFileSync(localPath, 'utf8');
    return { raw: text, sourceType: 'local-file', resolvedUrl: localPath };
  }

  // Relative URL — needs BASE_URL
  const baseUrl = (env['BASE_URL'] ?? '').trim().replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      `Cannot resolve spec source "${rawSource}".\n` +
      `  No local file found at that path, and BASE_URL is not set.\n` +
      `  Options:\n` +
      `    • Pass --env <name> to load BASE_URL from an env file\n` +
      `    • Use a full URL: shogun spec http://localhost:5000/${rawSource}\n` +
      `    • Use a local file: shogun spec specs/enigma-api.json`,
    );
  }

  const fullUrl = `${baseUrl}/${rawSource.replace(/^\//, '')}`;
  const text = await httpGet(fullUrl);
  return { raw: text, sourceType: 'relative-url', resolvedUrl: fullUrl };
}

async function httpGet(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch spec from ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}
