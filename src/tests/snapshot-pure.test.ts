/**
 * src/tests/snapshot-pure.test.ts
 * Unit tests for snapshot provider config resolution and identifier validation.
 * Pure tests — no network calls, no database connections.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderConfig, isSnapshotConfigured } from '../snapshots/registry.js';
import type { ShogunConfig } from '../types.js';

describe('isSnapshotConfigured', () => {
  it('returns false when no snapshots config exists', () => {
    const config: ShogunConfig = { version: 1 };
    assert.equal(isSnapshotConfigured(config), false);
  });

  it('returns false when providers map is empty', () => {
    const config: ShogunConfig = {
      version: 1,
      snapshots: { providers: {} },
    };
    assert.equal(isSnapshotConfigured(config), false);
  });

  it('returns true when at least one provider is configured', () => {
    const config: ShogunConfig = {
      version: 1,
      snapshots: {
        default: 'dtai-api',
        providers: {
          'dtai-api': { type: 'dtai-api', base_url: 'http://localhost:8080' },
        },
      },
    };
    assert.equal(isSnapshotConfigured(config), true);
  });
});

describe('resolveProviderConfig', () => {
  const config: ShogunConfig = {
    version: 1,
    snapshots: {
      default: 'primary',
      providers: {
        'primary': { type: 'dtai-api', base_url: 'http://localhost:8080' },
        'secondary': { type: 'dtai-api', base_url: 'http://other:8080' },
      },
    },
  };

  it('resolves the default provider when no name given', () => {
    const result = resolveProviderConfig(config);
    assert.equal(result?.name, 'primary');
    assert.equal(result?.config.type, 'dtai-api');
  });

  it('resolves a named provider', () => {
    const result = resolveProviderConfig(config, 'secondary');
    assert.equal(result?.name, 'secondary');
    assert.equal(result?.config.base_url, 'http://other:8080');
  });

  it('returns null for unknown provider name', () => {
    const result = resolveProviderConfig(config, 'nonexistent');
    assert.equal(result, null);
  });

  it('falls back to single provider when no default is set', () => {
    const singleConfig: ShogunConfig = {
      version: 1,
      snapshots: {
        providers: {
          'only-one': { type: 'dtai-api', base_url: 'http://localhost:8080' },
        },
      },
    };
    const result = resolveProviderConfig(singleConfig);
    assert.equal(result?.name, 'only-one');
  });

  it('returns null when no default and multiple providers without explicit name', () => {
    const multiConfig: ShogunConfig = {
      version: 1,
      snapshots: {
        providers: {
          'a': { type: 'dtai-api', base_url: 'http://a:8080' },
          'b': { type: 'dtai-api', base_url: 'http://b:8080' },
        },
      },
    };
    const result = resolveProviderConfig(multiConfig);
    assert.equal(result, null);
  });

  it('returns null when no snapshots config at all', () => {
    const emptyConfig: ShogunConfig = { version: 1 };
    const result = resolveProviderConfig(emptyConfig);
    assert.equal(result, null);
  });
});
