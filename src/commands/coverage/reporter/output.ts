/**
 * src/commands/coverage/reporter/output.ts
 * Shared output helper — handles --out file writing and stdout.
 */

import { writeFileSync, mkdirSync, writeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Writes content to a file (if outFile is given) or stdout.
 *
 * For stdout we write synchronously to fd 1. This is critical for large
 * payloads (e.g. `--format json` against a big spec can exceed 64KB): the
 * default `process.stdout.write` is asynchronous when stdout is a pipe, and
 * the CLI calls `process.exit()` immediately after the command returns, which
 * truncates any buffered data at the stream highWaterMark (65536 bytes).
 * Synchronous writes guarantee the full payload is flushed before exit.
 *
 * Strips ANSI color codes when writing to a file.
 */
export function writeOutput(content: string, outFile?: string): void {
  if (outFile) {
    const absPath = resolve(outFile);
    const dir = dirname(absPath);
    mkdirSync(dir, { recursive: true });
    // Strip ANSI escape codes for file output
    const cleanContent = content.replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(absPath, cleanContent, 'utf8');
    console.log(`Report written to ${outFile}`);
  } else {
    // Synchronous write to stdout (fd 1) — avoids truncation on process.exit().
    writeSync(1, content + '\n');
  }
}
