/**
 * src/tests/sse-pure.test.ts
 *
 * Unit tests for SSE parsing functions in src/sse.ts:
 *   parseSseResponse, isSseContentType, getAssertionBody
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSseResponse,
  isSseContentType,
  getAssertionBody,
} from '../sse.js';

// ===========================================================================
// parseSseResponse
// ===========================================================================

describe('parseSseResponse()', () => {
  test('parses a single-event SSE response (MCP-style)', () => {
    const raw = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].event, 'message');
    assert.deepEqual(result.events[0].data, {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'hello' }] },
    });
    // For single-event, body is the parsed data
    assert.deepEqual(result.body, result.events[0].data);
  });

  test('parses a single-event SSE response with no event: line (defaults to message)', () => {
    const raw = 'data: {"status":"ok"}\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].event, 'message');
    assert.deepEqual(result.events[0].data, { status: 'ok' });
    assert.deepEqual(result.body, { status: 'ok' });
  });

  test('parses multi-event SSE response', () => {
    const raw = [
      'event: ping\ndata: {"seq":1}',
      '',
      'event: message\ndata: {"seq":2,"final":true}',
      '',
    ].join('\n');
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].event, 'ping');
    assert.deepEqual(result.events[0].data, { seq: 1 });
    assert.equal(result.events[1].event, 'message');
    assert.deepEqual(result.events[1].data, { seq: 2, final: true });
    // For multi-event, body is the last event's data
    assert.deepEqual(result.body, { seq: 2, final: true });
  });

  test('joins multiple data: lines within one event', () => {
    const raw = 'data: line1\ndata: line2\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    // Multiple data lines are joined with \n — not valid JSON, so stays string
    assert.equal(result.events[0].data, 'line1\nline2');
    assert.equal(result.body, 'line1\nline2');
  });

  test('strips a single leading space after data:', () => {
    const raw = 'data: {"key":"value"}\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0].data, { key: 'value' });
  });

  test('ignores comment lines starting with :', () => {
    const raw = ': this is a comment\ndata: {"ok":true}\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0].data, { ok: true });
  });

  test('ignores id: and retry: lines', () => {
    const raw = 'id: 42\nretry: 5000\nevent: update\ndata: {"v":1}\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].event, 'update');
    assert.deepEqual(result.events[0].data, { v: 1 });
  });

  test('keeps non-JSON data as string', () => {
    const raw = 'data: plain text not json\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].data, 'plain text not json');
    assert.equal(result.body, 'plain text not json');
  });

  test('handles empty SSE response (no events)', () => {
    const raw = '';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 0);
    assert.equal(result.body, raw);
  });

  test('handles SSE with only blank lines', () => {
    const raw = '\n\n\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 0);
  });

  test('handles \r\n line endings', () => {
    const raw = 'event: message\r\ndata: {"ok":true}\r\n\r\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0].data, { ok: true });
  });

  test('handles event with no data: line (skipped)', () => {
    const raw = 'event: ping\n\n';
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 0);
  });

  test('handles multiple events with blank line separation', () => {
    const raw = [
      'data: {"n":1}',
      '',
      'data: {"n":2}',
      '',
      'data: {"n":3}',
      '',
    ].join('\n');
    const result = parseSseResponse(raw);

    assert.equal(result.events.length, 3);
    assert.deepEqual(result.body, { n: 3 }); // last event's data
  });
});

// ===========================================================================
// isSseContentType
// ===========================================================================

describe('isSseContentType()', () => {
  test('returns true for text/event-stream', () => {
    assert.equal(isSseContentType('text/event-stream'), true);
  });

  test('returns true for text/event-stream with charset', () => {
    assert.equal(isSseContentType('text/event-stream; charset=utf-8'), true);
  });

  test('returns true for uppercase Content-Type', () => {
    assert.equal(isSseContentType('Text/Event-Stream'), true);
  });

  test('returns false for application/json', () => {
    assert.equal(isSseContentType('application/json'), false);
  });

  test('returns false for text/plain', () => {
    assert.equal(isSseContentType('text/plain'), false);
  });

  test('returns false for empty string', () => {
    assert.equal(isSseContentType(''), false);
  });
});

// ===========================================================================
// getAssertionBody
// ===========================================================================

describe('getAssertionBody()', () => {
  test('returns raw for non-SSE response (no events)', () => {
    const response = { raw: '{"foo":"bar"}', body: { foo: 'bar' } };
    assert.equal(getAssertionBody(response), '{"foo":"bar"}');
  });

  test('returns JSON string of parsed body for SSE response', () => {
    const response = {
      raw: 'event: message\ndata: {"foo":"bar"}\n\n',
      body: { foo: 'bar' },
      events: [{ event: 'message', data: { foo: 'bar' } }],
    };
    assert.equal(getAssertionBody(response), '{"foo":"bar"}');
  });

  test('returns body as-is if body is already a string for SSE response', () => {
    const response = {
      raw: 'event: message\ndata: plain text\n\n',
      body: 'plain text',
      events: [{ event: 'message', data: 'plain text' }],
    };
    assert.equal(getAssertionBody(response), 'plain text');
  });

  test('returns raw when events is undefined', () => {
    const response = { raw: '{"a":1}', body: { a: 1 } };
    assert.equal(getAssertionBody(response), '{"a":1}');
  });

  test('returns raw when events is empty array', () => {
    const response = { raw: '{"a":1}', body: { a: 1 }, events: [] };
    assert.equal(getAssertionBody(response), '{"a":1}');
  });
});
