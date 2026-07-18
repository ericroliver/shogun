/**
 * src/tests/scripter-pure.test.ts
 *
 * Unit tests for pure functions in src/scripter.ts:
 *   serializeContext, loadSharedScriptPaths (shape), buildScriptWrapper
 *
 * These tests do NOT execute scripts — they validate the wrapper generation
 * and context serialization logic that feeds into both Bun and Node paths.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeContext,
  buildScriptWrapper,
  wrapUserSourceForTranspilation,
} from '../scripter.js';
import type { ScriptContext, SerializedContext } from '../scripter.js';
import type { ShogunRequest } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ScriptContext>): ScriptContext {
  const request: ShogunRequest = {
    method: 'GET',
    path: '/api/test',
    url: 'http://localhost:3071/api/test',
    headers: { Accept: 'application/json' },
    params: {},
  };
  return {
    env: { BASE_URL: 'http://localhost:3071', AUTH_TOKEN: 'Bearer abc123' },
    vars: { testVar: 'hello' },
    request,
    scriptsDir: '/fake/scripts',
    ...overrides,
  };
}

// ===========================================================================
// serializeContext
// ===========================================================================

describe('serializeContext()', () => {
  test('serializes env, vars, request, and response', () => {
    const ctx = makeCtx();
    const result = serializeContext(ctx);
    assert.equal(result.env.BASE_URL, 'http://localhost:3071');
    assert.equal(result.env.AUTH_TOKEN, 'Bearer abc123');
    assert.equal(result.vars.testVar, 'hello');
    assert.equal(result.request.method, 'GET');
    assert.equal(result.request.path, '/api/test');
  });

  test('sets response to null when not provided', () => {
    const ctx = makeCtx();
    const result = serializeContext(ctx);
    assert.equal(result.response, null);
  });

  test('preserves response when provided', () => {
    const response = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { ok: true },
      raw: '{"ok":true}',
      duration: 50,
      curlMs: 45,
    };
    const ctx = makeCtx({ response });
    const result = serializeContext(ctx);
    assert.equal(result.response, response);
    assert.equal(result.response.status, 200);
  });

  test('produces JSON-serializable output', () => {
    const ctx = makeCtx();
    const result = serializeContext(ctx);
    // Should not throw
    const json = JSON.stringify(result);
    assert.ok(json.length > 0);
    const parsed = JSON.parse(json);
    assert.equal(parsed.env.BASE_URL, 'http://localhost:3071');
  });

  test('handles empty env and vars', () => {
    const ctx = makeCtx({ env: {}, vars: {} });
    const result = serializeContext(ctx);
    assert.deepEqual(result.env, {});
    assert.deepEqual(result.vars, {});
  });
});

// ===========================================================================
// buildScriptWrapper — structure validation
// ===========================================================================

describe('buildScriptWrapper()', () => {
  const ctxData: SerializedContext = {
    env: { BASE_URL: 'http://localhost:3071' },
    vars: { testVar: 'hello' },
    request: {
      method: 'GET',
      path: '/api/test',
      url: 'http://localhost:3071/api/test',
      headers: {},
      params: {},
    },
    response: null,
  };

  // ---- Mode: return (Bun path) ----

  describe('mode="return" (Bun AsyncFunction)', () => {
    test('includes the user source code', () => {
      const source = 'ctx.log("hello from test");';
      const wrapper = buildScriptWrapper(source, ctxData, {}, 'return');
      assert.ok(wrapper.includes('hello from test'));
    });

    test('includes a return statement for the result', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('return {'));
      assert.ok(wrapper.includes('passed:'));
    });

    test('does NOT include export const __result', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(!wrapper.includes('export const __result'));
    });

    test('includes serialized context data', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('http://localhost:3071'));
      assert.ok(wrapper.includes('testVar'));
    });

    test('includes ctx.assert function', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('assert(condition: boolean'));
      assert.ok(wrapper.includes("err.name = 'ShogunAssertionError'"));
    });

    test('includes ctx.log function', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('log(message: string)'));
    });

    test('includes ctx.http helpers', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('async get(path: string'));
      assert.ok(wrapper.includes('async post(path: string'));
      assert.ok(wrapper.includes('async put(path: string'));
      assert.ok(wrapper.includes('async patch(path: string'));
      assert.ok(wrapper.includes('async delete(path: string'));
    });

    test('wraps user code in try/catch', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('try {'));
      assert.ok(wrapper.includes('catch (e: any)'));
      assert.ok(wrapper.includes('__errorMessage'));
    });
  });

  // ---- Mode: export (Node path) ----

  describe('mode="export" (Node import)', () => {
    test('includes the user source code', () => {
      const source = 'ctx.log("hello from node");';
      const wrapper = buildScriptWrapper(source, ctxData, {}, 'export');
      assert.ok(wrapper.includes('hello from node'));
    });

    test('includes export const __result', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'export');
      assert.ok(wrapper.includes('export const __result = {'));
    });

    test('does NOT include bare result return statement', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'export');
      // The 'return' mode has `return { passed: ... }`; export mode uses `export const __result`
      assert.ok(!wrapper.includes('return {\n    passed:'));
    });
  });

  // ---- Shared scripts ----

  describe('shared scripts', () => {
    test('mode="return": uses dynamic import() for shared scripts', () => {
      const sharedScripts = {
        'helper': '/path/to/scripts/helper.ts',
      };
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, sharedScripts, 'return');
      // Bun path uses `await import("file:///path/to/scripts/helper.ts")`
      assert.ok(wrapper.includes('await import('));
      assert.ok(wrapper.includes('helper.ts'));
      assert.ok(wrapper.includes('_script_helper'));
    });

    test('mode="export": uses static import for shared scripts', () => {
      const sharedScripts = {
        'helper': '/path/to/scripts/helper.ts',
      };
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, sharedScripts, 'export');
      // Node path uses `import * as _script_helper from "/path/to/scripts/helper.ts"`
      assert.ok(wrapper.includes('import * as _script_helper from'));
      assert.ok(wrapper.includes('helper.ts'));
    });

    test('includes shared script names in ctx.scripts object', () => {
      const sharedScripts = {
        'helper': '/path/to/scripts/helper.ts',
        'auth': '/path/to/scripts/auth.ts',
      };
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, sharedScripts, 'return');
      assert.ok(wrapper.includes('helper: _script_helper'));
      assert.ok(wrapper.includes('auth: _script_auth'));
    });

    test('no shared scripts declarations when map is empty', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      // Should not contain any import declarations for scripts
      assert.ok(!wrapper.includes('_script_'));
    });
  });

  // ---- Context injection ----

  describe('context injection', () => {
    test('injects env vars into wrapper', () => {
      const ctxWithEnv: SerializedContext = {
        ...ctxData,
        env: { BASE_URL: 'http://my-api.com', CUSTOM: 'value' },
      };
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxWithEnv, {}, 'return');
      assert.ok(wrapper.includes('http://my-api.com'));
      assert.ok(wrapper.includes('CUSTOM'));
    });

    test('injects request data', () => {
      const ctxWithReq: SerializedContext = {
        ...ctxData,
        request: {
          method: 'POST',
          path: '/api/submit',
          url: 'http://localhost:3071/api/submit',
          headers: { 'Content-Type': 'application/json' },
          params: { id: '42' },
        },
      };
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxWithReq, {}, 'return');
      assert.ok(wrapper.includes('/api/submit'));
      assert.ok(wrapper.includes('POST'));
    });

    test('injects response data when present', () => {
      const ctxWithResp: SerializedContext = {
        ...ctxData,
        response: {
          status: 404,
          headers: {},
          body: { error: 'not found' },
          raw: '{"error":"not found"}',
          duration: 100,
          curlMs: 90,
        },
      };
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxWithResp, {}, 'return');
      assert.ok(wrapper.includes('not found'));
    });
  });

  // ---- Error handling in wrapper ----

  describe('error handling', () => {
    test('catches ShogunAssertionError and sets __errorMessage', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes("e?.name === 'ShogunAssertionError'"));
      assert.ok(wrapper.includes('__errorMessage = e.message'));
    });

    test('catches generic errors and sets __errorMessage', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('__errorMessage = e?.message || String(e)'));
    });

    test('sets __errorMessage to null initially', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('let __errorMessage: string | null = null'));
    });
  });

  // ---- HTTP helper ----

  describe('http helper', () => {
    test('includes __httpCall with fetch', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('async function __httpCall'));
      assert.ok(wrapper.includes('await fetch(url'));
    });

    test('logs outgoing HTTP requests', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes('ctx.log(`${method} ${url}`)'));
    });

    test('masks Authorization header in logs', () => {
      const wrapper = buildScriptWrapper('ctx.log("x");', ctxData, {}, 'return');
      assert.ok(wrapper.includes("safeHeaders['Authorization']"));
      assert.ok(wrapper.includes("'$1$2...'"));
    });
  });

  // ---- wrapUserSourceForTranspilation ----

  describe('wrapUserSourceForTranspilation()', () => {
    test('wraps source in an async IIFE', () => {
      const source = 'ctx.log("hello");';
      const wrapped = wrapUserSourceForTranspilation(source);
      assert.ok(wrapped.includes('async () =>'));
      assert.ok(wrapped.includes('ctx.log("hello")'));
    });

    test('uses await on the IIFE call', () => {
      const wrapped = wrapUserSourceForTranspilation('ctx.log("x");');
      assert.ok(wrapped.startsWith('await (async () =>'));
      assert.ok(wrapped.endsWith('})();'));
    });

    test('preserves return statements inside the IIFE (not top-level)', () => {
      // This is the core fix: `return;` inside the async IIFE is legal,
      // whereas top-level `return` in ESM (triggered by top-level await) is not.
      const source = 'if (!ctx.response) return;\nctx.log("has response");';
      const wrapped = wrapUserSourceForTranspilation(source);
      // The return must be inside the IIFE body, not at the top level
      assert.ok(wrapped.includes('return;'));
      assert.ok(!wrapped.startsWith('return'));
      // Verify structure: starts with IIFE opening, ends with IIFE closing
      assert.ok(wrapped.startsWith('await (async () => {\n'));
      assert.ok(wrapped.endsWith('\n})();'));
      // The return; must appear after the IIFE opening, not before it
      const iifeOpenEnd = wrapped.indexOf('{\n') + 2;
      const returnIdx = wrapped.indexOf('return;');
      assert.ok(returnIdx > iifeOpenEnd, 'return; should be inside the IIFE body');
    });

    test('handles source with both return and await (the failing pattern)', () => {
      // This is the exact pattern that caused the 6 failures:
      // `return;` + `await` in a post-script
      const source = [
        'const data = await ctx.http.get("/api/test");',
        'if (!data.body) return;',
        'ctx.assert(data.status === 200, "expected 200");',
      ].join('\n');
      const wrapped = wrapUserSourceForTranspilation(source);
      assert.ok(wrapped.includes('await ctx.http.get'));
      assert.ok(wrapped.includes('return;'));
      // Both await and return are now inside the async IIFE — legal
      assert.ok(wrapped.startsWith('await (async () => {'));
      assert.ok(wrapped.endsWith('})();'));
    });

    test('preserves multi-line source with complex logic', () => {
      const source = [
        'const x = 1;',
        'const y = 2;',
        'if (x > y) {',
        '  ctx.log("x wins");',
        '  return;',
        '}',
        'ctx.log("y wins");',
      ].join('\n');
      const wrapped = wrapUserSourceForTranspilation(source);
      assert.ok(wrapped.includes('x wins'));
      assert.ok(wrapped.includes('y wins'));
      assert.ok(wrapped.includes('return;'));
      assert.ok(wrapped.startsWith('await (async () => {\n'));
    });

    test('handles empty source gracefully', () => {
      const wrapped = wrapUserSourceForTranspilation('');
      assert.ok(wrapped.includes('async () =>'));
      // Should still be valid JS: await (async () => { })(); 
      assert.ok(wrapped.startsWith('await (async () => {'));
    });
  });
});
