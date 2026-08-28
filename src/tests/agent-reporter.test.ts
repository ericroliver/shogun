/**
 * src/tests/agent-reporter.test.ts
 *
 * Unit tests for Story 6: Reporter & Output.
 *
 * Covers:
 *   - printTestResult: passing agent test displays grade and evaluator model
 *   - printTestResult: failing agent test displays FAIL, grade, criteria, reasoning
 *   - printTestResult: indeterminate agent test displays INDETERMINATE
 *   - printTestResult: failure diagnostics show agent response and evaluation response
 *   - getFailureReasons: indeterminate → "indeterminate" reason
 *   - getFailureReasons: low grade → "below threshold" reason
 *   - getFailureReasons: unmet criteria listed
 *
 * Run with:
 *   npx tsx --test src/tests/agent-reporter.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  printTestResult,
  getFailureReasons,
} from '../reporter.js';
import type {
  TestResult,
  AssertionResults,
  EvaluationAssertionResult,
  ShogunResponse,
  ShogunRequest,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvalResult(overrides?: Partial<EvaluationAssertionResult>): EvaluationAssertionResult {
  return {
    status: 'evaluated',
    grade: 85,
    passed: true,
    minPass: 80,
    reasoning: 'The response meets the expected behavior.',
    criteriaResults: [
      { criterion: 'Returns correct answer', met: true },
      { criterion: 'Is concise', met: true },
    ],
    evaluatorModel: 'gpt-4o-eval',
    durationMs: 200,
    ...overrides,
  };
}

function makeShogunResponse(body: unknown, status = 200): ShogunResponse {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    raw,
    duration: 100,
    curlMs: 50,
  };
}

function makeShogunRequest(url: string, body?: unknown): ShogunRequest {
  return {
    method: 'POST',
    url,
    path: url,
    headers: { 'content-type': 'application/json' },
    params: {},
    body,
  };
}

function makePassingAgentResult(overrides?: Partial<TestResult>): TestResult {
  return {
    name: 'Test agent response',
    file: 'test.yaml',
    status: 'passed',
    durationMs: 500,
    timings: { curlMs: 50, assertMs: 200, preMs: 0, postMs: 0, otherMs: 250 },
    assertions: { evaluation: makeEvalResult() },
    ...overrides,
  };
}

function makeFailingAgentResult(overrides?: Partial<TestResult>): TestResult {
  const evalResult = makeEvalResult({
    grade: 45,
    passed: false,
    reasoning: 'The response does not meet expectations.',
    criteriaResults: [
      { criterion: 'Returns correct answer', met: false, reasoning: 'Answer was 5, expected 4.' },
      { criterion: 'Is concise', met: true },
    ],
  });
  return {
    name: 'Test agent response',
    file: 'test.yaml',
    status: 'failed',
    durationMs: 500,
    timings: { curlMs: 50, assertMs: 200, preMs: 0, postMs: 0, otherMs: 250 },
    assertions: { evaluation: evalResult },
    agentResponse: makeShogunResponse({
      choices: [{ message: { role: 'assistant', content: 'The answer is 5.' } }],
    }),
    evaluationRequest: makeShogunRequest('https://eval.example.com/v1/chat/completions', {
      model: 'gpt-4o-eval',
      messages: [{ role: 'user', content: 'Evaluate this response...' }],
    }),
    evaluationResponse: makeShogunResponse({
      choices: [{ message: { role: 'assistant', content: '{"status":"evaluated","grade":45}' } }],
    }),
    ...overrides,
  };
}

function makeIndeterminateAgentResult(overrides?: Partial<TestResult>): TestResult {
  const evalResult = makeEvalResult({
    status: 'indeterminate',
    grade: undefined,
    passed: false,
    reasoning: 'The evaluator could not determine the quality of the response.',
    criteriaResults: undefined,
  });
  return {
    name: 'Test agent response',
    file: 'test.yaml',
    status: 'failed',
    durationMs: 500,
    timings: { curlMs: 50, assertMs: 200, preMs: 0, postMs: 0, otherMs: 250 },
    assertions: { evaluation: evalResult },
    ...overrides,
  };
}

/** Capture stdout to a string while running a callback. */
function captureStdout(fn: () => void): string {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  // Also capture console.log which writes to stdout
  const originalConsoleLog = console.log;
  console.log = ((...args: unknown[]) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
    chunks.push(msg);
  }) as typeof console.log;
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalConsoleLog;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests: printTestResult — passing agent tests
// ---------------------------------------------------------------------------

describe('printTestResult — passing agent tests', () => {
  test('displays OK and grade for passing agent test', () => {
    const result = makePassingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /OK/);
    assert.match(output, /Grade:\s+85\/100/);
  });

  test('displays evaluator model for passing agent test', () => {
    const result = makePassingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /gpt-4o-eval/);
  });

  test('displays N/A for grade when undefined', () => {
    const result = makePassingAgentResult({
      assertions: { evaluation: makeEvalResult({ grade: undefined }) },
    });
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /N\/A/);
  });

  test('omits diagnostics on passing agent test', () => {
    const result = makePassingAgentResult({
      agentResponse: makeShogunResponse({ data: 'should not appear' }),
    });
    const output = captureStdout(() => printTestResult(result));

    // On pass, diagnostics should not be shown
    assert.doesNotMatch(output, /agent response/);
    assert.doesNotMatch(output, /evaluation/);
  });
});

// ---------------------------------------------------------------------------
// Tests: printTestResult — failing agent tests
// ---------------------------------------------------------------------------

describe('printTestResult — failing agent tests', () => {
  test('displays FAIL for failing agent test', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /FAIL/);
  });

  test('displays grade for failing agent test', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /Grade:\s+45\/100/);
  });

  test('displays reasoning for failing agent test', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /The response does not meet expectations\./);
  });

  test('displays criteria breakdown with checkmarks and X marks', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /Returns correct answer/);
    assert.match(output, /Is concise/);
  });

  test('displays error message when present', () => {
    const result = makeFailingAgentResult({ error: 'Agent HTTP request failed: timeout' });
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /Agent HTTP request failed: timeout/);
  });

  test('displays agent response diagnostics on failure', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /agent response/);
    // Should include some of the agent response body
    assert.match(output, /The answer is 5/);
  });

  test('displays evaluation response diagnostics on failure', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /evaluation/);
  });

  test('displays evaluation request URL on failure', () => {
    const result = makeFailingAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /eval\.example\.com/);
  });
});

// ---------------------------------------------------------------------------
// Tests: printTestResult — indeterminate agent tests
// ---------------------------------------------------------------------------

describe('printTestResult — indeterminate agent tests', () => {
  test('displays INDETERMINATE label', () => {
    const result = makeIndeterminateAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /INDETERMINATE/);
  });

  test('displays N/A for grade when indeterminate', () => {
    const result = makeIndeterminateAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /N\/A/);
  });

  test('displays reasoning for indeterminate result', () => {
    const result = makeIndeterminateAgentResult();
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /could not determine the quality/);
  });
});

// ---------------------------------------------------------------------------
// Tests: printTestResult — dependency_failed agent tests
// ---------------------------------------------------------------------------

describe('printTestResult — dependency_failed agent tests', () => {
  test('displays SKIPPED with dependency info', () => {
    const result = makePassingAgentResult({
      status: 'dependency_failed',
      failedDependency: 'collection/other-test',
    });
    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /SKIPPED/);
    assert.match(output, /collection\/other-test/);
  });
});

// ---------------------------------------------------------------------------
// Tests: getFailureReasons — evaluation assertions
// ---------------------------------------------------------------------------

describe('getFailureReasons — evaluation assertion', () => {
  test('returns indeterminate reason for indeterminate evaluation', () => {
    const assertions: AssertionResults = {
      evaluation: makeEvalResult({
        status: 'indeterminate',
        passed: false,
        grade: undefined,
      }),
    };

    const reasons = getFailureReasons(assertions);

    assert.ok(reasons.some(r => r.includes('indeterminate')));
  });

  test('returns "below threshold" reason for low grade', () => {
    const assertions: AssertionResults = {
      evaluation: makeEvalResult({
        grade: 45,
        passed: false,
      }),
    };

    const reasons = getFailureReasons(assertions);

    assert.ok(reasons.some(r => r.includes('below threshold')));
    assert.ok(reasons.some(r => r.includes('45')));
  });

  test('lists unmet criteria', () => {
    const assertions: AssertionResults = {
      evaluation: makeEvalResult({
        grade: 30,
        passed: false,
        criteriaResults: [
          { criterion: 'Returns correct answer', met: false },
          { criterion: 'Is concise', met: true },
          { criterion: 'Includes examples', met: false },
        ],
      }),
    };

    const reasons = getFailureReasons(assertions);

    assert.ok(reasons.some(r => r.includes('Returns correct answer')));
    assert.ok(reasons.some(r => r.includes('Includes examples')));
    // Should NOT list met criteria
    assert.ok(!reasons.some(r => r.includes('Is concise') && r.includes('not met')));
  });

  test('returns empty reasons for passing evaluation', () => {
    const assertions: AssertionResults = {
      evaluation: makeEvalResult({ passed: true }),
    };

    const reasons = getFailureReasons(assertions);

    assert.equal(reasons.length, 0);
  });

  test('returns empty reasons when no evaluation present', () => {
    const assertions: AssertionResults = {};

    const reasons = getFailureReasons(assertions);

    assert.equal(reasons.length, 0);
  });

  test('handles evaluation with no criteriaResults', () => {
    const assertions: AssertionResults = {
      evaluation: makeEvalResult({
        grade: 50,
        passed: false,
        criteriaResults: undefined,
      }),
    };

    const reasons = getFailureReasons(assertions);

    assert.ok(reasons.some(r => r.includes('below threshold')));
    // Should not crash, should not list criteria
    assert.ok(!reasons.some(r => r.includes('Criterion not met')));
  });

  test('handles evaluation with N/A grade and indeterminate status', () => {
    const assertions: AssertionResults = {
      evaluation: makeEvalResult({
        status: 'indeterminate',
        grade: undefined,
        passed: false,
        criteriaResults: undefined,
      }),
    };

    const reasons = getFailureReasons(assertions);

    assert.ok(reasons.some(r => r.includes('indeterminate')));
    assert.ok(!reasons.some(r => r.includes('below threshold')));
  });
});

// ---------------------------------------------------------------------------
// Tests: existing HTTP/SQL reporter unchanged
// ---------------------------------------------------------------------------

describe('printTestResult — existing HTTP/SQL tests unchanged', () => {
  test('handles passing HTTP test without evaluation', () => {
    const result: TestResult = {
      name: 'GET /health',
      file: 'test.yaml',
      status: 'passed',
      httpStatus: 200,
      durationMs: 50,
      timings: { curlMs: 50, assertMs: 0, preMs: 0, postMs: 0, otherMs: 0 },
      assertions: { status: true },
    };

    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /OK/);
    assert.doesNotMatch(output, /Grade/);
    assert.doesNotMatch(output, /evaluator/i);
  });

  test('handles failing HTTP test without evaluation', () => {
    const result: TestResult = {
      name: 'GET /health',
      file: 'test.yaml',
      status: 'failed',
      httpStatus: 500,
      durationMs: 50,
      timings: { curlMs: 50, assertMs: 0, preMs: 0, postMs: 0, otherMs: 0 },
      assertions: { status: false },
      error: 'Internal Server Error',
    };

    const output = captureStdout(() => printTestResult(result));

    assert.match(output, /FAIL/);
    assert.match(output, /Status code mismatch/);
    assert.doesNotMatch(output, /Grade/);
    assert.doesNotMatch(output, /evaluator/i);
  });
});
