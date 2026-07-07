/**
 * src/commands/coverage/reporter/markdown.ts
 * Markdown table output — sorted by tag, method, path.
 */

import type {
  CoverageSummary,
  SpecEndpoint,
  EndpointResponseCodeCoverage,
} from '../types.js';

export function renderMarkdown(
  summary: CoverageSummary,
  specEndpoints: SpecEndpoint[],
  uncoveredOnly: boolean,
  responseCodeCoverage?: EndpointResponseCodeCoverage[],
): void {
  console.log('## API Coverage Report\n');
  console.log(
    `> ${summary.coveredEndpoints} / ${summary.totalEndpoints} endpoints covered ` +
    `(${summary.coveragePct}%) · ${summary.totalTests} tests · ${summary.collections} collections\n`
  );

  // Build a lookup for response code coverage by specKey
  const rccMap = new Map<string, EndpointResponseCodeCoverage>();
  if (responseCodeCoverage) {
    for (const rcc of responseCodeCoverage) {
      rccMap.set(rcc.specKey, rcc);
    }
  }

  // Sort endpoints by tag, then method, then path
  const sorted = [...specEndpoints].sort((a, b) => {
    const tagA = a.tag ?? '(untagged)';
    const tagB = b.tag ?? '(untagged)';
    if (tagA !== tagB) return tagA.localeCompare(tagB);
    if (a.method !== b.method) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });

  console.log('| Status | Method | Endpoint | Tests | Response Codes | Tag | Collections |');
  console.log('|--------|--------|----------|-------|----------------|-----|-------------|');

  for (const ep of sorted) {
    if (uncoveredOnly && ep.tests.length > 0) continue;
    const status = ep.tests.length > 0 ? '✅' : '❌';
    const testCount = ep.tests.length > 0 ? String(ep.tests.length) : '0';
    const rcc = rccMap.get(`${ep.method} ${ep.path}`);
    const responseCodes = rcc
      ? `${rcc.coveredCount}/${rcc.totalSpecCodes}`
      : '0/0';
    const tag = ep.tag ?? '(untagged)';
    const collectionNames = ep.tests.length > 0
      ? [...new Set(ep.tests.map(t => t.collection))].join(', ')
      : '—';
    console.log(`| ${status} | ${ep.method} | \`${ep.path}\` | ${testCount} | ${responseCodes} | ${tag} | ${collectionNames} |`);
  }
}
