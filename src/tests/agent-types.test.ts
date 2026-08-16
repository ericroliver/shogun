/**
 * src/tests/agent-types.test.ts
 *
 * Unit tests for the agent test type Zod schemas and TypeScript type exports.
 *
 * Covers:
 *   - TestDefinitionSchema accepts valid agent test definitions
 *   - TestDefinitionSchema rejects agent tests missing required fields
 *   - TestDefinitionSchema rejects agent tests without semantic expectation
 *   - request is NOT required for agent tests
 *   - ShogunConfigSchema accepts config with evaluation block
 *   - ShogunConfigSchema rejects evaluation block missing endpoint or model
 *   - All new types are exported from src/types.ts
 *
 * Run with:
 *   npx tsx --test src/tests/agent-types.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TestDefinitionSchema, ShogunConfigSchema } from '../loader.js';
import type {
  AgentTestConfig,
  AgentExpectedDef,
  AgentEvaluateConfig,
  EvaluationConfig,
  EvaluatorResponse,
  EvaluationAssertionResult,
  TestDefinition,
  TestResult,
  AssertionResults,
  ShogunConfig,
} from '../types.js';

// ---------------------------------------------------------------------------
// Type export verification
// ---------------------------------------------------------------------------

describe('Type exports from src/types.ts', () => {
  test('all agent-related types are exported and usable', () => {
    // These assignments exist purely to verify the types are importable.
    // If any import is missing, the file won't compile.
    const _agentCfg: AgentTestConfig = {
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'test-model',
      prompt: 'Hello',
    };
    const _expected: AgentExpectedDef = { description: 'should respond politely' };
    const _evaluate: AgentEvaluateConfig = { criteria: ['is polite'], min_pass: 80 };
    const _evalConfig: EvaluationConfig = { endpoint: 'http://localhost:11434/v1/chat/completions', model: 'eval-model' };
    const _evalResponse: EvaluatorResponse = { status: 'evaluated', grade: 90, reasoning: 'good' };
    const _evalResult: EvaluationAssertionResult = { status: 'evaluated', grade: 90, passed: true, reasoning: 'good' };
    const _assertions: AssertionResults = { evaluation: _evalResult };
    const _testDef: TestDefinition = {
      name: 'test',
      type: 'agent',
      agent: _agentCfg,
      expected: _expected,
    };
    const _config: ShogunConfig = { version: 1, evaluation: _evalConfig };

    // Use the variables to avoid unused-variable lint errors
    assert.ok(_agentCfg);
    assert.ok(_expected);
    assert.ok(_evaluate);
    assert.ok(_evalConfig);
    assert.ok(_evalResponse);
    assert.ok(_evalResult);
    assert.ok(_assertions);
    assert.ok(_testDef);
    assert.ok(_config);
  });
});

// ---------------------------------------------------------------------------
// TestDefinitionSchema — valid agent tests
// ---------------------------------------------------------------------------

describe('TestDefinitionSchema — valid agent test definitions', () => {

  test('accepts a minimal agent test with expected.description', () => {
    const valid = {
      name: 'agent-says-hello',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Say hello',
      },
      expected: { description: 'The agent should greet the user' },
    };
    const result = TestDefinitionSchema.safeParse(valid);
    assert.ok(result.success, `Expected schema to accept valid agent test: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  test('accepts an agent test with evaluate.criteria only (no expected.description)', () => {
    const valid = {
      name: 'agent-criteria-only',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Explain recursion',
      },
      evaluate: {
        criteria: ['mentions base case', 'provides an example'],
        min_pass: 75,
      },
    };
    const result = TestDefinitionSchema.safeParse(valid);
    assert.ok(result.success, `Expected schema to accept agent test with criteria only: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  test('accepts an agent test with both expected.description and evaluate.criteria', () => {
    const valid = {
      name: 'agent-full',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Write a haiku about testing',
        temperature: 0.5,
        max_tokens: 100,
        api_key: 'sk-test-key',
        parameters: {
          system_prompt: 'You are a poet',
          context_files: ['src/poems.txt'],
        },
      },
      expected: { description: 'A haiku with 5-7-5 syllable structure' },
      evaluate: {
        criteria: ['follows 5-7-5 pattern', 'mentions nature'],
        min_pass: 80,
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4-eval',
        temperature: 0,
        evaluator_system_prompt: 'You evaluate haikus',
      },
    };
    const result = TestDefinitionSchema.safeParse(valid);
    assert.ok(result.success, `Expected schema to accept full agent test: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  test('request is NOT required for agent tests', () => {
    // An agent test without a `request` field should be accepted.
    // This is the key distinction from HTTP tests.
    const valid = {
      name: 'agent-no-request',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Hello',
      },
      expected: { description: 'should respond' },
    };
    const result = TestDefinitionSchema.safeParse(valid);
    assert.ok(result.success, `Agent test should not require request: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });
});

// ---------------------------------------------------------------------------
// TestDefinitionSchema — invalid agent tests (missing required fields)
// ---------------------------------------------------------------------------

describe('TestDefinitionSchema — rejects invalid agent test definitions', () => {

  test('rejects agent test without agent.endpoint', () => {
    const invalid = {
      name: 'agent-no-endpoint',
      type: 'agent',
      agent: {
        model: 'gpt-4',
        prompt: 'Hello',
      },
      expected: { description: 'should respond' },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test without endpoint');
  });

  test('rejects agent test without agent.model', () => {
    const invalid = {
      name: 'agent-no-model',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        prompt: 'Hello',
      },
      expected: { description: 'should respond' },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test without model');
  });

  test('rejects agent test without agent.prompt', () => {
    const invalid = {
      name: 'agent-no-prompt',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
      },
      expected: { description: 'should respond' },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test without prompt');
  });

  test('rejects agent test without any agent config at all', () => {
    const invalid = {
      name: 'agent-no-config',
      type: 'agent',
      expected: { description: 'should respond' },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test without agent config');
  });
});

// ---------------------------------------------------------------------------
// TestDefinitionSchema — semantic expectation requirement
// ---------------------------------------------------------------------------

describe('TestDefinitionSchema — semantic expectation requirement', () => {

  test('rejects agent test with neither expected.description nor evaluate.criteria', () => {
    const invalid = {
      name: 'agent-no-expectation',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Hello',
      },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test without any semantic expectation');
  });

  test('rejects agent test with empty expected.description and no evaluate.criteria', () => {
    const invalid = {
      name: 'agent-empty-desc',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Hello',
      },
      expected: { description: '   ' },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test with whitespace-only description');
  });

  test('rejects agent test with empty evaluate.criteria array and no expected.description', () => {
    const invalid = {
      name: 'agent-empty-criteria',
      type: 'agent',
      agent: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4',
        prompt: 'Hello',
      },
      evaluate: { criteria: [] },
    };
    const result = TestDefinitionSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject agent test with empty criteria array');
  });
});

// ---------------------------------------------------------------------------
// ShogunConfigSchema — evaluation block
// ---------------------------------------------------------------------------

describe('ShogunConfigSchema — evaluation block', () => {

  test('accepts config with valid evaluation block', () => {
    const valid = {
      version: 1,
      evaluation: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        model: 'gpt-4-eval',
        temperature: 0,
      },
    };
    const result = ShogunConfigSchema.safeParse(valid);
    assert.ok(result.success, `Expected config with evaluation block to be accepted: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  test('accepts config with evaluation block including api_key', () => {
    const valid = {
      version: 1,
      evaluation: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        api_key: 'sk-eval-key',
        model: 'gpt-4-eval',
      },
    };
    const result = ShogunConfigSchema.safeParse(valid);
    assert.ok(result.success, `Expected config with evaluation block + api_key to be accepted: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  test('accepts config without evaluation block (backward compat)', () => {
    const valid = { version: 1 };
    const result = ShogunConfigSchema.safeParse(valid);
    assert.ok(result.success, `Expected config without evaluation to be accepted: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
  });

  test('rejects evaluation block without endpoint', () => {
    const invalid = {
      version: 1,
      evaluation: {
        model: 'gpt-4-eval',
      },
    };
    const result = ShogunConfigSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject evaluation block without endpoint');
  });

  test('rejects evaluation block without model', () => {
    const invalid = {
      version: 1,
      evaluation: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
      },
    };
    const result = ShogunConfigSchema.safeParse(invalid);
    assert.ok(!result.success, 'Should reject evaluation block without model');
  });
});
