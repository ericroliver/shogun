/**
 * src/cdc/provider.ts
 * Generic Change Data Capture (CDC) provider interface.
 *
 * Each provider implements this interface. Shogun dispatches to the
 * configured provider based on the --provider flag or the `default`
 * in the cdc config section.
 *
 * First implementation: dtai-api (calls DTAI REST endpoints)
 */

import type {
  CdcStartResult,
  CdcCaptureResult,
  CdcCompareResult,
} from '../types.js';

/**
 * CDC provider interface.
 * All methods are async — providers make HTTP calls to a CDC API.
 */
export interface CdcProvider {
  /** Provider name (e.g. "dtai-api") */
  readonly name: string;

  /**
   * Start CDC monitoring on the database.
   * @param sessionName - Unique name for this CDC session
   * @param tablesToInclude - Optional list of tables to monitor (all if omitted)
   * @param tablesToExclude - Optional list of tables to exclude
   * @returns Result with enabled/skipped tables and any errors
   */
  start(
    sessionName: string,
    tablesToInclude?: string[],
    tablesToExclude?: string[],
  ): Promise<CdcStartResult>;

  /**
   * Stop CDC, capture data, and disable CDC.
   * @param sessionName - Session name used when starting CDC
   * @param captureName - Name for this capture
   * @param captureType - Capture type (Baseline, Replay, etc.)
   * @returns Result with captured data details
   */
  stop(
    sessionName: string,
    captureName: string,
    captureType?: string,
  ): Promise<CdcCaptureResult>;

  /**
   * Capture CDC data without stopping CDC (intermediate capture).
   * @param sessionName - Session name used when starting CDC
   * @param captureName - Name for this capture
   * @param captureType - Capture type (Intermediate, Checkpoint, etc.)
   * @returns Result with captured data details
   */
  capture(
    sessionName: string,
    captureName: string,
    captureType?: string,
  ): Promise<CdcCaptureResult>;

  /**
   * Compare two CDC captures to validate they produce identical data changes.
   * @param baselineCaptureName - Baseline/expected capture name
   * @param testCaptureName - Test capture to compare against baseline
   * @param fieldsToIgnore - Optional list of field names to ignore
   * @param ignoreLsnDifferences - Whether to ignore LSN differences (default: true)
   * @returns Comparison result with failures and summary
   */
  compare(
    baselineCaptureName: string,
    testCaptureName: string,
    fieldsToIgnore?: string[],
    ignoreLsnDifferences?: boolean,
  ): Promise<CdcCompareResult>;
}
