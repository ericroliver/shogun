/**
 * src/commands/cdc.ts
 * CLI subcommand: shogun cdc
 *
 * Provides Change Data Capture management via the DTAI API:
 *
 *   shogun cdc start    --session <name> [--include <table>...] [--exclude <table>...] [--provider <name>]
 *   shogun cdc stop     --session <name> --capture <name> [--type <type>] [--provider <name>]
 *   shogun cdc capture  --session <name> --capture <name> [--type <type>] [--provider <name>]
 *   shogun cdc compare   --baseline <name> --test <name> [--ignore-field <field>...] [--no-ignore-lsn] [--provider <name>]
 *
 * Provider configuration is read from the `cdc` section of shogun.config.yaml.
 * The --provider flag overrides the configured default provider.
 */

import type { ShogunConfig, EnvVars } from '../types.js';
import { getCdcProvider, isCdcConfigured } from '../cdc/registry.js';

export interface CdcArgs {
  action: 'start' | 'stop' | 'capture' | 'compare';
  session?: string;
  capture?: string;
  captureType?: string;
  tablesToInclude?: string[];
  tablesToExclude?: string[];
  baselineCapture?: string;
  testCapture?: string;
  fieldsToIgnore?: string[];
  ignoreLsnDifferences?: boolean;
  provider?: string;
  config?: string;
  envFile?: string;
  cwd?: string;
}

export async function cdc(args: CdcArgs): Promise<number> {
  // Load config
  const { loadConfig, loadEnv } = await import('../loader.js');
  const cwd = args.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const envName = args.envFile ?? config.defaults?.env;
  const env: EnvVars = envName ? loadEnv(envName, config, cwd) : {};

  if (!isCdcConfigured(config)) {
    console.error('CDC management is not configured.');
    console.error('Add a cdc section to shogun.config.yaml with at least one provider:');
    console.error('  cdc:');
    console.error('    default_provider: dtai-api');
    console.error('    providers:');
    console.error('      dtai-api:');
    console.error('        type: dtai-api');
    console.error('        base_url: ${DTAI_API_URL}');
    return 1;
  }

  const provider = getCdcProvider(config, env, args.provider);
  if (!provider) {
    const name = args.provider ?? config.cdc?.default ?? '(default)';
    console.error(`CDC provider "${name}" not found or not configured.`);
    return 1;
  }

  switch (args.action) {
    case 'start':
      return await handleStart(provider, args);
    case 'stop':
      return await handleStop(provider, args);
    case 'capture':
      return await handleCapture(provider, args);
    case 'compare':
      return await handleCompare(provider, args);
    default:
      console.error(`Unknown CDC action: ${args.action as string}`);
      return 1;
  }
}

async function handleStart(provider: NonNullable<ReturnType<typeof getCdcProvider>>, args: CdcArgs): Promise<number> {
  if (!args.session) {
    console.error('--session is required for cdc start');
    return 1;
  }

  const result = await provider.start(
    args.session,
    args.tablesToInclude,
    args.tablesToExclude,
  );

  if (result.success) {
    console.log(`✓ ${result.message}`);
    if (result.tablesEnabled.length > 0) {
      console.log(`  Tables enabled: ${result.tablesEnabled.join(', ')}`);
    }
    if (result.tablesSkipped.length > 0) {
      console.log(`  Tables skipped: ${result.tablesSkipped.join(', ')}`);
    }
    if (result.errors.length > 0) {
      console.log(`  Warnings: ${result.errors.join('; ')}`);
    }
    return 0;
  }

  console.error(`✗ ${result.message}`);
  for (const err of result.errors) {
    console.error(`  ${err}`);
  }
  return 1;
}

async function handleStop(provider: NonNullable<ReturnType<typeof getCdcProvider>>, args: CdcArgs): Promise<number> {
  if (!args.session) {
    console.error('--session is required for cdc stop');
    return 1;
  }
  if (!args.capture) {
    console.error('--capture is required for cdc stop');
    return 1;
  }

  const result = await provider.stop(args.session, args.capture, args.captureType);

  if (result.success) {
    console.log(`✓ ${result.message}`);
    console.log(`  Capture: ${result.captureName}`);
    if (result.captureId) {
      console.log(`  Capture ID: ${result.captureId}`);
    }
    if (result.tablesWithChanges.length > 0) {
      console.log(`  Tables with changes: ${result.tablesWithChanges.join(', ')}`);
    }
    console.log(`  Total records: ${result.totalRecords}`);
    return 0;
  }

  console.error(`✗ ${result.message}`);
  for (const err of result.errors) {
    console.error(`  ${err}`);
  }
  return 1;
}

async function handleCapture(provider: NonNullable<ReturnType<typeof getCdcProvider>>, args: CdcArgs): Promise<number> {
  if (!args.session) {
    console.error('--session is required for cdc capture');
    return 1;
  }
  if (!args.capture) {
    console.error('--capture is required for cdc capture');
    return 1;
  }

  const result = await provider.capture(args.session, args.capture, args.captureType);

  if (result.success) {
    console.log(`✓ ${result.message}`);
    console.log(`  Capture: ${result.captureName}`);
    if (result.captureId) {
      console.log(`  Capture ID: ${result.captureId}`);
    }
    if (result.tablesWithChanges.length > 0) {
      console.log(`  Tables with changes: ${result.tablesWithChanges.join(', ')}`);
    }
    console.log(`  Total records: ${result.totalRecords}`);
    return 0;
  }

  console.error(`✗ ${result.message}`);
  for (const err of result.errors) {
    console.error(`  ${err}`);
  }
  return 1;
}

async function handleCompare(provider: NonNullable<ReturnType<typeof getCdcProvider>>, args: CdcArgs): Promise<number> {
  if (!args.baselineCapture) {
    console.error('--baseline is required for cdc compare');
    return 1;
  }
  if (!args.testCapture) {
    console.error('--test is required for cdc compare');
    return 1;
  }

  const result = await provider.compare(
    args.baselineCapture,
    args.testCapture,
    args.fieldsToIgnore,
    args.ignoreLsnDifferences ?? true,
  );

  if (result.errors.length > 0 && !result.isMatch) {
    console.error(`✗ Comparison failed`);
    for (const err of result.errors) {
      console.error(`  ${err}`);
    }
    return 1;
  }

  if (result.isMatch) {
    console.log(`✓ Captures match — no differences found`);
  } else {
    console.log(`✗ Captures do not match — ${result.summary.totalFailures} failure(s) across ${result.summary.tablesWithFailures} table(s)`);
  }

  console.log(`  Tables compared: ${result.summary.tablesCompared}`);
  console.log(`  Records compared: ${result.summary.recordsCompared}`);
  console.log(`  Fields compared: ${result.summary.fieldsCompared}`);
  console.log(`  Total failures: ${result.summary.totalFailures}`);

  if (result.failures.length > 0) {
    console.log('');
    console.log('  Failures:');
    for (const f of result.failures) {
      const pk = f.primaryKey ? ` [PK: ${JSON.stringify(f.primaryKey)}]` : '';
      const field = f.fieldName ? ` field "${f.fieldName}": "${JSON.stringify(f.baselineValue)}" vs "${JSON.stringify(f.testValue)}"` : '';
      console.log(`    ${f.tableName}${pk} — ${f.failureType}: ${f.description}${field}`);
    }
  }

  return result.isMatch ? 0 : 1;
}
