/**
 * src/commands/snapshot.ts — shogun snapshot subcommand
 * Runs tests in snapshot-capture mode: writes expected/ baselines instead of diffing.
 */

import { runTests, AGENT_SNAPSHOT_SKIP_MSG } from '../runner.js';

export interface SnapshotArgs {
  env?: string;
  collection?: string | string[];
  suite?: string;
  file?: string;
}


export async function snapshot(args: SnapshotArgs): Promise<number> {
  console.log('📸 Capturing snapshots...\n');
  try {
    const summary = await runTests({
      env: args.env,
      collection: args.collection,
      suite: args.suite,
      file: args.file,
      snapshotMode: true,
    });

    const isAgentSkip = (r: typeof summary.results[0]) =>
      r.scriptOutput?.some(s => s.includes(AGENT_SNAPSHOT_SKIP_MSG)) ?? false;

    const captured = summary.results.filter(r => r.status === 'passed' && !isAgentSkip(r)).length;
    const skipped = summary.results.filter(isAgentSkip).length;
    console.log(`\nCaptured ${captured} snapshot(s) in expected/`);
    if (skipped > 0) {
      console.log(`Skipped ${skipped} agent test(s) — no snapshot baseline`);
    }
    return 0;
  } catch (err) {
    console.error(`Snapshot error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
