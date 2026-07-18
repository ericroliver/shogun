/**
 * src/commands/check-backend.ts
 *
 * `shogun check-backend` — show active backend, its source, and dependency status.
 *
 * Exit code: 0 if backend is ready, 1 if not.
 */

import { createBackend, getBackendSource } from '../backend-factory.js';
import type { DependencyCheck } from '../backend-interface.js';

interface CheckBackendOptions {
  backend?: string;
}

export async function checkBackend(opts: CheckBackendOptions): Promise<number> {
  const backend = createBackend(opts.backend);
  const source = getBackendSource(opts.backend);

  console.log(`Backend: ${backend.name}`);
  console.log(`Source: ${source}`);
  console.log('');

  console.log('Dependencies:');

  let deps: DependencyCheck[];
  try {
    deps = await backend.checkDependencies();
  } catch (err: any) {
    console.error(`Status: Error`);
    console.error(`Error: ${err.message}`);
    return 1;
  }

  for (const dep of deps) {
    const icon = dep.found ? '✅' : '❌';
    const version = dep.version ? ` (v${dep.version})` : '';
    const note = dep.optional ? ' (not required for this backend)' : '';
    console.log(`  ${icon} ${dep.name}${version}${note}`);
  }

  const requiredDeps = deps.filter(d => !d.optional);
  const allFound = requiredDeps.every(d => d.found);

  console.log('');
  console.log(`Status: ${allFound ? 'Ready' : 'Not ready'}`);

  if (!allFound) {
    const missing = requiredDeps.filter(d => !d.found).map(d => d.name);
    console.log(`Error: Missing dependencies: ${missing.join(', ')}`);
    console.log(`Fix: Install missing dependencies, or run with --backend ${backend.name === 'unix' ? 'powershell' : 'unix'}`);
    return 1;
  }

  return 0;
}
