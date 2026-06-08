/**
 * src/tests/spec-pure.test.ts
 *
 * Unit tests for pure functions in src/commands/spec.ts:
 *   isRef, refName, schemaTypeString, resolveSchema,
 *   resolveSchemaShallow, schemaToFields, buildFlags
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRef,
  refName,
  schemaTypeString,
  resolveSchema,
  resolveSchemaShallow,
  schemaToFields,
  buildFlags,
} from '../commands/spec.js';
import type { SchemaObject, RefObject, OpenApiSpec } from '../commands/spec.js';

// ---------------------------------------------------------------------------
// Minimal fixture OpenAPI spec for resolve tests
// ---------------------------------------------------------------------------

function makeSpec(schemas: Record<string, SchemaObject> = {}): OpenApiSpec {
  return {
    openapi: '3.0.1',
    info: { title: 'Test', version: '1.0' },
    components: { schemas },
    paths: {},
  };
}

// ===========================================================================
// isRef
// ===========================================================================

describe('isRef()', () => {
  test('returns true for object with $ref', () => {
    assert.equal(isRef({ $ref: '#/components/schemas/Foo' }), true);
  });

  test('returns false for plain object', () => {
    assert.equal(isRef({ type: 'string' }), false);
  });

  test('returns false for null', () => {
    assert.equal(isRef(null), false);
  });

  test('returns false for undefined', () => {
    assert.equal(isRef(undefined), false);
  });

  test('returns false for string', () => {
    assert.equal(isRef('hello'), false);
  });

  test('returns false for empty object', () => {
    assert.equal(isRef({}), false);
  });
});

// ===========================================================================
// refName
// ===========================================================================

describe('refName()', () => {
  test('extracts name from standard OpenAPI ref', () => {
    assert.equal(refName('#/components/schemas/Foo'), 'Foo');
  });

  test('extracts name from nested path', () => {
    assert.equal(refName('#/components/schemas/deep/Nested'), 'Nested');
  });

  test('returns last segment for non-standard ref', () => {
    assert.equal(refName('some/random/Path'), 'Path');
  });

  test('returns whole string if no slash', () => {
    assert.equal(refName('NoSlash'), 'NoSlash');
  });

  test('handles trailing slash — pop returns empty', () => {
    // "#/components/schemas/" → pop gives ""
    assert.equal(refName('#/components/schemas/'), '');
  });
});

// ===========================================================================
// schemaTypeString
// ===========================================================================

describe('schemaTypeString()', () => {
  test('returns "unknown" for undefined schema', () => {
    assert.equal(schemaTypeString(undefined), 'unknown');
  });

  test('returns type string for simple types', () => {
    assert.equal(schemaTypeString({ type: 'string' }), 'string');
    assert.equal(schemaTypeString({ type: 'integer' }), 'integer');
    assert.equal(schemaTypeString({ type: 'number' }), 'number');
    assert.equal(schemaTypeString({ type: 'boolean' }), 'boolean');
  });

  test('returns "array" for array type without items', () => {
    assert.equal(schemaTypeString({ type: 'array' }), 'array');
  });

  test('returns "array<itemType>" for array type with items', () => {
    assert.equal(schemaTypeString({ type: 'array', items: { type: 'string' } }), 'array<string>');
    assert.equal(schemaTypeString({ type: 'array', items: { type: 'integer' } }), 'array<integer>');
  });

  test('returns "array<refName>" for array items with $ref', () => {
    const items = { $ref: '#/components/schemas/Widget' } as SchemaObject;
    assert.equal(schemaTypeString({ type: 'array', items }), 'array<Widget>');
  });

  test('returns "object{...}" for object with properties', () => {
    assert.equal(schemaTypeString({ type: 'object', properties: { name: { type: 'string' } } }), 'object{...}');
  });

  test('returns "object" for object without properties', () => {
    assert.equal(schemaTypeString({ type: 'object' }), 'object');
  });

  test('returns type string for enum — falls back to "string" if no type', () => {
    assert.equal(schemaTypeString({ enum: ['a', 'b'] }), 'string');
    assert.equal(schemaTypeString({ type: 'string', enum: ['a', 'b'] }), 'string');
    assert.equal(schemaTypeString({ type: 'integer', enum: [1, 2] }), 'integer');
  });

  // OpenAPI 3.1 nullable array syntax: ["string", "null"]
  test('handles OpenAPI 3.1 array-type syntax ["string", "null"]', () => {
    assert.equal(schemaTypeString({ type: ['string', 'null'] }), 'string?');
  });

  test('handles OpenAPI 3.1 array-type syntax ["integer", "null"]', () => {
    assert.equal(schemaTypeString({ type: ['integer', 'null'] }), 'integer?');
  });

  test('handles OpenAPI 3.1 array-type without null', () => {
    assert.equal(schemaTypeString({ type: ['string', 'integer'] }), 'string|integer');
  });

  test('handles OpenAPI 3.1 array-type ["null"] only', () => {
    assert.equal(schemaTypeString({ type: ['null'] }), 'null');
  });

  test('falls back to "object" when no type and no enum', () => {
    assert.equal(schemaTypeString({}), 'object');
  });

  test('array items with nullable array-type syntax — nullable ? not propagated to items', () => {
    // schemaTypeString handles the nullable array-type at the top level but
    // for array items it only extracts rawItemType (non-null portion) — the
    // "?" suffix is NOT appended for items. This documents current behavior.
    const items: SchemaObject = { type: ['string', 'null'] };
    assert.equal(schemaTypeString({ type: 'array', items }), 'array<string>');
  });
});

// ===========================================================================
// buildFlags
// ===========================================================================

describe('buildFlags()', () => {
  test('required only', () => {
    const result = buildFlags(true, false);
    assert.ok(result.includes('(required)'));
    assert.ok(!result.includes('(nullable)'));
  });

  test('nullable only', () => {
    const result = buildFlags(false, true);
    assert.ok(!result.includes('(required)'));
    assert.ok(result.includes('(nullable)'));
  });

  test('both required and nullable', () => {
    const result = buildFlags(true, true);
    assert.ok(result.includes('(required)'));
    assert.ok(result.includes('(nullable)'));
  });

  test('neither required nor nullable', () => {
    const result = buildFlags(false, false);
    assert.ok(!result.includes('(required)'));
    assert.ok(!result.includes('(nullable)'));
  });

  test('output is padded to 22 chars', () => {
    assert.equal(buildFlags(false, false).length, 22);
    assert.equal(buildFlags(true, true).length, 22);
  });
});

// ===========================================================================
// resolveSchema
// ===========================================================================

describe('resolveSchema()', () => {
  const spec = makeSpec({
    Foo: { type: 'string', description: 'A foo' },
    Bar: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { $ref: '#/components/schemas/Foo' },
      },
      required: ['id'],
    },
    Recursive: {
      type: 'object',
      properties: {
        child: { $ref: '#/components/schemas/Recursive' },
      },
    },
  });

  test('returns schema as-is when it is not a $ref', () => {
    const input: SchemaObject = { type: 'string' };
    assert.deepEqual(resolveSchema(input, spec, 0), { type: 'string' });
  });

  test('resolves a $ref to the target schema', () => {
    const ref: RefObject = { $ref: '#/components/schemas/Foo' };
    const result = resolveSchema(ref, spec, 0);
    assert.equal(result.type, 'string');
    assert.equal(result.description, 'A foo');
  });

  test('resolves $ref inside properties — depth-limited (MAX_DEPTH=2)', () => {
    // Tracing resolveSchema(Bar_ref, spec, 0):
    //   1. isRef → name='Bar', target found, depth(0) < MAX_DEPTH(2)
    //   2. → resolveSchema(Bar_target, spec, 1)
    //   3. Not ref, depth(1) < MAX_DEPTH, has properties → resolve each at depth 2
    //   4. For 'name' ($ref:Foo): resolveSchema(Foo_ref, spec, 2)
    //   5. isRef → name='Foo', target found, depth(2) >= MAX_DEPTH(2) → returns { type: 'Foo' }
    // So the nested $ref is NOT fully resolved — it becomes { type: 'Foo' } not { type: 'string' }.
    const ref: RefObject = { $ref: '#/components/schemas/Bar' };
    const result = resolveSchema(ref, spec, 0);
    assert.equal(result.type, 'object');
    const idProp = result.properties!['id'] as SchemaObject;
    assert.equal(idProp.type, 'integer');
    const nameProp = result.properties!['name'] as SchemaObject;
    // name $ref hit MAX_DEPTH guard — returned type marker instead of resolved schema
    assert.equal(nameProp.type, 'Foo');
  });

  test('resolves $ref inside properties — depth 1 returns Bar as-is', () => {
    // Tracing resolveSchema(Bar_ref, spec, 1):
    //   1. isRef → name='Bar', target found, depth(1) < MAX_DEPTH(2)
    //   2. → resolveSchema(Bar_target, spec, 2)
    //   3. Not ref, depth(2) >= MAX_DEPTH(2) → returns Bar_target as-is
    // So 'name' property stays as the raw $ref object (has $ref, not type)
    const ref: RefObject = { $ref: '#/components/schemas/Bar' };
    const result = resolveSchema(ref, spec, 1);
    assert.equal(result.type, 'object');
    const nameProp = result.properties!['name'] as SchemaObject;
    // The $ref is NOT resolved at all — it's still { $ref: '#/components/schemas/Foo' }
    assert.equal(nameProp.type, undefined);
    assert.ok('$ref' in nameProp);
  });

  test('returns { type: "$ref:NAME" } for missing $ref target', () => {
    const ref: RefObject = { $ref: '#/components/schemas/NonExistent' };
    const result = resolveSchema(ref, spec, 0);
    assert.equal(result.type, '$ref:NonExistent');
  });

  test('stops recursion at MAX_DEPTH (2)', () => {
    const ref: RefObject = { $ref: '#/components/schemas/Recursive' };
    // depth=0 → resolves Recursive, depth=1 → resolves child ref, depth=2 → returns name
    const result = resolveSchema(ref, spec, 0);
    // At depth 0: resolve Recursive → depth 1 for its properties →
    //   child is $ref to Recursive → depth 2 → resolves Recursive again →
    //   at depth 2, its properties resolve at depth 3 >= MAX_DEPTH, so child's
    //   child property is returned as-is (the $ref is not further resolved)
    assert.equal(result.type, 'object');
    const child = result.properties!['child'] as SchemaObject;
    // At depth 2, resolveSchema returns schemaOrRef as-is since depth >= MAX_DEPTH
    // But the ref at depth 1 was resolved, so child is the resolved Recursive object
    // whose own child property at depth 2 will stop recursion
    assert.ok(child);
  });

  // ── allOf / oneOf / anyOf merging ─────────────────────────────────────
  // NOTE: resolveSchema merges allOf, oneOf, and anyOf IDENTICALLY.
  // In OpenAPI, these have different semantics:
  //   allOf = intersection (all must match — merge is correct)
  //   oneOf = exclusive-or (only one matches — merge is WRONG)
  //   anyOf = inclusive-or (at least one matches — merge is WRONG)
  // This test documents the current behavior, which may be a design
  // shortcut or a bug depending on the intended use case.

  test('merges allOf schemas by combining properties and required', () => {
    const schema: SchemaObject = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
      ],
    };
    const result = resolveSchema(schema, spec, 0);
    assert.equal(result.type, 'object');
    assert.ok(result.properties!['a']);
    assert.ok(result.properties!['b']);
    assert.deepEqual(result.required, ['a', 'b']);
  });

  test('merges oneOf identically to allOf — POTENTIAL BUG', () => {
    const schema: SchemaObject = {
      oneOf: [
        { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        { type: 'object', properties: { y: { type: 'integer' } }, required: ['y'] },
      ],
    };
    const result = resolveSchema(schema, spec, 0);
    // oneOf should NOT merge, but current code does merge identically to allOf
    assert.equal(result.type, 'object');
    assert.ok(result.properties!['x'], 'oneOf merged x — this is the current behavior but may be incorrect semantically');
    assert.ok(result.properties!['y'], 'oneOf merged y — this is the current behavior but may be incorrect semantically');
    assert.deepEqual(result.required, ['x', 'y']);
  });

  test('merges anyOf identically to allOf — POTENTIAL BUG', () => {
    const schema: SchemaObject = {
      anyOf: [
        { type: 'object', properties: { p: { type: 'boolean' } }, required: ['p'] },
        { type: 'object', properties: { q: { type: 'number' } }, required: ['q'] },
      ],
    };
    const result = resolveSchema(schema, spec, 0);
    // anyOf should NOT merge, but current code does merge identically to allOf
    assert.equal(result.type, 'object');
    assert.ok(result.properties!['p']);
    assert.ok(result.properties!['q']);
    assert.deepEqual(result.required, ['p', 'q']);
  });

  test('resolves $ref inside allOf elements — depth-limited', () => {
    const schema: SchemaObject = {
      allOf: [
        { $ref: '#/components/schemas/Bar' },
      ],
    };
    const result = resolveSchema(schema, spec, 0);
    assert.equal(result.type, 'object');
    assert.ok(result.properties!['id']);
    // Bar is resolved at depth 0 → allOf element $ref:Bar resolved at depth 0:
    // refName→'Bar', target found, depth(0) < MAX_DEPTH(2), resolve target at depth 1.
    // At depth 1, Bar has properties → each resolved at depth 2.
    // 'name' $ref at depth 2: refName→'Foo', target found, depth(2) >= MAX_DEPTH(2)
    // → returns { type: 'Foo' }. So name is NOT fully resolved.
    const nameProp = result.properties!['name'] as SchemaObject;
    assert.equal(nameProp.type, 'Foo');
  });

  test('empty allOf array falls through to passthrough — no forced merge', () => {
    // When allOf is empty (length 0), the condition `combined.length > 0` is false,
    // so the function falls through and returns the schema as-is — the explicit
    // type/properties/required merge is NOT applied.
    const schema: SchemaObject = { allOf: [] };
    const result = resolveSchema(schema, spec, 0);
    // The allOf array exists but is empty — code falls through, returns as-is
    assert.deepEqual(result, { allOf: [] });
  });

  test('returns schema as-is when depth >= MAX_DEPTH and not a ref', () => {
    const schema: SchemaObject = { type: 'string', format: 'date' };
    const result = resolveSchema(schema, spec, 2);
    assert.deepEqual(result, { type: 'string', format: 'date' });
  });

  test('resolves inline property refs at depth 0', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        refProp: { $ref: '#/components/schemas/Foo' },
      },
    };
    const result = resolveSchema(schema, spec, 0);
    const refProp = result.properties!['refProp'] as SchemaObject;
    assert.equal(refProp.type, 'string');
    assert.equal(refProp.description, 'A foo');
  });
});

// ===========================================================================
// resolveSchemaShallow
// ===========================================================================

describe('resolveSchemaShallow()', () => {
  const spec = makeSpec({
    Foo: { type: 'string', description: 'Shallow foo' },
    NestedRef: { $ref: '#/components/schemas/Foo' },
  });

  test('resolves $ref one level', () => {
    const ref: RefObject = { $ref: '#/components/schemas/Foo' };
    const result = resolveSchemaShallow(ref, spec);
    assert.equal(result.type, 'string');
    assert.equal(result.description, 'Shallow foo');
  });

  test('follows chained $refs', () => {
    const ref: RefObject = { $ref: '#/components/schemas/NestedRef' };
    const result = resolveSchemaShallow(ref, spec);
    // NestedRef → $ref Foo → resolved
    assert.equal(result.type, 'string');
    assert.equal(result.description, 'Shallow foo');
  });

  test('returns { type: "$ref:NAME" } for missing target', () => {
    const ref: RefObject = { $ref: '#/components/schemas/Missing' };
    const result = resolveSchemaShallow(ref, spec);
    assert.equal(result.type, '$ref:Missing');
  });

  test('returns schema as-is when not a $ref', () => {
    const schema: SchemaObject = { type: 'integer' };
    const result = resolveSchemaShallow(schema, spec);
    assert.deepEqual(result, { type: 'integer' });
  });
});

// ===========================================================================
// schemaToFields
// ===========================================================================

describe('schemaToFields()', () => {
  const spec = makeSpec();

  test('returns empty array for schema with no properties', () => {
    assert.deepEqual(schemaToFields({ type: 'string' }, spec), []);
  });

  test('converts simple object schema to fields', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    };
    const fields = schemaToFields(schema, spec);
    assert.equal(fields.length, 2);
    assert.equal(fields[0].name, 'name');
    assert.equal(fields[0].type, 'string');
    assert.equal(fields[0].required, true);
    assert.equal(fields[1].name, 'age');
    assert.equal(fields[1].type, 'integer');
    assert.equal(fields[1].required, false);
  });

  test('includes enum values', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'inactive'] },
      },
    };
    const fields = schemaToFields(schema, spec);
    assert.deepEqual(fields[0].enum, ['active', 'inactive']);
  });

  test('includes description', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique identifier' },
      },
    };
    const fields = schemaToFields(schema, spec);
    assert.equal(fields[0].description, 'Unique identifier');
  });

  test('includes nullable flag', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        optional: { type: 'string', nullable: true },
      },
    };
    const fields = schemaToFields(schema, spec);
    assert.equal(fields[0].nullable, true);
  });

  test('recursively resolves nested object properties', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city'],
        },
      },
    };
    const fields = schemaToFields(schema, spec);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].name, 'address');
    assert.ok(fields[0].properties, 'nested properties should be present');
    assert.equal(fields[0].properties!.length, 2);
    assert.equal(fields[0].properties![0].name, 'city');
    assert.equal(fields[0].properties![0].required, true);
    assert.equal(fields[0].properties![1].name, 'zip');
    assert.equal(fields[0].properties![1].required, false);
  });

  test('defaults nullable to false when not specified', () => {
    const schema: SchemaObject = {
      type: 'object',
      properties: {
        val: { type: 'string' },
      },
    };
    const fields = schemaToFields(schema, spec);
    assert.equal(fields[0].nullable, false);
  });
});
