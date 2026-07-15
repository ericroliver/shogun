/**
 * src/scripter.ts
 * Executes inline TypeScript pre/post scripts from test definitions.
 *
 * Two execution paths:
 *
 * 1. Bun (compiled binary): In-memory transpile via Bun.Transpiler, then
 *    execute with `new AsyncFunction()`. No temp files, no import() — this
 *    avoids the Bun virtual-filesystem issue where compiled binaries cannot
 *    resolve temp .mts file paths from their virtual FS (B/~BUN/root/...).
 *
 * 2. Node (dev mode with tsx): Temp .mts file + dynamic import(). The tsx
 *    loader registered as ESM loader handles TypeScript transparently.
 *
 * Detection: `typeof Bun !== 'undefined'` is true only inside the Bun
 * runtime (compiled binary or `bun run`). In Node with tsx, Bun is absent.
 */

import { writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  ShogunRequest,
  ShogunResponse,
  EnvVars,
} from './types.js';

export interface ScriptRunResult {
  passed: boolean;
  error?: string;
  logs: string[];
  /** Mutations applied to the request (from pre-script) */
  requestMutations?: Partial<ShogunRequest>;
  /** Mutations applied to shared vars (from any script) */
  varMutations?: Record<string, unknown>;
}

export type SharedVars = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Bun runtime detection
// ---------------------------------------------------------------------------

/** True when running inside the Bun runtime (compiled binary or `bun run`). */
const isBunRuntime = typeof (globalThis as any).Bun !== 'undefined';

/** AsyncFunction constructor — used to execute transpiled JS without temp files. */
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;

interface BunTranspiler {
  transformSync(code: string): string;
}

/** Lazily-initialised Bun.Transpiler singleton (null when not in Bun runtime). */
let _bunTranspiler: BunTranspiler | null | undefined;

function getBunTranspiler(): BunTranspiler | null | undefined {
  if (_bunTranspiler !== undefined) return _bunTranspiler;
  if (!isBunRuntime) {
    _bunTranspiler = null;
    return null;
  }
  try {
    const Bun = (globalThis as any).Bun;
    _bunTranspiler = new Bun.Transpiler({ loader: 'ts' });
  } catch {
    _bunTranspiler = null;
  }
  return _bunTranspiler;
}

// ---------------------------------------------------------------------------
// Context serialization
// ---------------------------------------------------------------------------

export interface ScriptContext {
  env: EnvVars;
  vars: SharedVars;
  request: ShogunRequest;
  response?: ShogunResponse;
  scriptsDir: string;
}

/** Plain-data representation of the context, safe for JSON serialization. */
export interface SerializedContext {
  env: EnvVars;
  vars: SharedVars;
  request: ShogunRequest;
  response: ShogunResponse | null;
}

/**
 * Serializes the runtime context into a plain-data object suitable for
 * JSON.stringify injection into the script wrapper.
 */
export function serializeContext(ctx: ScriptContext): SerializedContext {
  return {
    env: ctx.env,
    vars: ctx.vars,
    request: ctx.request,
    response: ctx.response ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared script loading
// ---------------------------------------------------------------------------

/**
 * Scans the scripts/ directory for `.ts` files and returns a map of
 * script-name → absolute file path. Returns empty object if the directory
 * does not exist.
 */
export function loadSharedScriptPaths(scriptsDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(scriptsDir)) return result;

  const files = readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));
  for (const file of files) {
    const name = file.replace('.ts', '');
    result[name] = join(scriptsDir, file);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wrapper builder (pure function — unit-testable)
// ---------------------------------------------------------------------------

export type WrapperMode = 'return' | 'export';

/**
 * Builds the TypeScript wrapper source that:
 *  1. Injects context (env, vars, request, response) as serialised JSON
 *  2. Provides the `ctx` API (assert, log, http, scripts)
 *  3. Executes the user's inline script inside a try/catch
 *  4. Returns or exports the result object
 *
 * @param source        - The user's inline TypeScript (pre/post/setup script)
 * @param ctxData       - Serialized context data to inject
 * @param sharedScripts - Map of script-name → absolute path for shared scripts
 * @param mode          - 'return' for Bun (AsyncFunction), 'export' for Node (import)
 */
export function buildScriptWrapper(
  source: string,
  ctxData: SerializedContext,
  sharedScripts: Record<string, string>,
  mode: WrapperMode,
): string {
  const ctxJson = JSON.stringify(ctxData);

  // Shared script declarations differ by mode:
  // - 'return' (Bun): dynamic import() of real file paths (Bun resolves these)
  // - 'export' (Node): static import * as (tsx loader resolves these)
  const sharedScriptDecls = Object.entries(sharedScripts)
    .map(([name, path]) => {
      if (mode === 'return') {
        // Use file:// URL so Bun's import() resolves the real file on disk
        const url = pathToFileURL(path).href;
        return `const _script_${name} = await import(${JSON.stringify(url)});`;
      }
      return `import * as _script_${name} from ${JSON.stringify(path)};`;
    })
    .join('\n');

  const scriptNames = Object.keys(sharedScripts)
    .map(name => `${name}: _script_${name}`)
    .join(', ');

  // Result handling differs by mode:
  // - 'return': return statement (works inside AsyncFunction)
  // - 'export': export const (works as ESM module for import())
  const tail = mode === 'return'
    ? `return {\n    passed: __errorMessage === null,\n    error: __errorMessage ?? undefined,\n    request: ctx.request,\n    vars: ctx.vars,\n    logs: __logs,\n  };`
    : `export const __result = {\n    passed: __errorMessage === null,\n    error: __errorMessage ?? undefined,\n    request: ctx.request,\n    vars: ctx.vars,\n    logs: __logs,\n  };`;

  return `
${sharedScriptDecls}

// ---- shogun script runtime ----

const __ctxData = ${ctxJson};

const __logs: string[] = [];

const ctx = {
  env: __ctxData.env as Record<string, string>,
  vars: __ctxData.vars as Record<string, unknown>,
  request: __ctxData.request as Record<string, unknown>,
  response: __ctxData.response as Record<string, unknown> | null,
  scripts: { ${scriptNames} },

  assert(condition: boolean, message: string): void {
    if (!condition) {
      const err = new Error(message);
      err.name = 'ShogunAssertionError';
      throw err;
    }
  },

  log(message: string): void {
    __logs.push(String(message));
    if (process.env.SHOGUN_DEBUG) { process.stderr.write('[script] ' + String(message) + '\\n'); }
  },

  http: {
    async get(path: string, opts?: Record<string, unknown>) {
      return __httpCall('GET', path, undefined, opts);
    },
    async post(path: string, body: unknown, opts?: Record<string, unknown>) {
      return __httpCall('POST', path, body, opts);
    },
    async put(path: string, body: unknown, opts?: Record<string, unknown>) {
      return __httpCall('PUT', path, body, opts);
    },
    async patch(path: string, body: unknown, opts?: Record<string, unknown>) {
      return __httpCall('PATCH', path, body, opts);
    },
    async delete(path: string, opts?: Record<string, unknown>) {
      return __httpCall('DELETE', path, undefined, opts);
    },
  },
};

async function __httpCall(method: string, path: string, body?: unknown, _opts?: Record<string, unknown>) {
  const baseUrl = ctx.env.BASE_URL ?? '';
  const url = path.startsWith('http') ? path : baseUrl + path;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (ctx.env.AUTH_TOKEN) {
    const t = ctx.env.AUTH_TOKEN;
    headers['Authorization'] = t.startsWith('Bearer ') ? t : 'Bearer ' + t;
  }
  // Merge caller-supplied headers (e.g. X-Enigma-Workspace) — these take precedence
  if (_opts?.headers && typeof _opts.headers === 'object') {
    for (const [k, v] of Object.entries(_opts.headers as Record<string, string>)) {
      if (v !== undefined && v !== null) headers[k] = String(v);
    }
  }

  // Always log the outgoing request so failures show full context
  ctx.log(\`\${method} \${url}\`);
  if (body !== undefined) {
    ctx.log(\`  request body: \${JSON.stringify(body)}\`);
  }
  const safeHeaders = { ...headers };
  if (safeHeaders['Authorization']) {
    safeHeaders['Authorization'] = safeHeaders['Authorization'].replace(/(Bearer\\s+)(.{4}).*/, '$1$2...');
  }
  ctx.log(\`  request headers: \${JSON.stringify(safeHeaders)}\`);

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep string */ }

  // Log status; for non-2xx also dump the response body so failures are self-diagnosable
  ctx.log(\`  <- \${res.status}\`);
  if (res.status < 200 || res.status >= 300) {
    const snippet = text.length > 500 ? text.slice(0, 500) + '...' : text;
    ctx.log(\`  response body: \${snippet}\`);
  }

  return { status: res.status, body: parsed, raw: text, headers: Object.fromEntries(res.headers.entries()), duration: 0 };
}

// ---- user script ----

let __errorMessage: string | null = null;

try {
  await (async () => {
    ${source}
  })();
} catch (e: any) {
  if (e?.name === 'ShogunAssertionError') {
    __errorMessage = e.message;
  } else {
    __errorMessage = e?.message || String(e);
  }
}

// ---- result ----
${tail}
`;
}

// ---------------------------------------------------------------------------
// Plain-JS wrapper builder (for Bun AsyncFunction execution)
// ---------------------------------------------------------------------------

/**
 * Builds a PLAIN JAVASCRIPT wrapper (no TypeScript annotations) that:
 *  1. Injects context (env, vars, request, response) as serialised JSON
 *  2. Provides the `ctx` API (assert, log, http, scripts)
 *  3. Executes the already-transpiled user script inside a try/catch
 *  4. Returns the result object
 *
 * This is used ONLY by the Bun execution path. Because it contains zero
 * TypeScript syntax, Bun.Transpiler never touches it — we feed it directly
 * to `new AsyncFunction()` where top-level `return` is perfectly legal.
 *
 * @param userJsSource   - The user's script, ALREADY transpiled to JS by Bun.Transpiler
 * @param ctxData        - Serialized context data to inject
 * @param sharedScripts  - Map of script-name → absolute path for shared scripts
 */
export function buildPlainJsWrapper(
  userJsSource: string,
  ctxData: SerializedContext,
  sharedScripts: Record<string, string>,
): string {
  const ctxJson = JSON.stringify(ctxData);

  const sharedScriptDecls = Object.entries(sharedScripts)
    .map(([name, path]) => {
      const url = pathToFileURL(path).href;
      return `const _script_${name} = await import(${JSON.stringify(url)});`;
    })
    .join('\n');

  const scriptNames = Object.keys(sharedScripts)
    .map(name => `${name}: _script_${name}`)
    .join(', ');

  return `
${sharedScriptDecls}

var __ctxData = ${ctxJson};
var __logs = [];

var ctx = {
  env: __ctxData.env,
  vars: __ctxData.vars,
  request: __ctxData.request,
  response: __ctxData.response,
  scripts: { ${scriptNames} },

  assert: function(condition, message) {
    if (!condition) {
      var err = new Error(message);
      err.name = 'ShogunAssertionError';
      throw err;
    }
  },

  log: function(message) {
    __logs.push(String(message));
    if (process.env.SHOGUN_DEBUG) { process.stderr.write('[script] ' + String(message) + '\\n'); }
  },

  http: {
    get: function(path, opts) { return __httpCall('GET', path, undefined, opts); },
    post: function(path, body, opts) { return __httpCall('POST', path, body, opts); },
    put: function(path, body, opts) { return __httpCall('PUT', path, body, opts); },
    patch: function(path, body, opts) { return __httpCall('PATCH', path, body, opts); },
    delete: function(path, opts) { return __httpCall('DELETE', path, undefined, opts); },
  },
};

async function __httpCall(method, path, body, _opts) {
  var baseUrl = (ctx.env && ctx.env.BASE_URL) ? ctx.env.BASE_URL : '';
  var url = path.startsWith('http') ? path : baseUrl + path;
  var headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (ctx.env && ctx.env.AUTH_TOKEN) {
    var t = ctx.env.AUTH_TOKEN;
    headers['Authorization'] = t.startsWith('Bearer ') ? t : 'Bearer ' + t;
  }
  if (_opts && _opts.headers && typeof _opts.headers === 'object') {
    for (var k in _opts.headers) {
      if (_opts.headers[k] !== undefined && _opts.headers[k] !== null) {
        headers[k] = String(_opts.headers[k]);
      }
    }
  }

  ctx.log(method + ' ' + url);
  if (body !== undefined) {
    ctx.log('  request body: ' + JSON.stringify(body));
  }
  var safeHeaders = Object.assign({}, headers);
  if (safeHeaders['Authorization']) {
    safeHeaders['Authorization'] = safeHeaders['Authorization'].replace(/(Bearer\\s+)(.{4}).*/, '$1$2...');
  }
  ctx.log('  request headers: ' + JSON.stringify(safeHeaders));

  var res = await fetch(url, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  var text = await res.text();
  var parsed = text;
  try { parsed = JSON.parse(text); } catch (e) { /* keep string */ }

  ctx.log('  <- ' + res.status);
  if (res.status < 200 || res.status >= 300) {
    var snippet = text.length > 500 ? text.slice(0, 500) + '...' : text;
    ctx.log('  response body: ' + snippet);
  }

  return {
    status: res.status,
    body: parsed,
    raw: text,
    headers: Object.fromEntries(res.headers.entries()),
    duration: 0,
  };
}

var __errorMessage = null;

try {
  await (async () => {
    ${userJsSource}
  })();
} catch (e) {
  if (e && e.name === 'ShogunAssertionError') {
    __errorMessage = e.message;
  } else {
    __errorMessage = (e && e.message) ? e.message : String(e);
  }
}

return {
  passed: __errorMessage === null,
  error: __errorMessage !== null ? __errorMessage : undefined,
  request: ctx.request,
  vars: ctx.vars,
  logs: __logs,
};
`;
}

// ---------------------------------------------------------------------------
// Execution: Bun path (compiled binary)
// ---------------------------------------------------------------------------

/**
 * Executes the script using Bun.Transpiler + AsyncFunction.
 *
 * Two-step approach:
 * 1. Transpile ONLY the user's TypeScript snippet to JS (avoids ESM module
 *    treatment that would forbid top-level `return`).
 * 2. Wrap the transpiled JS in a plain JavaScript wrapper (no TS annotations)
 *    and execute via `new AsyncFunction()` where `return` is legal.
 *
 * This path avoids writing temp files entirely, working around the Bun
 * compiled binary's inability to resolve temp .mts file paths from its
 * virtual filesystem (B/~BUN/root/shogun-win-x64).
 */
async function runScriptBun(
  source: string,
  ctxData: SerializedContext,
  sharedScripts: Record<string, string>,
): Promise<ScriptRunResult> {
  const transpiler = getBunTranspiler();
  if (!transpiler) {
    return {
      passed: false,
      error: 'Bun.Transpiler is not available despite Bun runtime detection',
      logs: [],
    };
  }

  // Step 1: Transpile ONLY the user's TypeScript snippet to JavaScript.
  // This is a small fragment, not a module, so Bun won't wrap it in ESM.
  let jsUserSource: string;
  try {
    jsUserSource = transpiler.transformSync(source);
  } catch (err: any) {
    return {
      passed: false,
      error: `Failed to transpile script: ${err?.message || String(err)}`,
      logs: [],
    };
  }

  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] Bun path: transpiled user source (${source.length} → ${jsUserSource.length} chars)\n`);
  }

  // Step 2: Build a plain JS wrapper around the transpiled user source.
  // No TypeScript annotations → no ESM treatment → top-level return is legal.
  const jsWrapper = buildPlainJsWrapper(jsUserSource, ctxData, sharedScripts);

  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] Bun path: JS wrapper built (${jsWrapper.length} chars), executing via AsyncFunction\n`);
  }

  // Step 3: Execute via AsyncFunction (no temp files, no import()).
  let fn: (...args: any[]) => Promise<any>;
  try {
    fn = new AsyncFunctionCtor(jsWrapper) as typeof fn;
  } catch (err: any) {
    return {
      passed: false,
      error: `Failed to create async function from transpiled script: ${err?.message || String(err)}`,
      logs: [],
    };
  }

  try {
    const result = await fn();

    if (!result || typeof result !== 'object') {
      return {
        passed: false,
        error: 'Script returned an invalid result (expected object with passed/error/logs)',
        logs: [],
      };
    }

    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] Bun path: result passed=${result.passed}, error=${result.error ?? 'none'}, logs=${result.logs?.length ?? 0}\n`);
    }

    return {
      passed: result.passed,
      error: result.error,
      logs: result.logs ?? [],
      requestMutations: result.request,
      varMutations: result.vars,
    };
  } catch (err: any) {
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] Bun path: execution threw: ${err?.message || String(err)}\n`);
      process.stderr.write(`[scripter] stack: ${err?.stack ?? 'no stack'}\n`);
    }
    return {
      passed: false,
      error: `Script execution failed: ${err?.message || String(err)}`,
      logs: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Execution: Node path (dev mode with tsx)
// ---------------------------------------------------------------------------

/**
 * Executes the script by writing a temp .mts file and using dynamic import().
 * Works in dev mode where tsx is registered as the ESM loader.
 */
async function runScriptNode(
  source: string,
  ctxData: SerializedContext,
  sharedScripts: Record<string, string>,
): Promise<ScriptRunResult> {
  const tmpId = randomBytes(6).toString('hex');
  const scriptFile = join(tmpdir(), `shogun-script-${tmpId}.mts`);

  const wrapper = buildScriptWrapper(source, ctxData, sharedScripts, 'export');
  writeFileSync(scriptFile, wrapper, 'utf8');

  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] Node path: scriptFile: ${scriptFile}\n`);
    process.stderr.write(`[scripter] Node path: wrapper length: ${wrapper.length} chars\n`);
    process.stderr.write(`[scripter] Node path: source snippet: ${source.slice(0, 120)}...\n`);
  }

  try {
    const result = await executeScriptViaImport(scriptFile);
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] Node path: executeScript returned: passed=${result.passed}, error=${result.error ?? 'none'}, logs=${result.logs.length}\n`);
    }
    return result;
  } finally {
    cleanup(scriptFile);
  }
}

/**
 * Imports the temp .mts file via dynamic import().
 * The tsx loader (registered as ESM loader in dev mode) handles TypeScript.
 */
async function executeScriptViaImport(scriptFile: string): Promise<ScriptRunResult> {
  const scriptUrl = pathToFileURL(scriptFile).href;

  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] executeScriptViaImport: importing ${scriptUrl}\n`);
  }

  try {
    const mod = await import(scriptUrl);

    if (process.env.SHOGUN_DEBUG) {
      const exportKeys = mod ? Object.keys(mod) : [];
      process.stderr.write(`[scripter] import resolved, exports: ${JSON.stringify(exportKeys)}\n`);
      process.stderr.write(`[scripter] __result present: ${'__result' in (mod ?? {})}\n`);
    }

    const result = (mod as { __result?: any }).__result;

    if (!result) {
      if (process.env.SHOGUN_DEBUG) {
        process.stderr.write(`[scripter] __result is undefined — module loaded but export missing\n`);
      }
      return {
        passed: false,
        error: `Script module loaded but __result export was missing (possible stale module cache or import failure)`,
        logs: [],
      };
    }

    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] __result: passed=${result.passed}, error=${result.error ?? 'none'}, logs=${result.logs?.length ?? 0}\n`);
    }

    return {
      passed: result.passed,
      error: result.error,
      logs: result.logs ?? [],
      requestMutations: result.request,
      varMutations: result.vars,
    };
  } catch (err: any) {
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] import() threw: ${err?.message || String(err)}\n`);
      process.stderr.write(`[scripter] error stack: ${err?.stack ?? 'no stack'}\n`);
    }
    return {
      passed: false,
      error: `Script execution failed: ${err?.message || String(err)}`,
      logs: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs a pre or post script in-process.
 *
 * Automatically selects the appropriate execution path:
 * - Bun runtime: in-memory transpile (Bun.Transpiler) + AsyncFunction (no temp files)
 * - Node runtime: temp .mts file + import() (tsx loader handles TypeScript)
 *
 * @param scriptSource - The user's inline TypeScript source code
 * @param ctx          - Runtime context (env, vars, request, response, scriptsDir)
 */
export async function runScript(
  scriptSource: string,
  ctx: ScriptContext,
): Promise<ScriptRunResult> {
  const sharedScripts = loadSharedScriptPaths(ctx.scriptsDir);
  const ctxData = serializeContext(ctx);

  const transpiler = getBunTranspiler();
  if (transpiler) {
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] Using Bun execution path (in-memory transpile + AsyncFunction)\n`);
    }
    return runScriptBun(scriptSource, ctxData, sharedScripts);
  }

  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] Using Node execution path (temp file + import)\n`);
  }
  return runScriptNode(scriptSource, ctxData, sharedScripts);
}
