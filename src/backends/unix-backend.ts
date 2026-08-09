/**
 * src/backends/unix-backend.ts
 *
 * Unix backend — contains the MOVED curl / jq / diff logic from executor.ts and asserter.ts.
 *
 * ⚠️  CRITICAL: This code is MOVED, not rewritten.
 *    If you change behavior here, you break backward compatibility.
 *
 * Original source files (now thin wrappers):
 *   - src/executor.ts  → executeRequest() logic
 *   - src/asserter.ts   → jq shape assertions, normalizeJson(), runDiff(), snapshot logic
 */

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  ShogunRequest,
  ShogunResponse,
  EnvVars,
  TestDefinition,
  ShogunConfig,
  AssertionResults,
  ShapeAssertionResult,
  SseEvent,
} from '../types.js';
import type { BackendExecutor, DependencyCheck } from '../backend-interface.js';
import { sanitizeName } from '../loader.js';
import { parseSseResponse, isSseContentType, getAssertionBody } from '../sse.js';

// ===========================================================================
// AssertContext — moved from asserter.ts (local type, reused here)
// ===========================================================================

export interface AssertContext {
  test: TestDefinition;
  response: ShogunResponse;
  config: ShogunConfig;
  cwd: string;
  collectionName?: string;
  /** When true: write snapshot instead of diffing */
  snapshotMode?: boolean;
}

// ===========================================================================
// Executor: HTTP execution via curl (MOVED FROM executor.ts)
// ===========================================================================

export interface ExecutorOptions {
  timeout?: number;
  followRedirects?: boolean;
  /**
   * When true (default), inject AUTH_TOKEN from env as `Authorization: Bearer <token>`
   * on requests that do not already have an Authorization header.
   * Pass false to disable — auth must be wired explicitly in pre-scripts.
   */
  autoInjectAuth?: boolean;
  /**
   * Default Content-Type header for requests that don't specify one.
   * Falls back to 'application/json' if not provided.
   * Sourced from config.defaults.content_type.
   */
  contentType?: string;
}

/**
 * Execute an HTTP request via curl.
 * ORIGINAL code from executor.ts — MOVED here, not changed.
 */
export async function executeRequest(
  req: ShogunRequest,
  env: EnvVars,
  opts: ExecutorOptions = {},
): Promise<ShogunResponse> {
  const timeout = opts.timeout ?? parseInt(env.TIMEOUT ?? '10', 10);
  const tmpId = randomBytes(6).toString('hex');
  const bodyOutFile = join(tmpdir(), `shogun-body-${tmpId}.tmp`);

  const headers: Record<string, string> = {
    'Content-Type': opts.contentType ?? 'application/json',
    'Accept': 'application/json',
    ...req.headers,
  };

  // Auto-inject AUTH_TOKEN as Bearer only when:
  //   1. auto_inject_auth is not explicitly disabled (default: true)
  //   2. AUTH_TOKEN is present in env
  //   3. The request does not already have an Authorization header set
  //      (uses hasOwnProperty so an explicit empty-string value suppresses injection)
  const autoInject = opts.autoInjectAuth !== false;
  if (autoInject && env.AUTH_TOKEN && !Object.prototype.hasOwnProperty.call(headers, 'Authorization')) {
    const token = env.AUTH_TOKEN;
    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  const url = buildUrl(req);
  const curlArgs: string[] = [
    '-s',
    '--max-time', String(timeout),
    '-X', req.method,
  ];

  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }

  curlArgs.push(
    '-o', bodyOutFile,
    '-D', '-',
    '-w', '\n__SHOGUN_STATUS__%{http_code}__SHOGUN_TIME__%{time_total}',
    ...(opts.followRedirects !== false ? ['-L'] : []),
    url,
  );

  let bodyInFile: string | null = null;
  if (req.body !== undefined && req.body !== null) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const byteLen = Buffer.byteLength(bodyStr, 'utf8');
    bodyInFile = join(tmpdir(), `shogun-req-${tmpId}.tmp`);
    writeFileSync(bodyInFile, bodyStr, 'utf8');
    const verified = readFileSync(bodyInFile, 'utf8');
    const verifiedBytes = Buffer.byteLength(verified, 'utf8');
    if (process.env.SHOGUN_DEBUG) {
      process.stderr.write(
        `[unix-backend] body-write: ${byteLen} bytes\n` +
        `[unix-backend] body-verify: ${verifiedBytes} bytes\n` +
        `[unix-backend] body-file: ${bodyInFile}\n`
      );
    }
    curlArgs.push('--data-binary', `@${bodyInFile}`);
  }
  if (process.env.SHOGUN_DEBUG) {
    process.stderr.write(`[unix-backend] curl-args: ${JSON.stringify(curlArgs)}\n`);
  }

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await spawnPromise('curl', curlArgs);
    const duration = Date.now() - startTime;

    const sentinelMatch = stdout.match(/__SHOGUN_STATUS__(\d+)__SHOGUN_TIME__([\d.]+)/);
    const status = sentinelMatch ? parseInt(sentinelMatch[1], 10) : 0;
    const curlMs = sentinelMatch ? Math.round(parseFloat(sentinelMatch[2]) * 1000) : duration;

    const responseHeaders = parseResponseHeaders(stdout);

    let raw = '';
    if (existsSync(bodyOutFile)) {
      raw = readFileSync(bodyOutFile, 'utf8');
    }

    let body: unknown = raw;
    let events: SseEvent[] | undefined;

    // SSE auto-parsing: when Content-Type is text/event-stream, parse the SSE
    // events so that body/events are structured data instead of raw SSE text.
    const ct = responseHeaders['content-type'] ?? '';
    if (isSseContentType(ct)) {
      const parsed = parseSseResponse(raw);
      body = parsed.body;
      events = parsed.events;
    } else {
      try {
        if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
          body = JSON.parse(raw);
        }
      } catch { /* non-JSON */ }
    }

    if (stderr && process.env.SHOGUN_DEBUG) {
      console.error(`[unix-backend] curl stderr: ${stderr}`);
    }

    return { status, headers: responseHeaders, body, raw, duration, curlMs, events };
  } finally {
    cleanup(bodyOutFile);
    if (bodyInFile) cleanup(bodyInFile);
  }
}

export function buildUrl(req: ShogunRequest): string {
  let url = req.url;
  const params = req.params;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

export function parseResponseHeaders(stdout: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = stdout.split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9\-]+):\s*(.+)$/);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return headers;
}

function spawnPromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve({ stdout, stderr }));
  });
}

function cleanup(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ }
}

// ===========================================================================
// Asserter: jq shape assertions (MOVED FROM asserter.ts)
// ===========================================================================

export async function runShapeAssertions(
  rawBody: string,
  expressions: string[],
): Promise<ShapeAssertionResult[]> {
  const results: ShapeAssertionResult[] = [];
  for (const expr of expressions) {
    const result = await runJqExpression(rawBody, expr);
    results.push(result);
  }
  return results;
}

async function runJqExpression(jsonInput: string, expr: string): Promise<ShapeAssertionResult> {
  return new Promise((resolve) => {
    const proc = spawn('jq', ['-e', expr], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdin.write(jsonInput);
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ expr, passed: true });
      } else {
        resolve({
          expr,
          passed: false,
          error: stderr.trim() || `jq expression evaluated to false/null: ${expr}`,
        });
      }
    });
    proc.on('error', (err) => {
      resolve({ expr, passed: false, error: `jq error: ${err.message}` });
    });
  });
}

// ===========================================================================
// Asserter: JSON normalization via jq (MOVED FROM asserter.ts)
// ===========================================================================

export async function normalizeJson(raw: string, ignoreFields: string[]): Promise<string> {
  if (!raw.trim()) return '';

  let jqExpr = '.';
  for (const field of ignoreFields) {
    const jqPath = globToJqDel(field);
    jqExpr = `(${jqExpr}) | ${jqPath}`;
  }
  jqExpr = `(${jqExpr}) | . as $x | $x`;

  const sortedExpr = jqExpr.replace(/^\((.+)\) \| \. as \$x \| \$x$/, '$1');

  return new Promise((resolve) => {
    const proc = spawn('jq', ['-S', sortedExpr], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdin.write(raw);
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        if (process.env.SHOGUN_DEBUG) console.error(`[unix-backend] jq normalize failed: ${stderr}`);
        resolve(raw.trim());
      }
    });
    proc.on('error', () => resolve(raw.trim()));
  });
}

export function globToJqDel(field: string): string {
  if (field.startsWith('**.')) {
    const key = field.slice(3);
    return `del(.. | objects | .${key}?)`;
  }
  if (field.startsWith('.')) return `del(${field})`;
  return `del(.${field})`;
}

// ===========================================================================
// Asserter: Diff (MOVED FROM asserter.ts)
// ===========================================================================

export async function runDiff(expected: string, actual: string): Promise<string> {
  return formatSimpleDiff(expected, actual);
}

export function formatSimpleDiff(expected: string, actual: string): string {
  const expLines = expected.split('\n');
  const actLines = actual.split('\n');
  const maxLen = Math.max(expLines.length, actLines.length);
  const diffLines: string[] = ['--- expected', '+++ actual'];
  let hasDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const e = expLines[i];
    const a = actLines[i];
    if (e !== a) {
      hasDiff = true;
      if (e !== undefined) diffLines.push(`- ${e}`);
      if (a !== undefined) diffLines.push(`+ ${a}`);
    } else {
      diffLines.push(`  ${e}`);
    }
  }
  return hasDiff ? diffLines.join('\n') : '';
}

// ===========================================================================
// Asserter: Snapshot assertion (MOVED FROM asserter.ts)
// ===========================================================================

export interface SnapshotResult {
  passed: boolean;
  diff?: string;
  needsBaseline?: boolean;
}

export async function runSnapshotAssertion(ctx: AssertContext): Promise<SnapshotResult> {
  const expectedPath = getExpectedPath(ctx);

  if (ctx.snapshotMode) {
    await writeSnapshot(getAssertionBody(ctx.response), ctx.test, ctx.config, expectedPath);
    return { passed: true };
  }

  if (!existsSync(expectedPath)) {
    return { passed: false, needsBaseline: true };
  }

  const ignoreFields = [
    ...(ctx.config.ignore_fields_global ?? []),
    ...(ctx.test.response?.ignore_fields ?? []),
  ];

  const normalizedActual = await normalizeJson(getAssertionBody(ctx.response), ignoreFields);
  const expectedRaw = readFileSync(expectedPath, 'utf8');
  const normalizedExpected = await normalizeJson(expectedRaw, ignoreFields);

  if (normalizedActual === normalizedExpected) {
    return { passed: true };
  }

  const diff = await runDiff(normalizedExpected, normalizedActual);
  return { passed: false, diff };
}

export async function writeSnapshot(
  raw: string,
  test: TestDefinition,
  config: ShogunConfig,
  expectedPath?: string,
): Promise<void> {
  const path = expectedPath ?? getExpectedPathFromTest(test, config);
  const ignoreFields = [
    ...(config.ignore_fields_global ?? []),
    ...(test.response?.ignore_fields ?? []),
  ];
  const normalized = await normalizeJson(raw, ignoreFields);

  if (!normalized.trim()) {
    if (process.env.SHOGUN_DEBUG) {
      console.warn(`[unix-backend] writeSnapshot suppressed — normalized content is empty`);
    }
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalized + '\n', 'utf8');
}

function getExpectedPath(ctx: AssertContext): string {
  return getExpectedPathFromTest(ctx.test, ctx.config, ctx.cwd, ctx.collectionName);
}

export function getExpectedPathFromTest(
  test: TestDefinition,
  config: ShogunConfig,
  cwd = process.cwd(),
  collectionName?: string,
): string {
  const expectedDir = join(cwd, config.paths?.expected ?? 'expected');
  const collection = collectionName ?? test.collection ?? 'default';
  const safeName = sanitizeName(test.request.method, test.request.path);
  return join(expectedDir, collection, `${safeName}.json`);
}

// ===========================================================================
// Dependency checks (MOVED FROM executor.ts checkDependencies)
// ===========================================================================

export class UnixBackend implements BackendExecutor {
  readonly name = 'unix' as const;
  executeRequest = executeRequest;
  runJsonQuery = runJqExpression as any;
  runShapeAssertions = runShapeAssertions;
  normalizeJson = normalizeJson;
  runDiff = runDiff;
  checkDependencies = checkDependencies;
  runSnapshotAssertion = runSnapshotAssertion;
}

export async function checkDependencies(): Promise<DependencyCheck[]> {
  const results: DependencyCheck[] = [];
  for (const tool of ['curl', 'jq', 'diff'] as const) {
    try {
      await spawnPromise('which', [tool]);
      results.push({ name: tool, found: true, optional: tool === 'diff' });
    } catch {
      results.push({ name: tool, found: false, optional: tool === 'diff' });
    }
  }
  return results;
}
