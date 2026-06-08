/**
 * src/executor.ts
 *
 * Thin wrapper — delegates HTTP execution to the active BackendExecutor.
 *
 * The actual curl logic now lives in:
 *   src/backends/unix-backend.ts  (Unix/curl backend)
 *   src/backends/powershell-backend.ts  (PowerShell backend — future)
 *
 * The backend is set once at startup via initExecutor().
 * Called from index.ts after CLI flag parsing.
 */

import type { ShogunRequest, ShogunResponse, EnvVars } from './types.js';
import type { ExecutorOptions } from './backend-interface.js';

import { getActiveBackend, setActiveBackend } from './backend-global.js';

/**
 * Initialize the executor with a specific backend.
 * Must be called before any executeRequest() call.
 */
export function initExecutor(backend: unknown): void {
  setActiveBackend(backend as any);
}

/**
 * Execute an HTTP request using the active backend.
 * Delegates to backend.executeRequest().
 */
export async function executeRequest(
  req: ShogunRequest,
  env: EnvVars,
  opts: ExecutorOptions = {},
): Promise<ShogunResponse> {
  const backend = getActiveBackend();
  return backend.executeRequest(req, env, opts);
}

/**
 * Verify backend dependencies are available.
 * Delegates to backend.checkDependencies().
 * Throws if required dependencies are missing.
 */
export async function checkDependencies(): Promise<void> {
  const backend = getActiveBackend();

  const missing = await backend.checkDependencies();
  const required = missing.filter(d => !d.optional && !d.found);

  if (required.length > 0) {
    throw new Error(
      `Missing dependencies for ${backend.name} backend: ` +
      required.map(d => d.name).join(', ') + '\n' +
      `Install them and try again, or use --backend to switch backend.`
    );
  }
}
