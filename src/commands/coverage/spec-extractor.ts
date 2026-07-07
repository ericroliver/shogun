/**
 * src/commands/coverage/spec-extractor.ts
 * Extract endpoints from an OpenAPI spec — full contract detail.
 */

import type {
  OpenApiSpec,
  PathItem,
  OperationObject,
  SpecEndpoint,
  SpecParam,
  SpecBodyField,
  ParameterObject,
  RequestBodyObject,
  SchemaObject,
  RefObject,
} from './types.js';
import { HTTP_METHODS } from './types.js';

export function extractSpecEndpoints(openApi: OpenApiSpec, tagFilter?: string): SpecEndpoint[] {
  const paths = openApi.paths ?? {};
  const tagLower = tagFilter?.toLowerCase();
  const endpoints: SpecEndpoint[] = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof PathItem] as OperationObject | undefined;
      if (!op) continue;

      // Apply tag filter (spec-side)
      if (tagLower) {
        const hasTag = op.tags?.some(t => t.toLowerCase() === tagLower) ?? false;
        if (!hasTag) continue;
      }

      endpoints.push({
        method: method.toUpperCase(),
        path: pathKey,
        tag: op.tags?.[0],
        summary: op.summary,
        tests: [],
        documentedResponseCodes: extractResponseCodes(op),
        parameters: extractParameters(op, openApi),
        requestBodyFields: extractRequestBodyFields(op, openApi),
      });
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Response codes
// ---------------------------------------------------------------------------

function extractResponseCodes(op: OperationObject): string[] {
  const responses = op.responses ?? {};
  const codes = Object.keys(responses).filter(code => code !== 'default');
  // Sort numerically
  codes.sort((a, b) => Number(a) - Number(b));
  return codes;
}

// ---------------------------------------------------------------------------
// Parameters (path + query only)
// ---------------------------------------------------------------------------

function extractParameters(op: OperationObject, openApi: OpenApiSpec): SpecParam[] {
  const rawParams = op.parameters ?? [];
  const result: SpecParam[] = [];

  for (const paramOrRef of rawParams) {
    const param = resolveParameterRef(paramOrRef, openApi);
    if (!param) continue;

    const inLower = (param.in ?? '').toLowerCase();
    if (inLower !== 'path' && inLower !== 'query') continue;

    result.push({
      name: param.name,
      in: inLower as 'path' | 'query',
      required: param.required ?? false,
    });
  }

  return result;
}

function resolveParameterRef(
  paramOrRef: ParameterObject | RefObject,
  openApi: OpenApiSpec,
): ParameterObject | undefined {
  if ('$ref' in paramOrRef) {
    const name = refName(paramOrRef['$ref']);
    const target = openApi.components?.parameters?.[name];
    return target;
  }
  return paramOrRef;
}

// ---------------------------------------------------------------------------
// Request body fields
// ---------------------------------------------------------------------------

function extractRequestBodyFields(op: OperationObject, openApi: OpenApiSpec): SpecBodyField[] {
  if (!op.requestBody) return [];

  const body = resolveRequestBodyRef(op.requestBody, openApi);
  if (!body?.content) return [];

  // Prefer application/json; fall back to first available content type
  const jsonContent = body.content['application/json'];
  const contentEntry = jsonContent ?? Object.values(body.content)[0];
  if (!contentEntry || typeof contentEntry !== 'object') return [];

  const schema = (contentEntry as { schema?: SchemaObject | RefObject }).schema;
  if (!schema) return [];

  return extractTopLevelFields(schema, openApi);
}

function resolveRequestBodyRef(
  bodyOrRef: RequestBodyObject | RefObject,
  openApi: OpenApiSpec,
): RequestBodyObject | undefined {
  if ('$ref' in bodyOrRef) {
    const name = refName(bodyOrRef['$ref']);
    return openApi.components?.requestBodies?.[name];
  }
  return bodyOrRef;
}

// ---------------------------------------------------------------------------
// $ref resolution helpers (self-contained — copied minimal logic)
// ---------------------------------------------------------------------------

function refName(ref: string): string {
  // "#/components/schemas/Foo" → "Foo"
  return ref.split('/').pop() ?? ref;
}

function resolveSchemaRef(
  schemaOrRef: SchemaObject | RefObject,
  openApi: OpenApiSpec,
): SchemaObject {
  if ('$ref' in schemaOrRef) {
    const name = refName(schemaOrRef['$ref']);
    const schemas = openApi.components?.schemas ?? {};
    const target = schemas[name];
    if (!target) return {};
    if ('$ref' in target) return resolveSchemaRef(target, openApi);
    return target as SchemaObject;
  }
  return schemaOrRef as SchemaObject;
}

function extractTopLevelFields(
  schemaOrRef: SchemaObject | RefObject,
  openApi: OpenApiSpec,
): SpecBodyField[] {
  const schema = resolveSchemaRef(schemaOrRef, openApi);
  const requiredSet = new Set(schema.required ?? []);

  // Handle allOf / oneOf / anyOf — merge properties + required from all parts
  const combined = schema.allOf ?? schema.oneOf ?? schema.anyOf;
  if (combined && combined.length > 0) {
    const merged: Record<string, SchemaObject | RefObject> = {};
    const mergedRequired = new Set<string>();
    for (const part of combined) {
      const resolved = resolveSchemaRef(part, openApi);
      Object.assign(merged, resolved.properties ?? {});
      for (const r of resolved.required ?? []) mergedRequired.add(r);
    }
    return Object.keys(merged).map(name => ({
      name,
      required: mergedRequired.has(name),
    }));
  }

  return Object.keys(schema.properties ?? {}).map(name => ({
    name,
    required: requiredSet.has(name),
  }));
}
