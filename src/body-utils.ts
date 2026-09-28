/**
 * src/body-utils.ts
 * Shared body resolution and encoding utilities for HTTP request bodies.
 *
 * Used by both the Unix (curl) and PowerShell backends to ensure consistent
 * handling of the RequestBody wrapper and form-urlencoded encoding.
 */

import { readFileSync } from 'node:fs';

/**
 * Resolve the RequestBody wrapper ({ inline: ... } or { file: ... }) to the
 * actual body value.
 *
 * - If body is `{ inline: <value> }`, returns `<value>`.
 * - If body is `{ file: "path" }`, reads and returns the file contents.
 * - If body is a direct object (e.g. from a pre-script mutation), returns as-is.
 * - If body is a string, returns as-is.
 * - If body has `form_fields`/`form_files` (multipart), returns as-is —
 *   those are handled by the multipart path in each backend.
 */
export function resolveRequestBody(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const rb = body as { inline?: unknown; file?: string; form_fields?: unknown; form_files?: unknown };
    if (rb.inline !== undefined) {
      return rb.inline;
    }
    if (rb.file !== undefined) {
      try {
        return readFileSync(rb.file, 'utf8');
      } catch {
        return '';
      }
    }
    // form_fields/form_files are handled by the multipart path in each backend
  }
  return body;
}

/**
 * Check if a Content-Type string indicates form-urlencoded encoding.
 */
export function isFormEncodedContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('application/x-www-form-urlencoded');
}

/**
 * Build a URL-encoded form body string from an object, skipping null/undefined values.
 *
 * Fields with null or undefined values are OMITTED from the output. This is
 * intentional: form-encoded POST bodies can only send strings. There is no
 * way to represent a true "null" — including "field=null" sends the literal
 * string "null", not a SQL NULL. Omitting the field lets the server's model
 * binder use the property's default value (which for nullable types is null).
 *
 * If you need to send a true NULL value to the server, use JSON content type
 * instead (application/json), which properly serializes null.
 */
export function buildFormEncodedBody(body: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.join('&');
}
