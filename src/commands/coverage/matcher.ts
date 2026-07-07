/**
 * src/commands/coverage/matcher.ts
 * Three-tier path matching algorithm.
 */

import type { TestEntry, SpecEndpoint } from './types.js';

export function matchTests(testEntries: TestEntry[], specEndpoints: SpecEndpoint[]): void {
  for (const test of testEntries) {
    const match = matchTestToSpecEndpoint(test.method, test.staticPath, specEndpoints);
    if (match) {
      test.matchedSpecKey = `${match.method} ${match.path}`;
      match.tests.push(test);
    }
  }
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
