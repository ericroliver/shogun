# shogun

> Shell-first API testing with YAML test definitions, TypeScript scripting, and snapshot diffing.

## **NOTICE: This project was completely written using agentic development tools.**

Shogun is a minimalist, multi-purpose API testing harness that executes HTTP requests via `curl`, validates responses with `jq`, diffs snapshots with `diff`, and supports SQL stored procedure testing and LLM agent testing — all driven by YAML test definitions with optional TypeScript pre/post hooks.

No HTTP client libraries. No heavy test frameworks. Just the tools you already have.

---

## Table of Contents

- [Installation](#installation)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Test Types](#test-types)
  - [HTTP Tests](#http-tests)
  - [SQL Tests](#sql-tests)
  - [Agent Tests](#agent-tests)
- [Configuration](#configuration)
- [Environment Files](#environment-files)
- [Test Definition Format](#test-definition-format)
- [Collections](#collections)
- [Suites](#suites)
- [Snapshots](#snapshots)
- [Pre/Post Script Context](#prepost-script-context-ctx)
- [SSE (Server-Sent Events)](#sse-server-sent-events)
- [Run Logs](#run-logs)
- [Backends](#backends)
- [Commands](#commands)
  - [init](#init)
  - [ls](#ls)
  - [run](#run)
  - [snapshot](#snapshot)
  - [report](#report)
  - [lint](#lint)
  - [spec](#spec)
  - [coverage](#coverage)
  - [sql](#sql-1)
  - [check-backend](#check-backend)
- [CI Integration](#ci-integration)
- [Project Structure](#project-structure)

---

## Installation

### Option 1 — npm (recommended)

```bash
npm install -g shogun
shogun --version
```

### Option 2 — npx (zero install, great for CI)

```bash
npx shogun --version
npx shogun run --env QA
```

### Option 3 — Standalone binary (no Node.js required)

Download a prebuilt binary from the [Releases page](https://github.com/ericroliver/shogun/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/ericroliver/shogun/releases/latest/download/shogun-macos-arm64 \
  -o /usr/local/bin/shogun && chmod +x /usr/local/bin/shogun

# Linux x64
curl -L https://github.com/ericroliver/shogun/releases/latest/download/shogun-linux-x64 \
  -o /usr/local/bin/shogun && chmod +x /usr/local/bin/shogun
```

---

## Requirements

| Tool | Notes |
|------|-------|
| Node.js ≥ 20 | Not required for standalone binary |
| `curl` | HTTP execution (Unix backend) |
| `jq` | Shape assertions and snapshot normalization |
| `diff` | Snapshot comparison |
| PowerShell | HTTP execution (PowerShell backend — Windows) |
| `mssql` driver | Required for SQL tests (installed automatically via npm) |

**macOS:** `jq` is available via `brew install jq`.
**Ubuntu/Debian:** `apt install jq curl`.

> **Windows:** Shogun auto-detects PowerShell on Windows and uses `Invoke-WebRequest` instead of `curl`. Override with `--backend unix` if needed.

---

## Quick Start

```bash
# 1. Scaffold a new test repo
shogun init my-api-tests
cd my-api-tests

# 2. Copy the env template and fill in your values
cp envs/local.env.example envs/local.env

# 3. Run all tests against the local environment
shogun run --env local

# 4. Run only the smoke suite
shogun run --suite smoke --env local

# 5. Capture snapshot baselines for the first time
shogun snapshot --env local
```

---

## Test Types

Shogun supports three test types: `http` (default), `sql`, and `agent`.

### HTTP Tests

The original and default test type. Each test is a YAML file describing an HTTP request, expected status code, optional jq shape assertions, and optional snapshot diffing against a committed baseline.

```yaml
name: Get All Agents
type: http
tags:
  - smoke
  - readonly

request:
  method: GET
  path: /api/agents
  headers:
    Accept: application/json
  params:
    limit: 20
    offset: 0

response:
  status: 200
  snapshot: true
  ignore_fields:
    - "**.id"
    - "**.timestamp"
  shape:
    - 'has("agents")'
    - '.agents | type == "array"'
    - 'has("total")'
```

See [Test Definition Format](#test-definition-format) for the full HTTP schema.

### SQL Tests

Test database stored procedures and raw SQL queries with parameterized execution, snapshot baselining, and diff modes.

```yaml
name: Get user by ID
type: sql
sql:
  connection: qa-db
  proc: dbo.sp_GetUser
  parameters:
    inline:
      - UserId: 42
        ActiveOnly: true
  outputFormat: json
  diff_mode: strict
```

**Key concepts:**

| Concept | Description |
|---------|-------------|
| **Connection** | A named database connection in `shogun.config.yaml` with a driver type and connection string |
| **Parameter set** | A single set of input parameters — the proc/query runs once per set |
| **Baseline** | A JSON file in `expected/` capturing the "known good" output for all parameter sets |
| **Diff mode** | `strict` (any difference fails) or `relaxed` (extra columns in actual are ignored) |
| **CSV output** | Set `outputFormat: csv` to write CSV artifacts alongside JSON baselines |

**Configuring a connection:**

```yaml
# shogun.config.yaml
connections:
  qa-db:
    driver: mssql
    connectionString: "Server=${DB_HOST};Database=QA;User Id=${DB_USER};Password=${DB_PASS};Encrypt=true"
    timeout: 30
```

**Raw SQL queries (alternative to stored procedures):**

```yaml
name: Count active users
type: sql
sql:
  connection: qa-db
  query: "SELECT COUNT(*) AS ActiveCount FROM Users WHERE IsActive = 1"
  outputFormat: json
```

**File-based parameter sets:**

```yaml
name: Bulk user lookup
type: sql
sql:
  connection: qa-db
  proc: dbo.sp_GetUsersByIds
  parameters:
    file: ./params/user-ids.json
```

**Runtime parameter override (for Playwright integration):**

```bash
shogun run --file tests/sql/get-user.yaml --params '[{"UserId": 42}]'
```

**Pre/post scripts for SQL tests:**

```yaml
name: Validate user creation
type: sql
sql:
  connection: qa-db
  proc: dbo.sp_CreateUser
  pre: |
    ctx.log(`Creating user with ${ctx.params.length} param set(s)`);
  post: |
    ctx.assert(ctx.results.length > 0, 'Must produce results');
    ctx.assert(ctx.results[0].rows[0].Success === true, 'User creation must succeed');
```

> **MSSQL is the v1 driver.** Postgres and SQLite drivers are planned but not yet shipped.

### Agent Tests

Test LLM agents via OpenAI-compatible `chat/completions` endpoints. Agent tests send a prompt to a target agent, then evaluate the response using a separate evaluator model against configurable criteria with a `min_pass` threshold.

This uses **LLM-as-a-judge** — a probabilistic evaluation model where an evaluator agent grades the response on a 0–100 scale with per-criteria pass/fail breakdowns and reasoning.

```yaml
name: explains code correctly
type: agent

agent:
  endpoint: ${AGENT_BASE_URL}/v1/chat/completions
  model: enigma/default
  temperature: 0.3
  max_tokens: 1024
  prompt: |
    Explain what this function does and identify any bugs:

    function add(a, b) {
      return a - b;  // BUG: should be a + b
    }
  parameters:
    system_prompt: "You are a code review assistant."
    context_files:
      - ./src/utils.ts

expected:
  description: "Should explain that the function performs addition and identify the subtraction bug"

evaluate:
  criteria:
    - "Correctly identifies the subtraction bug (a - b should be a + b)"
    - "Suggests the fix (change - to +)"
    - "Explains the intended purpose of the function"
  min_pass: 80
```

**How it works:**

1. **Test definition** specifies: prompt, parameters, target model, expected result
2. **Execution** sends the prompt to the target agent endpoint via HTTP and captures the response
3. **Evaluation** constructs an evaluation prompt (expected + actual + criteria) and sends it to a separate evaluator model
4. **Contract validation** enforces strict 1:1 criteria correspondence and parses the evaluator's JSON response
5. **Result** includes a grade (0–100), per-criteria pass/fail, reasoning, and pass/fail determination against `min_pass`

**Global evaluator config (in `shogun.config.yaml`):**

```yaml
# shogun.config.yaml
evaluation:
  endpoint: ${EVALUATOR_BASE_URL}/v1/chat/completions
  model: gpt-4o
  temperature: 0
  timeout: 300
```

Per-test `evaluate` overrides (endpoint, model, api_key, temperature, timeout) take precedence over global config.

**Evaluation contract:**

The evaluator must return strict JSON:

```json
{
  "status": "evaluated",
  "grade": 85,
  "reasoning": "The response correctly identifies the bug...",
  "criteriaResults": [
    { "criterion": "Identifies the subtraction bug", "met": true, "reasoning": "..." },
    { "criterion": "Suggests the fix", "met": true, "reasoning": "..." },
    { "criterion": "Explains the intended purpose", "met": false, "reasoning": "..." }
  ]
}
```

- `grade` must be 0–100; `min_pass` defaults to 80
- Criteria must match 1:1 (count + exact string match)
- `indeterminate` status = fail (fail-closed)
- The evaluation prompt includes an explicit injection boundary (`UNTRUSTED DATA`) to prevent the agent under test from manipulating the evaluator

**Agent test output in the reporter:**

- Passing: shows grade, evaluator model, and status
- Failing: shows grade, reasoning, per-criteria breakdown (✓/✗), and diagnostics (agent response + evaluation response)
- Indeterminate: clearly labeled with `INDETERMINATE`

> **No snapshots for agent tests:** Agent tests are skipped by `shogun snapshot` and `shogun coverage`. The "baseline" is inline in the YAML (`expected.description` or `evaluate.criteria`).

---

## Configuration

### `shogun.config.yaml`

```yaml
version: 1

defaults:
  env: local              # default environment when --env is omitted
  timeout: 10             # curl/HTTP timeout in seconds
  follow_redirects: true
  content_type: application/json
  auto_inject_auth: true  # inject AUTH_TOKEN as Authorization header (default: true)

paths:
  tests: ./tests
  envs: ./envs
  expected: ./expected
  runs: ./runs
  scripts: ./scripts
  setup_fixtures: ./tests/setup-fixtures

# jq paths stripped from ALL snapshot diffs (override per-test with ignore_fields)
ignore_fields_global:
  - "**.timestamp"
  - "**.createdAt"
  - "**.updatedAt"
  - "**.requestId"

# OpenAPI spec source (for shogun spec and shogun coverage)
spec:
  path: ./specs/openapi.json   # local file
  # OR
  url: ${BASE_URL}/openapi.json  # fetched at runtime

# Named database connections (for SQL tests)
connections:
  qa-db:
    driver: mssql
    connectionString: "Server=${DB_HOST};Database=QA;User Id=${DB_USER};Password=${DB_PASS};Encrypt=true"
    timeout: 30

# Global evaluation config (for agent tests)
evaluation:
  endpoint: ${EVALUATOR_BASE_URL}/v1/chat/completions
  model: gpt-4o
  temperature: 0
  timeout: 300

# Coverage configuration (optional)
coverage:
  defaultSuite: smoke
  suppressDrift: ['401']

reporting:
  format: pretty           # pretty | json | tap
  on_fail: diff            # diff | body | silent
  save_passing_logs: true
```

### `shogun init`

Scaffold a new test repo with sensible defaults:

```bash
shogun init                    # Scaffold in the current directory
shogun init my-api-tests       # Scaffold into a new subdirectory
shogun init --force            # Overwrite existing files
```

Creates: `shogun.config.yaml`, `envs/local.env`, `envs/local.env.example`, `.gitignore`, a sample collection, a smoke suite, and starter scripts.

---

## Environment Files

Select an environment with `--env`:

```bash
shogun run --env QA
shogun run --env QA-2
shogun run              # defaults to "local"
```

Variables are available in YAML as `${VAR_NAME}` interpolation and in scripts as `ctx.env.VAR_NAME`.

Shogun reads env vars from both the `.env` file and `process.env`, so CI secrets can be injected directly without a file.

**Minimum variables:**

| Variable | Purpose |
|----------|---------|
| `BASE_URL` | Base URL for all HTTP requests (required) |
| `AUTH_TOKEN` | Injected as `Authorization: Bearer <token>` header if set |
| `TIMEOUT` | Request timeout in seconds (default: 10) |

---

## Test Definition Format

```yaml
name: Get All Agents
description: Returns the paginated agent list
type: http                          # 'http' (default) | 'sql' | 'agent'
collection: agents
tags:
  - smoke
  - readonly

# Optional: per-test env overrides
env:
  TIMEOUT: 30

# TypeScript — runs before curl; can mutate ctx.request
pre: |
  ctx.request.headers['X-Request-Source'] = 'shogun';

request:
  method: GET
  path: /api/agents
  headers:
    Accept: application/json
  params:
    limit: 20
    offset: 0
  body:
    inline:                          # Inline JSON body (supports ${VAR} interpolation)
      name: ${testName}
    # OR
    # file: ./fixtures/create-agent.json   # Path to JSON fixture file

response:
  status: 200                        # Assert HTTP status code
  snapshot: true                     # Diff against expected/ baseline
  ignore_fields:                     # Strip these jq paths before diffing
    - "**.id"
    - "**.timestamp"
  shape:                             # jq boolean expressions — each must be truthy
    - 'has("agents")'
    - '.agents | type == "array"'
    - 'has("total")'

# TypeScript — runs after assertions; has ctx.response
post: |
  ctx.assert(Array.isArray(ctx.response.body.agents), '"agents" must be array');
  ctx.vars.agentCount = ctx.response.body.total;
  ctx.log(`Found ${ctx.response.body.total} agents`);
```

### Dependencies

Tests can declare dependencies — a test won't run until its dependencies pass:

```yaml
name: Delete Agent
dependsOn:
  - Create Agent
```

If a dependency fails, the dependent test is marked `dependency_failed` and skipped.

---

## Collections

A collection is a directory under `tests/collections/` with an optional `_collection.yaml`:

```yaml
name: Agents API
order:
  - get-agents
  - create-agent
  - get-agent-by-name
  - delete-agent

# Runs once before first test — ctx.vars available to all tests
setup: |
  ctx.vars.testAgentName = `shogun-${Date.now()}`;
  ctx.log(`Test agent: ${ctx.vars.testAgentName}`);

# Runs once after last test — even if tests fail
teardown: |
  if (ctx.vars.createdAgentName) {
    await ctx.http.delete(`/api/agents/${ctx.vars.createdAgentName}`);
  }
```

---

## Suites

Run a named subset of collections:

```yaml
# tests/suites/smoke.yaml
name: Smoke Suite
collections:
  - system
  - agents
tags:
  - smoke
```

```bash
shogun run --suite smoke
```

---

## Snapshots

Snapshots compare the actual response body against a saved baseline file in `expected/`. Volatile fields (timestamps, IDs) are stripped before comparison using `ignore_fields`.

```bash
# Capture baselines — writes expected/ files (commit these)
shogun snapshot --env QA

# Update a single test's baseline
shogun snapshot --file tests/collections/agents/get-agents.yaml

# Normal run — diffs against committed baselines
shogun run --env QA
```

On first run with `snapshot: true` and no baseline, the test is marked **needs_baseline** rather than failing.

> **Agent tests are skipped** during snapshot mode with the message: "Skipped: agent tests do not support snapshot mode."

### Diff Modes (SQL Tests)

| Mode | Behavior |
|------|----------|
| `strict` (default) | Any difference between actual and baseline fails the test |
| `relaxed` | Extra columns in the actual result that aren't in the baseline are ignored — useful for forward-compatible schema changes |

---

## Pre/Post Script Context (`ctx`)

Scripts are inline TypeScript, executed via `tsx`. They receive a `ShogunContext` object:

```typescript
ctx.env                  // env vars — read only
ctx.vars                 // mutable store, persists across tests in a run
ctx.request              // current request — mutable in pre-script
ctx.response             // current response — available in post-script

ctx.assert(bool, msg)    // throws and fails test if bool is false
ctx.log(msg)             // write to stdout and run log

// Additional HTTP calls (for setup/teardown/chaining)
await ctx.http.get('/api/something')
await ctx.http.post('/api/agents', { name: 'test' })
await ctx.http.delete('/api/agents/test')

// Shared helpers from scripts/
ctx.scripts.auth.getBearerToken(ctx.env)
ctx.scripts.transforms.stripVolatileFields(ctx.response.body)
```

Scripts support `async/await`. Auth tokens are automatically redacted in all log output.

### SQL Script Context

For `type: sql` tests, the context includes:

```typescript
// In pre-script:
ctx.sql.paramCount        // number of parameter sets
ctx.sql.params            // the parameter sets array
ctx.sql.proc              // proc name (undefined for query tests)
ctx.sql.query             // raw SQL query (undefined for proc tests)
ctx.sql.connection       // connection name

// In post-script (also includes):
ctx.sql.results           // SqlExecResult[] — results after execution
```

---

## SSE (Server-Sent Events)

When an HTTP response has `Content-Type: text/event-stream`, shogun auto-parses the SSE event stream so tests can work with structured data instead of raw `event: ...\ndata: ...` text.

- Events are parsed into `{ event: string, data: unknown }` objects
- For single-event responses, `body` is the parsed data from that event
- For multi-event responses, `body` is the data from the last event
- If no events are found, `body` falls back to the original raw text

This is especially useful for testing MCP (Model Context Protocol) and streaming endpoints.

---

## Run Logs

Every run produces a timestamped directory under `runs/`:

```
runs/20260328_200532/
  summary.json                      # Overall results
  agents--get-all-agents.log        # Per-test detail
```

```bash
shogun report                       # Latest run
shogun report --run 20260328_200532 # Specific run
shogun report --format json         # JSON output
```

---

## Backends

Shogun supports two execution backends:

| Backend | HTTP Execution | Platform |
|---------|---------------|----------|
| `unix` | `curl` + `jq` + `diff` | macOS, Linux (default) |
| `powershell` | `Invoke-WebRequest` | Windows (auto-detected) |

**Selection hierarchy (highest priority first):**

1. `--backend` CLI flag (e.g., `shogun run --backend powershell`)
2. `SHOGUN_BACKEND` environment variable
3. OS detection (Windows → powershell, else unix)

```bash
# Check which backend is active and verify dependencies
shogun check-backend

# Force a specific backend
shogun run --backend unix
shogun run --backend powershell
```

---

## Commands

### init

Scaffold a new test repo with sensible defaults.

```bash
shogun init                         # Scaffold in current directory
shogun init my-api-tests            # Scaffold into a new subdirectory
shogun init --force                 # Overwrite existing files
```

### ls

List available resources in the test repo.

```bash
shogun ls                           # List everything
shogun ls envs                      # Environment files only
shogun ls collections               # Collections only
shogun ls suites                    # Suites only
shogun ls tests                     # All test files across collections
shogun ls tests --collection agents # Tests in a specific collection
shogun ls runs                      # Recent runs
shogun ls fixtures                  # Setup fixtures
shogun ls --format json             # JSON output (for scripting)
```

Test listings show type indicators: `[http]`, `[sql]`, or `[agent]`.

### run

Execute tests.

```bash
shogun run                           # Run all tests (default env)
shogun run --env QA                  # Select environment
shogun run --collection agents       # Run one collection
shogun run --collection a --collection b  # Run multiple collections
shogun run --tags smoke             # Filter by tag (comma-separated)
shogun run --suite smoke             # Run a named suite
shogun run --file path/to/test.yaml  # Run single test file
shogun run --format json            # JSON output (for CI)
shogun run --format tap             # TAP output
shogun run --output results.json    # Write JSON results to file (Playwright integration)
shogun run --params '[{"UserId":42}]'  # Override SQL test params at runtime
shogun run --backend unix           # Force unix backend
shogun run --backend powershell     # Force PowerShell backend
```

**Exit codes:** `0` = all tests passed. `1` = one or more failures (suitable for CI gate).

### snapshot

Capture or update baselines in `expected/`.

```bash
shogun snapshot                      # Capture/update all baselines
shogun snapshot --env QA             # Snapshot against specific environment
shogun snapshot --file path/...      # Update single test baseline
shogun snapshot --suite api-testapp-1  # Snapshot with suite vars
```

Agent tests are automatically skipped with a clear message.

### report

Show run reports.

```bash
shogun report                        # Show last run report
shogun report --run <timestamp>     # Show specific run
shogun report --format json          # JSON output
```

### lint

Validate YAML test files without making any HTTP calls.

```bash
shogun lint                          # Validate all YAML files
shogun lint --file path/to/test.yaml  # Validate single file
```

Lint checks include:
- Zod schema validation for all test types
- Missing required fields (name, type, request, response, etc.)
- Agent test validation (requires agent config + at least one of expected.description or evaluate.criteria)
- Warnings for missing `evaluate.criteria` on agent tests
- Warnings for very low `min_pass` (< 50) on agent tests

### spec

Query and explore an OpenAPI spec with progressive disclosure.

```bash
shogun spec                          # List all API endpoints (from spec)
shogun spec --env local --endpoint /api/workspaces --method GET  # Specific endpoint
shogun spec --tag Agents             # All endpoints in a tag group
shogun spec --schema AgentDef        # Resolve a named schema ($refs inlined)
shogun spec --search checkpoint      # Keyword search across summaries
shogun spec --list                   # Explicit list mode
shogun spec --format json            # JSON output (for scripting)
shogun spec [spec-source]            # Override spec URL or local file path
```

All `$ref` chains are resolved inline — no raw `$ref` strings in output.

### coverage

API test coverage matrix — cross-references your OpenAPI spec against test YAML files.

```bash
shogun coverage                       # API test coverage matrix
shogun coverage --env local           # Load env for live spec fetching
shogun coverage --collection graph    # Scope tests to one collection
shogun coverage --suite smoke         # Scope tests to a named suite
shogun coverage --tag Agents          # Scope spec to a tag group
shogun coverage --uncovered           # Show only uncovered endpoints
shogun coverage --gaps                # Prioritized gap analysis
shogun coverage --gaps --top 20       # Limit gaps to top 20 by priority
shogun coverage --detail              # Full depth matrix (codes, params, fields, quality)
shogun coverage --last-run            # Integrate latest run results (statuses, drift)
shogun coverage --run <timestamp>     # Integrate a specific run
shogun coverage --suppress-drift 401  # Hide drift for these codes (default: 401)
shogun coverage --compare             # Compare two runs and show delta
shogun coverage --deps                # Show test dependency graph
shogun coverage --min-coverage 80     # CI gate: fail if endpoint coverage < 80%
shogun coverage --format json        # JSON output (for scripting)
shogun coverage --format markdown     # Markdown table output (for PRs/docs)
shogun coverage --out report.md       # Write report to file instead of stdout
```

**SQL coverage:**

```bash
shogun coverage --sql                 # SQL stored procedure coverage (static)
shogun coverage --sql --live           # SQL coverage with live DB introspection
```

The `--sql` mode scans test YAML for `type: sql` tests and builds a coverage matrix of stored procedures. With `--live`, it connects to the database and introspects actual procedures, parameters, and dependencies to identify untested procs and parameters.

### sql

SQL stored procedure introspection with progressive disclosure — mirrors `shogun spec` but for database objects.

```bash
shogun sql                           # List all stored procs (all connections)
shogun sql --connection qa-db        # List procs in one connection
shogun sql --schema dbo              # Filter by database schema
shogun sql --search "user"           # Search proc names + parameter names
shogun sql --proc dbo.sp_GetUser     # Detail one proc (params, types, flags)
shogun sql --source dbo.sp_GetUser   # Retrieve proc source definition
shogun sql --deps dbo.sp_GetUser     # Show proc dependencies (tables, views, procs)
shogun sql --env QA                  # Load env for connection string interpolation
shogun sql --format json             # JSON output (for scripting)
shogun sql --format markdown         # Markdown table output (for docs/PRs)
```

### check-backend

Show backend info and verify dependencies.

```bash
shogun check-backend                 # Show current backend + dependency status
shogun check-backend --backend unix  # Check specific backend
```

---

## CI Integration

### GitHub Actions

```yaml
- name: Run API smoke tests
  run: npx shogun run --env QA --suite smoke --format json
  env:
    BASE_URL: ${{ secrets.QA_BASE_URL }}
    AUTH_TOKEN: ${{ secrets.QA_AUTH_TOKEN }}
```

### Coverage Gate

```yaml
- name: Coverage gate (min 80%)
  run: npx shogun coverage --env QA --min-coverage 80 --format markdown --out coverage-report.md
  env:
    BASE_URL: ${{ secrets.QA_BASE_URL }}
    AUTH_TOKEN: ${{ secrets.QA_AUTH_TOKEN }}
```

### Playwright Integration

```bash
# Run shogun from Playwright and capture JSON output
shogun run --file tests/sql/get-user.yaml --format json --output results.json

# Or capture JSON via stdout
shogun run --file tests/sql/get-user.yaml --format json > results.json

# Check exit code (0=pass, 1=fail)
echo $?
```

SQL test results include `sqlExecSummary` (totalParams, executed, errors, totalRows) on all SQL test results — not just failures — enabling Playwright to access row counts and execution details on passing tests.

---

## Project Structure

```
my-api-tests/
├── shogun.config.yaml          # Global config
│
├── envs/                       # One file per environment
│   ├── local.env.example       # Committed template
│   ├── local.env               # Gitignored — real values
│   ├── QA.env                  # Gitignored
│   └── staging.env             # Gitignored
│
├── tests/
│   ├── collections/
│   │   ├── agents/             # One directory per collection
│   │   │   ├── _collection.yaml    # Order, setup/teardown hooks
│   │   │   ├── get-agents.yaml
│   │   │   ├── create-agent.yaml
│   │   │   └── delete-agent.yaml
│   │   └── system/
│   │       ├── _collection.yaml
│   │       └── health.yaml
│   ├── suites/
│   │   └── smoke.yaml          # Named multi-collection run
│   └── fixtures/               # Shared request body JSON files
│
├── expected/                   # Snapshot baselines — committed to git
│   ├── agents/
│   └── system/
│
└── scripts/                    # Shared TypeScript helpers
    ├── auth.ts                 # e.g. token refresh helpers
    └── transforms.ts           # e.g. response normalizers
```

> `runs/` is generated at runtime and gitignored.
