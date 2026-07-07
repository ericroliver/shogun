# Story 3 — Enhanced Spec Extraction: Full Contract Detail

**Wave:** 1 (Foundation — unlocks Stories 4, 6, 7, 14)  
**Status:** Ready for implementation  
**Depends on:** Story 1 (module restructure)  
**Files touched:** `src/commands/coverage/types.ts`, `src/commands/coverage/spec-extractor.ts`

---

## Problem

The current `extractSpecEndpoints()` reads only `method`, `path`, `tag`, and `summary` from the OpenAPI spec. It ignores documented response codes, parameters, and request body schemas entirely. Without this data, the coverage engine cannot answer "which response codes are untested?" or "which parameters are never exercised?" — the two highest-value depth dimensions.

---

## Goal

Enrich `SpecEndpoint` with the full contract detail available in the OpenAPI spec: documented response codes, parameters (path + query), and request body field names. Reuse the `$ref` resolution logic already implemented in [`src/commands/spec.ts`](../../../src/commands/spec.ts).

---

## Updated `SpecEndpoint` Interface

Replace the current `SpecEndpoint` in `src/commands/coverage/types.ts` with:

```typescript
export interface SpecParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
}

export interface SpecEndpoint {
  // --- existing fields (unchanged) ---
  method: string;         // uppercase
  path: string;           // raw OAS path e.g. /api/graph/nodes/{path}
  tag?: string;
  summary?: string;
  tests: TestEntry[];     // populated during match phase

  // --- NEW: contract detail ---
  documentedResponseCodes: string[];   // e.g. ["200", "400", "403", "404"]
  parameters: SpecParam[];             // path + query params from spec
  requestBodyFields: string[];         // top-level field names from requestBody schema
}
```

---

## Updated OpenAPI Internal Types

Extend the minimal OpenAPI 3 types in `src/commands/coverage/types.ts` to include what the extractor needs:

```typescript
interface ResponsesObject {
  [statusCode: string]: unknown;
}

interface ParameterObject {
  name: string;
  in: string;
  required?: boolean;
  schema?: SchemaObject | RefObject;
}

interface RefObject {
  '$ref': string;
}

interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaObject | RefObject>;
  required?: string[];
  allOf?: Array<SchemaObject | RefObject>;
  oneOf?: Array<SchemaObject | RefObject>;
  anyOf?: Array<SchemaObject | RefObject>;
  items?: SchemaObject | RefObject;
}

interface RequestBodyObject {
  content?: {
    'application/json'?: {
      schema?: SchemaObject | RefObject;
    };
    [contentType: string]: unknown;
  };
}

// Updated OperationObject
interface OperationObject {
  tags?: string[];
  summary?: string;
  responses?: ResponsesObject;
  parameters?: Array<ParameterObject | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
}

// Updated OpenApiSpec to include components
interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    schemas?: Record<string, SchemaObject | RefObject>;
    parameters?: Record<string, ParameterObject>;
    requestBodies?: Record<string, RequestBodyObject>;
  };
}
```

---

## Acceptance Criteria

- [ ] `SpecEndpoint` in `src/commands/coverage/types.ts` is updated to the interface above.

- [ ] `extractSpecEndpoints()` in `src/commands/coverage/spec-extractor.ts` is updated to populate all new fields.

- [ ] **`documentedResponseCodes`**: collect the keys of `operation.responses` as strings. Filter out `'default'` (the OAS catch-all). Sort numerically. Example: `["200", "400", "403", "404"]`.

- [ ] **`parameters`**: collect from `operation.parameters[]`. Each entry may be a `$ref` — resolve it via `openApi.components?.parameters?.[refName]`. For each resolved parameter, extract `name`, `in` (normalized to lowercase), and `required` (default `false` if absent). Include only `in: 'path'` and `in: 'query'` parameters (skip `header` and `cookie` — not useful for coverage analysis).

- [ ] **`requestBodyFields`**: extract top-level field names from the request body schema:
  1. If `operation.requestBody` is a `$ref`, resolve it via `openApi.components?.requestBodies?.[refName]`.
  2. Get the `application/json` content schema (prefer `application/json`; if absent, try the first available content type).
  3. If the schema is a `$ref`, resolve it via `openApi.components?.schemas?.[refName]`.
  4. If the resolved schema has `properties`, return `Object.keys(properties)`.
  5. If the schema uses `allOf`/`oneOf`/`anyOf`, merge properties from all parts (same logic as [`resolveSchema()`](../../../src/commands/spec.ts:701) in `spec.ts`).
  6. If no schema or no properties, return `[]`.
  - Only top-level keys — no deep traversal.

- [ ] All existing fields (`method`, `path`, `tag`, `summary`, `tests`) are populated exactly as before — no regression.

- [ ] The tag filter (`--tag`) continues to work correctly.

- [ ] `$ref` resolution is self-contained in `spec-extractor.ts` — do not import from `spec.ts` (that file is a CLI command, not a library). Copy the minimal resolution logic needed (it is small: ~30 lines).

---

## `$ref` Resolution Helper (copy into `spec-extractor.ts`)

```typescript
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
): string[] {
  const schema = resolveSchemaRef(schemaOrRef, openApi);

  // Handle allOf / oneOf / anyOf — merge properties from all parts
  const combined = schema.allOf ?? schema.oneOf ?? schema.anyOf;
  if (combined && combined.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of combined) {
      const resolved = resolveSchemaRef(part, openApi);
      Object.assign(merged, resolved.properties ?? {});
    }
    return Object.keys(merged);
  }

  return Object.keys(schema.properties ?? {});
}
```

---

## Example: What Gets Extracted

For `POST /api/apikeys` with this spec fragment:

```json
{
  "post": {
    "tags": ["ApiKeys"],
    "summary": "Create an API key",
    "parameters": [
      { "name": "workspaceId", "in": "query", "required": true }
    ],
    "requestBody": {
      "content": {
        "application/json": {
          "schema": { "$ref": "#/components/schemas/CreateApiKeyRequest" }
        }
      }
    },
    "responses": {
      "201": { "description": "Created" },
      "400": { "description": "Bad request" },
      "403": { "description": "Forbidden" }
    }
  }
}
```

With `CreateApiKeyRequest` schema having properties `name`, `scopes`, `expiresAt`:

```
documentedResponseCodes: ["201", "400", "403"]
parameters:              [{ name: "workspaceId", in: "query", required: true }]
requestBodyFields:       ["name", "scopes", "expiresAt"]
```

---

## Notes for Implementer

- The `$ref` resolution here is intentionally shallow (one level). Deep nested schemas are not needed — we only want top-level field names for coverage purposes.
- `documentedResponseCodes` should be strings, not numbers — OAS response codes are string keys in the `responses` object.
- Path parameters in the OAS path template (e.g., `{id}` in `/api/users/{id}`) are also declared in `parameters[]` with `in: "path"`. Include them.
- If `operation.parameters` contains a `$ref` to `components/parameters`, resolve it. If the ref target is not found, skip that parameter silently.
- Do not fail if `requestBody` or `responses` are absent — many GET endpoints have no request body.
