/**
 * src/backend-factory.ts
 * Backend selection and factory.
 *
 * Selection hierarchy (highest priority first):
 *   1. --backend CLI flag
 *   2. SHOGUN_BACKEND env var
 *   3. OS detection (Windows → powershell, else unix)
 */

import type { BackendExecutor } from './backend-interface.js';
import { UnixBackend } from './backends/unix-backend.js';
import { PowerShellBackend } from './backends/powershell-backend.js';

/**
 * Create a backend instance based on the selection hierarchy.
 * @param cliBackend - Value of --backend CLI flag (if provided)
 */
export function createBackend(cliBackend?: string): BackendExecutor {
  // 1. CLI flag (highest priority)
  if (cliBackend === 'powershell') {
    return new PowerShellBackend();
  }
  if (cliBackend === 'unix') {
    return new UnixBackend();
  }
  if (cliBackend) {
    throw new Error(
      `Invalid --backend value: "${cliBackend}". Valid values: unix, powershell`
    );
  }

  // 2. SHOGUN_BACKEND env var
  const envVar = (process.env.SHOGUN_BACKEND ?? '').toLowerCase().trim();
  if (envVar === 'powershell') {
    return new PowerShellBackend();
  }
  if (envVar === 'unix') {
    return new UnixBackend();
  }

  // 3. OS detection (default)
  const defaultBackend = process.platform === 'win32' ? 'powershell' : 'unix';
  return defaultBackend === 'powershell'
    ? new PowerShellBackend()
    : new UnixBackend();
}

/**
 * Return a human-readable string describing how the backend was selected.
 * Useful for `shogun check-backend` output.
 */
export function getBackendSource(cliBackend?: string): string {
  if (cliBackend) {
    return '--backend CLI flag';
  }
  if (process.env.SHOGUN_BACKEND) {
    return 'SHOGUN_BACKEND env var';
  }
  return `OS detection (platform: ${process.platform})`;
}
