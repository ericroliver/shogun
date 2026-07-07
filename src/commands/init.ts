/**
 * src/commands/init.ts — `shogun init` command
 *
 * Scaffolds a new shogun test repo in the current directory (or a named
 * subdirectory).  All generated files are annotated with comments so a new
 * user understands what each piece does without having to read the docs first.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

const SHOGUN_CONFIG = `# shogun.config.yaml — Global configuration for this test repo
# Docs: https://github.com/your-org/shogun
version: 1

defaults:
  env: local          # default env file (envs/local.env) when --env is omitted
  timeout: 10         # curl timeout in seconds
  follow_redirects: true
  content_type: application/json

paths:
  tests: ./tests       # test YAML files live here
  envs: ./envs         # .env files live here
  expected: ./expected # snapshot baselines (committed to git)
  runs: ./runs         # generated run logs (gitignored)
  scripts: ./scripts   # shared TypeScript helpers

# jq paths stripped from ALL snapshot diffs (override per-test with ignore_fields)
ignore_fields_global:
  - "**.timestamp"
  - "**.createdAt"
  - "**.updatedAt"
  - "**.requestId"
  - "**.traceId"

reporting:
  format: pretty           # pretty | json | tap
  on_fail: diff            # diff | body | silent
  save_passing_logs: true  # write .log files even for passing tests

# Optional: point at an OpenAPI spec for \`shogun spec\` and \`shogun coverage\`
# spec:
#   path: ./specs/openapi.json   # local file
#   # OR
#   url: \${BASE_URL}/openapi.json  # fetched at runtime using env vars
`;

const LOCAL_ENV = `# envs/local.env — Local development environment
# Copy this file to create other environments: QA.env, staging.env, etc.
# NEVER commit real secrets — use a secrets manager or CI env injection.

BASE_URL=http://localhost:3000
AUTH_TOKEN=your-local-token-here
TIMEOUT=10
LOG_LEVEL=debug
`;

const LOCAL_ENV_EXAMPLE = `# envs/local.env.example — Checked-in template; copy to local.env and fill in values
BASE_URL=http://localhost:3000
AUTH_TOKEN=
TIMEOUT=10
LOG_LEVEL=debug
`;

const GITIGNORE = `# shogun test repo — gitignore
runs/           # generated run logs — never commit
envs/local.env  # local secrets — never commit
envs/*.env      # all env files except examples
!envs/*.env.example
`;

const SMOKE_SUITE = `# tests/suites/smoke.yaml — Fast, read-only subset for CI gate or quick checks
name: Smoke Suite
description: >
  Runs only GET endpoints tagged 'smoke'. Safe to run against production.
  Should complete in under 30 seconds.

collections:
  - system

# Only run tests carrying ALL of these tags within each collection
tags:
  - smoke
`;

const SYSTEM_COLLECTION = `# tests/collections/system/_collection.yaml — System health endpoints
name: System API
description: Health check and system-level metadata endpoints

order:
  - health

tags:
  - system
  - smoke
  - readonly

# No setup/teardown needed for read-only system endpoints
`;

const HEALTH_TEST = `# tests/collections/system/health.yaml — GET /health
name: Health Check
description: Verifies the API is reachable and returns a healthy status.
collection: system
tags:
  - smoke
  - system
  - readonly

request:
  method: GET
  path: /health
  headers:
    Accept: application/json

response:
  status: 200

  # Set snapshot: true once you have a stable baseline to diff against.
  # Run \`shogun snapshot\` to capture the first baseline.
  snapshot: false

  # jq expressions — each must evaluate to truthy or the test fails
  shape:
    - 'has("status")'
    - '.status == "ok" or .status == "healthy" or .status == "up"'

post: |
  ctx.assert(ctx.response.status === 200, 'Health endpoint must return 200');
  ctx.log(\`Health status: \${ctx.response.body?.status}\`);
`;

const AUTH_SCRIPT = `/**
 * scripts/auth.ts — Shared auth helpers
 *
 * Import in a pre-script via ctx.scripts.auth.*
 *
 * Example usage in a test YAML pre-script:
 *   const token = ctx.scripts.auth.getBearerToken(ctx.env);
 *   ctx.request.headers['Authorization'] = token;
 */

export interface EnvVars {
  AUTH_TOKEN?: string;
  AUTH_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

/**
 * Returns the configured bearer token string.
 * If the token already starts with "Bearer " it is returned as-is.
 * Otherwise "Bearer " is prepended.
 */
export function getBearerToken(env: EnvVars): string {
  const token = env.AUTH_TOKEN;
  if (!token) throw new Error('AUTH_TOKEN is not set in environment');
  return token.startsWith('Bearer ') ? token : \`Bearer \${token}\`;
}

/**
 * Fetches a fresh OAuth2 client_credentials token from AUTH_URL.
 * Requires: AUTH_URL, CLIENT_ID, CLIENT_SECRET in env.
 * Returns: "Bearer <access_token>"
 */
export async function fetchOAuthToken(env: EnvVars): Promise<string> {
  const { AUTH_URL, CLIENT_ID, CLIENT_SECRET } = env;
  if (!AUTH_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('fetchOAuthToken requires AUTH_URL, CLIENT_ID, CLIENT_SECRET in env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(\`OAuth token fetch failed: \${res.status} \${res.statusText}\`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error('OAuth response missing access_token');
  return \`Bearer \${data.access_token}\`;
}
`;

const TRANSFORMS_SCRIPT = `/**
 * scripts/transforms.ts — Shared response body transformers
 *
 * Import in a post-script via ctx.scripts.transforms.*
 */

/**
 * Strips volatile fields (timestamps, IDs) from an object before snapshotting.
 * Pass the field names you want removed.
 */
export function stripVolatile<T extends Record<string, unknown>>(
  obj: T,
  fields: string[] = ['id', 'createdAt', 'updatedAt', 'timestamp']
): Partial<T> {
  const result = { ...obj };
  for (const field of fields) {
    delete result[field];
  }
  return result;
}

/**
 * Normalises a paginated list response so snapshot diffs are stable.
 * Strips the top-level \`total\` and \`page\` fields which change between runs.
 */
export function normalisePaginatedList<T>(body: {
  items?: T[];
  data?: T[];
  total?: number;
  page?: number;
  [key: string]: unknown;
}): unknown[] {
  return body.items ?? body.data ?? [];
}
`;

const README = `# My Shogun Test Repo

API tests powered by [shogun](https://github.com/your-org/shogun) — a shell-first, TypeScript-enhanced API testing CLI.

## Quick Start

\`\`\`bash
# 1. Copy the env template and fill in your values
cp envs/local.env.example envs/local.env

# 2. Run all tests against the local environment
shogun run --env local

# 3. Run only the smoke suite
shogun run --suite smoke --env local

# 4. Capture snapshot baselines for the first time
shogun snapshot --env local
\`\`\`

## Folder Structure

\`\`\`
.
├── shogun.config.yaml          # Global config
├── envs/
│   ├── local.env.example       # Template — copy to local.env
│   ├── local.env               # Local secrets (gitignored)
│   └── QA.env                  # QA environment (gitignored)
├── tests/
│   ├── collections/            # One folder per API domain
│   │   └── system/
│   │       ├── _collection.yaml  # Collection metadata + setup/teardown hooks
│   │       └── health.yaml       # Individual test file
│   └── suites/                 # Named multi-collection suites
│       └── smoke.yaml
├── expected/                   # Snapshot baselines (committed to git)
├── runs/                       # Generated run logs (gitignored)
└── scripts/                    # Shared TypeScript helpers
    ├── auth.ts
    └── transforms.ts
\`\`\`

## Adding a New Collection

1. Create \`tests/collections/<domain>/\`
2. Add \`_collection.yaml\` with \`name\`, \`order\`, \`tags\`, and optional \`setup\`/\`teardown\`
3. Add individual test YAML files (one per endpoint/scenario)
4. Add the collection name to any relevant suite in \`tests/suites/\`

## Key Commands

\`\`\`bash
shogun run                          # Run all tests (default env)
shogun run --env QA                 # Select environment
shogun run --collection system      # Run one collection
shogun run --suite smoke            # Run a named suite
shogun snapshot                     # Capture/update all baselines
shogun report                       # Show last run report
shogun lint                         # Validate all YAML files
shogun spec --list                  # List all API endpoints (requires spec.path in config)
shogun coverage                     # API test coverage matrix
\`\`\`
`;

// ---------------------------------------------------------------------------
// Scaffold definition
// ---------------------------------------------------------------------------

interface ScaffoldFile {
  /** Relative path from the target root */
  relPath: string;
  content: string;
}

function buildScaffold(): ScaffoldFile[] {
  return [
    { relPath: 'shogun.config.yaml',                              content: SHOGUN_CONFIG },
    { relPath: 'envs/local.env.example',                          content: LOCAL_ENV_EXAMPLE },
    { relPath: 'envs/local.env',                                  content: LOCAL_ENV },
    { relPath: '.gitignore',                                       content: GITIGNORE },
    { relPath: 'tests/collections/system/_collection.yaml',       content: SYSTEM_COLLECTION },
    { relPath: 'tests/collections/system/health.yaml',            content: HEALTH_TEST },
    { relPath: 'tests/suites/smoke.yaml',                         content: SMOKE_SUITE },
    { relPath: 'expected/.gitkeep',                               content: '' },
    { relPath: 'runs/.gitkeep',                                   content: '' },
    { relPath: 'scripts/auth.ts',                                 content: AUTH_SCRIPT },
    { relPath: 'scripts/transforms.ts',                           content: TRANSFORMS_SCRIPT },
    { relPath: 'README.md',                                       content: README },
  ];
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Target directory name (default: current working directory) */
  dir?: string;
  /** If true, overwrite existing files */
  force?: boolean;
}

export async function init(options: InitOptions = {}): Promise<number> {
  const targetRoot = options.dir
    ? path.resolve(process.cwd(), options.dir)
    : process.cwd();

  const isNewDir = !!options.dir;

  // Safety check: refuse to init into a non-empty directory unless --force
  if (fs.existsSync(targetRoot) && !options.force) {
    const entries = fs.readdirSync(targetRoot);
    if (entries.length > 0) {
      console.error(
        `\n✗  Directory is not empty: ${targetRoot}\n` +
        `   shogun init refuses to scaffold into a non-empty directory.\n` +
        `   Use --force to overwrite existing files, or choose an empty directory.\n`
      );
      return 1;
    }
  }

  if (isNewDir && !fs.existsSync(targetRoot)) {
    fs.mkdirSync(targetRoot, { recursive: true });
  }

  const scaffold = buildScaffold();
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of scaffold) {
    const absPath = path.join(targetRoot, file.relPath);
    const dir = path.dirname(absPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(absPath) && !options.force) {
      skipped.push(file.relPath);
      continue;
    }

    fs.writeFileSync(absPath, file.content, 'utf8');
    written.push(file.relPath);
  }

  // Pretty output
  const rel = path.relative(process.cwd(), targetRoot) || '.';
  console.log(`\n🥷  shogun init — scaffolded test repo at ${rel}/\n`);

  if (written.length > 0) {
    console.log('  Created:');
    for (const f of written) console.log(`    ✓  ${f}`);
  }

  if (skipped.length > 0) {
    console.log('\n  Skipped (already exist — use --force to overwrite):');
    for (const f of skipped) console.log(`    –  ${f}`);
  }

  console.log(`
  Next steps:
    1.  Edit envs/local.env with your BASE_URL and AUTH_TOKEN
    2.  Run: shogun run --env local
    3.  Add collections under tests/collections/<domain>/
    4.  Run: shogun snapshot --env local   (capture first baselines)
`);

  return 0;
}
