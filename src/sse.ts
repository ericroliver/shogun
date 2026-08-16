/**
 * src/sse.ts
 * Server-Sent Events (SSE) parsing utility.
 *
 * When an HTTP response has `Content-Type: text/event-stream`, shogun
 * auto-parses the SSE event stream so that tests can work with structured
 * data instead of raw `event: ...\ndata: ...` text.
 *
 * Parsing rules (per the SSE spec):
 *  - Events are separated by a blank line (double newline `\n\n`).
 *  - Lines starting with `event:` set the event type (default: `message`).
 *  - Lines starting with `data:` carry the payload (leading space stripped).
 *  - Multiple `data:` lines within one event are joined with `\n`.
 *  - Lines starting with `:` are comments (ignored).
 *  - `id:` and `retry:` lines are ignored (not relevant for test assertions).
 *
 * After parsing:
 *  - `events` is an array of `{ event: string, data: unknown }`.
 *  - For single-event responses (the common MCP case), `body` is the parsed
 *    data from that one event.
 *  - For multi-event responses, `body` is the data from the last event
 *    (useful for streaming endpoints where the final event carries the result).
 *  - If no events are found, `body` falls back to the original raw text.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** SSE event type (from `event:` line, default: "message") */
  event: string;
  /** Parsed data from `data:` line(s). JSON-parsed if possible, else string. */
  data: unknown;
}

export interface SseParseResult {
  /** All parsed SSE events from the stream. */
  events: SseEvent[];
  /** Single value for ctx.response.body — see module doc for rules. */
  body: unknown;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an SSE response body into structured events.
 *
 * @param raw - The raw response body text (Content-Type: text/event-stream)
 * @returns Parsed events array + body value
 */
export function parseSseResponse(raw: string): SseParseResult {
  const events: SseEvent[] = [];

  // SSE events are separated by a blank line. Split on \n\n (or \r\n\r\n).
  const blocks = raw.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    let eventType = 'message'; // default per SSE spec
    const dataLines: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) {
        // Comment line — ignore
        continue;
      }
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // Per spec, a single leading space after "data:" is stripped
        const dataContent = line.slice(5);
        dataLines.push(dataContent.startsWith(' ') ? dataContent.slice(1) : dataContent);
      }
      // id:, retry:, and unknown fields are ignored
    }

    if (dataLines.length === 0) continue;

    const dataStr = dataLines.join('\n');

    // Try JSON parsing — the data: line is almost always JSON in practice
    let data: unknown = dataStr;
    try {
      data = JSON.parse(dataStr);
    } catch {
      // Keep as string if not valid JSON
    }

    events.push({ event: eventType, data });
  }

  // Determine body value:
  //  - Single event → the event's parsed data (the common MCP case)
  //  - Multiple events → last event's data
  //  - No events → fall back to raw text
  let body: unknown;
  if (events.length === 1) {
    body = events[0].data;
  } else if (events.length > 1) {
    body = events[events.length - 1].data;
  } else {
    body = raw;
  }

  return { events, body };
}

/**
 * Check if a response Content-Type header indicates an SSE response.
 *
 * @param contentType - The Content-Type header value (case-insensitive)
 * @returns true if the content type is text/event-stream
 */
export function isSseContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('text/event-stream');
}

/**
 * Returns the JSON string to use for shape/snapshot assertions.
 *
 * For SSE responses, the assertion should run against the parsed body
 * (JSON from the `data:` line), not the raw SSE text.
 *
 * For non-SSE responses, the assertion runs against the raw response text
 * (which is already valid JSON for JSON APIs).
 *
 * @param response - The ShogunResponse (or similar) with raw, body, events
 * @returns JSON string for jq/PowerShell/normalization
 */
export function getAssertionBody(response: {
  raw: string;
  body: unknown;
  events?: SseEvent[];
}): string {
  if (response.events && response.events.length > 0) {
    // SSE response — use JSON string of parsed body
    return typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  }
  return response.raw;
}
