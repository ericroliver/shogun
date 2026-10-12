/**
 * src/cdc/registry.ts
 * CDC provider factory — instantiates the correct provider
 * based on the config `type` field.
 *
 * Usage:
 *   const provider = getCdcProvider(config, env, 'my-provider');
 *   await provider.start('test-session', ['dbo.Orders']);
 */

import type { ShogunConfig, EnvVars, CdcProviderConfig } from '../types.js';
import type { CdcProvider } from './provider.js';
import { DtaiApiCdcProvider } from './dtai-api-provider.js';

/**
 * Resolve a named provider config from the cdc section.
 * Falls back to the default provider if name is omitted.
 */
export function resolveCdcProviderConfig(
  config: ShogunConfig,
  providerName?: string,
): { name: string; config: CdcProviderConfig } | null {
  const cdc = config.cdc;
  if (!cdc?.providers) return null;

  const name = providerName ?? cdc.default;
  if (!name) {
    // If only one provider is configured, use it
    const providerKeys = Object.keys(cdc.providers);
    if (providerKeys.length === 1) {
      const singleName = providerKeys[0]!;
      return { name: singleName, config: cdc.providers[singleName] };
    }
    return null;
  }

  const providerConfig = cdc.providers[name];
  if (!providerConfig) return null;

  return { name, config: providerConfig };
}

/**
 * Instantiate a CDC provider by name (or default).
 * Returns null if no provider is configured.
 */
export function getCdcProvider(
  config: ShogunConfig,
  env: EnvVars,
  providerName?: string,
): CdcProvider | null {
  const resolved = resolveCdcProviderConfig(config, providerName);
  if (!resolved) return null;

  switch (resolved.config.type) {
    case 'dtai-api':
      return new DtaiApiCdcProvider(resolved.config, env);

    default:
      throw new Error(`Unknown CDC provider type: ${resolved.config.type as string}`);
  }
}

/**
 * Check if CDC management is configured.
 */
export function isCdcConfigured(config: ShogunConfig): boolean {
  return !!(config.cdc?.providers && Object.keys(config.cdc.providers).length > 0);
}
