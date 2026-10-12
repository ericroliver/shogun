/**
 * src/commands/db.ts
 * `shogun db` — database management subcommand group.
 *
 * Current subcommands:
 *   shogun db snapshot create    --database <db> --name <snapshot>
 *   shogun db snapshot restore   --database <db> --name <snapshot>
 *   shogun db snapshot delete    --name <snapshot> [--if-exists]
 *   shogun db snapshot list      [--database <db>] [--format json]
 *   shogun db snapshot exists    --database <db> --name <snapshot>
 *
 * The `db` parent group is extensible — future subcommands like
 * `shogun db query`, `shogun db reset` can live alongside it.
 */

import { loadConfig, loadEnv } from '../loader.js';
import { getSnapshotProvider, isSnapshotConfigured } from '../snapshots/registry.js';
import type { ShogunConfig, EnvVars } from '../types.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface DbArgs {
  env?: string;
  cwd?: string;
  /** Subcommand: 'snapshot' */
  action: string;
  /** Snapshot sub-action: 'create' | 'restore' | 'delete' | 'list' | 'exists' */
  snapshotAction?: string;
  /** --database: source/target database name */
  database?: string;
  /** --name: snapshot name */
  name?: string;
  /** --provider: override default provider from config */
  provider?: string;
  /** --if-exists: don't error if snapshot doesn't exist (for delete) */
  ifExists?: boolean;
  /** --format: output format for list */
  format?: 'pretty' | 'json';
  /** --force: accepted for compatibility (dtai-api always force-restores) */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function db(args: DbArgs): Promise<number> {
  if (args.action !== 'snapshot') {
    console.error(`Unknown db subcommand: "${args.action}"`);
    console.error('Available: shogun db snapshot <create|restore|delete|list|exists>');
    return 1;
  }

  if (!args.snapshotAction) {
    console.error('Usage: shogun db snapshot <create|restore|delete|list|exists> [options]');
    return 1;
  }

  const cwd = args.cwd ?? process.cwd();

  // Load config
  let config: ShogunConfig;
  try {
    config = loadConfig(cwd);
  } catch {
    console.error('Error: No shogun.config.yaml found in the current directory.');
    return 1;
  }

  if (!isSnapshotConfigured(config)) {
    console.error('Error: No snapshot providers configured in shogun.config.yaml.');
    console.error('  Add a `snapshots:` section with at least one provider.');
    console.error('  Example:');
    console.error('    snapshots:');
    console.error('      default: dtai-api');
    console.error('      providers:');
    console.error('        dtai-api:');
    console.error('          type: dtai-api');
    console.error('          base_url: ${BASE_URL}');
    console.error('          auth_token: ${AUTH_TOKEN}');
    return 1;
  }

  // Load env for ${VAR} interpolation in provider config
  let env: EnvVars = {};
  const envName = args.env ?? config.defaults?.env;
  if (envName) {
    try {
      env = loadEnv(envName, config, cwd);
    } catch {
      // Env loading is optional for snapshot commands — provider config
      // might use literal URLs without ${VAR} interpolation
    }
  }

  // Get provider
  let provider;
  try {
    provider = getSnapshotProvider(config, env, args.provider);
  } catch (err) {
    console.error(`Error initializing snapshot provider: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!provider) {
    console.error('Error: Could not resolve snapshot provider.');
    console.error('  Specify --provider <name> or set snapshots.default in shogun.config.yaml.');
    return 1;
  }

  // Dispatch to snapshot action
  switch (args.snapshotAction) {
    case 'create':
      return snapshotCreate(provider, args);
    case 'restore':
      return snapshotRestore(provider, args);
    case 'delete':
      return snapshotDelete(provider, args);
    case 'list':
      return snapshotList(provider, args);
    case 'exists':
      return snapshotExists(provider, args);
    default:
      console.error(`Unknown snapshot action: "${args.snapshotAction}"`);
      console.error('Available: create, restore, delete, list, exists');
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Snapshot actions
// ---------------------------------------------------------------------------

async function snapshotCreate(provider: ReturnType<typeof getSnapshotProvider>, args: DbArgs): Promise<number> {
  if (!args.database || !args.name) {
    console.error('Usage: shogun db snapshot create --database <db> --name <snapshot>');
    return 1;
  }

  const result = await provider!.create(args.database, args.name);
  if (result.success) {
    console.log(`✓ ${result.message}`);
    return 0;
  }
  console.error(`✗ ${result.message}`);
  return 1;
}

async function snapshotRestore(provider: ReturnType<typeof getSnapshotProvider>, args: DbArgs): Promise<number> {
  if (!args.database || !args.name) {
    console.error('Usage: shogun db snapshot restore --database <db> --name <snapshot> [--force]');
    return 1;
  }

  if (args.force) {
    // dtai-api always force-kills connections (SINGLE_USER with ROLLBACK IMMEDIATE)
    // --force is accepted for compatibility and future mssql-direct provider
  }

  const result = await provider!.restore(args.database, args.name);
  if (result.success) {
    console.log(`✓ ${result.message}`);
    return 0;
  }
  console.error(`✗ ${result.message}`);
  return 1;
}

async function snapshotDelete(provider: ReturnType<typeof getSnapshotProvider>, args: DbArgs): Promise<number> {
  if (!args.name) {
    console.error('Usage: shogun db snapshot delete --name <snapshot> [--if-exists]');
    return 1;
  }

  const result = await provider!.delete(args.name);
  if (result.success) {
    console.log(`✓ ${result.message}`);
    return 0;
  }

  // Handle 404 with --if-exists (idempotent teardown)
  if (args.ifExists && result.message.includes('not found')) {
    console.log(`  Snapshot "${args.name}" does not exist — skipping (--if-exists)`);
    return 0;
  }

  console.error(`✗ ${result.message}`);
  return 1;
}

async function snapshotList(provider: ReturnType<typeof getSnapshotProvider>, args: DbArgs): Promise<number> {
  try {
    const snapshots = await provider!.list(args.database);

    if (args.format === 'json') {
      console.log(JSON.stringify(snapshots, null, 2));
      return 0;
    }

    // Pretty print
    if (snapshots.length === 0) {
      const scope = args.database ? ` for database "${args.database}"` : '';
      console.log(`No snapshots found${scope}.`);
      return 0;
    }

    console.log(`\nSnapshots${args.database ? ` (database: ${args.database})` : ''}:`);
    console.log('─'.repeat(80));
    for (const s of snapshots) {
      console.log(`  ${s.snapshotName}`);
      console.log(`    Database:   ${s.sourceDatabase}`);
      console.log(`    Created:    ${s.createdTime || 'unknown'}`);
      if (s.sizeInBytes !== undefined) {
        const sizeStr = s.sizeInBytes > 1024 * 1024
          ? `${(s.sizeInBytes / (1024 * 1024)).toFixed(2)} MB`
          : `${s.sizeInBytes} bytes`;
        console.log(`    Size:       ${sizeStr}`);
      }
      if (s.status) {
        console.log(`    Status:     ${s.status}`);
      }
      console.log();
    }
    console.log(`Total: ${snapshots.length} snapshot(s)`);
    return 0;
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function snapshotExists(provider: ReturnType<typeof getSnapshotProvider>, args: DbArgs): Promise<number> {
  if (!args.database || !args.name) {
    console.error('Usage: shogun db snapshot exists --database <db> --name <snapshot>');
    console.error('  Exit code 0 = exists, 1 = does not exist');
    return 1;
  }

  const exists = await provider!.exists(args.database, args.name);
  if (exists) {
    console.log(`✓ Snapshot "${args.name}" exists for database "${args.database}".`);
    return 0;
  }
  console.log(`  Snapshot "${args.name}" does not exist for database "${args.database}".`);
  return 1;
}
