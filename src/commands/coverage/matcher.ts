/**
 * src/commands/coverage/matcher.ts
 * Three-tier path matching algorithm.
 */

import type { TestEntry, SpecEndpoint } from './types.js';

/**
 * Match all test entries to spec endpoints.
 *
 * Three matching strategies (in priority order):
 * 1. Explicit `covers` annotations — link test to declared endpoint(s)
 * 2. Normal method+path matching (three-tier algorithm)
 *    2b. If test asserts 405, also credit additional spec endpoints at
 *        child paths that document 405 (parent-path multi-child crediting)
 * 3. Method-agnostic 405 fallback — if the test asserts 405 and the normal
 *    matching found nothing, credit it to spec endpoints at the same path
 *    that document 405, regardless of method
 */
export function matchTests(testEntries: TestEntry[], specEndpoints: SpecEndpoint[]): void {
  for (const test of testEntries) {
    // 1. Handle explicit `covers` annotations
    if (test.covers && test.covers.length > 0) {
      for (const cover of test.covers) {
        const specKey = cover.endpoint;
        const ep = specEndpoints.find(e => `${e.method} ${e.path}` === specKey);
        if (ep) {
          ep.tests.push(test);
          // If this test hasn't been matched yet, use the first covers entry
          if (!test.matchedSpecKey) {
            test.matchedSpecKey = specKey;
          }
        }
      }
      // If covers matched at least one endpoint, we're done with this test
      if (test.matchedSpecKey) continue;
    }

    // 2. Normal method+path matching
    const match = matchTestToSpecEndpoint(test.method, test.staticPath, specEndpoints);
    if (match) {
      test.matchedSpecKey = `${match.method} ${match.path}`;
      match.tests.push(test);

      // 2b. If test asserts 405, also credit additional spec endpoints at
      // child paths that document 405 (parent-path multi-child crediting).
      // credit405MethodGuard avoids double-adding tests already in ep.tests.
      if (test.expectedStatus === 405) {
        credit405MethodGuard(test, specEndpoints);
      }
      continue;
    }

    // 3. Method-agnostic 405 fallback
    // If the test asserts 405 and normal matching found nothing (e.g. method
    // mismatch), credit it to all spec endpoints at the same path that
    // document 405, regardless of method.
    if (test.expectedStatus === 405) {
      const credited = credit405MethodGuard(test, specEndpoints);
      if (credited) continue;
    }
  }
}

/**
 * Credit a 405 method-guard test to spec endpoints at the same path that
 * document 405, regardless of method. This handles the common case of
 * method-guard tests that intentionally send a wrong HTTP method.
 *
 * Also handles parent-path tests: a test at PUT /api/admin/config asserting
 * 405 will credit 405 on all child spec endpoints (e.g. /api/admin/config/max-users)
 * that document 405.
 *
 * Returns true if at least one spec endpoint was credited.
 */
function credit405MethodGuard(
  test: TestEntry,
  specEndpoints: SpecEndpoint[],
): boolean {
  const testPath = test.staticPath;
  const testSegs = testPath.split('/');

  // Find all spec endpoints at the same path (or child paths) that document 405
  const matchingEndpoints = specEndpoints.filter(ep => {
    // Must document 405
    if (!ep.documentedResponseCodes.includes('405')) return false;

    // Match on path — same path or parent path
    // Use the same path matching logic: exact, template, or prefix
    if (pathsMatch(testPath, testSegs, ep.path)) return true;

    // Parent-path: test path is a prefix of spec path
    if (ep.path.startsWith(testPath + '/')) return true;

    return false;
  });

  if (matchingEndpoints.length === 0) return false;

  for (const ep of matchingEndpoints) {
    // Avoid double-adding if already in ep.tests
    if (!ep.tests.includes(test)) {
      ep.tests.push(test);
    }
  }

  // Set matchedSpecKey only if not already set (e.g. by normal matching)
  if (!test.matchedSpecKey) {
    test.matchedSpecKey = `${matchingEndpoints[0]!.method} ${matchingEndpoints[0]!.path}`;
  }
  return true;
}

/**
 * Check if a test path matches a spec path using the same logic as the
 * three-tier matcher (exact, template, or prefix).
 */
function pathsMatch(testPath: string, testSegs: string[], specPath: string): boolean {
  // Exact match
  if (specPath === testPath) return true;

  // Template match with wildcards
  const specSegs = specPath.split('/').map(seg => /^\{.+\}$/.test(seg) ? '__W__' : seg);
  const testSegsNorm = testSegs.map(seg => isDynamic(seg) ? '__W__' : seg);

  // Same segment count with template matching
  if (specSegs.length === testSegsNorm.length) {
    let mismatch = false;
    for (let i = 0; i < testSegsNorm.length; i++) {
      const t = testSegsNorm[i]!;
      const s = specSegs[i]!;
      if (t === '__W__' || s === '__W__') continue;
      if (t !== s) { mismatch = true; break; }
    }
    if (!mismatch) return true;
  }

  // Prefix match (test path is a prefix of spec path or vice versa)
  return specPath === testPath ||
         specPath.startsWith(testPath + '/') ||
         testPath.startsWith(specPath + '/');
}

/**
 * Three-tier path matching algorithm.
 *
 * TIER 1: Exact match on method + path
 * TIER 2: Segment-count-equal template match (wildcard segment alignment)
 * TIER 3: Prefix fallback for multi-segment dynamic tails
 */
export function matchTestToSpecEndpoint(
  method: string,
  testPath: string,
  specEndpoints: SpecEndpoint[],
): SpecEndpoint | undefined {
  const methodUpper = method.toUpperCase();
  const sameMethod = specEndpoints.filter(e => e.method === methodUpper);

  // TIER 1 — exact match
  const exact = sameMethod.find(e => e.path === testPath);
  if (exact) return exact;

  // Normalize test path segments — replace dynamic tokens with sentinel __W__
  const testSegs = testPath.split('/').map(seg => isDynamic(seg) ? '__W__' : seg);

  // TIER 2 — same segment count, template match with scoring
  let bestCandidate: SpecEndpoint | undefined;
  let bestScore = -1;

  for (const endpoint of sameMethod) {
    const specSegs = endpoint.path.split('/').map(seg => /^\{.+\}$/.test(seg) ? '__W__' : seg);
    if (specSegs.length !== testSegs.length) continue;

    let score = 0;
    let mismatch = false;

    for (let i = 0; i < testSegs.length; i++) {
      const t = testSegs[i]!;
      const s = specSegs[i]!;
      if (t === '__W__' || s === '__W__') {
        // wildcard — counts but no score
        continue;
      }
      if (t === s) {
        score++;
      } else {
        mismatch = true;
        break;
      }
    }

    if (!mismatch && score > bestScore) {
      bestScore = score;
      bestCandidate = endpoint;
    }
  }

  if (bestCandidate) return bestCandidate;

  // TIER 3 — prefix fallback for multi-segment dynamic tails
  // Find the static prefix: segments before the first __W__
  const firstWild = testSegs.indexOf('__W__');
  const staticSegs = firstWild >= 0 ? testSegs.slice(0, firstWild) : testSegs;
  const staticPrefix = staticSegs.join('/');

  if (!staticPrefix) return undefined;

  const prefixCandidates = sameMethod.filter(e => {
    return e.path === staticPrefix ||
           e.path.startsWith(staticPrefix + '/');
  });

  if (prefixCandidates.length === 0) return undefined;

  // Pick spec path whose segment count is closest to testPath segment count
  const testSegCount = testSegs.length;
  prefixCandidates.sort((a, b) => {
    const aDiff = Math.abs(a.path.split('/').length - testSegCount);
    const bDiff = Math.abs(b.path.split('/').length - testSegCount);
    return aDiff - bDiff;
  });

  return prefixCandidates[0];
}

export function isDynamic(seg: string): boolean {
  return seg === '__placeholder__' ||
         seg.startsWith('${') ||
         (seg.includes('{') && seg.includes('}'));
}
