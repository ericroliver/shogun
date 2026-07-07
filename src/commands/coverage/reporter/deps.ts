/**
 * src/commands/coverage/reporter/deps.ts
 * Test dependency graph output.
 */

import type { DependencyGraph } from '../types.js';

export function renderDeps(graph: DependencyGraph): void {
  console.log('── Dependency Graph ' + '─'.repeat(61));
  console.log('');

  if (graph.edges.length === 0 && graph.orphanedVars.length === 0) {
    console.log('No ctx.vars dependencies found in test scripts.');
    return;
  }

  // Cascade risks
  if (graph.cascadeRisks.length > 0) {
    console.log('Cascade Risks (vars with 3+ consumers):');
    for (const risk of graph.cascadeRisks) {
      console.log(`  ctx.vars.${risk.varName}  written by: ${risk.producer.collection}/${risk.producer.testName}`);
      const consumerList = risk.consumers.map(c => `${c.collection}/${c.testName}`).join(', ');
      console.log(`    consumed by: ${consumerList}`);
      console.log(`    ⚠️ If ${risk.producer.testName} fails, ${risk.consumerCount} downstream tests will fail`);
    }
    console.log('');
  }

  // Cross-collection dependencies
  if (graph.crossCollectionDeps.length > 0) {
    console.log(`Cross-Collection Dependencies (${graph.crossCollectionDeps.length}):`);
    for (const edge of graph.crossCollectionDeps) {
      console.log(`  ctx.vars.${edge.varName}  written by: ${edge.producer.collection}/${edge.producer.testName}`);
      console.log(`    consumed by: ${edge.consumer.collection}/${edge.consumer.testName}  ← cross-collection`);
    }
    console.log('');
  }

  // Orphaned vars
  if (graph.orphanedVars.length > 0) {
    console.log('Orphaned Vars (written but never read):');
    for (const orphan of graph.orphanedVars) {
      console.log(`  ctx.vars.${orphan.varName}  written by: ${orphan.writtenBy.collection}/${orphan.writtenBy.testName}`);
    }
    console.log('');
  }
}
