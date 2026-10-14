/**
 * src/tests/coverage-matcher.test.ts
 *
 * Unit tests for the coverage matcher — focused on:
 *   - 405 method-agnostic credit (Approach 1)
 *   - Explicit `covers` annotations (Approach 3)
 *   - Parent-path multi-child crediting
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchTests, matchTestToSpecEndpoint, isDynamic } from '../commands/coverage/matcher.js';
import { extractCovers, stripQueryString } from '../commands/coverage/test-collector.js';
import { computeParameterCoverage } from '../commands/coverage/analyzer.js';
import type { TestEntry, SpecEndpoint, CoverAnnotation } from '../commands/coverage/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpecEndpoint(
  method: string,
  path: string,
  responseCodes: string[] = ['200'],
): SpecEndpoint {
  return {
    method,
    path,
    tests: [],
    documentedResponseCodes: responseCodes,
    parameters: [],
    requestBodyFields: [],
  };
}

function makeSpecEndpointWithParams(
  method: string,
  path: string,
  params: Array<{ name: string; in: 'path' | 'query'; required: boolean }>,
  responseCodes: string[] = ['200'],
): SpecEndpoint {
  return {
    method,
    path,
    tests: [],
    documentedResponseCodes: responseCodes,
    parameters: params,
    requestBodyFields: [],
  };
}

function makeTestWithParams(
  method: string,
  path: string,
  requestParams: string[],
  expectedStatus?: number,
): TestEntry {
  return {
    name: `test-${method}-${path}`,
    file: `tests/collections/test/${path.replace(/\//g, '-')}.yaml`,
    collection: 'test',
    staticPath: stripQueryString(path),
    method: method.toUpperCase(),
    tags: [],
    expectedStatus,
    shapeAssertions: [],
    snapshotEnabled: false,
    postScriptAssertCount: 0,
    hasPreScript: false,
    hasPostScript: false,
    requestBodyFields: [],
    requestParams,
    covers: undefined,
  };
}

function makeTest(
  method: string,
  path: string,
  expectedStatus?: number,
  covers?: CoverAnnotation[],
): TestEntry {
  return {
    name: `test-${method}-${path}`,
    file: `tests/collections/test/${path.replace(/\//g, '-')}.yaml`,
    collection: 'test',
    staticPath: path,
    method: method.toUpperCase(),
    tags: [],
    expectedStatus,
    shapeAssertions: [],
    snapshotEnabled: false,
    postScriptAssertCount: 0,
    hasPreScript: false,
    hasPostScript: false,
    requestBodyFields: [],
    requestParams: [],
    covers,
  };
}

// ===========================================================================
// Existing behavior: normal method+path matching still works
// ===========================================================================

describe('matchTests() — normal method+path matching', () => {
  test('exact method+path match credits test to endpoint', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '401', '405']),
    ];
    const tests = [
      makeTest('POST', '/api/auth/login', 200),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/auth/login');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('method mismatch with no 405 assertion leaves test unmatched', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '401', '405']),
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 200),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, undefined);
    assert.equal(specs[0]!.tests.length, 0);
  });
});

// ===========================================================================
// Approach 1: Method-agnostic 405 credit
// ===========================================================================

describe('matchTests() — method-agnostic 405 credit', () => {
  test('GET test asserting 405 credits POST spec endpoint that documents 405', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '401', '405']),
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 405),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/auth/login');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('PUT test asserting 405 credits POST spec endpoint at same path', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/users', ['200', '400', '405']),
    ];
    const tests = [
      makeTest('PUT', '/api/users', 405),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/users');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('405 test does NOT credit spec endpoint that does not document 405', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '401']),  // no 405
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 405),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, undefined);
    assert.equal(specs[0]!.tests.length, 0);
  });

  test('405 test credits ALL spec endpoints at same path that document 405', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '405']),
      makeSpecEndpoint('PUT', '/api/auth/login', ['200', '405']),
      makeSpecEndpoint('DELETE', '/api/auth/login', ['200', '405']),
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 405),
    ];

    matchTests(tests, specs);

    assert.ok(tests[0]!.matchedSpecKey);
    assert.equal(specs[0]!.tests.length, 1); // POST
    assert.equal(specs[1]!.tests.length, 1); // PUT
    assert.equal(specs[2]!.tests.length, 1); // DELETE
  });

  test('405 test only credits endpoints at matching path, not other paths', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '405']),
      makeSpecEndpoint('POST', '/api/auth/register', ['200', '405']),
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 405),
    ];

    matchTests(tests, specs);

    assert.equal(specs[0]!.tests.length, 1); // /api/auth/login credited
    assert.equal(specs[1]!.tests.length, 0); // /api/auth/register NOT credited
  });
});

// ===========================================================================
// Parent-path multi-child crediting
// ===========================================================================

describe('matchTests() — parent-path 405 multi-child crediting', () => {
  test('PUT /api/admin/config → 405 credits all child endpoints that document 405', () => {
    const specs = [
      makeSpecEndpoint('PUT', '/api/admin/config/max-users', ['200', '405']),
      makeSpecEndpoint('PUT', '/api/admin/config/signup-enabled', ['200', '405']),
    ];
    const tests = [
      makeTest('PUT', '/api/admin/config', 405),
    ];

    matchTests(tests, specs);

    assert.ok(tests[0]!.matchedSpecKey);
    assert.equal(specs[0]!.tests.length, 1); // max-users credited
    assert.equal(specs[1]!.tests.length, 1); // signup-enabled credited
  });

  test('parent-path 405 only credits children that document 405', () => {
    const specs = [
      makeSpecEndpoint('PUT', '/api/admin/config/max-users', ['200', '405']),
      makeSpecEndpoint('PUT', '/api/admin/config/signup-enabled', ['200']), // no 405
    ];
    const tests = [
      makeTest('PUT', '/api/admin/config', 405),
    ];

    matchTests(tests, specs);

    assert.equal(specs[0]!.tests.length, 1); // max-users credited
    assert.equal(specs[1]!.tests.length, 0); // signup-enabled NOT credited
  });

  test('405 test with template path matches spec endpoints with {param}', () => {
    const specs = [
      makeSpecEndpoint('PUT', '/api/admin/config/{key}', ['200', '405']),
    ];
    const tests = [
      makeTest('PUT', '/api/admin/config/max-users', 405),
    ];

    matchTests(tests, specs);

    assert.ok(tests[0]!.matchedSpecKey);
    assert.equal(specs[0]!.tests.length, 1);
  });
});

// ===========================================================================
// Approach 3: Explicit `covers` annotation
// ===========================================================================

describe('matchTests() — explicit covers annotation', () => {
  test('covers annotation links test to declared endpoint', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '401', '405']),
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 405, [
        { endpoint: 'POST /api/auth/login', responseCode: 405 },
      ]),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/auth/login');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('covers annotation credits multiple endpoints (parent-path children)', () => {
    const specs = [
      makeSpecEndpoint('PUT', '/api/admin/config/max-users', ['200', '405']),
      makeSpecEndpoint('PUT', '/api/admin/config/signup-enabled', ['200', '405']),
    ];
    const tests = [
      makeTest('PUT', '/api/admin/config', 405, [
        { endpoint: 'PUT /api/admin/config/max-users', responseCode: 405 },
        { endpoint: 'PUT /api/admin/config/signup-enabled', responseCode: 405 },
      ]),
    ];

    matchTests(tests, specs);

    assert.equal(specs[0]!.tests.length, 1); // max-users
    assert.equal(specs[1]!.tests.length, 1); // signup-enabled
  });

  test('covers annotation takes priority over method+path matching', () => {
    const specs = [
      makeSpecEndpoint('GET', '/api/users', ['200']),
      makeSpecEndpoint('POST', '/api/users', ['201', '405']),
    ];
    const tests = [
      // This test would normally match GET /api/users, but covers says POST
      makeTest('GET', '/api/users', 200, [
        { endpoint: 'POST /api/users', responseCode: 405 },
      ]),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/users');
    assert.equal(specs[0]!.tests.length, 0); // GET not credited
    assert.equal(specs[1]!.tests.length, 1); // POST credited
  });

  test('covers annotation with non-existent endpoint is ignored', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '405']),
    ];
    const tests = [
      makeTest('GET', '/api/auth/login', 405, [
        { endpoint: 'DELETE /api/nonexistent', responseCode: 405 },
      ]),
    ];

    matchTests(tests, specs);

    // covers didn't match, so fall through to 405 method-agnostic matching
    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/auth/login');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('covers without responseCode still credits the test to the endpoint', () => {
    const specs = [
      makeSpecEndpoint('POST', '/api/auth/login', ['200', '405']),
    ];
    const tests = [
      makeTest('DELETE', '/api/other', 200, [
        { endpoint: 'POST /api/auth/login' },
      ]),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'POST /api/auth/login');
    assert.equal(specs[0]!.tests.length, 1);
  });
});

// ===========================================================================
// extractCovers() — parsing from YAML
// ===========================================================================

describe('extractCovers()', () => {
  test('parses object form with responseCode', () => {
    const parsed = {
      covers: [
        { endpoint: 'POST /api/auth/login', responseCode: 405 },
      ],
    };

    const result = extractCovers(parsed);

    assert.deepEqual(result, [
      { endpoint: 'POST /api/auth/login', responseCode: 405 },
    ]);
  });

  test('parses object form without responseCode', () => {
    const parsed = {
      covers: [
        { endpoint: 'PUT /api/admin/config/max-users' },
      ],
    };

    const result = extractCovers(parsed);

    assert.deepEqual(result, [
      { endpoint: 'PUT /api/admin/config/max-users', responseCode: undefined },
    ]);
  });

  test('parses string form with response code', () => {
    const parsed = {
      covers: ['POST /api/auth/login:405'],
    };

    const result = extractCovers(parsed);

    assert.deepEqual(result, [
      { endpoint: 'POST /api/auth/login', responseCode: 405 },
    ]);
  });

  test('parses string form without response code', () => {
    const parsed = {
      covers: ['PUT /api/admin/config/max-users'],
    };

    const result = extractCovers(parsed);

    assert.deepEqual(result, [
      { endpoint: 'PUT /api/admin/config/max-users', responseCode: undefined },
    ]);
  });

  test('parses mixed array of objects and strings', () => {
    const parsed = {
      covers: [
        { endpoint: 'POST /api/auth/login', responseCode: 405 },
        'PUT /api/admin/config/max-users',
      ],
    };

    const result = extractCovers(parsed);

    assert.deepEqual(result, [
      { endpoint: 'POST /api/auth/login', responseCode: 405 },
      { endpoint: 'PUT /api/admin/config/max-users', responseCode: undefined },
    ]);
  });

  test('returns undefined when covers field is absent', () => {
    const parsed = { name: 'test', request: { method: 'GET', path: '/api/test' } };

    const result = extractCovers(parsed);

    assert.equal(result, undefined);
  });

  test('returns undefined when covers is an empty array', () => {
    const parsed = { covers: [] };

    const result = extractCovers(parsed);

    assert.equal(result, undefined);
  });

  test('skips invalid entries in covers array', () => {
    const parsed = {
      covers: [
        'not-a-valid-format',
        { endpoint: 'POST /api/auth/login', responseCode: 405 },
        42,
        null,
      ],
    };

    const result = extractCovers(parsed);

    assert.deepEqual(result, [
      { endpoint: 'POST /api/auth/login', responseCode: 405 },
    ]);
  });
});

// ===========================================================================
// isDynamic() — helper function
// ===========================================================================

describe('isDynamic()', () => {
  test('detects {param} segments', () => {
    assert.equal(isDynamic('{id}'), true);
    assert.equal(isDynamic('{path}'), true);
  });

  test('detects ${param} segments', () => {
    assert.equal(isDynamic('${id}'), true);
  });

  test('detects __placeholder__', () => {
    assert.equal(isDynamic('__placeholder__'), true);
  });

  test('returns false for static segments', () => {
    assert.equal(isDynamic('api'), false);
    assert.equal(isDynamic('users'), false);
    assert.equal(isDynamic('max-users'), false);
  });
});

// ===========================================================================
// stripQueryString() — query string removal from path
// ===========================================================================

describe('stripQueryString()', () => {
  test('strips query string from path with single param', () => {
    assert.equal(stripQueryString('/api/v1/tasks?status=idle'), '/api/v1/tasks');
  });

  test('strips query string from path with multiple params', () => {
    assert.equal(
      stripQueryString('/api/v1/tasks?status=idle&limit=2&offset=10'),
      '/api/v1/tasks',
    );
  });

  test('returns path unchanged when no query string', () => {
    assert.equal(stripQueryString('/api/v1/tasks'), '/api/v1/tasks');
  });

  test('handles path with no query string but with dynamic segment', () => {
    assert.equal(stripQueryString('/api/v1/queues/{name}/tasks'), '/api/v1/queues/{name}/tasks');
  });

  test('strips query string from path with dynamic segment', () => {
    assert.equal(
      stripQueryString('/api/v1/queues/{name}/tasks?status=idle'),
      '/api/v1/queues/{name}/tasks',
    );
  });

  test('handles empty query string (just ?)', () => {
    assert.equal(stripQueryString('/api/v1/tasks?'), '/api/v1/tasks');
  });
});

// ===========================================================================
// Query string in path: end-to-end matcher + parameter coverage
// ===========================================================================

describe('matchTests() — query string in path does not break matching', () => {
  test('test with query params in path matches spec endpoint', () => {
    const specs = [
      makeSpecEndpointWithParams('GET', '/api/v1/tasks', [
        { name: 'status', in: 'query', required: false },
        { name: 'limit', in: 'query', required: false },
      ]),
    ];
    const tests = [
      makeTestWithParams('GET', '/api/v1/tasks?status=idle&limit=2', ['status', 'limit'], 200),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'GET /api/v1/tasks');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('test with single query param in path matches spec endpoint', () => {
    const specs = [
      makeSpecEndpointWithParams('GET', '/api/v1/tasks', [
        { name: 'status', in: 'query', required: false },
      ]),
    ];
    const tests = [
      makeTestWithParams('GET', '/api/v1/tasks?status=idle', ['status'], 200),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'GET /api/v1/tasks');
    assert.equal(specs[0]!.tests.length, 1);
  });

  test('test with query params in dynamic path matches spec endpoint', () => {
    const specs = [
      makeSpecEndpointWithParams('GET', '/api/v1/queues/{name}/tasks', [
        { name: 'status', in: 'query', required: false },
        { name: 'limit', in: 'query', required: false },
      ]),
    ];
    const tests = [
      makeTestWithParams(
        'GET',
        '/api/v1/queues/dev/tasks?status=idle&limit=2',
        ['status', 'limit'],
        200,
      ),
    ];

    matchTests(tests, specs);

    assert.equal(tests[0]!.matchedSpecKey, 'GET /api/v1/queues/{name}/tasks');
    assert.equal(specs[0]!.tests.length, 1);
  });
});

describe('computeParameterCoverage() — query params from path are detected', () => {
  test('query params in path: field are marked as tested', () => {
    const specs = [
      makeSpecEndpointWithParams('GET', '/api/v1/tasks', [
        { name: 'status', in: 'query', required: false },
        { name: 'limit', in: 'query', required: false },
        { name: 'offset', in: 'query', required: false },
      ]),
    ];
    const tests = [
      makeTestWithParams('GET', '/api/v1/tasks?status=idle&limit=2', ['status', 'limit'], 200),
      makeTestWithParams('GET', '/api/v1/tasks?offset=10', ['offset'], 200),
    ];

    matchTests(tests, specs);
    const coverage = computeParameterCoverage(specs);

    assert.equal(coverage.length, 1);
    const params = coverage[0]!.parameters;
    assert.equal(params.find(p => p.name === 'status')!.tested, true);
    assert.equal(params.find(p => p.name === 'limit')!.tested, true);
    assert.equal(params.find(p => p.name === 'offset')!.tested, true);
    assert.equal(coverage[0]!.testedCount, 3);
    assert.equal(coverage[0]!.hasUntested, false);
  });

  test('untested query params are still flagged when not all are exercised', () => {
    const specs = [
      makeSpecEndpointWithParams('GET', '/api/v1/tasks', [
        { name: 'status', in: 'query', required: false },
        { name: 'limit', in: 'query', required: false },
        { name: 'offset', in: 'query', required: false },
      ]),
    ];
    const tests = [
      makeTestWithParams('GET', '/api/v1/tasks?status=idle', ['status'], 200),
    ];

    matchTests(tests, specs);
    const coverage = computeParameterCoverage(specs);

    assert.equal(coverage[0]!.testedCount, 1);
    assert.equal(coverage[0]!.hasUntested, true);
    const params2 = coverage[0]!.parameters;
    assert.equal(params2.find(p => p.name === 'status')!.tested, true);
    assert.equal(params2.find(p => p.name === 'limit')!.tested, false);
    assert.equal(params2.find(p => p.name === 'offset')!.tested, false);
  });
});
