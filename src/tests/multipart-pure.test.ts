/**
 * src/tests/multipart-pure.test.ts
 *
 * Unit tests for multipart/form-data support:
 *   - Zod schema validation (loader.ts) for form_fields, form_files, content_type
 *   - buildBodyArg (powershell-backend.ts) rejects multipart with clear error
 *   - PowerShell buildBodyArg still works for JSON and form-encoded
 *
 * Run with:
 *   npx tsx --test src/tests/multipart-pure.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TestDefinitionSchema } from '../loader.js';
import { buildBodyArg } from '../backends/powershell-backend.js';
import type { ShogunRequest } from '../types.js';

// ===========================================================================
// Zod schema: RequestDef with content_type + form_fields + form_files
// ===========================================================================

describe('RequestDef schema — multipart validation', () => {

  test('accepts multipart with form_fields and content_type', () => {
    const yaml = {
      name: 'Upload Template',
      request: {
        method: 'POST',
        path: '/api/upload',
        content_type: 'multipart/form-data',
        body: {
          form_fields: {
            Name: 'test-template',
            Version: '1.0',
          },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(result.success, `Should parse: ${result.success ? '' : JSON.stringify(result.error.errors)}`);
  });

  test('accepts multipart with form_files', () => {
    const yaml = {
      name: 'Upload File',
      request: {
        method: 'POST',
        path: '/api/upload',
        content_type: 'multipart/form-data',
        body: {
          form_files: {
            File: {
              path: '/tmp/test.zip',
              content_type: 'application/octet-stream',
            },
          },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(result.success, `Should parse: ${result.success ? '' : JSON.stringify(result.error.errors)}`);
  });

  test('accepts multipart with both form_fields and form_files', () => {
    const yaml = {
      name: 'Upload With Metadata',
      request: {
        method: 'POST',
        path: '/api/upload',
        content_type: 'multipart/form-data',
        body: {
          form_fields: {
            Name: 'test',
            Description: 'a test file',
          },
          form_files: {
            File: {
              path: '/tmp/test.zip',
              content_type: 'application/octet-stream',
            },
            Thumbnail: {
              path: '/tmp/thumb.png',
              filename: 'thumb.png',
            },
          },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(result.success, `Should parse: ${result.success ? '' : JSON.stringify(result.error.errors)}`);
  });

  test('rejects form_fields without multipart content_type', () => {
    const yaml = {
      name: 'Bad Upload',
      request: {
        method: 'POST',
        path: '/api/upload',
        body: {
          form_fields: { Name: 'test' },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(!result.success, 'Should reject form_fields without multipart content_type');
  });

  test('rejects form_files without multipart content_type', () => {
    const yaml = {
      name: 'Bad Upload',
      request: {
        method: 'POST',
        path: '/api/upload',
        body: {
          form_files: {
            File: { path: '/tmp/test.zip' },
          },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(!result.success, 'Should reject form_files without multipart content_type');
  });

  test('accepts content_type on request without form fields (e.g. application/xml)', () => {
    const yaml = {
      name: 'XML Post',
      request: {
        method: 'POST',
        path: '/api/data',
        content_type: 'application/xml',
        body: {
          inline: { data: 'test' },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(result.success, `Should parse: ${result.success ? '' : JSON.stringify(result.error.errors)}`);
  });

  test('form_files entries require path', () => {
    const yaml = {
      name: 'Bad File Entry',
      request: {
        method: 'POST',
        path: '/api/upload',
        content_type: 'multipart/form-data',
        body: {
          form_files: {
            File: {
              content_type: 'application/octet-stream',
              // path is missing
            },
          },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(!result.success, 'Should reject form_files without path');
  });

  test('form_files entries accept optional filename and content_type', () => {
    const yaml = {
      name: 'Upload With Custom Name',
      request: {
        method: 'POST',
        path: '/api/upload',
        content_type: 'multipart/form-data',
        body: {
          form_files: {
            File: {
              path: '/tmp/test.zip',
              filename: 'custom-name.zip',
              content_type: 'application/zip',
            },
          },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(result.success, `Should parse: ${result.success ? '' : JSON.stringify(result.error.errors)}`);
  });

  test('inline body still works without content_type', () => {
    const yaml = {
      name: 'JSON Post',
      request: {
        method: 'POST',
        path: '/api/data',
        body: {
          inline: { name: 'test' },
        },
      },
    };
    const result = TestDefinitionSchema.safeParse(yaml);
    assert.ok(result.success, `Should parse: ${result.success ? '' : JSON.stringify(result.error.errors)}`);
  });
});

// ===========================================================================
// PowerShell backend: buildBodyArg rejects multipart
// ===========================================================================

describe('buildBodyArg — multipart rejection on PowerShell', () => {

  test('throws on multipart/form-data content_type', () => {
    const req: ShogunRequest = {
      method: 'POST',
      url: 'http://api.com',
      path: '/',
      headers: { 'Content-Type': 'multipart/form-data' },
      params: {},
      body: { form_fields: { Name: 'test' } },
    };
    assert.throws(
      () => buildBodyArg(req),
      /multipart\/form-data is not supported on the PowerShell backend/,
    );
  });

  test('throws when body has form_fields regardless of content_type header', () => {
    const req: ShogunRequest = {
      method: 'POST',
      url: 'http://api.com',
      path: '/',
      headers: {},
      params: {},
      body: { form_fields: { Name: 'test' } },
    };
    assert.throws(
      () => buildBodyArg(req),
      /multipart\/form-data is not supported on the PowerShell backend/,
    );
  });

  test('throws when body has form_files regardless of content_type header', () => {
    const req: ShogunRequest = {
      method: 'POST',
      url: 'http://api.com',
      path: '/',
      headers: {},
      params: {},
      body: { form_files: { File: { path: '/tmp/test.zip' } } },
    };
    assert.throws(
      () => buildBodyArg(req),
      /multipart\/form-data is not supported on the PowerShell backend/,
    );
  });

  test('JSON body still works after multipart guard', () => {
    const req: ShogunRequest = {
      method: 'POST',
      url: 'http://api.com',
      path: '/',
      headers: { 'Content-Type': 'application/json' },
      params: {},
      body: { inline: { name: 'test' } },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('$bodyStr'));
    assert.ok(result.includes('name'));
    assert.ok(result.includes('test'));
  });

  test('form-encoded body still works after multipart guard', () => {
    const req: ShogunRequest = {
      method: 'POST',
      url: 'http://api.com',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      params: {},
      body: { inline: { key: 'value' } },
    };
    const result = buildBodyArg(req);
    assert.ok(result.includes('key=value'));
  });

  test('empty body returns empty string', () => {
    const req: ShogunRequest = {
      method: 'GET',
      url: 'http://api.com',
      path: '/',
      headers: {},
      params: {},
    };
    const result = buildBodyArg(req);
    assert.equal(result, '');
  });
});
