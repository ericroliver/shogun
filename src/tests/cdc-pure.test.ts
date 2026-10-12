/**
 * src/tests/cdc-pure.test.ts
 * Unit tests for CDC provider config resolution and isCdcConfigured.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCdcProviderConfig, isCdcConfigured } from '../cdc/registry.js';
import type { ShogunConfig } from '../types.js';

describe('isCdcConfigured', () => {
  test('returns false when no cdc config', () => {
    const config: ShogunConfig = { version: 1 };
    assert.ok(!isCdcConfigured(config));
  });

  test('returns false when cdc has no providers', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: { default: 'dtai-api' },
    };
    assert.ok(!isCdcConfigured(config));
  });

  test('returns true when cdc has providers', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: {
        default: 'dtai-api',
        providers: {
          'dtai-api': { type: 'dtai-api', base_url: 'http://localhost:5000' },
        },
      },
    };
    assert.ok(isCdcConfigured(config));
  });
});

describe('resolveCdcProviderConfig', () => {
  test('resolves by explicit name', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: {
        providers: {
          'primary': { type: 'dtai-api', base_url: 'http://dtai:5000' },
          'secondary': { type: 'dtai-api', base_url: 'http://dtai2:5000' },
        },
      },
    };
    const result = resolveCdcProviderConfig(config, 'secondary');
    assert.ok(result);
    assert.strictEqual(result.name, 'secondary');
    assert.strictEqual(result.config.base_url, 'http://dtai2:5000');
  });

  test('resolves by default when no name given', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: {
        default: 'primary',
        providers: {
          'primary': { type: 'dtai-api', base_url: 'http://dtai:5000' },
        },
      },
    };
    const result = resolveCdcProviderConfig(config);
    assert.ok(result);
    assert.strictEqual(result.name, 'primary');
  });

  test('uses single provider when no default and no name given', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: {
        providers: {
          'only': { type: 'dtai-api', base_url: 'http://dtai:5000' },
        },
      },
    };
    const result = resolveCdcProviderConfig(config);
    assert.ok(result);
    assert.strictEqual(result.name, 'only');
  });

  test('returns null when no name, no default, and multiple providers', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: {
        providers: {
          'a': { type: 'dtai-api', base_url: 'http://a:5000' },
          'b': { type: 'dtai-api', base_url: 'http://b:5000' },
        },
      },
    };
    const result = resolveCdcProviderConfig(config);
    assert.strictEqual(result, null);
  });

  test('returns null when named provider not found', () => {
    const config: ShogunConfig = {
      version: 1,
      cdc: {
        providers: {
          'a': { type: 'dtai-api', base_url: 'http://a:5000' },
        },
      },
    };
    const result = resolveCdcProviderConfig(config, 'nonexistent');
    assert.strictEqual(result, null);
  });

  test('returns null when no providers at all', () => {
    const config: ShogunConfig = { version: 1 };
    const result = resolveCdcProviderConfig(config);
    assert.strictEqual(result, null);
  });
});
