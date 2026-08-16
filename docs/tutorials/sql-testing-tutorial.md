# Tutorial: Setting Up a Shogun Test Repo for SQL Object Testing

This tutorial walks you through creating a complete shogun test repository for
testing database objects — stored procedures, raw queries, and functions. You'll
set up the repo structure, configure a database connection, write SQL test
definitions, capture baselines, and run tests.

> **Prerequisites:** Shogun is installed and on your PATH. You have access to a
> SQL Server database (MSSQL is the v1 driver; Postgres and SQLite drivers are
> planned but not yet shipped).

---

## Table of Contents

1. [How SQL Testing Works in Shogun](#1-how-sql-testing-works-in-shogun)
2. [Create the Repo Structure](#2-create-the-repo-structure)
3. [Configure the Database Connection](#3-configure-the-database-connection)
4. [Write Your First Stored Procedure Test](#4-write-your-first-stored-procedure-test)
5. [Capture the Baseline](#5-capture-the-baseline)
6. [Run the Test](#6-run-the-test)
7. [Add Parameter Sets](#7-add-parameter-sets)
8. [Use File-Based Parameter Sets](#8-use-file-based-parameter-sets)
9. [Write a Raw SQL Query Test](#9-write-a-raw-sql-query-test)
10. [Diff Modes: Strict vs Relaxed](#10-diff-modes-strict-vs-relaxed)
11. [Ignoring Volatile Fields](#11-ignoring-volatile-fields)
12. [Pre and Post Scripts](#12-pre-and-post-scripts)
13. [CSV Output Artifacts](#13-csv-output-artifacts)
14. [Organizing Tests into Collections](#14-organizing-tests-into-collections)
15. [Mixing SQL and HTTP Tests](#15-mixing-sql-and-http-tests)
16. [CI Integration](#16-ci-integration)

---

## 1. How SQL Testing Works in Shogun

Shogun's SQL testing follows the same snapshot-based pattern as HTTP tests,
but instead of curl, it uses a database driver to execute stored procedures
or raw queries against one or more parameter sets.

The execution flow for a single SQL test:

```
load parameters → pre-script (optional) → execute proc/query for each param set
→ snapshot diff against baseline → post-script (optional) → record result
```

Key concepts:

| Concept | Description |
|---------|-------------|
| **Connection** | A named database connection in `shogun.config.yaml` with a driver type and connection string |
| **Parameter set** | A single set of input parameters — the proc/query runs once per set |
| **Baseline** | A JSON file in `expected/` capturing the "known good" output for all parameter sets |
| **Snapshot mode** | `shogun snapshot` captures baselines; `shogun run` diffs against them |
| **Diff mode** | `strict` (any difference fails) or `relaxed` (extra columns in actual are ignored) |

A SQL test produces **one `TestResult`** — not one per parameter set. All
parameter sets are executed and their results are compared as a group against
the baseline. This means if one parameter set's output drifts, the test fails.

---

## 2. Create the Repo Structure

Create a new directory for your test repo and set up the folder structure:

```bash
mkdir my-sql-tests
cd my-sql-tests
mkdir -p tests/collections/users
mkdir -p tests/collections/orders
mkdir -p tests/suites
mkdir -p envs
mkdir -p expected
mkdir -p scripts
```

Your repo should look like this:

```
my-sql-tests/
├── shogun.config.yaml
├── envs/
│   ├── local.env
│   └── local.env.example
├── tests/
│   ├── collections/
│   │   ├── users/
│   │   │   ├── _collection.yaml
│   │   │   ├── get-user-by-id.yaml
│   │   │   └── search-users.yaml
│   │   └── orders/
│   │       ├── _collection.yaml
│   │       └── get-order-summary.yaml
│   └── suites/
│       └── smoke.yaml
├── expected/
├── scripts/
└── runs/          # auto-created on first run
```

---

## 3. Configure the Database Connection

### 3.1 Create `shogun.config.yaml`

```yaml
version: 1

defaults:
  env: local
  timeout: 30

paths:
  tests: ./tests
  envs: ./envs
  expected: ./expected
  runs: ./runs
  scripts: ./scripts

# Named database connections — referenced by SQL tests via sql.connection
connections:
  primary:
    driver: mssql
    connectionString: ${DB_CONNECTION_STRING}
    timeout: 30

  reporting:
    driver: mssql
    connectionString: ${REPORTING_DB_CONNECTION_STRING}
    timeout: 60

# Fields to strip from ALL SQL result sets before comparison
ignore_fields_global:
  - "**.executionTime"
  - "**.rowVersion"

reporting:
  format: pretty
  on_fail: diff
  save_passing_logs: false
```

**Key points:**

- **`connections`** — a map of named connections. Each needs a `driver` and a
  `connectionString`. The connection string supports `${VAR}` interpolation from
  your env files.
- **`driver`** — currently only `mssql` is supported. The `mssql` npm package is
  lazy-loaded, so HTTP-only repos don't need it installed.
- **`timeout`** — query timeout in seconds. Can be set per-connection or
  overridden per-test.

### 3.2 Create the Environment File

```bash
cp envs/local.env.example envs/local.env
```

Create `envs/local.env.example` (commit this — it's a template):

```bash
# envs/local.env.example
DB_CONNECTION_STRING=Server=localhost,1433;Database=MyApp;User Id=sa;Password=YourPassword;Encrypt=true;TrustServerCertificate=true
REPORTING_DB_CONNECTION_STRING=Server=localhost,1433;Database=MyAppReporting;User Id=sa;Password=YourPassword;Encrypt=true;TrustServerCertificate=true
```

Create `envs/local.env` (gitignored — your real credentials):

```bash
# envs/local.env
DB_CONNECTION_STRING=Server=localhost,1433;Database=MyApp;User Id=sa;Password=RealPassword123;Encrypt=true;TrustServerCertificate=true
REPORTING_DB_CONNECTION_STRING=Server=localhost,1433;Database=MyAppReporting;User Id=sa;Password=RealPassword123;Encrypt=true;TrustServerCertificate=true
```

> **Important:** Add `envs/*.env` to your `.gitignore`. Only commit `.env.example` files.

```bash
# .gitignore
envs/*.env
runs/
```

### 3.3 Install the MSSQL Driver

If you haven't already, install the `mssql` package in the shogun engine repo:

```bash
cd /path/to/shogun
npm install mssql
```

> The driver is lazy-loaded — if no SQL tests run, the package is never imported.

---

## 4. Write Your First Stored Procedure Test

Create `tests/collections/users/get-user-by-id.yaml`:

```yaml
name: Get User By ID
description: Tests dbo.sp_GetUserById with a known user
type: sql
collection: users
tags:
  - sql
  - users
  - readonly

sql:
  connection: primary
  proc: dbo.sp_GetUserById
  parameters:
    inline:
      - UserId: 1

response:
  diff_mode: strict
```

**What's happening here:**

- `type: sql` — tells shogun this is a SQL test, not an HTTP test
- `sql.connection: primary` — references the named connection from config
- `sql.proc: dbo.sp_GetUserById` — the stored procedure to execute
- `sql.parameters.inline` — an array of parameter sets. Each object is one
  execution. Here we have a single set: `{ UserId: 1 }`
- `response.diff_mode: strict` — any difference from baseline fails the test

---

## 5. Capture the Baseline

Before you can run tests, you need to capture a baseline. The baseline is the
"known good" output that future runs will be compared against.

```bash
shogun snapshot --env local --collection users
```

This executes each SQL test in the `users` collection and writes the results to
`expected/`:

```
expected/users/sql_dbo.sp_GetUserById.json
```

The baseline file looks like this:

```json
[
  {
    "paramIndex": 0,
    "params": { "UserId": 1 },
    "resultSets": [
      {
        "columns": ["UserId", "UserName", "Email", "Status"],
        "rows": [
          {
            "UserId": 1,
            "UserName": "jdoe",
            "Email": "jdoe@example.com",
            "Status": "active"
          }
        ]
      }
    ],
    "returnValue": 0,
    "rowsAffected": [-1],
    "durationMs": 42
  }
]
```

**Commit baselines to git.** They are the contract — the expected output that
all future runs are validated against.

```bash
git add expected/
git commit -m "Add SQL baselines for users collection"
```

> **Note:** `durationMs` and other volatile fields should be stripped via
> `ignore_fields` (see [section 11](#11-ignoring-volatile-fields)).

---

## 6. Run the Test

```bash
shogun run --env local --collection users
```

Output:

```
━━━ Users ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◷ Get User By ID                              SQL  dbo.sp_GetUserById
  ✓ passed (42ms)

━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1 passed  ·  0 failed  ·  0 needs baseline  ·  42ms total
```

If the stored procedure's output changes (a column is added, a value changes,
row count differs), the test fails and shogun shows a diff:

```
  ✗ failed (38ms)
  param 0, result set 0: row count changed (1 → 0)
```

---

## 7. Add Parameter Sets

Most stored procedures behave differently with different inputs. Test multiple
scenarios by adding more parameter sets:

```yaml
name: Search Users
description: Tests dbo.sp_SearchUsers with various filters
type: sql
collection: users
tags:
  - sql
  - users
  - readonly

sql:
  connection: primary
  proc: dbo.sp_SearchUsers
  parameters:
    inline:
      - SearchTerm: ""           # all users
        PageSize: 10
        PageNumber: 1
      - SearchTerm: "admin"      # filter by keyword
        PageSize: 5
        PageNumber: 1
      - SearchTerm: ""           # second page
        PageSize: 10
        PageNumber: 2

response:
  diff_mode: strict
```

Each entry in the `inline` array is one execution. The baseline captures all
three results in order. If any single parameter set's output drifts, the test
fails and the diff shows exactly which param set changed:

```
  param 1, result set 0, row 2:
  -   {"UserName":"admin2","Email":"admin2@example.com","Status":"active"}
  +   {"UserName":"admin2","Email":"admin2@newdomain.com","Status":"active"}
```

---

## 8. Use File-Based Parameter Sets

For tests with many parameter sets or complex parameters, use a file instead
of inline:

Create `tests/collections/users/search-users-params.yaml`:

```yaml
parameters:
  - SearchTerm: ""
    PageSize: 10
    PageNumber: 1
  - SearchTerm: "admin"
    PageSize: 5
    PageNumber: 1
  - SearchTerm: ""
    PageSize: 10
    PageNumber: 2
  - SearchTerm: "inactive"
    PageSize: 50
    PageNumber: 1
    StatusFilter: "inactive"
```

Reference it from the test YAML:

```yaml
name: Search Users
description: Tests dbo.sp_SearchUsers with various filters
type: sql
collection: users
tags:
  - sql
  - users

sql:
  connection: primary
  proc: dbo.sp_SearchUsers
  parameters:
    file: ./search-users-params.yaml

response:
  diff_mode: strict
```

The parameter file path is **relative to the test YAML file's directory**.

---

## 9. Write a Raw SQL Query Test

If you're testing a query (not a stored procedure), use `sql.query` instead of
`sql.proc`. Use `@paramName` for parameter substitution:

```yaml
name: Order Summary by Date Range
description: Verifies the order summary query returns correct totals
type: sql
collection: orders
tags:
  - sql
  - orders
  - readonly

sql:
  connection: reporting
  query: |
    SELECT
      COUNT(*) AS TotalOrders,
      SUM(TotalAmount) AS GrandTotal,
      AVG(TotalAmount) AS AverageOrder
    FROM Orders
    WHERE OrderDate BETWEEN @StartDate AND @EndDate
      AND Status = 'completed'
  parameters:
    inline:
      - StartDate: "2024-01-01"
        EndDate: "2024-01-31"
      - StartDate: "2024-02-01"
        EndDate: "2024-02-29"
      - StartDate: "2024-03-01"
        EndDate: "2024-03-31"

  # Override baseline name (defaults to sanitized test name)
  baseline: order-summary-monthly

response:
  diff_mode: strict
```

**Key differences from proc tests:**

- `sql.query` replaces `sql.proc` — you provide the raw SQL string
- `@StartDate` and `@EndDate` are substituted with the parameter values
- `sql.baseline` overrides the baseline filename — defaults to the proc name
  for proc tests, or a sanitized version of the test name for query tests
- The baseline file will be `expected/orders/sql_order-summary-monthly.json`

---

## 10. Diff Modes: Strict vs Relaxed

### Strict Mode (default)

Any difference between actual and baseline fails the test:
- Extra columns in actual → fail
- Missing columns → fail
- Changed values → fail
- Row count change → fail

### Relaxed Mode

Extra columns in the actual results are **ignored** — only columns present in
the baseline are compared. This is useful when the database might add new
metadata columns (like `CreatedAt`, `RowVersion`) that you don't want to
trigger failures.

```yaml
response:
  diff_mode: relaxed
```

When relaxed mode detects extra columns, they are reported as informational
output but don't fail the test:

```
  ✓ passed (45ms) — 2 extra columns ignored: [CreatedAt, RowVersion]
```

**When to use which:**

| Mode | Use When |
|------|----------|
| `strict` | You own the schema and want to catch ALL changes |
| `relaxed` | The schema may add columns you don't control (e.g., shared DB, vendor schema) |

---

## 11. Ignoring Volatile Fields

Many database results contain fields that change on every execution. Strip
them before comparison using `ignore_fields`:

### Global (all tests)

In `shogun.config.yaml`:

```yaml
ignore_fields_global:
  - "**.executionTime"
  - "**.rowVersion"
  - "**.RowVersion"
```

### Per-test

In the test YAML:

```yaml
response:
  ignore_fields:
    - "durationMs"
    - "executionTime"
```

Both lists are merged. The ignore pattern supports:
- `"fieldName"` — matches that column name in any result set
- `"**.fieldName"` — same as above (glob prefix, for consistency with HTTP tests)

Ignored fields are stripped from both the actual results and the baseline
before comparison, so they won't appear in the baseline file either.

> **Tip:** Always ignore `durationMs` and any execution metadata. Without this,
> every run will fail because query timing is never identical.

---

## 12. Pre and Post Scripts

SQL tests support `pre` and `post` scripts — TypeScript snippets that run
before and after all parameter sets are executed.

### Pre-script

Runs once before all parameter sets. Has access to `ctx.sql` with `paramCount`,
`params`, `proc`/`query`, and `connection`:

```yaml
sql:
  connection: primary
  proc: dbo.sp_GetUserById
  parameters:
    inline:
      - UserId: 1

  pre: |
    // Verify the database is reachable and the proc exists
    ctx.log(`About to execute ${ctx.sql.proc} with ${ctx.sql.paramCount} param set(s)`);

    // You can modify params at runtime — useful for dynamic test data
    const now = new Date();
    ctx.sql.params[0].AsOfDate = now.toISOString();

    // Assert preconditions
    ctx.assert(ctx.sql.paramCount > 0, 'Must have at least one parameter set');
```

### Post-script

Runs once after all parameter sets are executed. Has access to `ctx.sql.results`:

```yaml
  post: |
    const results = ctx.sql.results!;

    // Check that every parameter set returned exactly one row
    for (const r of results) {
      ctx.assert(
        r.resultSets[0]?.rows.length === 1,
        `Param set ${r.paramIndex}: expected 1 row, got ${r.resultSets[0]?.rows.length ?? 0}`
      );
    }

    // Stash a value for downstream tests
    const firstUserEmail = results[0].resultSets[0].rows[0].Email;
    ctx.vars.knownUserEmail = firstUserEmail;
    ctx.log(`Stashed known user email: ${firstUserEmail}`);
```

The `ctx.sql` context shape:

```typescript
interface SqlScriptContext {
  paramCount: number;           // available in pre
  params: Record<string, unknown>[];  // available in pre (mutable)
  results?: SqlExecResult[];    // available in post only
  proc?: string;                // proc name (if proc-based test)
  query?: string;               // query text (if query-based test)
  connection: string;           // connection name
}
```

---

## 13. CSV Output Artifacts

For reporting or data-warehouse tests, you can export results as CSV in
addition to the JSON baseline:

```yaml
sql:
  connection: reporting
  query: |
    SELECT * FROM Orders WHERE OrderDate >= @StartDate
  parameters:
    inline:
      - StartDate: "2024-01-01"
  outputFormat: both    # json | csv | both
```

When `outputFormat` is `csv` or `both`, shogun writes CSV files to the run
log directory:

```
runs/2024-01-15_10-30-00/
  orders--sql_order-summary-monthly_0_0.csv
  orders--sql_order-summary-monthly_1_0.csv
```

The filename pattern is `{collection}--sql_{baselineName}_{paramIndex}_{resultSetIndex}.csv`.

---

## 14. Organizing Tests into Collections

Collections group related tests and define shared setup/teardown.

Create `tests/collections/users/_collection.yaml`:

```yaml
name: Users SQL
description: Stored procedure tests for the users domain

order:
  - get-user-by-id
  - search-users

tags:
  - sql
  - users

# Optional: pre-seed vars available to all tests in this collection
vars:
  KNOWN_USER_ID: "1"

setup: |
  ctx.log(`Starting Users SQL collection — testing against ${ctx.env.DB_CONNECTION_STRING?.split(';')[1] ?? 'unknown DB'}`);

teardown: |
  ctx.log('Users SQL collection complete');
```

Create `tests/collections/orders/_collection.yaml`:

```yaml
name: Orders SQL
description: Stored procedure and query tests for the orders domain

order:
  - get-order-summary

tags:
  - sql
  - orders

setup: |
  // You can use ctx.http to make API calls during setup if needed
  // (e.g., to seed test data via an API endpoint)
  ctx.log('Starting Orders SQL collection');
```

### Suites

Create `tests/suites/smoke.yaml` for a quick SQL-only smoke test:

```yaml
name: SQL Smoke Suite
description: Core SQL tests that should always pass
collections:
  - users
  - orders
tags:
  - sql
  - smoke
```

Run it:

```bash
shogun run --env local --suite smoke
```

---

## 15. Mixing SQL and HTTP Tests

A single shogun test repo can contain both HTTP and SQL tests. This is
powerful for end-to-end testing: create data via the API, then verify the
database state via SQL.

Example mixed collection:

```
tests/collections/user-lifecycle/
  _collection.yaml       # setup: create user via API, stash ID
  create-user-api.yaml   # type: http (POST /api/users)
  verify-user-db.yaml    # type: sql (SELECT * FROM Users WHERE UserId = @Id)
  delete-user-api.yaml   # type: http (DELETE /api/users/{id})
```

`_collection.yaml`:

```yaml
name: User Lifecycle
description: Create a user via API, verify in DB, clean up via API

order:
  - create-user-api
  - verify-user-db
  - delete-user-api

setup: |
  // Generate unique test user name
  ctx.vars.testUserName = `shogun-test-${Date.now()}`;
  ctx.log(`Test user: ${ctx.vars.testUserName}`);

teardown: |
  // Safety-net cleanup via API
  if (ctx.vars.createdUserId) {
    try {
      await ctx.http.delete(`/api/users/${ctx.vars.createdUserId}`);
      ctx.log(`Teardown: deleted user ${ctx.vars.createdUserId}`);
    } catch (err) {
      ctx.log(`Teardown: delete failed (non-fatal): ${err.message}`);
    }
  }
```

`create-user-api.yaml` (HTTP test):

```yaml
name: Create User via API
description: Creates a test user and stashes the ID for DB verification
type: http
collection: user-lifecycle
tags:
  - http
  - users
  - write

pre: |
  ctx.request.body = {
    userName: ctx.vars.testUserName,
    email: `${ctx.vars.testUserName}@test.example.com`,
    status: "active"
  };

request:
  method: POST
  path: /api/users
  headers:
    Content-Type: application/json

response:
  status: 201
  snapshot: false

post: |
  const body = ctx.response.body;
  ctx.vars.createdUserId = body.userId;
  ctx.log(`Created user with ID: ${body.userId}`);
```

`verify-user-db.yaml` (SQL test — uses `dependsOn` to ensure the API test ran first):

```yaml
name: Verify User in Database
description: Confirms the user created via API exists in the database
type: sql
collection: user-lifecycle
tags:
  - sql
  - users
  - verification

dependsOn:
  - create-user-api

sql:
  connection: primary
  query: |
    SELECT UserId, UserName, Email, Status
    FROM Users
    WHERE UserId = @UserId
  parameters:
    inline:
      - UserId: "${createdUserId}"

response:
  diff_mode: strict

post: |
  // Additional assertion: the user must exist
  const results = ctx.sql.results!;
  ctx.assert(
    results[0].resultSets[0].rows.length === 1,
    'User should exist in database after API creation'
  );
  ctx.assert(
    results[0].resultSets[0].rows[0].UserName === ctx.vars.testUserName,
    'DB username should match the one created via API'
  );
```

> **Note:** The `${createdUserId}` interpolation in the parameters pulls from
> `ctx.vars` — the same variable store used by HTTP tests. This is how SQL and
> HTTP tests share state within a collection.

`delete-user-api.yaml` (HTTP test):

```yaml
name: Delete User via API
description: Cleans up the test user created earlier
type: http
collection: user-lifecycle
tags:
  - http
  - users
  - cleanup

dependsOn:
  - verify-user-db

pre: |
  const userId = ctx.vars.createdUserId;
  ctx.assert(!!userId, 'createdUserId must be set from create-user-api test');
  ctx.request.path = `/api/users/${userId}`;

request:
  method: DELETE
  path: /api/users/placeholder    # overridden by pre-script

response:
  status: 204
  snapshot: false

post: |
  ctx.vars.createdUserId = null;
  ctx.log('User deleted successfully');
```

---

## 16. CI Integration

### Basic CI Script

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run SQL tests against the CI database
shogun run --env ci --suite smoke --format json > results.json

# Check exit code — shogun exits non-zero on any failure
exit $?
```

### Using Runtime Parameter Overrides

You can override parameters at runtime using the `--params` flag (useful for
CI where you want to test against a dynamically created user):

```bash
shogun run --env ci --file tests/collections/users/get-user-by-id.yaml \
  --params '[{"UserId": 42}]'
```

The `--params` flag accepts a JSON array of parameter objects and takes
precedence over any `parameters` defined in the YAML.

### Coverage Gate

If your repo also has HTTP tests with OpenAPI coverage, you can enforce
minimum coverage thresholds:

```bash
shogun run --env ci --suite smoke
shogun coverage --min-coverage endpoint=80,responseCode=70
```

### Baseline Update Workflow

When a stored procedure intentionally changes its output (e.g., a new column
is added to a result set):

1. Update the proc in the database
2. Run `shogun snapshot --env local --collection users` to capture new baselines
3. Review the diff in the baseline files with `git diff expected/`
4. Commit the updated baselines: `git commit -am "Update baselines for new user column"`

> **Never** update baselines without understanding why the output changed.
> Baseline drift is the signal — it means either the proc changed or the data
> changed. Always investigate before accepting.

---

## Quick Reference

### SQL Test YAML Structure

```yaml
name: <test name>              # required
type: sql                      # required for SQL tests
collection: <collection name>
tags: [...]

sql:
  connection: <named connection>        # required — from config.connections
  proc: <schema.procname>               # required if no query
  query: <raw SQL with @params>         # required if no proc
  baseline: <override name>             # optional
  parameters:                           # required (unless using --params)
    inline:                             # inline parameter sets
      - { param1: value1, param2: value2 }
    file: ./params.yaml                 # OR file-based
  outputFormat: json | csv | both       # optional, default: json
  timeout: 30                           # optional, overrides connection timeout
  pre: |                                # optional TypeScript
    ...
  post: |                               # optional TypeScript
    ...

response:
  diff_mode: strict | relaxed           # optional, default: strict
  ignore_fields:                        # optional, merged with global
    - "fieldName"
```

### CLI Commands

```bash
# Capture baselines
shogun snapshot --env local --collection users
shogun snapshot --env local --file tests/collections/users/get-user-by-id.yaml

# Run tests
shogun run --env local --collection users
shogun run --env local --suite smoke
shogun run --env local --file tests/collections/users/get-user-by-id.yaml

# Run with runtime parameter override
shogun run --env ci --file tests/collections/users/get-user-by-id.yaml --params '[{"UserId": 42}]'

# Validate YAML without executing
shogun lint

# Show last run report
shogun report
```

### Baseline File Location

```
expected/{collection}/sql_{baselineName}.json
```

Where `baselineName` is:
- The `sql.baseline` value if specified
- The proc name (e.g., `dbo.sp_GetUserById`) for proc tests
- A sanitized version of the test name for query tests
