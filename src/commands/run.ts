/**
 * src/commands/run.ts — shogun run subcommand
 */

import { runTests } from '../runner.js';
import { printReport } from '../reporter.js';

export interface RunArgs {
  env?: string;
  collection?: string | string[];
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap';
  output?: string;
  params?: string;
}

export async function run(args: RunArgs): Promise<number> {
  try {
    const summary = await runTests({
      env: args.env,
      collection: args.collection,
      tags: args.tags,
      suite: args.suite,
      file: args.file,
      format: args.format,
      params: args.params,
    });

    // Write JSON output to file (for Playwright and other integrations)
    if (args.output) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.output, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    }

    if (args.format === 'json') {
      printReport(summary, 'json');
    } else if (args.format === 'tap') {
      printReport(summary, 'tap');
    }

    return summary.failed > 0 ? 1 : 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
