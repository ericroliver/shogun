#!/usr/bin/env node
/**
 * src/index.ts — shogun CLI entrypoint
 */

import { run } from './commands/run.js';
import { snapshot } from './commands/snapshot.js';
import { report } from './commands/report.js';
import { lint } from './commands/lint.js';
import { spec } from './commands/spec.js';
import { coverage } from './commands/coverage.js';
import { init } from './commands/init.js';
// VERSION is a generated constant so it is always correct whether shogun is
// run via tsx, via the compiled dist/, or as a standalone bun binary.
// See scripts/gen-version.mjs — it is regenerated before every pkg:* build.
import { VERSION } from './version.js';

function getVersion(): string {
  return VERSION;
}

const USAGE = `
shogun — shell-first API testing system

Usage:
  shogun init                         Scaffold a new test repo in the current directory
  shogun init <dir>                   Scaffold into a new subdirectory
  shogun init --force                 Overwrite existing files

  shogun run                          Run all tests (default env)
  shogun run --env QA                 Select environment
  shogun run --collection agents      Run one collection
  shogun run --collection a --collection b  Run multiple collections
  shogun run --tags smoke             Filter by tag (comma-separated)
  shogun run --suite smoke            Run a named suite
  shogun run --file path/to/test.yaml Run single test file
  shogun run --format json            JSON output (for CI)

  shogun snapshot                     Capture/update all baselines
  shogun snapshot --suite api-testapp-1  Snapshot with suite vars (workspace etc.)
  shogun snapshot --file path/...     Update single test baseline

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
  shogun coverage --format json       JSON output (for scripting)

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
  // init-specific
  initDir?: string;
  force?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
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
      case '--run':        result.run = argv[++i]; break;
      case '--cwd':        result.cwd = argv[++i]; break;
      // spec flags
      case '--endpoint':   result.endpoint = argv[++i]; break;
      case '--method':     result.method = argv[++i]; break;
      case '--tag':        result.tag = argv[++i]; break;
      case '--schema':     result.schema = argv[++i]; break;
      case '--search':     result.search = argv[++i]; break;
      case '--list':       result.list = true; break;
      case '--uncovered':  result.uncovered = true; break;
      case '--force':      result.force = true; break;
      default:
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

async function main() {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
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

  switch (subcommand) {
    case 'init': {
      const exitCode = await init({ dir: args.initDir, force: args.force });
      process.exit(exitCode);
      break;
    }
    case 'run': {
      const exitCode = await run({ ...args, format: args.format as 'pretty' | 'json' | 'tap' | undefined });
      process.exit(exitCode);
      break;
    }
    case 'snapshot': {
      const exitCode = await snapshot(args);
      process.exit(exitCode);
      break;
    }
    case 'report': {
      await report({ ...args, format: args.format as 'pretty' | 'json' | 'tap' | undefined });
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
        format: args.format as 'pretty' | 'json' | 'markdown' | undefined,
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

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
