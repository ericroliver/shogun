/**
 * src/commands/coverage/test-collector.ts
 * Collect test entries from YAML files — full metadata extraction.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as yaml from 'js-yaml';
import {
  loadSuite,
  discoverCollections,
} from '../../loader.js';
import type { ShogunConfig } from '../../types.js';
import type { TestEntry, CoverAnnotation } from './types.js';

export async function collectTestEntries(
  config: ShogunConfig,
  cwd: string,
  collectionFilter?: string | string[],
  suiteFilter?: string,
): Promise<TestEntry[]> {
  const testsDir = join(cwd, config.paths?.tests ?? 'tests');
  const collectionsDir = join(testsDir, 'collections');

  // Determine which collections to scan
  let collectionNames: string[];

  if (suiteFilter) {
    const suite = loadSuite(suiteFilter, config, cwd);
    collectionNames = suite.collections;
  } else if (collectionFilter) {
    collectionNames = Array.isArray(collectionFilter) ? collectionFilter : [collectionFilter];
  } else {
    collectionNames = discoverCollections(config, cwd);
  }

  const entries: TestEntry[] = [];

  for (const collectionName of collectionNames) {
    const collectionDir = join(collectionsDir, collectionName);
    if (!existsSync(collectionDir)) continue;

    const yamlFiles = readdirSync(collectionDir)
      .filter(f => f.endsWith('.yaml') && f !== '_collection.yaml');

    for (const file of yamlFiles) {
      const filePath = join(collectionDir, file);
      const relPath = join('tests', 'collections', collectionName, file);

      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(filePath, 'utf8'));
      } catch {
        // Skip unreadable files silently — lint command handles validation
        continue;
      }

      const p = parsed as Record<string, unknown>;
      const req = p['request'] as Record<string, unknown> | undefined;
      if (!req) continue;

      const rawMethod = req['method'];
      const rawPath = req['path'];
      if (typeof rawMethod !== 'string' || typeof rawPath !== 'string') continue;

      const rawTags = p['tags'];
      const tags = Array.isArray(rawTags) ? (rawTags as string[]) : [];
      const name = typeof p['name'] === 'string' ? p['name'] : file.replace(/\.yaml$/, '');

      // --- Response assertion metadata ---
      const response = p['response'] as Record<string, unknown> | undefined;
      const expectedStatus =
        response && typeof response['status'] === 'number' ? response['status'] : undefined;
      const rawShape = response?.['shape'];
      const shapeAssertions = Array.isArray(rawShape) ? (rawShape as string[]) : [];
      const snapshotEnabled = response?.['snapshot'] === true;

      // --- Script presence + assert count ---
      const preScript = p['pre'];
      const postScript = p['post'];
      const hasPreScript = typeof preScript === 'string' && preScript.trim().length > 0;
      const hasPostScript = typeof postScript === 'string' && postScript.trim().length > 0;
      const postScriptAssertCount = hasPostScript
        ? ((postScript as string).match(/assert\(/g) ?? []).length
        : 0;

      // --- Request body fields ---
      // Merge two sources: static YAML body (inline/fixture) + fields set
      // dynamically in pre-scripts via `ctx.request.body = {…}` or
      // `ctx.request.body = JSON.stringify({…})`. Most tests set the body in
      // pre-scripts, so without the pre-script scan body-field coverage is
      // falsely reported as 0%.
      const staticBodyFields = extractRequestBodyFields(req, filePath);
      const preScriptBodyFields = hasPreScript
        ? extractBodyFieldsFromScript(preScript as string)
        : [];
      const requestBodyFields = [...new Set([...staticBodyFields, ...preScriptBodyFields])];

      // --- Request params (params object + query string) ---
      // Also scan pre-scripts for query params set via
      // `ctx.request.path = '…?key=value'` to catch dynamic param coverage.
      // staticPath uses the path WITHOUT query string so the matcher can
      // correctly align tests to spec endpoints.
      const strippedPath = stripQueryString(rawPath);
      const staticParams = extractRequestParams(req, rawPath);
      const preScriptParams = hasPreScript
        ? extractParamsFromScript(preScript as string)
        : [];
      const requestParams = [...new Set([...staticParams, ...preScriptParams])];

      // --- Covers annotation (explicit endpoint+responseCode declarations) ---
      const covers = extractCovers(p);

      entries.push({
        name,
        file: relPath,
        collection: collectionName,
        staticPath: strippedPath,
        method: rawMethod.toUpperCase(),
        tags,
        expectedStatus,
        shapeAssertions,
        snapshotEnabled,
        postScriptAssertCount,
        hasPreScript,
        hasPostScript,
        requestBodyFields,
        requestParams,
        preScriptBody: hasPreScript ? (preScript as string) : undefined,
        postScriptBody: hasPostScript ? (postScript as string) : undefined,
        covers,
      });
    }
  }

  return entries;
}

/**
 * Extract top-level keys from the request body — inline object or fixture file.
 * Fixture file path is resolved relative to the test YAML's directory.
 * Failures are silently swallowed → returns [].
 */
function extractRequestBodyFields(
  req: Record<string, unknown>,
  testFilePath: string,
): string[] {
  const body = req['body'] as Record<string, unknown> | undefined;
  if (!body) return [];

  // Inline body
  const inline = body['inline'];
  if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
    return Object.keys(inline as Record<string, unknown>);
  }

  // Fixture file
  const fileRef = body['file'];
  if (typeof fileRef === 'string') {
    const fixturePath = join(dirname(testFilePath), fileRef);
    if (!existsSync(fixturePath)) return [];
    try {
      const fixtureRaw = readFileSync(fixturePath, 'utf8');
      const fixture = JSON.parse(fixtureRaw);
      if (fixture && typeof fixture === 'object' && !Array.isArray(fixture)) {
        return Object.keys(fixture as Record<string, unknown>);
      }
    } catch {
      // Invalid JSON or read error — swallow
    }
  }

  return [];
}

/**
 * Strip the query string from a path, returning only the path portion.
 * e.g. "/api/v1/tasks?status=idle&limit=2" → "/api/v1/tasks"
 */
export function stripQueryString(path: string): string {
  const qIdx = path.indexOf('?');
  return qIdx >= 0 ? path.slice(0, qIdx) : path;
}

/**
 * Extract request parameter keys from two sources, merged + deduplicated:
 *   1. request.params object keys
 *   2. Query string params parsed from request.path
 */
function extractRequestParams(
  req: Record<string, unknown>,
  path: string,
): string[] {
  const keys = new Set<string>();

  // 1. params object
  const params = req['params'];
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const key of Object.keys(params as Record<string, unknown>)) {
      keys.add(key);
    }
  }

  // 2. query string in path
  const qIdx = path.indexOf('?');
  if (qIdx >= 0) {
    const qs = path.slice(qIdx + 1);
    const parsed = new URLSearchParams(qs);
    for (const key of parsed.keys()) {
      keys.add(key);
    }
  }

  return [...keys];
}

/**
 * Extract top-level field names from a request body set dynamically in a
 * pre/post script. Recognises the common shogun patterns:
 *
 *   ctx.request.body = { firstName, lastName, email: 'x' };
 *   ctx.request.body = JSON.stringify({ firstName, lastName });
 *   ctx.request.body = JSON.stringify(buildUser(), { extra: true });
 *
 * Only object *literals* are parsed — variable references (e.g.
 * `ctx.request.body = requestBody`) cannot be resolved statically and are
 * skipped. Nested objects are not traversed; only top-level keys are returned,
 * matching the spec-extractor's top-level-field behaviour.
 */
export function extractBodyFieldsFromScript(script: string): string[] {
  const fields = new Set<string>();

  // Match `ctx.request.body = <expr>` captures. We grab everything after the
  // `=` up to the end of the statement. Because object literals may span
  // multiple lines and contain nested braces, we balance braces rather than
  // relying on a single-line regex.
  const assignRegex = /ctx\.request\.body\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = assignRegex.exec(script)) !== null) {
    const start = m.index + m[0].length;
    // Strip an optional JSON.stringify( wrapper — we want the object literal
    // that is (usually) the first argument.
    let cursor = start;
    const slice = script.slice(cursor);
    const stringifyMatch = /^JSON\.stringify\s*\(\s*/.exec(slice);
    if (stringifyMatch) {
      cursor += stringifyMatch[0].length;
    }

    const obj = tryExtractObjectLiteral(script, cursor);
    if (obj) {
      for (const key of Object.keys(obj)) {
        fields.add(key);
      }
    }
  }

  return [...fields];
}

/**
 * Given a position in `script` that should point at the start of an object
 * literal (`{`), balance braces to extract the literal and JSON.parse it.
 * Returns the parsed object or null if the position is not an object literal
 * or parsing fails. Property shorthand (`{ foo }`) and unquoted keys are
 * normalised before parsing.
 */
function tryExtractObjectLiteral(script: string, start: number): Record<string, unknown> | null {
  // Skip whitespace
  let i = start;
  while (i < script.length && /\s/.test(script[i]!)) i++;

  if (script[i] !== '{') return null;

  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  const begin = i;
  for (; i < script.length; i++) {
    const ch = script[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = script.slice(begin, i + 1);
        return parseLooseObjectLiteral(raw);
      }
    }
  }
  return null;
}

/**
 * Parse a JS object literal into a plain object, tolerating:
 *   - unquoted keys: `{ foo: 1 }`
 *   - shorthand props: `{ foo }`  →  `{ foo: foo }`
 *   - trailing commas
 *   - template literals / single-quoted strings (converted to double-quoted)
 *
 * Only top-level keys are needed; values are not evaluated, so function calls
 * or template expressions in values are replaced with null. This is a
 * best-effort static extractor — correctness of values is irrelevant for
 * coverage field-name detection.
 */
function parseLooseObjectLiteral(raw: string): Record<string, unknown> | null {
  // Convert single-quoted strings to double-quoted
  let s = raw.replace(/'([^']*)'/g, (_m, p1: string) => `"${p1}"`);

  // Normalise shorthand properties: `{ foo,` or `{ foo }` or `{ foo\n` → `{ "foo": foo,`
  // A shorthand key is a bare identifier (not preceded by `:`) followed by `,` or `}`.
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*[,}])/g,
    (_m, pre: string, key: string, post: string) => `${pre}"${key}": null${post}`);

  // Quote unquoted keys: `{ foo: 1 }` → `{ "foo": 1 }`
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m, pre: string, key: string) => `${pre}"${key}":`);

  // Replace template literals with a placeholder string
  s = s.replace(/`[^`]*`/g, '"placeholder"');

  // Replace any remaining function-call or complex value between `:` and `,`/`}`
  // with null so JSON.parse succeeds. We do this conservatively: only swap
  // values that contain characters JSON forbids at the top level of a value
  // (i.e. an identifier that isn't true/false/null, or a parenthesised call).
  s = s.replace(/:\s*([A-Za-z_$][\w$]*\s*\([^)]*\))/g, ': null');
  s = s.replace(/:\s*([A-Za-z_$][\w$.]*(?!\s*:))/g, (match, p1: string) => {
    if (p1 === 'true' || p1 === 'false' || p1 === 'null') return match;
    return ': null';
  });

  // Remove trailing commas
  s = s.replace(/,(\s*[}\]])/g, '$1');

  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Best-effort — if it doesn't parse, we get no fields from this literal.
  }
  return null;
}

/**
 * Extract query-parameter names set dynamically in a script via
 * `ctx.request.path = '…?key=value&key2=…'`. Path params (`{name}`) are
 * ignored — they are handled by the matcher via the static path. Returns
 * deduplicated query-param keys.
 */
export function extractParamsFromScript(script: string): string[] {
  const keys = new Set<string>();
  const pathAssignRegex = /ctx\.request\.path\s*=\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = pathAssignRegex.exec(script)) !== null) {
    const pathStr = m[1]!;
    const qIdx = pathStr.indexOf('?');
    if (qIdx < 0) continue;
    const qs = pathStr.slice(qIdx + 1);
    const parsed = new URLSearchParams(qs);
    for (const key of parsed.keys()) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Extract explicit `covers` annotations from test YAML.
 *
 * Supports two formats:
 *   covers:
 *     - endpoint: POST /api/auth/login
 *       responseCode: 405
 *     - endpoint: PUT /api/admin/config/max-users
 *
 *   covers:
 *     - "POST /api/auth/login:405"
 *     - "PUT /api/admin/config/max-users"
 */
export function extractCovers(parsed: Record<string, unknown>): CoverAnnotation[] | undefined {
  const raw = parsed['covers'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const annotations: CoverAnnotation[] = [];

  for (const item of raw) {
    // Object form: { endpoint: "POST /api/auth/login", responseCode: 405 }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const endpoint = obj['endpoint'];
      const responseCode = obj['responseCode'];
      if (typeof endpoint === 'string') {
        annotations.push({
          endpoint,
          responseCode: typeof responseCode === 'number' ? responseCode : undefined,
        });
      }
    }
    // String form: "POST /api/auth/login:405" or "POST /api/auth/login"
    else if (typeof item === 'string') {
      const parsed = parseCoverString(item);
      if (parsed) annotations.push(parsed);
    }
  }

  return annotations.length > 0 ? annotations : undefined;
}

/**
 * Parse a cover annotation string like "POST /api/auth/login:405".
 * Returns null if the string doesn't match the expected format.
 */
function parseCoverString(s: string): CoverAnnotation | null {
  // Match: "METHOD /path" optionally followed by ":code"
  // The path may contain colons (e.g. /api/v1/users), so we match from the end.
  const match = s.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+?)(?::(\d+))?$/i);
  if (!match) return null;

  const method = match[1]!.toUpperCase();
  const path = match[2]!;
  const code = match[3] ? Number(match[3]) : undefined;

  return {
    endpoint: `${method} ${path}`,
    responseCode: code,
  };
}
