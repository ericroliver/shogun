/**
 * src/backend-global.ts
 *
 * Provides a global accessor for the active BackendExecutor.
 * This breaks a circular dependency between executor.ts and asserter.ts:
 *
 *   index.ts → creates backend → calls initExecutor + initAsserter
 *   executor.ts → uses backend.executeRequest()
 *   asserter.ts → uses backend for shape/snapshot (via getActiveBackend())
 *
 * Both executor and asserter import FROM this file rather than from each other.
 */

import type { BackendExecutor } from './backend-interface.js';

let _activeBackend: BackendExecutor | null = null;

/** Called once at startup by index.ts after backend is created. */
export function setActiveBackend(backend: BackendExecutor): void {
  _activeBackend = backend;
}

/** Returns the active backend. Throws if not yet initialized. */
export function getActiveBackend(): BackendExecutor {
  if (!_activeBackend) {
    throw new Error(
      'Backend not initialized. ' +
      'Call setActiveBackend() from index.ts before running tests.'
    );
  }
  return _activeBackend;
}
