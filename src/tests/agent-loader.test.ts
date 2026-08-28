/**
 * src/tests/agent-loader.test.ts
 *
 * Unit tests for the agent test loader — resolveEvaluationConfig() and
 * loadTestFile() with type: agent tests.
 *
 * Covers:
 *   - resolveEvaluationConfig returns global config values when test has no overrides
 *   - resolveEvaluationConfig returns per-test values when test overrides
 *   - resolveEvaluationConfig interpolates ${...} tokens against the env
 *   - resolveEvaluationConfig throws when neither global nor per-test endpoint is set
 *   - resolveEvaluationConfig throws when neither global nor per-test model is set
 *   - resolveEvaluationConfig uses temperature 0 as default, per-test override works
 *   - loadTestFile successfully loads a valid agent test YAML
 *
 * Run with:
 *   npx tsx --test src/tests/agent-loader.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveEvaluationConfig,
  loadTestFile,
  TestDefinitionSchema,
} from '../loader.js';
import type {
  ShogunConfig,
  AgentEvaluateConfig,
  EnvVars,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(evaluation?: Partial<ShogunConfig['evaluation']>): ShogunConfig {
  if (evaluation) {
    return {
      version: 1,
      evaluation: evaluation as ShogunConfig['evaluation'],
    };
  }
  return { version: 1 };
}

// ---------------------------------------------------------------------------
// resolveEvaluationConfig — global config fallback
// ---------------------------------------------------------------------------

describe('resolveEvaluationConfig() — global config fallback', () => {

  test('returns global config values when test has no overrides', () => {
    const config = makeConfig({
      endpoint: 'http://localhost:5000/v1/chat/completions',
      model: 'gpt-4o',
      api_key: 'sk-global-key',
      temperature: 0,
    });
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.endpoint, 'http://localhost:5000/v1/chat/completions');
    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.api_key, 'sk-global-key');
    assert.equal(result.temperature, 0);
    assert.equal(result.evaluator_system_prompt, undefined);
  });

  test('returns global config values without api_key when not set', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: 'llama-3',
    });
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.endpoint, 'http://eval.example.com/v1/chat/completions');
    assert.equal(result.model, 'llama-3');
    assert.equal(result.api_key, undefined);
    assert.equal(result.temperature, 0);
  });
});

// ---------------------------------------------------------------------------
// resolveEvaluationConfig — per-test overrides
// ---------------------------------------------------------------------------

describe('resolveEvaluationConfig() — per-test overrides', () => {

  test('returns per-test values when test overrides all global fields', () => {
    const config = makeConfig({
      endpoint: 'http://global.example.com/v1/chat/completions',
      model: 'global-model',
      api_key: 'global-key',
      temperature: 0.5,
    });
    const testEvaluate: AgentEvaluateConfig = {
      endpoint: 'http://override.example.com/v1/chat/completions',
      model: 'override-model',
      api_key: 'override-key',
      temperature: 0.2,
      evaluator_system_prompt: 'You are a strict grader.',
    };
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(testEvaluate, config, env);

    assert.equal(result.endpoint, 'http://override.example.com/v1/chat/completions');
    assert.equal(result.model, 'override-model');
    assert.equal(result.api_key, 'override-key');
    assert.equal(result.temperature, 0.2);
    assert.equal(result.evaluator_system_prompt, 'You are a strict grader.');
  });

  test('per-test endpoint overrides global, rest falls back', () => {
    const config = makeConfig({
      endpoint: 'http://global.example.com/v1/chat/completions',
      model: 'global-model',
      api_key: 'global-key',
      temperature: 0.5,
    });
    const testEvaluate: AgentEvaluateConfig = {
      endpoint: 'http://per-test.example.com/v1/chat/completions',
    };
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(testEvaluate, config, env);

    assert.equal(result.endpoint, 'http://per-test.example.com/v1/chat/completions');
    assert.equal(result.model, 'global-model');
    assert.equal(result.api_key, 'global-key');
    assert.equal(result.temperature, 0.5);
  });

  test('per-test evaluator_system_prompt passes through', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: 'eval-model',
    });
    const testEvaluate: AgentEvaluateConfig = {
      evaluator_system_prompt: 'Grade on a curve.',
    };
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(testEvaluate, config, env);

    assert.equal(result.evaluator_system_prompt, 'Grade on a curve.');
  });
});

// ---------------------------------------------------------------------------
// resolveEvaluationConfig — environment interpolation
// ---------------------------------------------------------------------------

describe('resolveEvaluationConfig() — environment interpolation', () => {

  test('interpolates ${...} tokens in endpoint against env', () => {
    const config = makeConfig({
      endpoint: 'http://${EVAL_HOST}/v1/chat/completions',
      model: 'gpt-4o',
    });
    const env: EnvVars = { EVAL_HOST: 'localhost:5000' };

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.endpoint, 'http://localhost:5000/v1/chat/completions');
  });

  test('interpolates ${...} tokens in model against env', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: '${EVAL_MODEL}',
    });
    const env: EnvVars = { EVAL_MODEL: 'claude-3-opus' };

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.model, 'claude-3-opus');
  });

  test('interpolates ${...} tokens in api_key against env', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: 'gpt-4o',
      api_key: '${EVALUATOR_API_KEY}',
    });
    const env: EnvVars = { EVALUATOR_API_KEY: 'sk-secret-key' };

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.api_key, 'sk-secret-key');
  });

  test('interpolates tokens in per-test overrides too', () => {
    const config = makeConfig();
    const testEvaluate: AgentEvaluateConfig = {
      endpoint: 'http://${EVAL_HOST}:${EVAL_PORT}/v1/chat/completions',
      model: '${EVAL_MODEL}',
      api_key: '${EVAL_KEY}',
    };
    const env: EnvVars = {
      EVAL_HOST: '10.0.0.1',
      EVAL_PORT: '8080',
      EVAL_MODEL: 'my-model',
      EVAL_KEY: 'secret',
    };

    const result = resolveEvaluationConfig(testEvaluate, config, env);

    assert.equal(result.endpoint, 'http://10.0.0.1:8080/v1/chat/completions');
    assert.equal(result.model, 'my-model');
    assert.equal(result.api_key, 'secret');
  });

  test('leaves unresolved ${...} tokens as-is when env var is missing', () => {
    const config = makeConfig({
      endpoint: 'http://${MISSING_VAR}/v1/chat/completions',
      model: 'gpt-4o',
    });
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(undefined, config, env);

    // interpolateEnv falls back to ${MISSING_VAR} literal when not found
    assert.equal(result.endpoint, 'http://${MISSING_VAR}/v1/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// resolveEvaluationConfig — error cases
// ---------------------------------------------------------------------------

describe('resolveEvaluationConfig() — error cases', () => {

  test('throws when neither global nor per-test endpoint is set', () => {
    const config = makeConfig(); // no evaluation block
    const env: EnvVars = {};

    assert.throws(
      () => resolveEvaluationConfig(undefined, config, env),
      /Evaluation endpoint is required/,
    );
  });

  test('throws when neither global nor per-test model is set', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      // model missing
    });
    const env: EnvVars = {};

    assert.throws(
      () => resolveEvaluationConfig(undefined, config, env),
      /Evaluation model is required/,
    );
  });

  test('throws when global endpoint is set but model is missing and per-test has no model', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
    });
    const testEvaluate: AgentEvaluateConfig = {
      // has criteria but no model override
      criteria: ['response is polite'],
    };
    const env: EnvVars = {};

    assert.throws(
      () => resolveEvaluationConfig(testEvaluate, config, env),
      /Evaluation model is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveEvaluationConfig — temperature defaults and overrides
// ---------------------------------------------------------------------------

describe('resolveEvaluationConfig() — temperature', () => {

  test('defaults to 0 when neither global nor per-test temperature is set', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: 'gpt-4o',
    });
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.temperature, 0);
  });

  test('uses global temperature when per-test does not override', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: 'gpt-4o',
      temperature: 0.3,
    });
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(undefined, config, env);

    assert.equal(result.temperature, 0.3);
  });

  test('per-test temperature overrides global', () => {
    const config = makeConfig({
      endpoint: 'http://eval.example.com/v1/chat/completions',
      model: 'gpt-4o',
      temperature: 0.5,
    });
    const testEvaluate: AgentEvaluateConfig = {
      temperature: 0.1,
    };
    const env: EnvVars = {};

    const result = resolveEvaluationConfig(testEvaluate, config, env);

    assert.equal(result.temperature, 0.1);
  });
});

// ---------------------------------------------------------------------------
// loadTestFile — agent test YAML loading
// ---------------------------------------------------------------------------

describe('loadTestFile() — loads valid agent test YAML', () => {
  const tmpDir = join(process.cwd(), '.tmp-test-agent-loader');

  before(() => {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

    // Minimal agent test with expected.description
    writeFileSync(join(tmpDir, 'agent-minimal.yaml'), `
name: agent-minimal
type: agent
agent:
  endpoint: http://localhost:5000/v1/chat/completions
  model: gpt-4o
  prompt: Hello, who are you?
expected:
  description: The agent should identify itself.
`);

    // Agent test with evaluate.criteria and env interpolation
    writeFileSync(join(tmpDir, 'agent-with-eval.yaml'), `
name: agent-with-eval
type: agent
agent:
  endpoint: http://\${AGENT_HOST}/v1/chat/completions
  model: llama-3
  prompt: What is 2+2?
  api_key: \${AGENT_API_KEY}
evaluate:
  criteria:
    - "Response contains the number 4"
    - "Response is concise"
  min_pass: 75
  temperature: 0.1
`);

    // Agent test with both expected.description and evaluate.criteria
    writeFileSync(join(tmpDir, 'agent-full.yaml'), `
name: agent-full
type: agent
description: Full agent test
agent:
  endpoint: http://localhost:5000/v1/chat/completions
  model: gpt-4o
  prompt: Tell me a joke.
  temperature: 0.8
  max_tokens: 100
  parameters:
    system_prompt: You are a comedian.
    context_files:
      - data.txt
expected:
  description: The joke should be funny.
evaluate:
  criteria:
    - "Contains a punchline"
  min_pass: 80
  endpoint: http://override.example.com/v1/chat/completions
  model: gpt-4o-mini
`);
  });

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads minimal agent test with expected.description', () => {
    const env: EnvVars = {};
    const result = loadTestFile(join(tmpDir, 'agent-minimal.yaml'), env);

    assert.equal(result.type, 'agent');
    assert.equal(result.agent?.endpoint, 'http://localhost:5000/v1/chat/completions');
    assert.equal(result.agent?.model, 'gpt-4o');
    assert.equal(result.agent?.prompt, 'Hello, who are you?');
    assert.equal(result.expected?.description, 'The agent should identify itself.');
  });

  test('loads agent test with evaluate.criteria and env interpolation', () => {
    const env: EnvVars = {
      AGENT_HOST: '10.0.0.5:8080',
      AGENT_API_KEY: 'sk-agent-key',
    };
    const result = loadTestFile(join(tmpDir, 'agent-with-eval.yaml'), env);

    assert.equal(result.type, 'agent');
    assert.equal(result.agent?.endpoint, 'http://10.0.0.5:8080/v1/chat/completions');
    assert.equal(result.agent?.api_key, 'sk-agent-key');
    assert.deepEqual(result.evaluate?.criteria, ['Response contains the number 4', 'Response is concise']);
    assert.equal(result.evaluate?.min_pass, 75);
    assert.equal(result.evaluate?.temperature, 0.1);
  });

  test('loads full agent test with all fields', () => {
    const env: EnvVars = {};
    const result = loadTestFile(join(tmpDir, 'agent-full.yaml'), env);

    assert.equal(result.type, 'agent');
    assert.equal(result.agent?.temperature, 0.8);
    assert.equal(result.agent?.max_tokens, 100);
    assert.equal(result.agent?.parameters?.system_prompt, 'You are a comedian.');
    assert.deepEqual(result.agent?.parameters?.context_files, ['data.txt']);
    assert.equal(result.expected?.description, 'The joke should be funny.');
    assert.deepEqual(result.evaluate?.criteria, ['Contains a punchline']);
    assert.equal(result.evaluate?.min_pass, 80);
    assert.equal(result.evaluate?.endpoint, 'http://override.example.com/v1/chat/completions');
    assert.equal(result.evaluate?.model, 'gpt-4o-mini');
  });
});
