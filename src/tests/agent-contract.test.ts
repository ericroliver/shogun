/**
 * src/tests/agent-contract.test.ts
 *
 * Unit tests for Story 5: Evaluation Contract Validation.
 *
 * Covers:
 *   - validateCriteriaCorrespondence: 1:1 and in-order criteria matching
 *   - runAgentTest end-to-end: pass/fail based on grade vs min_pass
 *   - runAgentTest: indeterminate status = fail
 *   - runAgentTest: default min_pass is 80
 *   - assertionsAllPassed: recognizes evaluation assertion
 *
 * Run with:
 *   npx tsx --test src/tests/agent-contract.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEvaluationPrompt,
  parseEvaluatorResponse,
  validateCriteriaCorrespondence,
} from '../agent-evaluator.js';
import { runAgentTest } from '../runner.js';
import { assertionsAllPassed } from '../asserter.js';
import { setActiveBackend, getActiveBackend } from '../backend-global.js';
import type { BackendExecutor, ExecutorOptions } from '../backend-interface.js';
import type {
  ShogunRequest, ShogunResponse, TestDefinition, TestResult,
  EnvVars, ShogunConfig, SessionState, EvaluatorResponse, AssertionResults,
} from '../types.js';
import { RunLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

interface MockBackendConfig {
  response?: ShogunResponse;
  error?: Error;
  secondResponse?: ShogunResponse;
  secondError?: Error;
}

interface CapturedCall {
  req: ShogunRequest;
  env: EnvVars;
  opts: ExecutorOptions | undefined;
}

let capturedCalls: CapturedCall[] = [];
let mockConfig: MockBackendConfig = {};

const mockBackend: BackendExecutor = {
  name: 'unix',
  async executeRequest(req: ShogunRequest, env: EnvVars, opts?: ExecutorOptions): Promise<ShogunResponse> {
    capturedCalls.push({ req, env, opts });
    const callIndex = capturedCalls.length - 1;
    if (callIndex === 0) {
      if (mockConfig.error) throw mockConfig.error;
      return mockConfig.response!;
    }
    // Second call (evaluator)
    if (mockConfig.secondError) throw mockConfig.secondError;
    return mockConfig.secondResponse ?? mockConfig.response!;
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

function makeShogunResponse(body: unknown): ShogunResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    raw: typeof body === 'string' ? body : JSON.stringify(body),
    duration: 100,
    curlMs: 50,
  };
}

function makeOpenAiResponse(content: string): ShogunResponse {
  return makeShogunResponse({
    choices: [{ message: { role: 'assistant', content } }],
  });
}

function makeEvaluatorResponse(evalContent: string): ShogunResponse {
  return makeOpenAiResponse(evalContent);
}

function makeValidEvaluatorJson(overrides?: Partial<EvaluatorResponse>): string {
  const base: EvaluatorResponse = {
    status: 'evaluated',
    grade: 85,
    reasoning: 'The response meets the expected behavior.',
    criteriaResults: [],
  };
  return JSON.stringify({ ...base, ...overrides });
}

function makeAgentTest(overrides?: Partial<TestDefinition>): TestDefinition {
  return {
    name: 'Test agent response',
    type: 'agent',
    agent: {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4',
      prompt: 'What is 2+2?',
      ...overrides?.agent,
    },
    expected: {
      description: 'The agent should return 4',
    },
    ...overrides,
  };
}

function makeRunOpts(cwd: string): Parameters<typeof runAgentTest>[2] {
  const config: ShogunConfig = {
    version: 1,
    defaults: { timeout: 300 },
    evaluation: {
      endpoint: 'https://eval.example.com/v1/chat/completions',
      model: 'gpt-4o-eval',
    },
  };
  const env: EnvVars = { BASE_URL: 'http://localhost:3000' };
  const session: SessionState = {
    testsRun: new Map(),
    collectionsSetup: new Set(),
    collectionsTornDown: new Set(),
    fixturesRun: new Set(),
  };
  return {
    env,
    vars: {},
    baseUrl: 'http://localhost:3000',
    config,
    scriptsDir: join(cwd, 'scripts'),
    cwd,
    collectionsDir: join(cwd, 'tests', 'collections'),
    session,
    logger: new RunLogger(config, cwd),
  };
}

function resetMock(): void {
  capturedCalls = [];
  mockConfig = {};
}

function setMockResponse(response: ShogunResponse): void {
  mockConfig.response = response;
}

function setMockSecondResponse(response: ShogunResponse): void {
  mockConfig.secondResponse = response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedBackend: BackendExecutor | null = null;
const TMP_DIR = join(process.cwd(), 'tmp-agent-contract-test');

before(() => {
  try {
    savedBackend = getActiveBackend();
  } catch {
    savedBackend = null;
  }
  setActiveBackend(mockBackend);
  mkdirSync(TMP_DIR, { recursive: true });
});

after(() => {
  if (savedBackend) {
    setActiveBackend(savedBackend);
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ===========================================================================
// validateCriteriaCorrespondence
// ===========================================================================

describe('validateCriteriaCorrespondence', () => {
  test('passes when counts match and strings match exactly', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 90,
      reasoning: 'All criteria met.',
      criteriaResults: [
        { criterion: 'Returns the correct answer', met: true },
        { criterion: 'Explains the reasoning', met: true },
      ],
    };
    const criteria = ['Returns the correct answer', 'Explains the reasoning'];

    // Should not throw
    validateCriteriaCorrespondence(evaluatorResponse, criteria);
  });

  test('throws when counts differ', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 80,
      reasoning: 'Partial.',
      criteriaResults: [
        { criterion: 'Criterion A', met: true },
      ],
    };
    const criteria = ['Criterion A', 'Criterion B'];

    assert.throws(
      () => validateCriteriaCorrespondence(evaluatorResponse, criteria),
      /Criteria count mismatch: supplied 2, evaluator returned 1/,
    );
  });

  test('throws when criterion text differs (paraphrased)', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 80,
      reasoning: 'Met.',
      criteriaResults: [
        { criterion: 'Returns a valid response', met: true },
      ],
    };
    const criteria = ['Returns the correct answer'];

    assert.throws(
      () => validateCriteriaCorrespondence(evaluatorResponse, criteria),
      /Criteria mismatch at index 0/,
    );
  });

  test('passes when no criteria supplied (no-op)', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 85,
      reasoning: 'Good response.',
      // criteriaResults absent
    };

    // Should not throw
    validateCriteriaCorrespondence(evaluatorResponse, undefined);
    validateCriteriaCorrespondence(evaluatorResponse, []);
  });

  test('throws when criteria supplied but evaluator returned empty criteriaResults', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 80,
      reasoning: 'Some reasoning.',
      criteriaResults: [],
    };
    const criteria = ['Criterion A', 'Criterion B'];

    assert.throws(
      () => validateCriteriaCorrespondence(evaluatorResponse, criteria),
      /Criteria were supplied.*but evaluator returned no criteriaResults/,
    );
  });

  test('throws when criteria supplied but evaluator returned undefined criteriaResults', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 80,
      reasoning: 'Some reasoning.',
      // criteriaResults not set
    };
    const criteria = ['Criterion A'];

    assert.throws(
      () => validateCriteriaCorrespondence(evaluatorResponse, criteria),
      /Criteria were supplied.*but evaluator returned no criteriaResults/,
    );
  });

  test('passes with single criterion matching exactly', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 100,
      reasoning: 'Perfect.',
      criteriaResults: [
        { criterion: 'Responds politely', met: true },
      ],
    };

    validateCriteriaCorrespondence(evaluatorResponse, ['Responds politely']);
  });

  test('detects mismatch at second index', () => {
    const evaluatorResponse: EvaluatorResponse = {
      status: 'evaluated',
      grade: 80,
      reasoning: 'Ok.',
      criteriaResults: [
        { criterion: 'First criterion', met: true },
        { criterion: 'Wrong text', met: false },
      ],
    };
    const criteria = ['First criterion', 'Second criterion'];

    assert.throws(
      () => validateCriteriaCorrespondence(evaluatorResponse, criteria),
      /Criteria mismatch at index 1/,
    );
  });
});

// ===========================================================================
// runAgentTest — end-to-end pass/fail with evaluation
// ===========================================================================

describe('runAgentTest — end-to-end evaluation results', () => {
  test('passes when grade >= min_pass (default 80)', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('The answer is 4.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 85,
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'passed');
    assert.ok(result.assertions.evaluation, 'evaluation assertion should be present');
    assert.equal(result.assertions.evaluation!.passed, true);
    assert.equal(result.assertions.evaluation!.grade, 85);
    assert.equal(result.assertions.evaluation!.status, 'evaluated');
    assert.equal(result.assertions.evaluation!.evaluatorModel, 'gpt-4o-eval');
  });

  test('fails when grade < min_pass (default 80)', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('The answer is 4.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 50,
      reasoning: 'The response does not meet the criteria.',
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'failed');
    assert.ok(result.assertions.evaluation, 'evaluation assertion should be present');
    assert.equal(result.assertions.evaluation!.passed, false);
    assert.equal(result.assertions.evaluation!.grade, 50);
  });

  test('indeterminate status = fail', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Some ambiguous response.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      status: 'indeterminate',
      grade: undefined,
      reasoning: 'Cannot determine if the response meets criteria.',
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'failed');
    assert.ok(result.assertions.evaluation, 'evaluation assertion should be present');
    assert.equal(result.assertions.evaluation!.passed, false);
    assert.equal(result.assertions.evaluation!.status, 'indeterminate');
    assert.equal(result.assertions.evaluation!.grade, undefined);
  });

  test('default min_pass is 80 when not specified', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Response.'));
    // grade 80 should pass (>= 80)
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 80,
    })));

    const testDef = makeAgentTest();
    // No evaluate.min_pass set — should default to 80
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'passed', 'grade 80 should pass with default min_pass 80');
    assert.equal(result.assertions.evaluation!.passed, true);
  });

  test('grade 79 fails with default min_pass 80', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Response.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 79,
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'failed', 'grade 79 should fail with default min_pass 80');
    assert.equal(result.assertions.evaluation!.passed, false);
  });

  test('custom min_pass is respected', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Response.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 60,
    })));

    const testDef = makeAgentTest({
      evaluate: {
        min_pass: 50,
      },
    });
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'passed', 'grade 60 should pass with min_pass 50');
    assert.equal(result.assertions.evaluation!.passed, true);
  });

  test('failure includes diagnostics (agentResponse, evaluationResponse)', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Wrong answer.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 30,
      reasoning: 'The response is incorrect.',
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'failed');
    // Diagnostics should be present on failure
    assert.ok(result.agentResponse, 'agentResponse should be present on failure');
    assert.ok(result.resolvedRequest, 'resolvedRequest should be present on failure');
    assert.ok(result.evaluationRequest, 'evaluationRequest should be present on failure');
    assert.ok(result.evaluationResponse, 'evaluationResponse should be present on failure');
  });

  test('pass omits diagnostics', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Correct answer.'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 95,
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'passed');
    assert.equal(result.agentResponse, undefined, 'agentResponse should be omitted on pass');
    assert.equal(result.resolvedRequest, undefined, 'resolvedRequest should be omitted on pass');
    assert.equal(result.evaluationRequest, undefined, 'evaluationRequest should be omitted on pass');
    assert.equal(result.evaluationResponse, undefined, 'evaluationResponse should be omitted on pass');
  });

  test('criteria mismatch produces failed test with clear error', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('Some response.'));
    setMockSecondResponse(makeEvaluatorResponse(JSON.stringify({
      status: 'evaluated',
      grade: 90,
      reasoning: 'Good response.',
      criteriaResults: [
        { criterion: 'Returns a valid response', met: true },
      ],
    })));

    const testDef = makeAgentTest({
      evaluate: {
        criteria: ['Returns the correct answer'],
      },
    });
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'failed');
    assert.ok(
      result.error!.includes('Evaluation contract validation failed'),
      'error should mention contract validation failure',
    );
    assert.ok(
      result.error!.includes('Criteria mismatch'),
      'error should mention criteria mismatch',
    );
  });

  test('timings: curlMs = agent call, assertMs = evaluation call', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('4'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 90,
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.ok(result.timings);
    assert.equal(result.timings!.curlMs, 50, 'curlMs should come from agent response');
    assert.ok(result.timings!.assertMs >= 0, 'assertMs should be set from evaluation');
    assert.equal(result.timings!.preMs, 0);
    assert.equal(result.timings!.postMs, 0);
  });

  test('evaluationResult includes evaluatorModel and durationMs', async () => {
    resetMock();
    setMockResponse(makeOpenAiResponse('4'));
    setMockSecondResponse(makeEvaluatorResponse(makeValidEvaluatorJson({
      grade: 90,
    })));

    const testDef = makeAgentTest();
    const opts = makeRunOpts(process.cwd());
    const result = await runAgentTest(testDef, 'test.yaml', opts);

    assert.equal(result.status, 'passed');
    assert.equal(result.assertions.evaluation!.evaluatorModel, 'gpt-4o-eval');
    assert.ok(
      result.assertions.evaluation!.durationMs !== undefined,
      'durationMs should be set in evaluation result',
    );
  });
});

// ===========================================================================
// assertionsAllPassed — evaluation assertion
// ===========================================================================

describe('assertionsAllPassed — evaluation assertion', () => {
  test('returns true when evaluation.passed is true', () => {
    const results: AssertionResults = {
      evaluation: {
        status: 'evaluated',
        grade: 90,
        passed: true,
        minPass: 80,
        reasoning: 'Good.',
      },
    };
    assert.equal(assertionsAllPassed(results), true);
  });

  test('returns false when evaluation.passed is false', () => {
    const results: AssertionResults = {
      evaluation: {
        status: 'evaluated',
        grade: 50,
        passed: false,
        minPass: 80,
        reasoning: 'Not good enough.',
      },
    };
    assert.equal(assertionsAllPassed(results), false);
  });

  test('returns true when evaluation.passed is true even with no other assertions', () => {
    const results: AssertionResults = {
      evaluation: {
        status: 'evaluated',
        grade: 100,
        passed: true,
        minPass: 80,
        reasoning: 'Perfect.',
      },
      // No status, shape, snapshot, or postScript assertions
    };
    assert.equal(assertionsAllPassed(results), true);
  });

  test('returns false when evaluation is indeterminate (passed = false)', () => {
    const results: AssertionResults = {
      evaluation: {
        status: 'indeterminate',
        passed: false,
        minPass: 80,
        reasoning: 'Cannot determine.',
      },
    };
    assert.equal(assertionsAllPassed(results), false);
  });

  test('returns false when no assertions at all (fail closed)', () => {
    const results: AssertionResults = {};
    assert.equal(assertionsAllPassed(results), false);
  });
});
