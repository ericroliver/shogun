/**
 * src/snapshots/dtai-api-provider.ts
 * DTAI REST API snapshot provider.
 *
 * Calls the existing DTAI snapshot endpoints:
 *   POST   /api/Snapshot               — create snapshot
 *   POST   /api/Snapshot/restore       — restore from snapshot
 *   DELETE /api/Snapshot/{name}        — delete snapshot
 *   GET    /api/Snapshot/{db}/snapshots — list snapshots for a database
 *   GET    /api/Snapshot/{db}/snapshots/{name} — check if specific snapshot exists
 *
 * The DTAI API currently has no authentication but will add bearer token
 * auth in the future. The auth_token config field is optional and sent
 * as Authorization: Bearer <token> when present.
 *
 * Limitations of SQL Server snapshots (handled by DTAI API):
 *   - One snapshot per source database maximum
 *   - Restore kills all active connections (SINGLE_USER with ROLLBACK IMMEDIATE)
 *   - Snapshot names must be valid SQL identifiers (no hyphens, spaces, etc.)
 */

import type { SnapshotProvider } from './provider.js';
import type { SnapshotResult, SnapshotInfo, SnapshotProviderConfig } from '../types.js';
import { interpolateEnv } from '../loader.js';
import type { EnvVars } from '../types.js';

export class DtaiApiProvider implements SnapshotProvider {
  readonly name = 'dtai-api';

  private baseUrl: string;
  private authToken: string | undefined;
  private timeout: number;

  constructor(config: SnapshotProviderConfig, env: EnvVars) {
    this.baseUrl = config.base_url ? interpolateEnv(config.base_url, env) : '';
    this.authToken = config.auth_token ? interpolateEnv(config.auth_token, env) : undefined;
    this.timeout = config.timeout ?? 30;

    if (!this.baseUrl) {
      throw new Error(
        'dtai-api snapshot provider requires base_url. ' +
        'Set snapshots.providers.<name>.base_url in shogun.config.yaml ' +
        'or BASE_URL in your env file.'
      );
    }

    // Remove trailing slash for clean URL construction
    this.baseUrl = this.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      h['Authorization'] = `Bearer ${this.authToken}`;
    }
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);
    try {
      const res = await fetch(url, {
        ...options,
        headers: { ...this.headers(), ...(options.headers as Record<string, string>) },
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate that a name is a valid SQL identifier.
   * SQL Server identifiers: letters, digits, @, #, $, underscore. Cannot start with a digit.
   */
  private validateIdentifier(name: string, label: string): void {
    if (!name || name.trim() === '') {
      throw new Error(`${label} cannot be empty.`);
    }
    if (!/^[A-Za-z_@#$][A-Za-z0-9_@#$]*$/.test(name)) {
      throw new Error(
        `${label} "${name}" is not a valid SQL identifier. ` +
        'Use only letters, digits, underscores, @, #, $. Cannot start with a digit. ' +
        'Hyphens and spaces are not allowed.'
      );
    }
  }

  async create(database: string, snapshotName: string): Promise<SnapshotResult> {
    this.validateIdentifier(database, 'Database name');
    this.validateIdentifier(snapshotName, 'Snapshot name');

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/Snapshot`, {
        method: 'POST',
        body: JSON.stringify({ databaseName: database, snapshotName }),
      });

      if (res.ok) {
        return {
          success: true,
          message: `Snapshot "${snapshotName}" created for database "${database}".`,
          snapshotName,
        };
      }

      // Try to extract error message from response body
      const body = await this.safeParseBody(res);
      const msg = body?.error || body?.message || res.statusText;
      return {
        success: false,
        message: `Failed to create snapshot "${snapshotName}": ${msg}`,
        snapshotName,
      };
    } catch (err) {
      return {
        success: false,
        message: `Error creating snapshot "${snapshotName}": ${err instanceof Error ? err.message : String(err)}`,
        snapshotName,
      };
    }
  }

  async restore(database: string, snapshotName: string): Promise<SnapshotResult> {
    this.validateIdentifier(database, 'Database name');
    this.validateIdentifier(snapshotName, 'Snapshot name');

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/Snapshot/restore`, {
        method: 'POST',
        body: JSON.stringify({ databaseName: database, snapshotName }),
      });

      if (res.ok) {
        return {
          success: true,
          message: `Database "${database}" restored from snapshot "${snapshotName}".`,
          snapshotName,
        };
      }

      const body = await this.safeParseBody(res);
      const msg = body?.error || body?.message || res.statusText;
      return {
        success: false,
        message: `Failed to restore snapshot "${snapshotName}": ${msg}`,
        snapshotName,
      };
    } catch (err) {
      return {
        success: false,
        message: `Error restoring snapshot "${snapshotName}": ${err instanceof Error ? err.message : String(err)}`,
        snapshotName,
      };
    }
  }

  async delete(snapshotName: string): Promise<SnapshotResult> {
    this.validateIdentifier(snapshotName, 'Snapshot name');

    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/api/Snapshot/${encodeURIComponent(snapshotName)}`,
        { method: 'DELETE' },
      );

      if (res.ok) {
        return {
          success: true,
          message: `Snapshot "${snapshotName}" deleted.`,
          snapshotName,
        };
      }

      if (res.status === 404) {
        return {
          success: false,
          message: `Snapshot "${snapshotName}" not found.`,
          snapshotName,
        };
      }

      const body = await this.safeParseBody(res);
      const msg = body?.error || body?.message || res.statusText;
      return {
        success: false,
        message: `Failed to delete snapshot "${snapshotName}": ${msg}`,
        snapshotName,
      };
    } catch (err) {
      return {
        success: false,
        message: `Error deleting snapshot "${snapshotName}": ${err instanceof Error ? err.message : String(err)}`,
        snapshotName,
      };
    }
  }

  async list(database?: string): Promise<SnapshotInfo[]> {
    const dbSegment = database ? encodeURIComponent(database) : '';
    const url = database
      ? `${this.baseUrl}/api/Snapshot/${dbSegment}/snapshots`
      : `${this.baseUrl}/api/Snapshot/snapshots`;

    try {
      const res = await this.fetchWithTimeout(url, { method: 'GET' });

      if (!res.ok) {
        const body = await this.safeParseBody(res);
        const msg = body?.error || body?.message || res.statusText;
        throw new Error(`Failed to list snapshots: ${msg}`);
      }

      const data = await res.json() as Record<string, unknown> | unknown[];
      const snapshots: unknown[] = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.snapshots as unknown[] ?? []);
      return snapshots.map((s) => {
        const snap = s as Record<string, unknown>;
        return {
        snapshotName: String(snap.snapshotName ?? snap.snapshot_name ?? snap.name ?? ''),
        sourceDatabase: String(snap.sourceDatabase ?? snap.source_database ?? snap.databaseName ?? snap.database ?? ''),
        createdTime: String(snap.createdTime ?? snap.created_time ?? snap.createdAt ?? ''),
        sizeInBytes: typeof snap.sizeInBytes === 'number' ? snap.sizeInBytes : (snap.size_in_bytes as number | undefined),
        status: typeof snap.status === 'string' ? snap.status : undefined,
      };
      });
    } catch (err) {
      throw new Error(`Error listing snapshots: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async exists(database: string, snapshotName: string): Promise<boolean> {
    this.validateIdentifier(database, 'Database name');
    this.validateIdentifier(snapshotName, 'Snapshot name');

    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/api/Snapshot/${encodeURIComponent(database)}/snapshots/${encodeURIComponent(snapshotName)}`,
        { method: 'GET' },
      );
      return res.ok;
    } catch {
      // Network errors → treat as "does not exist"
      return false;
    }
  }

  /**
   * Safely parse JSON response body, returning null if parsing fails.
   */
  private async safeParseBody(res: Response): Promise<Record<string, unknown> | null> {
    try {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
}
