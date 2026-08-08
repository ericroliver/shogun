/**
 * src/tests/coverage-mcp.test.ts
 *
 * Unit tests for MCP / JSON-RPC coverage extraction and analysis (Phases 1–3).
 *
 * Covers:
 *   - extractMcpMetadata from inline body, fixture file, and pre-scripts
 *   - JSON-RPC method extraction (tools/call, initialize, tools/list)
 *   - MCP tool name extraction from tools/call params
 *   - buildToolCall() pattern recognition in scripts
 *   - computeMcpCoverage aggregation
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  extractMcpMetadata,
  type McpMetadata,
} from '../commands/coverage/test-collector.js';
import { computeMcpCoverage } from '../commands/coverage/analyzer.js';
import type { TestEntry } from '../commands/coverage/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMcpTest(
  method: string,
  tool: string | undefined,
  name = 'mcp-test',
  collection = 'mcp',
): TestEntry {
  return {
    name,
    file: `tests/collections/${collection}/${name}.yaml`,
    collection,
    staticPath: '/mcp',
    method: 'POST',
    tags: [],
    expectedStatus: 200,
    shapeAssertions: [],
    snapshotEnabled: false,
    postScriptAssertCount: 0,
    hasPreScript: false,
    hasPostScript: false,
    requestBodyFields: [],
    requestParams: [],
    jsonrpcMethod: method,
    mcpToolName: tool,
  };
}

// ---------------------------------------------------------------------------
// extractMcpMetadata — inline body
// ---------------------------------------------------------------------------

describe('extractMcpMetadata — inline body', () => {
  test('extracts tools/call method and tool name from inline body', () => {
    const req = {
      body: {
        inline: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'enigma_get_agent_status', arguments: { agentName: 'test-agent' } },
        },
      },
    };
    const result = extractMcpMetadata(req, '/fake/path.yaml');
    assert.equal(result.method, 'tools/call');
    assert.equal(result.tool, 'enigma_get_agent_status');
  });

  test('extracts initialize method (no tool name)', () => {
    const req = {
      body: {
        inline: {
          jsonrpc: '2.0',
          method: 'initialize',
          params: {},
        },
      },
    };
    const result = extractMcpMetadata(req, '/fake/path.yaml');
    assert.equal(result.method, 'initialize');
    assert.equal(result.tool, undefined);
  });

  test('extracts tools/list method (no tool name)', () => {
    const req = {
      body: {
        inline: {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
        },
      },
    };
    const result = extractMcpMetadata(req, '/fake/path.yaml');
    assert.equal(result.method, 'tools/list');
    assert.equal(result.tool, undefined);
  });

  test('returns empty for non-JSON-RPC inline body', () => {
    const req = {
      body: {
        inline: { name: 'test-agent', status: 'Ready' },
      },
    };
    const result = extractMcpMetadata(req, '/fake/path.yaml');
    assert.equal(result.method, undefined);
    assert.equal(result.tool, undefined);
  });

  test('handles tools/call with missing params.name', () => {
    const req = {
      body: {
        inline: {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {},
        },
      },
    };
    const result = extractMcpMetadata(req, '/fake/path.yaml');
    assert.equal(result.method, 'tools/call');
    assert.equal(result.tool, undefined);
  });
});

// ---------------------------------------------------------------------------
// extractMcpMetadata — fixture file
// ---------------------------------------------------------------------------

describe('extractMcpMetadata — fixture file', () => {
  let tmpDir: string;

  test.before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shogun-mcp-test-'));
  });

  test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('extracts JSON-RPC from fixture file', () => {
    const fixturePath = join(tmpDir, 'tool-call.json');
    writeFileSync(fixturePath, JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'enigma_discover_agents', arguments: { includeSkills: true } },
    }));

    const req = { body: { file: 'tool-call.json' } };
    const result = extractMcpMetadata(req, join(tmpDir, 'test.yaml'));
    assert.equal(result.method, 'tools/call');
    assert.equal(result.tool, 'enigma_discover_agents');
  });

  test('returns empty for non-JSON-RPC fixture', () => {
    const fixturePath = join(tmpDir, 'regular.json');
    writeFileSync(fixturePath, JSON.stringify({ name: 'test', value: 42 }));

    const req = { body: { file: 'regular.json' } };
    const result = extractMcpMetadata(req, join(tmpDir, 'test.yaml'));
    assert.equal(result.method, undefined);
    assert.equal(result.tool, undefined);
  });

  test('returns empty for missing fixture file', () => {
    const req = { body: { file: 'nonexistent.json' } };
    const result = extractMcpMetadata(req, join(tmpDir, 'test.yaml'));
    assert.equal(result.method, undefined);
    assert.equal(result.tool, undefined);
  });
});

// ---------------------------------------------------------------------------
// extractMcpMetadata — pre-script
// ---------------------------------------------------------------------------

describe('extractMcpMetadata — pre-script', () => {
  test('extracts from JSON.stringify({jsonrpc, method, params}) pattern', () => {
    const script = `
      ctx.request.body = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "enigma_send_message", arguments: { targetAgent: "test-agent", message: "hello" } }
      });
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, 'tools/call');
    assert.equal(result.tool, 'enigma_send_message');
  });

  test('extracts from direct object assignment (no JSON.stringify)', () => {
    const script = `
      ctx.request.body = {
        jsonrpc: "2.0",
        method: "initialize",
        params: {}
      };
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, 'initialize');
    assert.equal(result.tool, undefined);
  });

  test('extracts from buildToolCall("tool_name", args) pattern', () => {
    const script = `
      ctx.request.body = JSON.stringify(buildToolCall("enigma_get_agent_status", { agentName: "test-agent" }));
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, 'tools/call');
    assert.equal(result.tool, 'enigma_get_agent_status');
  });

  test('extracts from variable assignment then JSON.stringify', () => {
    const script = `
      const rpcBody = {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {}
      };
      ctx.request.body = JSON.stringify(rpcBody);
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, 'tools/list');
    assert.equal(result.tool, undefined);
  });

  test('returns empty for non-JSON-RPC pre-script', () => {
    const script = `
      ctx.request.body = JSON.stringify({ name: "test-agent", status: "Ready" });
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, undefined);
    assert.equal(result.tool, undefined);
  });

  test('returns empty for script with no body assignment', () => {
    const script = `
      // just a comment
      const x = 42;
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, undefined);
    assert.equal(result.tool, undefined);
  });

  test('returns empty when no pre-script provided', () => {
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml');
    assert.equal(result.method, undefined);
    assert.equal(result.tool, undefined);
  });

  test('extracts from multiline object literal', () => {
    const script = `
      ctx.request.body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "enigma_discover_agents",
          arguments: {
            includeSkills: true
          }
        }
      });
    `;
    const result = extractMcpMetadata({ method: 'POST', path: '/mcp' }, '/fake/path.yaml', script);
    assert.equal(result.method, 'tools/call');
    assert.equal(result.tool, 'enigma_discover_agents');
  });
});

// ---------------------------------------------------------------------------
// computeMcpCoverage
// ---------------------------------------------------------------------------

describe('computeMcpCoverage', () => {
  test('returns null when no MCP tests exist', () => {
    const tests: TestEntry[] = [
      {
        name: 'rest-test',
        file: 'tests/collections/rest/test1.yaml',
        collection: 'rest',
        staticPath: '/api/users',
        method: 'GET',
        tags: [],
        expectedStatus: 200,
        shapeAssertions: [],
        snapshotEnabled: false,
        postScriptAssertCount: 0,
        hasPreScript: false,
        hasPostScript: false,
        requestBodyFields: [],
        requestParams: [],
      },
    ];
    const result = computeMcpCoverage(tests);
    assert.equal(result, null);
  });

  test('aggregates JSON-RPC methods correctly', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'enigma_get_agent_status', 'test1'),
      makeMcpTest('tools/call', 'enigma_discover_agents', 'test2'),
      makeMcpTest('tools/list', undefined, 'test3'),
      makeMcpTest('initialize', undefined, 'test4'),
    ];
    const result = computeMcpCoverage(tests)!;
    assert.equal(result.totalMcpTests, 4);
    assert.equal(result.methods.length, 3);

    const toolsCall = result.methods.find(m => m.method === 'tools/call');
    assert.ok(toolsCall);
    assert.equal(toolsCall!.testCount, 2);

    const toolsList = result.methods.find(m => m.method === 'tools/list');
    assert.ok(toolsList);
    assert.equal(toolsList!.testCount, 1);

    const initialize = result.methods.find(m => m.method === 'initialize');
    assert.ok(initialize);
    assert.equal(initialize!.testCount, 1);
  });

  test('aggregates MCP tools correctly', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'enigma_get_agent_status', 'test1'),
      makeMcpTest('tools/call', 'enigma_get_agent_status', 'test2'),
      makeMcpTest('tools/call', 'enigma_discover_agents', 'test3'),
      makeMcpTest('tools/call', 'enigma_send_message', 'test4'),
    ];
    const result = computeMcpCoverage(tests)!;
    assert.equal(result.tools.length, 3);

    const getStatus = result.tools.find(t => t.tool === 'enigma_get_agent_status');
    assert.ok(getStatus);
    assert.equal(getStatus!.testCount, 2);

    const discover = result.tools.find(t => t.tool === 'enigma_discover_agents');
    assert.ok(discover);
    assert.equal(discover!.testCount, 1);

    const sendMessage = result.tools.find(t => t.tool === 'enigma_send_message');
    assert.ok(sendMessage);
    assert.equal(sendMessage!.testCount, 1);
  });

  test('counts unnamed tools/call tests', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'enigma_get_agent_status', 'test1'),
      makeMcpTest('tools/call', undefined, 'test2'),
      makeMcpTest('tools/call', undefined, 'test3'),
    ];
    const result = computeMcpCoverage(tests)!;
    assert.equal(result.unnamedToolCallCount, 2);
    assert.equal(result.tools.length, 1);
  });

  test('sorts methods by test count descending', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'tool_a', 'test1'),
      makeMcpTest('tools/call', 'tool_a', 'test2'),
      makeMcpTest('tools/call', 'tool_a', 'test3'),
      makeMcpTest('initialize', undefined, 'test4'),
      makeMcpTest('tools/list', undefined, 'test5'),
      makeMcpTest('tools/list', undefined, 'test6'),
    ];
    const result = computeMcpCoverage(tests)!;
    assert.equal(result.methods[0]!.method, 'tools/call');
    assert.equal(result.methods[0]!.testCount, 3);
    assert.equal(result.methods[1]!.method, 'tools/list');
    assert.equal(result.methods[1]!.testCount, 2);
    assert.equal(result.methods[2]!.method, 'initialize');
    assert.equal(result.methods[2]!.testCount, 1);
  });

  test('excludes non-tools/call methods from tool list', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/list', undefined, 'test1'),
      makeMcpTest('initialize', undefined, 'test2'),
    ];
    const result = computeMcpCoverage(tests)!;
    assert.equal(result.tools.length, 0);
    assert.equal(result.unnamedToolCallCount, 0);
  });

  test('handles mixed MCP and non-MCP tests', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'enigma_get_agent_status', 'mcp1'),
      {
        name: 'rest-test',
        file: 'tests/collections/rest/get-users.yaml',
        collection: 'rest',
        staticPath: '/api/users',
        method: 'GET',
        tags: [],
        expectedStatus: 200,
        shapeAssertions: [],
        snapshotEnabled: false,
        postScriptAssertCount: 0,
        hasPreScript: false,
        hasPostScript: false,
        requestBodyFields: [],
        requestParams: [],
        // no jsonrpcMethod / mcpToolName
      } as TestEntry,
    ];
    const result = computeMcpCoverage(tests)!;
    assert.equal(result.totalMcpTests, 1);
    assert.equal(result.methods.length, 1);
    assert.equal(result.tools.length, 1);
  });

  test('includes test details in method coverage', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'enigma_get_agent_status', 'get-status-test', 'mcp'),
    ];
    const result = computeMcpCoverage(tests)!;
    const method = result.methods[0]!;
    assert.equal(method.tests.length, 1);
    assert.equal(method.tests[0]!.name, 'get-status-test');
    assert.equal(method.tests[0]!.collection, 'mcp');
  });

  test('includes test details in tool coverage', () => {
    const tests: TestEntry[] = [
      makeMcpTest('tools/call', 'enigma_discover_agents', 'discover-1', 'mcp'),
      makeMcpTest('tools/call', 'enigma_discover_agents', 'discover-2', 'mcp'),
    ];
    const result = computeMcpCoverage(tests)!;
    const tool = result.tools[0]!;
    assert.equal(tool.tests.length, 2);
    assert.equal(tool.tests[0]!.name, 'discover-1');
    assert.equal(tool.tests[1]!.name, 'discover-2');
  });
});