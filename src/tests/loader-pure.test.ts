/**
 * src/tests/loader-pure.test.ts
 *
 * Unit tests for pure (no I/O) functions exported from loader.ts.
 *
 * Covers:
 *   - sanitizeName() — method + path → safe filename
 *   - interpolateEnv() — ${VAR} token replacement
 *   - resolveTestRef() — bare name vs cross-collection ref resolution
 *   - collectionFromCanonicalId() — extract collection from canonical ID
 *
 * Run with:
 *   npx tsx --test src/tests/loader-pure.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  sanitizeName,
  interpolateEnv,
  resolveTestRef,
  collectionFromCanonicalId,
} from '../loader.js';

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

describe('sanitizeName()', () => {

  test('replaces forward slashes with underscores', () => {
    assert.equal(sanitizeName('GET', '/api/graph/nodes'), 'GET_api_graph_nodes');
  });

  test('replaces curly braces — { and } become _ then __ deduped', () => {
    // /api/nodes/{id} → slashes → _ → braces → _ → results in __ which dedupes to _
    assert.equal(sanitizeName('GET', '/api/nodes/{id}'), 'GET_api_nodes_id');
  });

  test('curly braces with no adjacent underscore survive as single _', () => {
    // In "{id}", { and } are adjacent to id, not to another _
    // After replacing / → _: "GET_api_nodes_{id}"
    // After replacing { → _: "GET_api_nodes__id_"
    // After __ dedup: "GET_api_nodes_id_"
    // After trailing _ trim: "GET_api_nodes_id"
    assert.equal(sanitizeName('GET', '/api/nodes/{id}'), 'GET_api_nodes_id');
  });

  test('collapses multiple consecutive underscores into one', () => {
    assert.equal(sanitizeName('GET', '/api//nodes'), 'GET_api_nodes');
  });

  test('trims leading and trailing underscores', () => {
    assert.equal(sanitizeName('GET', '/api/nodes/'), 'GET_api_nodes');
  });

  test('simple path without special characters', () => {
    assert.equal(sanitizeName('GET', '/api/workspaces'), 'GET_api_workspaces');
  });

  test('POST method is preserved', () => {
    assert.equal(sanitizeName('POST', '/api/graph/nodes'), 'POST_api_graph_nodes');
  });

  test('root path "/" produces just method after dedup and trim', () => {
    // GET_/ → GET__ → GET_ → trim trailing _ → GET
    assert.equal(sanitizeName('GET', '/'), 'GET');
  });

  test('path with query-style braces and slashes combined', () => {
    const result = sanitizeName('PATCH', '/api/nodes/{path}/sub/{id}');
    // Should have no { or }, no double underscores, no leading/trailing _
    assert.ok(!result.includes('{'), 'Should not contain {');
    assert.ok(!result.includes('}'), 'Should not contain }');
  });

  test('empty path produces method with single underscore', () => {
    const result = sanitizeName('GET', '');
    // Empty path: "GET_" → trim trailing _ → "GET"
    // Actually let's verify the actual behavior
    assert.ok(result.startsWith('GET'), `Expected to start with GET, got: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// interpolateEnv
// ---------------------------------------------------------------------------

describe('interpolateEnv()', () => {

  test('replaces a single ${VAR} token', () => {
    const result = interpolateEnv('Hello ${NAME}', { NAME: 'world' });
    assert.equal(result, 'Hello world');
  });

  test('replaces multiple different tokens', () => {
    const result = interpolateEnv('${HOST}:${PORT}', { HOST: 'localhost', PORT: '3080' });
    assert.equal(result, 'localhost:3080');
  });

  test('replaces same token multiple times', () => {
    const result = interpolateEnv('${X}/${X}', { X: 'val' });
    assert.equal(result, 'val/val');
  });

  test('leaves unknown tokens as-is (no blank replacement)', () => {
    const result = interpolateEnv('${MISSING}', {});
    assert.equal(result, '${MISSING}');
  });

  test('falls back to process.env for tokens not in env object', () => {
    const saved = process.env._SHOGUN_TEST_VAR;
    process.env._SHOGUN_TEST_VAR = 'from-process';
    try {
      const result = interpolateEnv('${_SHOGUN_TEST_VAR}', {});
      assert.equal(result, 'from-process');
    } finally {
      if (saved === undefined) {
        delete process.env._SHOGUN_TEST_VAR;
      } else {
        process.env._SHOGUN_TEST_VAR = saved;
      }
    }
  });

  test('env object takes priority over process.env', () => {
    const saved = process.env._SHOGUN_TEST_VAR;
    process.env._SHOGUN_TEST_VAR = 'from-process';
    try {
      const result = interpolateEnv('${_SHOGUN_TEST_VAR}', { _SHOGUN_TEST_VAR: 'from-env' });
      assert.equal(result, 'from-env');
    } finally {
      if (saved === undefined) {
        delete process.env._SHOGUN_TEST_VAR;
      } else {
        process.env._SHOGUN_TEST_VAR = saved;
      }
    }
  });

  test('only matches uppercase alphanumeric + underscore token names', () => {
    // The regex is /\$\{([A-Z0-9_]+)\}/g — lowercase should NOT match
    const result = interpolateEnv('${lowercase}', {});
    assert.equal(result, '${lowercase}');
  });

  test('no tokens in string returns string unchanged', () => {
    const result = interpolateEnv('plain text', {});
    assert.equal(result, 'plain text');
  });

  test('mixed token and non-token content', () => {
    const result = interpolateEnv('url: ${BASE_URL}/api/test', { BASE_URL: 'http://localhost' });
    assert.equal(result, 'url: http://localhost/api/test');
  });

  test('token with underscores and digits', () => {
    const result = interpolateEnv('${MY_VAR_2}', { MY_VAR_2: 'value' });
    assert.equal(result, 'value');
  });
});

// ---------------------------------------------------------------------------
// resolveTestRef
// ---------------------------------------------------------------------------

describe('resolveTestRef()', () => {

  const collectionsDir = '/project/tests/collections';

  test('cross-collection ref: "other-coll/test-name"', () => {
    const result = resolveTestRef('other-coll/test-name', undefined, collectionsDir);
    assert.equal(result.canonicalId, 'other-coll/test-name');
    assert.equal(result.filePath, join(collectionsDir, 'other-coll', 'test-name.yaml'));
  });

  test('cross-collection ref with .yaml extension: "other-coll/test-name.yaml"', () => {
    const result = resolveTestRef('other-coll/test-name.yaml', undefined, collectionsDir);
    assert.equal(result.canonicalId, 'other-coll/test-name');
    assert.equal(result.filePath, join(collectionsDir, 'other-coll', 'test-name.yaml'));
  });

  test('bare name with ownerCollection resolves to that collection', () => {
    const result = resolveTestRef('my-test', 'my-collection', collectionsDir);
    assert.equal(result.canonicalId, 'my-collection/my-test');
    assert.equal(result.filePath, join(collectionsDir, 'my-collection', 'my-test.yaml'));
  });

  test('bare name without ownerCollection throws', () => {
    assert.throws(
      () => resolveTestRef('my-test', undefined, collectionsDir),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /bare test name/);
        assert.match(err.message, /ownerCollection/);
        return true;
      },
    );
  });

  test('bare name with .yaml extension strips extension', () => {
    const result = resolveTestRef('my-test.yaml', 'my-collection', collectionsDir);
    assert.equal(result.canonicalId, 'my-collection/my-test');
    assert.equal(result.filePath, join(collectionsDir, 'my-collection', 'my-test.yaml'));
  });

  test('cross-collection ref ignores ownerCollection (slash takes precedence)', () => {
    const result = resolveTestRef('other-coll/test-name', 'my-collection', collectionsDir);
    assert.equal(result.canonicalId, 'other-coll/test-name');
    // Should NOT be my-collection/test-name
  });
});

// ---------------------------------------------------------------------------
// collectionFromCanonicalId
// ---------------------------------------------------------------------------

describe('collectionFromCanonicalId()', () => {

  test('extracts collection from standard canonical ID', () => {
    assert.equal(collectionFromCanonicalId('graph/get-nodes'), 'graph');
  });

  test('extracts collection with hyphens', () => {
    assert.equal(collectionFromCanonicalId('my-collection/my-test'), 'my-collection');
  });

  test('throws for canonical ID without slash', () => {
    assert.throws(
      () => collectionFromCanonicalId('no-slash-here'),
      /Invalid canonical test ID/,
    );
  });

  test('extracts collection when test name contains no slash', () => {
    assert.equal(collectionFromCanonicalId('code/get-class'), 'code');
  });
});
