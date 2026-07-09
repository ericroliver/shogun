/**
 * src/scripter.ts
 * Executes inline TypeScript pre/post scripts from test definitions.
 * Scripts receive a ShogunContext and run via in-process import().
 * Works in both dev mode (Node + tsx) and compiled binary (Bun).
 */

import { writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  ShogunContext,
  ShogunRequest,
  ShogunResponse,
  EnvVars,
  ShogunAssertionError as ShogunAssertionErrorType,
} from './types.js';
import { ShogunAssertionError } from './types.js';

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

/**
 * Runs a pre or post script in-process.
 * Uses dynamic import() which works natively in Bun (compiled binary)
 * and in Node with tsx registered as loader (dev mode).
 */
export async function runScript(
  scriptSource: string,
  ctx: {
    env: EnvVars;
    vars: SharedVars;
    request: ShogunRequest;
    response?: ShogunResponse;
    scriptsDir: string;
  },
): Promise<ScriptRunResult> {
  const tmpId = randomBytes(6).toString('hex');
  const scriptFile = join(tmpdir(), `shogun-script-${tmpId}.mts`);

  // Load available shared scripts
  const sharedScripts = loadSharedScriptImports(ctx.scriptsDir);

  const wrapper = buildScriptWrapper(scriptSource, ctx, sharedScripts);
  writeFileSync(scriptFile, wrapper, 'utf8');

  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] scriptFile: ${scriptFile}\n`);
    process.stderr.write(`[scripter] wrapper length: ${wrapper.length} chars\n`);
    process.stderr.write(`[scripter] source snippet: ${scriptSource.slice(0, 120)}...\n`);
  }

  try {
    const result = await executeScript(scriptFile);
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(`[scripter] executeScript returned: passed=${result.passed}, error=${result.error ?? 'none'}, logs=${result.logs.length}, reqMutations=${JSON.stringify(result.requestMutations ?? {}).slice(0, 200)}, varMutations=${JSON.stringify(result.varMutations ?? {}).slice(0, 200)}\n`);
    }
    return result;
  } finally {
    cleanup(scriptFile);
  }
}

function buildScriptWrapper(
  source: string,
  ctx: {
    env: EnvVars;
    vars: SharedVars;
    request: ShogunRequest;
    response?: ShogunResponse;
    scriptsDir: string;
  },
  sharedScripts: Record<string, string>,
): string {
  const sharedImports = Object.entries(sharedScripts)
    .map(([name, path]) => `import * as _script_${name} from ${JSON.stringify(path)};`)
    .join('\n');

  const scriptNames = Object.keys(sharedScripts)
    .map(name => `${name}: _script_${name}`)
    .join(', ');

  // Serialize context data for injection
  const ctxData = JSON.stringify({
    env: ctx.env,
    vars: ctx.vars,
    request: ctx.request,
    response: ctx.response ?? null,
  });

  return `
${sharedImports}

// ---- shogun script runtime ----

const __ctxData = ${ctxData};

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

// ---- export result for in-process import() ----
export const __result = {
  passed: __errorMessage === null,
  error: __errorMessage ?? undefined,
  request: ctx.request,
  vars: ctx.vars,
  logs: __logs,
};
`;
}

/**
 * Executes the wrapper script via in-process dynamic import().
 * 
 * - Bun (compiled binary): handles TypeScript natively, no loader needed.
 * - Node + tsx (dev mode): tsx is registered as the ESM loader, so import()
 *   of .mts files works transparently.
 * 
 * This replaces the previous spawn-based approach which had multiple issues:
 * - DEP0190: spawn with shell:true deprecated in Node 22+
 * - EINVAL: spawn without shell:true fails for .cmd files on Windows
 * - require.resolve('tsx'): fails in compiled binary (no node_modules at runtime)
 */
async function executeScript(scriptFile: string): Promise<ScriptRunResult> {
  const scriptUrl = pathToFileURL(scriptFile).href;
  
  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[scripter] executeScript: importing ${scriptUrl}\n`);
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

function loadSharedScriptImports(scriptsDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(scriptsDir)) return result;

  const files = readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));
  for (const file of files) {
    const name = file.replace('.ts', '');
    result[name] = join(scriptsDir, file);
  }
  return result;
}

function cleanup(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* ignore */ }
}
