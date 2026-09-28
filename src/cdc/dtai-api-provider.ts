/**
 * src/cdc/dtai-api-provider.ts
 * DTAI REST API CDC provider.
 *
 * Calls the DTAI CDC endpoints:
 *   POST /api/cdc/start    — start CDC monitoring
 *   POST /api/cdc/stop     — stop CDC, capture data, disable CDC
 *   POST /api/cdc/capture   — capture without stopping (intermediate)
 *   POST /api/cdc/compare   — compare two captures
 *
 * The auth_token config field is optional and sent as
 * Authorization: Bearer <token> when present.
 */

import type { CdcProvider } from './provider.js';
import type {
  CdcStartResult,
  CdcCaptureResult,
  CdcCompareResult,
  CdcProviderConfig,
  CdcComparisonFailure,
} from '../types.js';
import { interpolateEnv } from '../loader.js';
import type { EnvVars } from '../types.js';

export class DtaiApiCdcProvider implements CdcProvider {
  readonly name = 'dtai-api';

  private baseUrl: string;
  private authToken: string | undefined;
  private timeout: number;

  constructor(config: CdcProviderConfig, env: EnvVars) {
    this.baseUrl = config.base_url ? interpolateEnv(config.base_url, env) : '';
    this.authToken = config.auth_token ? interpolateEnv(config.auth_token, env) : undefined;
    this.timeout = config.timeout ?? 30;

    if (!this.baseUrl) {
      throw new Error(
        'dtai-api CDC provider requires base_url. ' +
        'Set cdc.providers.<name>.base_url in shogun.config.yaml ' +
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

  async start(
    sessionName: string,
    tablesToInclude?: string[],
    tablesToExclude?: string[],
  ): Promise<CdcStartResult> {
    if (!sessionName) {
      throw new Error('CDC start requires a session name.');
    }

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/cdc/start`, {
        method: 'POST',
        body: JSON.stringify({
          sessionName,
          tablesToInclude: tablesToInclude ?? null,
          tablesToExclude: tablesToExclude ?? null,
        }),
      });

      const body = await this.safeParseBody(res);
      if (res.ok && body?.success) {
        return {
          success: true,
          sessionName: String(body.sessionName ?? sessionName),
          message: String(body.message ?? 'CDC started successfully'),
          tablesEnabled: Array.isArray(body.tablesEnabled) ? body.tablesEnabled as string[] : [],
          tablesSkipped: Array.isArray(body.tablesSkipped) ? body.tablesSkipped as string[] : [],
          errors: Array.isArray(body.errors) ? body.errors as string[] : [],
        };
      }

      const msg = body?.error || body?.message || res.statusText;
      return {
        success: false,
        sessionName,
        message: `Failed to start CDC: ${msg}`,
        tablesEnabled: [],
        tablesSkipped: [],
        errors: [String(msg)],
      };
    } catch (err) {
      return {
        success: false,
        sessionName,
        message: `Error starting CDC: ${err instanceof Error ? err.message : String(err)}`,
        tablesEnabled: [],
        tablesSkipped: [],
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  async stop(
    sessionName: string,
    captureName: string,
    captureType?: string,
  ): Promise<CdcCaptureResult> {
    if (!sessionName) throw new Error('CDC stop requires a session name.');
    if (!captureName) throw new Error('CDC stop requires a capture name.');

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/cdc/stop`, {
        method: 'POST',
        body: JSON.stringify({
          sessionName,
          captureName,
          captureType: captureType ?? 'Baseline',
        }),
      });

      const body = await this.safeParseBody(res);
      if (res.ok && body?.success) {
        return {
          success: true,
          sessionName: String(body.sessionName ?? sessionName),
          captureName: String(body.captureName ?? captureName),
          message: String(body.message ?? 'CDC stopped and captured successfully'),
          tablesWithChanges: Array.isArray(body.tablesWithChanges) ? body.tablesWithChanges as string[] : [],
          totalRecords: typeof body.totalRecords === 'number' ? body.totalRecords : 0,
          captureId: body.captureId ? String(body.captureId) : undefined,
          errors: Array.isArray(body.errors) ? body.errors as string[] : [],
        };
      }

      const msg = body?.error || body?.message || res.statusText;
      return {
        success: false,
        sessionName,
        captureName,
        message: `Failed to stop CDC: ${msg}`,
        tablesWithChanges: [],
        totalRecords: 0,
        errors: [String(msg)],
      };
    } catch (err) {
      return {
        success: false,
        sessionName,
        captureName,
        message: `Error stopping CDC: ${err instanceof Error ? err.message : String(err)}`,
        tablesWithChanges: [],
        totalRecords: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  async capture(
    sessionName: string,
    captureName: string,
    captureType?: string,
  ): Promise<CdcCaptureResult> {
    if (!sessionName) throw new Error('CDC capture requires a session name.');
    if (!captureName) throw new Error('CDC capture requires a capture name.');

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/cdc/capture`, {
        method: 'POST',
        body: JSON.stringify({
          sessionName,
          captureName,
          captureType: captureType ?? 'Intermediate',
        }),
      });

      const body = await this.safeParseBody(res);
      if (res.ok && body?.success) {
        return {
          success: true,
          sessionName: String(body.sessionName ?? sessionName),
          captureName: String(body.captureName ?? captureName),
          captureType: String(body.captureType ?? captureType ?? 'Intermediate'),
          message: String(body.message ?? 'CDC data captured successfully'),
          tablesWithChanges: Array.isArray(body.tablesWithChanges) ? body.tablesWithChanges as string[] : [],
          totalRecords: typeof body.totalRecords === 'number' ? body.totalRecords : 0,
          captureId: body.captureId ? String(body.captureId) : undefined,
          errors: Array.isArray(body.errors) ? body.errors as string[] : [],
        };
      }

      const msg = body?.error || body?.message || res.statusText;
      return {
        success: false,
        sessionName,
        captureName,
        message: `Failed to capture CDC: ${msg}`,
        tablesWithChanges: [],
        totalRecords: 0,
        errors: [String(msg)],
      };
    } catch (err) {
      return {
        success: false,
        sessionName,
        captureName,
        message: `Error capturing CDC: ${err instanceof Error ? err.message : String(err)}`,
        tablesWithChanges: [],
        totalRecords: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  async compare(
    baselineCaptureName: string,
    testCaptureName: string,
    fieldsToIgnore?: string[],
    ignoreLsnDifferences?: boolean,
  ): Promise<CdcCompareResult> {
    if (!baselineCaptureName) throw new Error('CDC compare requires a baseline capture name.');
    if (!testCaptureName) throw new Error('CDC compare requires a test capture name.');

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/cdc/compare`, {
        method: 'POST',
        body: JSON.stringify({
          baselineCaptureName,
          testCaptureName,
          fieldsToIgnore: fieldsToIgnore ?? [],
          ignoreLsnDifferences: ignoreLsnDifferences ?? true,
        }),
      });

      const body = await this.safeParseBody(res);
      if (res.ok) {
        const summary = (body?.summary ?? {}) as Record<string, unknown>;
        return {
          isMatch: Boolean(body?.isMatch),
          failures: Array.isArray(body?.failures)
            ? (body.failures as unknown[]).map((f) => {
                const fl = f as Record<string, unknown>;
                return {
                  tableName: String(fl.tableName ?? ''),
                  failureType: String(fl.failureType ?? ''),
                  primaryKey: fl.primaryKey,
                  fieldName: fl.fieldName ? String(fl.fieldName) : undefined,
                  baselineValue: fl.baselineValue,
                  testValue: fl.testValue,
                  description: String(fl.description ?? ''),
                } satisfies CdcComparisonFailure;
              })
            : [],
          summary: {
            tablesCompared: typeof summary.tablesCompared === 'number' ? summary.tablesCompared : 0,
            recordsCompared: typeof summary.recordsCompared === 'number' ? summary.recordsCompared : 0,
            fieldsCompared: typeof summary.fieldsCompared === 'number' ? summary.fieldsCompared : 0,
            totalFailures: typeof summary.totalFailures === 'number' ? summary.totalFailures : 0,
            tablesWithFailures: typeof summary.tablesWithFailures === 'number' ? summary.tablesWithFailures : 0,
          },
          errors: Array.isArray(body?.errors) ? body.errors as string[] : [],
        };
      }

      const msg = body?.error || body?.message || res.statusText;
      return {
        isMatch: false,
        failures: [],
        summary: {
          tablesCompared: 0,
          recordsCompared: 0,
          fieldsCompared: 0,
          totalFailures: 0,
          tablesWithFailures: 0,
        },
        errors: [String(msg)],
      };
    } catch (err) {
      return {
        isMatch: false,
        failures: [],
        summary: {
          tablesCompared: 0,
          recordsCompared: 0,
          fieldsCompared: 0,
          totalFailures: 0,
          tablesWithFailures: 0,
        },
        errors: [err instanceof Error ? err.message : String(err)],
      };
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
