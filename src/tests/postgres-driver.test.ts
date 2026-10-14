/**
 * src/tests/postgres-driver.test.ts
 *
 * Unit tests for the PostgreSQL driver:
 *   - SqlDriverRegistry now includes 'postgres' alongside 'mssql'
 *   - PostgresDriver correctly implements the SqlDriver interface
 *   - mapNamedParams and rewriteQueryPlaceholders work correctly
 *   - checkDependencies finds the 'pg' package
 *   - collectResultSets handles rows, empty results, and column extraction
 *
 * Run with:
 *   npx tsx --test src/tests/postgres-driver.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Import the drivers (auto-register on import)
import '../drivers/postgres-driver.js';
import '../drivers/mssql-driver.js';
import { SqlDriverRegistry } from '../sql-driver.js';
import { PostgresDriver } from '../drivers/postgres-driver.js';
import {
  parseRoutineIdentifier,
  buildSafeQualifiedRoutine,
  rewriteQueryPlaceholders,
} from '../drivers/postgres-driver.js';

// ===========================================================================
// Driver registration
// ===========================================================================

describe('SqlDriverRegistry — postgres registration', () => {

  test('postgres driver is registered', () => {
    const available = SqlDriverRegistry.available();
    assert.ok(available.includes('postgres'), `Available drivers: ${available.join(', ')}`);
  });

  test('postgres and mssql are both available', () => {
    const available = SqlDriverRegistry.available();
    assert.ok(available.includes('mssql'), 'mssql should still be available');
    assert.ok(available.includes('postgres'), 'postgres should be available');
  });

  test('SqlDriverRegistry.get("postgres") returns the PostgresDriver instance', () => {
    const driver = SqlDriverRegistry.get('postgres');
    assert.equal(driver.name, 'postgres');
  });

  test('SqlDriverRegistry.get("nonexistent") throws with helpful message', () => {
    assert.throws(
      () => SqlDriverRegistry.get('nonexistent'),
      /Unknown SQL driver "nonexistent"/,
    );
  });
});

// ===========================================================================
// PostgresDriver — interface conformance
// ===========================================================================

describe('PostgresDriver — interface conformance', () => {

  const driver = new PostgresDriver();

  test('has name property', () => {
    assert.equal(driver.name, 'postgres');
  });

  test('has executeProc method', () => {
    assert.equal(typeof driver.executeProc, 'function');
  });

  test('has executeBatch method', () => {
    assert.equal(typeof driver.executeBatch, 'function');
  });

  test('has executeQuery method', () => {
    assert.equal(typeof driver.executeQuery, 'function');
  });

  test('has executeQueryBatch method', () => {
    assert.equal(typeof driver.executeQueryBatch, 'function');
  });

  test('has checkDependencies method', () => {
    assert.equal(typeof driver.checkDependencies, 'function');
  });

  test('has listProcedures method', () => {
    assert.equal(typeof driver.listProcedures, 'function');
  });

  test('has getProcSource method', () => {
    assert.equal(typeof driver.getProcSource, 'function');
  });

  test('has getProcDependencies method', () => {
    assert.equal(typeof driver.getProcDependencies, 'function');
  });
});

// ===========================================================================
// PostgresDriver — checkDependencies
// ===========================================================================

describe('PostgresDriver — checkDependencies', () => {

  test('finds the pg package', async () => {
    const driver = new PostgresDriver();
    const deps = await driver.checkDependencies();
    assert.equal(deps.length, 1);
    assert.equal(deps[0].name, 'pg');
    assert.equal(deps[0].found, true);
    assert.equal(deps[0].optional, false);
  });
});

// ===========================================================================
// PostgresDriver — query placeholder rewriting (private method test via
// behavior)
// ===========================================================================

describe('PostgresDriver — named param mapping and query rewriting', () => {

  const driver = new PostgresDriver();

  test('mapNamedParams assigns 1-based positional params', () => {
    const { values, paramMap } = (driver as any).mapNamedParams({ name: 'Alice', age: 30 });
    assert.equal(paramMap.get('name'), 1);
    assert.equal(paramMap.get('age'), 2);
    assert.equal(values[0], 'Alice');
    assert.equal(values[1], 30);
  });

  test('rewriteQueryPlaceholders: @paramName → $N', () => {
    const paramMap = new Map<string, number>([['name', 1], ['age', 2]]);
    const rewritten = (driver as any).rewriteQueryPlaceholders(
      'SELECT * FROM users WHERE name = @name AND age = @age', paramMap,
    );
    assert.equal(rewritten, 'SELECT * FROM users WHERE name = $1 AND age = $2');
  });

  test('rewriteQueryPlaceholders leaves unknown @names alone', () => {
    const paramMap = new Map<string, number>([]);
    const rewritten = (driver as any).rewriteQueryPlaceholders(
      'SELECT * FROM users WHERE name = @unknown', paramMap,
    );
    assert.equal(rewritten, 'SELECT * FROM users WHERE name = @unknown');
  });

  test('rewriteQueryPlaceholders does not replace @@ sequences', () => {
    const paramMap = new Map<string, number>([['version', 1]]);
    const rewritten = (driver as any).rewriteQueryPlaceholders(
      'SELECT @@version AS version', paramMap,
    );
    // @@version should NOT be rewritten to @@$1 — the negative lookbehind prevents it
    assert.ok(!rewritten.includes('$1'), `Expected @@version to be preserved, got: ${rewritten}`);
    assert.ok(rewritten.includes('@@version'));
  });

  test('splitArgs respects nested parentheses', () => {
    const parts = (driver as any).splitArgs('name text, age integer, tags text[], custom_type(a, b)');
    assert.equal(parts.length, 4);
    assert.equal(parts[0].trim(), 'name text');
    assert.equal(parts[1].trim(), 'age integer');
    assert.equal(parts[2].trim(), 'tags text[]');
    assert.equal(parts[3].trim(), 'custom_type(a, b)');
  });
});

// ===========================================================================
// PostgresDriver — collectResultSets (tested indirectly via query simulation)
// ===========================================================================

describe('PostgresDriver — result collection logic', () => {

  const driver = new PostgresDriver();

  test('collectResultSets handles rows with columns from fields', () => {
    const mockResult = {
      rows: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      fields: [
        { name: 'id' },
        { name: 'name' },
      ],
      rowCount: 2,
    };

    const result = (driver as any).collectResultSets(mockResult, {}, 0);
    assert.equal(result.resultSets.length, 1);
    assert.deepEqual(result.resultSets[0].columns, ['id', 'name']);
    assert.equal(result.resultSets[0].rows.length, 2);
  });

  test('collectResultSets handles empty result set with column metadata', () => {
    const mockResult = {
      rows: [],
      fields: [{ name: 'id' }, { name: 'name' }],
      rowCount: 0,
    };

    const result = (driver as any).collectResultSets(mockResult, {}, 0);
    assert.equal(result.resultSets.length, 1);
    assert.deepEqual(result.resultSets[0].columns, ['id', 'name']);
    assert.equal(result.resultSets[0].rows.length, 0);
  });

  test('collectResultSets handles no results (command query)', () => {
    const mockResult = {
      rows: [],
      fields: [],
      rowCount: null,
    };

    const result = (driver as any).collectResultSets(mockResult, {}, 0);
    assert.equal(result.resultSets.length, 0);
  });

  test('rowsAffected uses rowCount for INSERT/UPDATE/DELETE', () => {
    const mockResult = { rows: [], fields: [], rowCount: 42 };
    const result = (driver as any).collectResultSets(mockResult, {}, 0);
    assert.deepEqual(result.rowsAffected, [42]);
  });

  test('rowsAffected is empty when rowCount is null', () => {
    const mockResult = { rows: [], fields: [], rowCount: null };
    const result = (driver as any).collectResultSets(mockResult, {}, 0);
    assert.deepEqual(result.rowsAffected, []);
  });
});

// ===========================================================================
// PostgresDriver — proc name parsing
// ===========================================================================

describe('PostgresDriver — proc name parsing', () => {

  test('bare name defaults to public schema', () => {
    const proc = 'my_function';
    const parts = proc.split('.');
    let schema = 'public';
    let name = proc;
    if (parts.length >= 2) {
      schema = parts[0]!;
      name = parts[1]!;
    }
    assert.equal(schema, 'public');
    assert.equal(name, 'my_function');
  });

  test('qualified name splits correctly', () => {
    const proc = 'myschema.my_function';
    const parts = proc.split('.');
    let schema = 'public';
    let name = proc;
    if (parts.length >= 2) {
      schema = parts[0]!;
      name = parts[1]!;
    }
    assert.equal(schema, 'myschema');
    assert.equal(name, 'my_function');
  });
});

// ===========================================================================
// Routine identifier parsing + quoting (SQL injection prevention — #29)
// ===========================================================================

describe('parseRoutineIdentifier() — valid identifiers', () => {

  test('bare unquoted routine name', () => {
    const parsed = parseRoutineIdentifier('myfunc');
    assert.equal(parsed.schema, null);
    assert.deepEqual(parsed.routine, { name: 'myfunc', quoted: false });
  });

  test('qualified schema.routine', () => {
    const parsed = parseRoutineIdentifier('myschema.myfunc');
    assert.deepEqual(parsed.schema, { name: 'myschema', quoted: false });
    assert.deepEqual(parsed.routine, { name: 'myfunc', quoted: false });
  });

  test('quoted routine name with spaces', () => {
    const parsed = parseRoutineIdentifier('"My Func"');
    assert.equal(parsed.schema, null);
    assert.deepEqual(parsed.routine, { name: 'My Func', quoted: true });
  });

  test('quoted schema and routine with embedded dots', () => {
    const parsed = parseRoutineIdentifier('"my schema"."My.Func"');
    assert.deepEqual(parsed.schema, { name: 'my schema', quoted: true });
    assert.deepEqual(parsed.routine, { name: 'My.Func', quoted: true });
  });

  test('embedded quotes are unescaped ("" → ")', () => {
    const parsed = parseRoutineIdentifier('"Weird""Quote"');
    assert.deepEqual(parsed.routine, { name: 'Weird"Quote', quoted: true });
  });

  test('unquoted identifiers allow $ (PL/pgSQL style names)', () => {
    const parsed = parseRoutineIdentifier('my$schema.my_func$1');
    assert.deepEqual(parsed.schema, { name: 'my$schema', quoted: false });
    assert.deepEqual(parsed.routine, { name: 'my_func$1', quoted: false });
  });

  test('empty quoted identifier is legal', () => {
    const parsed = parseRoutineIdentifier('""');
    assert.deepEqual(parsed.routine, { name: '', quoted: true });
  });

  test('surrounding whitespace is trimmed', () => {
    const parsed = parseRoutineIdentifier('  myfunc  ');
    assert.deepEqual(parsed.routine, { name: 'myfunc', quoted: false });
  });
});

describe('parseRoutineIdentifier() — malicious / invalid identifiers rejected', () => {

  const malicious = [
    'myfunc; DROP TABLE users; --',
    'myfunc--comment',
    'myfunc/*comment*/',
    'a.b.c',
    'schema.func(1)',
    'func name',
    '"unterminated',
    'func(',
    '',
    '   ',
    '1func',
    'func-x',
    'schema .func',
    "func'; SELECT pg_sleep(10); --",
    'public.myfunc) AS x; DROP TABLE t; --',
  ];

  for (const bad of malicious) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(
        () => parseRoutineIdentifier(bad),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Invalid PostgreSQL routine identifier/);
          return true;
        },
      );
    });
  }
});

describe('buildSafeQualifiedRoutine() — safe SQL rendering', () => {

  test('bare name defaults to public schema, fully quoted', () => {
    assert.equal(buildSafeQualifiedRoutine('myfunc'), '"public"."myfunc"');
  });

  test('qualified name rendered fully quoted', () => {
    assert.equal(buildSafeQualifiedRoutine('myschema.myfunc'), '"myschema"."myfunc"');
  });

  test('unquoted mixed-case names are folded to lowercase (PostgreSQL semantics)', () => {
    // Raw SQL 'MySchema.MyFunc' resolves to myschema.myfunc — preserve that
    assert.equal(buildSafeQualifiedRoutine('MySchema.MyFunc'), '"myschema"."myfunc"');
  });

  test('quoted names keep exact case', () => {
    assert.equal(buildSafeQualifiedRoutine('"MySchema"."MyFunc"'), '"MySchema"."MyFunc"');
  });

  test('quoted names with embedded quotes are escaped (doubling)', () => {
    assert.equal(buildSafeQualifiedRoutine('"Weird""Quote"'), '"public"."Weird""Quote"');
  });

  test('quoted names with embedded dots stay a single identifier', () => {
    assert.equal(buildSafeQualifiedRoutine('"My.Func"'), '"public"."My.Func"');
  });

  test('renders injection attempts impossible — malicious input throws', () => {
    assert.throws(() => buildSafeQualifiedRoutine('myfunc; DROP TABLE users; --'));
    assert.throws(() => buildSafeQualifiedRoutine('myfunc(1)'));
    assert.throws(() => buildSafeQualifiedRoutine('a.b.c'));
  });
});

// ===========================================================================
// SQL-aware placeholder rewriting (#36)
// ===========================================================================

describe('rewriteQueryPlaceholders() — SQL lexical awareness', () => {

  const paramMap = new Map<string, number>([['name', 1], ['limit', 2]]);

  test('rewrites placeholders in plain code context', () => {
    assert.equal(
      rewriteQueryPlaceholders('SELECT * FROM t WHERE u = @name LIMIT @limit', paramMap),
      'SELECT * FROM t WHERE u = $1 LIMIT $2',
    );
  });

  test('does NOT rewrite inside single-quoted strings', () => {
    const q = "SELECT '@name' AS literal, @name AS code";
    assert.equal(rewriteQueryPlaceholders(q, paramMap), "SELECT '@name' AS literal, $1 AS code");
  });

  test('does NOT rewrite inside single-quoted strings with escaped quotes', () => {
    const q = "SELECT 'it''s @name' AS literal, @name AS code";
    assert.equal(rewriteQueryPlaceholders(q, paramMap), "SELECT 'it''s @name' AS literal, $1 AS code");
  });

  test('does NOT rewrite inside double-quoted identifiers', () => {
    const q = 'SELECT "@name" AS ident, @name AS code';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), 'SELECT "@name" AS ident, $1 AS code');
  });

  test('does NOT rewrite inside line comments', () => {
    const q = '-- @name is a comment\nSELECT @name';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), '-- @name is a comment\nSELECT $1');
  });

  test('does NOT rewrite inside block comments', () => {
    const q = '/* @name block comment */ SELECT @name';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), '/* @name block comment */ SELECT $1');
  });

  test('does NOT rewrite inside nested block comments', () => {
    const q = '/* outer /* @name nested */ still comment */ SELECT @name';
    assert.equal(
      rewriteQueryPlaceholders(q, paramMap),
      '/* outer /* @name nested */ still comment */ SELECT $1',
    );
  });

  test('does NOT rewrite inside dollar-quoted strings (tagless $$)', () => {
    const q = 'SELECT $$body with @name inside$$ AS dq, @name AS code';
    assert.equal(
      rewriteQueryPlaceholders(q, paramMap),
      'SELECT $$body with @name inside$$ AS dq, $1 AS code',
    );
  });

  test('does NOT rewrite inside dollar-quoted strings (tagged $fn$)', () => {
    const q = 'SELECT $tag$ @name $tag$ AS dq, @name AS code';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), 'SELECT $tag$ @name $tag$ AS dq, $1 AS code');
  });

  test('$1 positional placeholders are not treated as dollar-quote openers', () => {
    const q = 'SELECT * FROM t WHERE a = $1 AND b = @limit';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  test('@@ system variables are still preserved', () => {
    const q = 'SELECT @@version, @name';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), 'SELECT @@version, $1');
  });

  test('unknown @names in code context are left alone', () => {
    const q = 'SELECT * FROM t WHERE u = @unknown';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), 'SELECT * FROM t WHERE u = @unknown');
  });

  test('repeated parameter names all rewritten', () => {
    const q = 'SELECT @name, @name, @limit, @name';
    assert.equal(rewriteQueryPlaceholders(q, paramMap), 'SELECT $1, $1, $2, $1');
  });

  test('realistic function body with mixed contexts', () => {
    const q = [
      'SELECT u.name, count(*)',
      'FROM users u -- @name in comment',
      "WHERE u.display_name = '@name displayed'",
      '  AND u.real_name = @name',
      "  AND u.note = $notes$ contains @name $notes$",
      'LIMIT @limit',
    ].join('\n');
    const expected = [
      'SELECT u.name, count(*)',
      'FROM users u -- @name in comment',
      "WHERE u.display_name = '@name displayed'",
      '  AND u.real_name = $1',
      "  AND u.note = $notes$ contains @name $notes$",
      'LIMIT $2',
    ].join('\n');
    assert.equal(rewriteQueryPlaceholders(q, paramMap), expected);
  });
});
