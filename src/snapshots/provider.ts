/**
 * src/snapshots/provider.ts
 * Generic database snapshot provider interface.
 *
 * Each provider implements this interface. Shogun dispatches to the
 * configured provider based on the --provider flag or the `default`
 * in the snapshots config section.
 *
 * First implementation: dtai-api (calls existing DTAI REST endpoints)
 * Future: mssql-direct (DDL via existing mssql driver)
 * Future: postgres-dump (pg_dump / pg_restore)
 */

import type { SnapshotResult, SnapshotInfo } from '../types.js';

/**
 * Database snapshot provider interface.
 * All methods are async — providers may make HTTP calls or direct DB connections.
 */
export interface SnapshotProvider {
  /** Provider name (e.g. "dtai-api", "mssql-direct") */
  readonly name: string;

  /**
   * Create a new snapshot of a database.
   * @param database - Source database to snapshot
   * @param snapshotName - Name for the new snapshot (must be a valid SQL identifier)
   * @returns Success/failure with descriptive message
   */
  create(database: string, snapshotName: string): Promise<SnapshotResult>;

  /**
   * Restore a database from an existing snapshot.
   * This typically kills active connections (SINGLE_USER mode).
   * @param database - Target database to restore into
   * @param snapshotName - Snapshot to restore from
   * @returns Success/failure with descriptive message
   */
  restore(database: string, snapshotName: string): Promise<SnapshotResult>;

  /**
   * Delete/drop a snapshot.
   * @param snapshotName - Snapshot to delete
   * @returns Success/failure with descriptive message
   */
  delete(snapshotName: string): Promise<SnapshotResult>;

  /**
   * List snapshots, optionally filtered by source database.
   * @param database - Optional filter by source database name
   * @returns Array of snapshot metadata
   */
  list(database?: string): Promise<SnapshotInfo[]>;

  /**
   * Check if a snapshot exists.
   * @param database - Source database (required for dtai-api, since one snapshot per DB)
   * @param snapshotName - Snapshot name to check
   * @returns true if the snapshot exists
   */
  exists(database: string, snapshotName: string): Promise<boolean>;
}
