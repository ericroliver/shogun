/**
 * src/tests/agent-commands.test.ts
 * Tests for Story 7: Command Integration
 *
 * Verifies that existing commands (snapshot, coverage, lint, ls) correctly
 * handle the agent test type.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import { setActiveBackend, getActiveBackend } from '../backend-global.js';
import type { BackendExecutor, ExecutorOptions } from '../backend-interface.js';
import type { ShogunRequest, ShogunResponse, EnvVars } from '../types.js';

// ---------------------------------------------------------------------------
// Mock backend (for snapshot tests that call runTests)
// ---------------------------------------------------------------------------

let savedBackend: BackendExecutor | null = null;

const mockBackend: BackendExecutor = {
  name: 'unix',
  async executeRequest(_req: ShogunRequest, _env: EnvVars, _opts?: ExecutorOptions): Promise<ShogunResponse> {
    // Return a minimal HTTP response (won't actually be used for agent tests in snapshot mode)
    return {
      status: 200,
      body: {},
      raw: '{}',
      curlMs: 0,
      duration: 0,
      headers: {},
    };
  },
  async runJsonQuery() { return { passed: true }; },
  async runShapeAssertions() { return []; },
  async normalizeJson(json: string) { return json; },
  async runDiff() { return ''; },
  async checkDependencies() { return []; },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'shogun-cmd-'));
  mkdirSync(join(cwd, 'tests', 'collections'), { recursive: true });
  mkdirSync(join(cwd, 'envs'), { recursive: true });
  mkdirSync(join(cwd, 'runs'), { recursive: true });

  writeFileSync(join(cwd, 'envs', 'local.env'), 'BASE_URL=http://localhost:8080\n');

  writeFileSync(join(cwd, 'shogun.config.yaml'), yaml.dump({
    version: 1,
    defaults: { timeout: 10 },
    evaluation: {
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'llama3',
    },
  }));

  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function makeCollectionDir(cwd: string, name: string): string {
  const dir = join(cwd, 'tests', 'collections', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTest(dir: string, filename: string, data: Record<string, unknown>): string {
  const path = join(dir, filename);
  writeFileSync(path, yaml.dump(data));
  return path;
}

// ---------------------------------------------------------------------------
// 7.1 — Snapshot: skip agent tests
// ---------------------------------------------------------------------------

describe('snapshot — agent tests are skipped', () => {
  let origCwd: string;

  before(() => {
    origCwd = process.cwd();
    try {
      savedBackend = getActiveBackend();
    } catch {
      savedBackend = null;
    }
    setActiveBackend(mockBackend);
  });

  after(() => {
    process.chdir(origCwd);
    if (savedBackend) {
      setActiveBackend(savedBackend);
    }
  });

  it('runSingleTest returns passed status with skip message in snapshot mode', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'agents');
    writeTest(colDir, 'explain-code.yaml', {
      name: 'explain code',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Explain this code',
      },
      evaluate: {
        criteria: ['is accurate'],
        min_pass: 80,
      },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'agents' }));

    try {
      const { runTests } = await import('../runner.js');
      const summary = await runTests({
        env: 'local',
        collection: 'agents',
        snapshotMode: true,
        cwd,
      });

      const agentResult = summary.results.find(r => r.name === 'explain code');
      assert.ok(agentResult, 'agent test result should exist');
      assert.equal(agentResult!.status, 'passed', 'agent test should be passed (skipped)');
      assert.ok(
        agentResult!.scriptOutput?.some(s => s.includes('Skipped: agent tests do not support snapshot mode')),
        'should have skip message in scriptOutput',
      );
    } finally {
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('HTTP tests are still snapshotted normally in the same run', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'mixed');
    writeTest(colDir, 'health.yaml', {
      name: 'health check',
      request: { method: 'GET', path: '/health' },
      response: { status: 200, snapshot: true },
    });
    writeTest(colDir, 'agent-test.yaml', {
      name: 'agent test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      evaluate: { criteria: ['responds'], min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'mixed' }));

    // Suppress stdout/stderr to avoid Node.js test runner serialization issues
    const origWrite = process.stdout.write.bind(process.stdout);
    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = () => true;
    process.stderr.write = () => true;

    try {
      const { runTests } = await import('../runner.js');
      const summary = await runTests({
        env: 'local',
        collection: 'mixed',
        snapshotMode: true,
        cwd,
      });

      const httpResult = summary.results.find(r => r.name === 'health check');
      const agentResult = summary.results.find(r => r.name === 'agent test');

      // HTTP test should execute (not be skipped)
      assert.ok(httpResult, 'HTTP test result should exist');
      assert.ok(
        !httpResult!.scriptOutput?.some(s => s.includes('Skipped')),
        'HTTP test should not be skipped',
      );

      // Agent test should be skipped
      assert.ok(agentResult, 'agent test result should exist');
      assert.equal(agentResult!.status, 'passed');
      assert.ok(
        agentResult!.scriptOutput?.some(s => s.includes('Skipped: agent tests')),
      );
    } finally {
      process.stdout.write = origWrite;
      process.stderr.write = origErrWrite;
      process.chdir(origCwd);
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 7.2 — Coverage: ignore agent tests
// ---------------------------------------------------------------------------

describe('coverage — agent tests are not collected', () => {
  it('collectTestEntries skips agent tests', async () => {
    const { cwd, cleanup } = makeTmpProject();

    const colDir = makeCollectionDir(cwd, 'api');
    writeTest(colDir, 'get-users.yaml', {
      name: 'get users',
      request: { method: 'GET', path: '/api/users' },
      response: { status: 200 },
    });
    writeTest(colDir, 'agent-explain.yaml', {
      name: 'agent explain',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Explain users API',
      },
      evaluate: { criteria: ['accurate'], min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'api' }));

    try {
      const { collectTestEntries } = await import('../commands/coverage/test-collector.js');
      const { loadConfig } = await import('../loader.js');
      const config = loadConfig(cwd);

      const entries = await collectTestEntries(config, cwd);

      // Only the HTTP test should be collected
      assert.equal(entries.length, 1, 'only HTTP test should be collected');
      assert.equal(entries[0]!.name, 'get users');
      assert.notEqual(entries[0]!.name, 'agent explain');
    } finally {
      cleanup();
    }
  });

  it('agent tests without request field are naturally skipped', async () => {
    const { cwd, cleanup } = makeTmpProject();

    const colDir = makeCollectionDir(cwd, 'agents-only');
    writeTest(colDir, 'agent-1.yaml', {
      name: 'agent 1',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      evaluate: { criteria: ['responds'], min_pass: 80 },
    });
    writeTest(colDir, 'agent-2.yaml', {
      name: 'agent 2',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'World',
      },
      evaluate: { criteria: ['responds'], min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'agents-only' }));

    try {
      const { collectTestEntries } = await import('../commands/coverage/test-collector.js');
      const { loadConfig } = await import('../loader.js');
      const config = loadConfig(cwd);

      const entries = await collectTestEntries(config, cwd);
      assert.equal(entries.length, 0, 'no entries should be collected for agent-only collection');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 7.3 — Lint: agent test warnings
// ---------------------------------------------------------------------------

describe('lint — agent test warnings', () => {
  let origCwd: string;

  before(() => {
    origCwd = process.cwd();
  });

  after(() => {
    process.chdir(origCwd);
  });

  it('warns on missing evaluate.criteria', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'agents');
    writeTest(colDir, 'no-criteria.yaml', {
      name: 'no criteria test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      expected: { description: 'The agent should respond' },
      evaluate: { min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'agents' }));

    let output = '';
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (msg: string) => { output += msg + '\n'; };
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const { lint } = await import('../commands/lint.js');
      await lint({});
      assert.ok(
        output.includes('no evaluate.criteria'),
        'should warn about missing criteria',
      );
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('warns on very low min_pass (< 50)', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'agents');
    writeTest(colDir, 'low-threshold.yaml', {
      name: 'low threshold test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      evaluate: {
        criteria: ['responds'],
        min_pass: 30,
      },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'agents' }));

    let output = '';
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (msg: string) => { output += msg + '\n'; };
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const { lint } = await import('../commands/lint.js');
      await lint({});
      assert.ok(
        output.includes('min_pass 30 is very low'),
        'should warn about low min_pass',
      );
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('does not warn when criteria is present and min_pass is reasonable', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'agents');
    writeTest(colDir, 'good-test.yaml', {
      name: 'good test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      evaluate: {
        criteria: ['responds correctly'],
        min_pass: 80,
      },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'agents' }));

    let output = '';
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (msg: string) => { output += msg + '\n'; };
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const { lint } = await import('../commands/lint.js');
      await lint({});
      assert.ok(
        !output.includes('no evaluate.criteria'),
        'should not warn about missing criteria',
      );
      assert.ok(
        !output.includes('is very low'),
        'should not warn about low min_pass',
      );
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('lint returns 0 (success) even with agent warnings', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'agents');
    writeTest(colDir, 'warn-test.yaml', {
      name: 'warn test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      expected: { description: 'Agent should respond' },
      evaluate: { min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'agents' }));

    let output = '';
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (msg: string) => { output += msg + '\n'; };
    console.log = (msg: string) => { output += msg + '\n'; };

    try {
      const { lint } = await import('../commands/lint.js');
      const result = await lint({});
      assert.equal(result, 0, 'lint should return 0 (warnings are not errors)');
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 7.4 — Ls: list agent tests with type indicator
// ---------------------------------------------------------------------------

describe('ls — type indicators', () => {
  let origCwd: string;

  before(() => {
    origCwd = process.cwd();
  });

  after(() => {
    process.chdir(origCwd);
  });

  it('shows [agent] type indicator for agent tests', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'mixed');
    writeTest(colDir, 'health.yaml', {
      name: 'health check',
      request: { method: 'GET', path: '/health' },
      response: { status: 200 },
    });
    writeTest(colDir, 'agent-test.yaml', {
      name: 'agent test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      evaluate: { criteria: ['responds'], min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'mixed' }));

    let output = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { output += args.join(' ') + '\n'; };

    try {
      const { ls } = await import('../commands/ls.js');
      await ls({ target: 'tests', collection: 'mixed', format: 'pretty' });

      assert.ok(output.includes('[agent]'), 'should show [agent] type indicator');
      assert.ok(output.includes('[http]'), 'should show [http] type indicator');
      assert.ok(output.includes('agent-test'), 'should list agent test name');
      assert.ok(output.includes('health'), 'should list http test name');
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('shows [sql] type indicator for SQL tests', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'db');
    writeTest(colDir, 'proc-test.yaml', {
      name: 'proc test',
      type: 'sql',
      sql: {
        proc: 'GetUsers',
        connection: 'default',
      },
      response: { status: 200 },
    });
    writeTest(colDir, 'health.yaml', {
      name: 'health check',
      request: { method: 'GET', path: '/health' },
      response: { status: 200 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'db' }));

    let output = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { output += args.join(' ') + '\n'; };

    try {
      const { ls } = await import('../commands/ls.js');
      await ls({ target: 'tests', collection: 'db', format: 'pretty' });

      assert.ok(output.includes('[sql]'), 'should show [sql] type indicator');
      assert.ok(output.includes('[http]'), 'should show [http] type indicator');
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('defaults to [http] when type field is absent', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'api');
    writeTest(colDir, 'get-users.yaml', {
      name: 'get users',
      request: { method: 'GET', path: '/api/users' },
      response: { status: 200 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'api' }));

    let output = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { output += args.join(' ') + '\n'; };

    try {
      const { ls } = await import('../commands/ls.js');
      await ls({ target: 'tests', collection: 'api', format: 'pretty' });

      assert.ok(output.includes('[http]'), 'should default to [http] when no type field');
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('JSON output includes type field', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const colDir = makeCollectionDir(cwd, 'mixed');
    writeTest(colDir, 'health.yaml', {
      name: 'health check',
      request: { method: 'GET', path: '/health' },
      response: { status: 200 },
    });
    writeTest(colDir, 'agent-test.yaml', {
      name: 'agent test',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Hello',
      },
      evaluate: { criteria: ['responds'], min_pass: 80 },
    });

    writeFileSync(join(colDir, '_collection.yaml'), yaml.dump({ name: 'mixed' }));

    let output = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { output += args.join(' ') + '\n'; };

    try {
      const { ls } = await import('../commands/ls.js');
      await ls({ target: 'tests', collection: 'mixed', format: 'json' });

      const parsed = JSON.parse(output);
      assert.ok(parsed.tests, 'should have tests array');
      assert.equal(parsed.tests.length, 2, 'should have 2 tests');

      const agentTest = parsed.tests.find((t: { name: string }) => t.name === 'agent-test');
      assert.ok(agentTest, 'agent test should exist');
      assert.equal(agentTest.type, 'agent', 'agent test should have type=agent');

      const httpTest = parsed.tests.find((t: { name: string }) => t.name === 'health');
      assert.ok(httpTest, 'http test should exist');
      assert.equal(httpTest.type, 'http', 'http test should have type=http');
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });

  it('lists all tests with type indicators across collections', async () => {
    const { cwd, cleanup } = makeTmpProject();
    process.chdir(cwd);

    const apiDir = makeCollectionDir(cwd, 'api');
    writeTest(apiDir, 'get-users.yaml', {
      name: 'get users',
      request: { method: 'GET', path: '/api/users' },
      response: { status: 200 },
    });

    const agentDir = makeCollectionDir(cwd, 'agents');
    writeTest(agentDir, 'explain.yaml', {
      name: 'explain',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        endpoint: 'http://localhost:8080/v1/chat/completions',
        prompt: 'Explain',
      },
      evaluate: { criteria: ['accurate'], min_pass: 80 },
    });

    writeFileSync(join(apiDir, '_collection.yaml'), yaml.dump({ name: 'api' }));
    writeFileSync(join(agentDir, '_collection.yaml'), yaml.dump({ name: 'agents' }));

    let output = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => { output += args.join(' ') + '\n'; };

    try {
      const { ls } = await import('../commands/ls.js');
      await ls({ target: 'tests', format: 'pretty' });

      assert.ok(output.includes('[agent]'), 'should show [agent] in all tests listing');
      assert.ok(output.includes('[http]'), 'should show [http] in all tests listing');
      assert.ok(output.includes('api/'), 'should show api collection');
      assert.ok(output.includes('agents/'), 'should show agents collection');
    } finally {
      console.log = origLog;
      process.chdir(origCwd);
      cleanup();
    }
  });
});
