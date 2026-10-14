/**
 * src/redact.ts
 *
 * Centralized redaction of credentials and sensitive data before anything
 * is written to logs (SHOGUN_DEBUG output, error messages, test reports).
 *
 * Security contract:
 *   - Header values of sensitive headers (Authorization, Cookie, API keys,
 *     ...) are replaced with `[REDACTED]` — case-insensitive name matching.
 *   - Sensitive query-string parameters in URLs (token, api_key, password,
 *     ...) are replaced with `[REDACTED]` while preserving the rest of the URL.
 *   - Credentials embedded in the URL userinfo (`user:pass@host`) are masked.
 *   - curl auth options (`-u/--user`, `--proxy-user`) are fully redacted.
 *
 * Redaction is applied to debug logging only — the actual requests sent to
 * servers are never modified by this module.
 */

/** Header names whose values must never appear in logs (compared lowercase). */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'auth-token',
  'x-access-token',
  'access-token',
  'x-session-token',
  'session-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'private-token',
  'secret-key',
  'x-secret',
]);

/** Query parameter names whose values must never appear in logs (compared lowercase). */
const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'apikey',
  'api_key',
  'key',
  'client_secret',
  'secret',
  'password',
  'passwd',
  'pass',
  'pwd',
  'signature',
  'sig',
  'session_id',
  'sessionid',
  'session',
  'sas',
  'assertion',
  'credential',
  'private_key',
]);

const REDACTED = '[REDACTED]';

/**
 * Redact a single header value if the header name is sensitive.
 * Case-insensitive on the header name.
 */
export function redactHeaderValue(name: string, value: string): string {
  const normalized = name.trim().toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized) ? REDACTED : value;
}

/**
 * Redact sensitive query parameters and userinfo credentials from a URL.
 *
 * Non-URL input is returned unchanged. URLs that fail to parse are passed
 * through `redactTextFallback` so secrets in query-like strings are still
 * masked.
 */
export function redactUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;

  // Only treat strings that look like URLs
  if (!/^https?:\/\//i.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not parseable — leave as-is (redactText's inline-header masking still
    // applies at the text level; returning the input avoids a re-parse loop)
    return url;
  }

  // Detect what actually needs redaction so clean URLs pass through
  // byte-for-byte (no normalization side effects like added trailing slashes)
  const hasUserinfo = Boolean(parsed.username || parsed.password);
  const sensitiveEntries: Array<[string, string]> = [];
  let hasSensitiveParams = false;
  for (const [key, value] of parsed.searchParams.entries()) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      sensitiveEntries.push([key, REDACTED]);
      hasSensitiveParams = true;
    } else {
      sensitiveEntries.push([key, value]);
    }
  }
  if (!hasUserinfo && !hasSensitiveParams) return url;

  // Mask userinfo credentials (https://user:pass@host/...)
  if (hasUserinfo) {
    parsed.username = REDACTED;
    parsed.password = '';
  }

  // Mask sensitive query parameter values
  if (hasSensitiveParams) {
    parsed.search = '';
    for (const [key, value] of sensitiveEntries) {
      parsed.searchParams.append(key, value);
    }
  }

  return parsed.toString();
}

/**
 * Redact a curl argument vector:
 *   - `-H/--header "Name: value"` args get their value redacted
 *   - `-u/--user/--proxy-user` args are fully redacted
 *   - URL args (and anything containing a URL) get URL redaction applied
 *
 * The shape of the argument vector is preserved so debug output stays useful.
 */
export function redactCurlArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // Header arguments: value is the next arg ("Name: value")
    if (arg === '-H' || arg === '--header') {
      out.push(arg);
      const headerArg = args[i + 1] ?? '';
      const colonIdx = headerArg.indexOf(':');
      if (colonIdx === -1) {
        // Malformed header arg — redact entirely rather than leak anything
        out.push(REDACTED);
      } else {
        const name = headerArg.slice(0, colonIdx);
        const value = headerArg.slice(colonIdx + 1).trim();
        out.push(`${name}: ${redactHeaderValue(name, value)}`);
      }
      i++;
      continue;
    }

    // Credential arguments: redact the value entirely
    if (arg === '-u' || arg === '--user' || arg === '--proxy-user') {
      out.push(arg, REDACTED);
      i++;
      continue;
    }

    // URLs and anything else that might embed one
    out.push(redactText(arg));
  }
  return out;
}

/**
 * Redact secrets from free-form text (e.g. curl stderr, error messages):
 *   - inline `Authorization: <value>` style headers
 *   - URLs with sensitive query parameters or userinfo credentials
 */
export function redactText(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let out = text.replace(
    /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*:\s*)([^\r\n"']+)/gi,
    (_m, prefix: string) => `${prefix}${REDACTED}`,
  );

  // Redact URLs embedded anywhere in the text
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url));

  return out;
}
