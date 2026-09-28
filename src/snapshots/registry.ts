/**
 * src/snapshots/registry.ts
 * Snapshot provider factory — instantiates the correct provider
 * based on the config `type` field.
 *
 * Usage:
 *   const provider = await getSnapshotProvider(config, env, 'my-provider');
 *   await provider.restore('CdcTestDB', 'baseline');
 */

import type { ShogunConfig, EnvVars, SnapshotProviderConfig } from '../types.js';
import type { SnapshotProvider } from './provider.js';
import { DtaiApiProvider } from './dtai-api-provider.js';

/**
 * Resolve a named provider config from the snapshots section.
 * Falls back to the default provider if name is omitted.
 */
export function resolveProviderConfig(
  config: ShogunConfig,
  providerName?: string,
): { name: string; config: SnapshotProviderConfig } | null {
  const snapshots = config.snapshots;
  if (!snapshots?.providers) return null;

  const name = providerName ?? snapshots.default;
  if (!name) {
    // If only one provider is configured, use it
    const providerKeys = Object.keys(snapshots.providers);
    if (providerKeys.length === 1) {
      const singleName = providerKeys[0]!;
      return { name: singleName, config: snapshots.providers[singleName] };
    }
    return null;
  }

  const providerConfig = snapshots.providers[name];
  if (!providerConfig) return null;

  return { name, config: providerConfig };
}

/**
 * Instantiate a snapshot provider by name (or default).
 * Returns null if no provider is configured.
 */
export function getSnapshotProvider(
  config: ShogunConfig,
  env: EnvVars,
  providerName?: string,
): SnapshotProvider | null {
  const resolved = resolveProviderConfig(config, providerName);
  if (!resolved) return null;

  switch (resolved.config.type) {
    case 'dtai-api':
      return new DtaiApiProvider(resolved.config, env);

    case 'mssql-direct':
      // TODO: implement mssql-direct provider using existing mssql driver
      throw new Error(
        'mssql-direct snapshot provider is not yet implemented. ' +
        'Use the dtai-api provider type instead.'
      );

    default:
      throw new Error(`Unknown snapshot provider type: ${resolved.config.type as string}`);
  }
}

/**
 * Check if snapshot management is configured.
 */
export function isSnapshotConfigured(config: ShogunConfig): boolean {
  return !!(config.snapshots?.providers && Object.keys(config.snapshots.providers).length > 0);
}
