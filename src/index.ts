#!/usr/bin/env node
/**
 * src/index.ts — shogun CLI entrypoint
 */

// Bun runtime detection — declare global so TypeScript is satisfied
// without requiring @types/bun as a dev dependency.
declare const Bun: unknown;

import { run } from './commands/run.js';
import { snapshot } from './commands/snapshot.js';
import { report } from './commands/report.js';
import { lint } from './commands/lint.js';
import { spec } from './commands/spec.js';
import { coverage } from './commands/coverage/index.js';
import { checkBackend } from './commands/check-backend.js';
import { createBackend, getBackendSource } from './backend-factory.js';
import { initExecutor, checkDependencies } from './executor.js';
import { init } from './commands/init.js';
import { ls } from './commands/ls.js';
// VERSION is a generated constant so it is always correct whether shogun is
// run via tsx, via the compiled dist/, or as a standalone bun binary.
// See scripts/gen-version.mjs — it is regenerated before every pkg:* build.
import { VERSION } from './version.js';
import { fileURLToPath } from 'node:url';

function getVersion(): string {
  return VERSION;
}

const USAGE = `
shogun — shell-first API testing system

Usage:
  shogun init                         Scaffold a new test repo in the current directory
  shogun init <dir>                   Scaffold into a new subdirectory
  shogun init --force                 Overwrite existing files

  shogun ls                           List everything (envs, collections, suites, tests, runs)
  shogun ls envs                      List environment files only
  shogun ls collections               List collections only
  shogun ls suites                    List suites only
  shogun ls tests                     List all test files across collections
  shogun ls tests --collection agents List tests in a specific collection
  shogun ls runs                      List recent runs
  shogun ls fixtures                  List setup fixtures
  shogun ls --format json             JSON output (for scripting)

  shogun run                          Run all tests (default env)
  shogun run --env QA                 Select environment
  shogun run --collection agents      Run one collection
  shogun run --collection a --collection b  Run multiple collections
  shogun run --tags smoke             Filter by tag (comma-separated)
  shogun run --suite smoke            Run a named suite
  shogun run --file path/to/test.yaml Run single test file
  shogun run --format json            JSON output (for CI)
  shogun run --output results.json    Write JSON results to file (for Playwright)
  shogun run --params '[{"UserId":42}]'  Override SQL test params at runtime
  shogun run --backend unix           Force unix backend (curl + jq)
  shogun run --backend powershell     Force PowerShell backend

  shogun snapshot                     Capture/update all baselines
  shogun snapshot --suite api-testapp-1  Snapshot with suite vars (workspace etc.)
  shogun snapshot --file path/...     Update single test baseline
  shogun snapshot --backend powershell

  shogun check-backend                Show backend info + dependency status
  shogun check-backend --backend unix

  shogun report                       Show last run report
  shogun report --run <timestamp>     Show specific run

  shogun lint                         Validate all YAML files
  shogun lint --file path/to/test.yaml

  shogun spec                         List all API endpoints (live from spec)
  shogun spec --env local --endpoint /api/workspaces --method GET
  shogun spec --tag Agents            All endpoints in a tag group
  shogun spec --schema AgentDef       Resolve a named schema ($refs inlined)
  shogun spec --search checkpoint     Keyword search across summaries
  shogun spec --list                  Explicit list mode
  shogun spec --format json           JSON output (for scripting)
  shogun spec [spec-source]           Override spec URL or local file path

  shogun coverage                     API test coverage matrix
  shogun coverage --env local         Load env for live spec fetching
  shogun coverage --collection graph  Scope tests to one collection
  shogun coverage --suite smoke       Scope tests to a named suite
  shogun coverage --tag Agents        Scope spec to a tag group
  shogun coverage --uncovered         Show only uncovered endpoints
  shogun coverage --gaps              Prioritized gap analysis
  shogun coverage --gaps --top 20     Limit gaps to top 20 by priority
  shogun coverage --gaps --collection code  Scope gaps to one collection
  shogun coverage --detail            Full depth matrix (codes, params, fields, quality)
  shogun coverage --last-run          Integrate latest run results (statuses, drift)
  shogun coverage --run <timestamp>   Integrate a specific run
  shogun coverage --suppress-drift 401  Hide drift for these codes (default: 401)
  shogun coverage --compare           Compare two runs and show delta
  shogun coverage --deps              Show test dependency graph
  shogun coverage --sql               SQL stored procedure coverage report (static)
  shogun coverage --sql --live         SQL coverage with live DB introspection
  shogun coverage --min-coverage 80   CI gate: fail if endpoint coverage < 80%
  shogun coverage --format json       JSON output (for scripting)
  shogun coverage --format markdown   Markdown table output (for PRs/docs)
  shogun coverage --out report.md     Write report to file instead of stdout

  shogun --version                    Print version
  shogun --help                       Print this message
`.trimStart();

interface ParsedArgs {
  env?: string;
  collection?: string | string[];
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap' | 'markdown';
  run?: string;
  cwd?: string;
  backend?: string;
  // spec-specific
  specSource?: string;
  endpoint?: string;
  method?: string;
  tag?: string;
  schema?: string;
  search?: string;
  list?: boolean;
  // coverage-specific
  uncovered?: boolean;
  gaps?: boolean;
  detail?: boolean;
  lastRun?: boolean;
  runId?: string;
  deps?: boolean;
  compare?: boolean;
  compareRunIds?: [string, string];
  minCoverage?: number;
  out?: string;
  // coverage v0.5 additions
  top?: number;              // --top N: limit --gaps to N highest-priority gaps
  suppressDrift?: string[];  // --suppress-drift <code,code>: hide drift for these codes
  sql?: boolean;             // --sql: SQL stored procedure coverage mode
  live?: boolean;             // --live: live DB introspection (requires --sql)
  // init-specific
  initDir?: string;
  force?: boolean;
  // output file for JSON results (Playwright integration)
  output?: string;
  // runtime parameter override for SQL tests (JSON string, e.g. '[{"UserId": 42}]')
  params?: string;
}
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--env':        result.env = argv[++i]; break;
      case '--collection': {
        const val = argv[++i]!;
        if (!result.collection) {
          result.collection = val;
        } else if (Array.isArray(result.collection)) {
          result.collection.push(val);
        } else {
          result.collection = [result.collection, val];
        }
        break;
      }
      case '--tags':       result.tags = argv[++i]!.split(',').map(t => t.trim()); break;
      case '--suite':      result.suite = argv[++i]; break;
      case '--file':       result.file = argv[++i]; break;
      case '--format':     result.format = argv[++i] as ParsedArgs['format']; break;
      case '--cwd':        result.cwd = argv[++i]; break;
      case '--backend':    result.backend = argv[++i]; break;
      // spec flags
      case '--endpoint':   result.endpoint = argv[++i]; break;
      case '--method':     result.method = argv[++i]; break;
      case '--tag':        result.tag = argv[++i]; break;
      case '--schema':     result.schema = argv[++i]; break;
      case '--search':     result.search = argv[++i]; break;
      case '--list':       result.list = true; break;
      case '--uncovered':  result.uncovered = true; break;
      case '--gaps':       result.gaps = true; break;
      case '--detail':     result.detail = true; break;
      case '--last-run':   result.lastRun = true; break;
      case '--run': {
        const val = argv[++i];
        result.run = val;   // used by `shogun report`
        result.runId = val; // used by `shogun coverage`
        break;
      }
      case '--top':        result.top = parseInt(argv[++i]!, 10); break;
      case '--suppress-drift': {
        const val = argv[++i];
        result.suppressDrift = val ? val.split(',').map(s => s.trim()) : ['401'];
        break;
      }
      case '--deps':       result.deps = true; break;
      case '--sql':        result.sql = true; break;
      case '--live':       result.live = true; break;
      case '--compare': {
        result.compare = true;
        // Check for two positional run IDs after --compare
        const id1 = argv[i + 1];
        const id2 = argv[i + 2];
        if (id1 && !id1.startsWith('--') && id2 && !id2.startsWith('--')) {
          result.compareRunIds = [id1, id2];
          i += 2;
        }
        break;
      }
      case '--min-coverage': {
        const val = parseInt(argv[++i]!, 10);
        if (!isNaN(val)) result.minCoverage = val;
        break;
      }
      case '--out':        result.out = argv[++i]; break;
      case '--force':      result.force = true; break;
      case '--output':     result.output = argv[++i]; break;
      case '--params':     result.params = argv[++i]; break;      default:
        if (arg.startsWith('--')) {
          // Unknown flag — skip the value token if it doesn't look like a flag
          // itself, then warn so the user knows the flag was not recognised.
          const nextIsValue = argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--');
          if (nextIsValue) i++;
          console.warn(`Warning: unrecognised flag "${arg}" ignored.  Run shogun --help for usage.`);
        } else {
          // Bare positional — used as spec source override OR init target dir
          result.specSource = arg;
          result.initDir = arg;
        }
        break;
    }
  }
  return result;
}

function getCliArgs(): string[] {
  const argv = process.argv;

  // Bun standalone executable:
  // ["C:\\bin\\shogun.exe", "--help"]
  if (
    typeof Bun !== 'undefined' &&
    argv[0]?.toLowerCase() === process.execPath.toLowerCase()
  ) {
    return argv.slice(1);
  }

  // Node / tsx:
  // ["node.exe", "src/index.ts", "--help"]
  return argv.slice(2);
}

async function main() {
  const [subcommand, ...rest] = getCliArgs();

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    // Parse any --backend flag that was provided alongside --help
    const helpArgs = parseArgs(rest);
    const backend = createBackend(helpArgs.backend);
    const source = getBackendSource(helpArgs.backend);

    process.stdout.write(USAGE);
    process.stdout.write(`\nBackend: ${backend.name} (selected via ${source})\n`);
    process.stdout.write(`Run 'shogun check-backend' to verify dependencies.\n`);
    process.exit(0);
  }

  if (subcommand === '--version' || subcommand === '-v') {
    console.log(getVersion());
    process.exit(0);
  }

  const args = parseArgs(rest);

  if (args.cwd) {
    process.chdir(args.cwd);
  }

  // -----------------------------------------------------------------------
  // Wire up backend for commands that need it (run, snapshot, lint)
  // check-backend wires its own backend.
  // -----------------------------------------------------------------------
  const needsBackend = ['run', 'snapshot', 'lint'].includes(subcommand);

  if (needsBackend) {
    const backend = createBackend(args.backend);
    initExecutor(backend);

    if (subcommand !== 'lint') {
      await checkDependencies();
    }
  }

  switch (subcommand) {
    case 'init': {
      const exitCode = await init({ dir: args.initDir, force: args.force });
      process.exit(exitCode);
      break;
    }
    case 'ls': {
      // The first positional arg is the target (envs, collections, etc.)
      // parseArgs stores it in specSource/initDir — we extract it here.
      const target = args.specSource;
      const exitCode = await ls({
        target,
        collection: typeof args.collection === 'string' ? args.collection : undefined,
        format: args.format as 'pretty' | 'json' | undefined,
      });
      process.exit(exitCode);
      break;
    }
    case 'run': {
      const exitCode = await run({
        env: args.env,
        collection: args.collection,
        tags: args.tags,
        suite: args.suite,
        file: args.file,
        format: args.format as 'pretty' | 'json' | 'tap' | undefined,
        output: args.output,
        params: args.params,
      });
      process.exit(exitCode);
      break;
    }
    case 'snapshot': {
      const exitCode = await snapshot(args);
      process.exit(exitCode);
      break;
    }
    case 'check-backend': {
      const exitCode = await checkBackend({ backend: args.backend });
      process.exit(exitCode);
      break;
    }
    case 'report': {
      await report({ ...args, format: args.format === 'markdown' ? 'pretty' : args.format as 'pretty' | 'json' | 'tap' | undefined });
      process.exit(0);
      break;
    }
    case 'lint': {
      const exitCode = await lint(args);
      process.exit(exitCode);
      break;
    }
    case 'spec': {
      const exitCode = await spec({
        specSource: args.specSource,
        env: args.env,
        endpoint: args.endpoint,
        method: args.method,
        tag: args.tag,
        schema: args.schema,
        search: args.search,
        list: args.list,
        format: args.format as 'pretty' | 'json' | 'markdown' | undefined,
        cwd: args.cwd,
      });
      process.exit(exitCode);
      break;
    }
    case 'coverage': {
      const exitCode = await coverage({
        specSource: args.specSource,
        env: args.env,
        collection: args.collection,
        suite: args.suite,
        tag: args.tag,
        uncovered: args.uncovered,
        gaps: args.gaps,
        detail: args.detail,
        lastRun: args.lastRun,
        runId: args.runId,
        deps: args.deps,
        compare: args.compare,
        compareRunIds: args.compareRunIds,
        minCoverage: args.minCoverage,
        out: args.out,
        format: args.format as 'pretty' | 'json' | 'markdown' | undefined,
        top: args.top,
        suppressDrift: args.suppressDrift,
        sql: args.sql,
        live: args.live,
        cwd: args.cwd,
      });
      process.exit(exitCode);
      break;
    }
    default: {
      console.error(`Unknown subcommand: ${subcommand}`);
      process.stdout.write(USAGE);
      process.exit(1);
    }
  }
}

/*
// Only run main() when executed directly (not when imported for testing)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
  });
}
*/

// Run when invoked directly through Node/tsx or as a Bun standalone executable.
const isDirectExecution =
  typeof Bun !== 'undefined'
    ? true
    : process.argv[1] !== undefined &&
      fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  main().catch((err: unknown) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}