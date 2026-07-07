# Story 2 — Enhanced Test Collection: Full Metadata Extraction

**Wave:** 1 (Foundation — unlocks Stories 4, 6, 7, 8, 8b, 13, 14)  
**Status:** Ready for implementation  
**Depends on:** Story 1 (module restructure)  
**Files touched:** `src/commands/coverage/types.ts`, `src/commands/coverage/test-collector.ts`

---

## Problem

The current `collectTestEntries()` extracts only four fields from each test YAML: `name`, `method`, `path`, and `tags`. This is enough for the binary "covered / not covered" report but nothing more. To compute response code coverage, assertion quality, parameter coverage, body field coverage, and the thin-test flag, the collector must extract the full test metadata in a single pass.

---

## Goal

Enrich `TestEntry` with all available test YAML metadata. No visible output change — this story is pure internal data enrichment. The richer `TestEntry` is the foundation every depth-dimension story builds on.

---

## Updated `TestEntry` Interface

Replace the current `TestEntry` in `src/commands/coverage/types.ts` with:

```typescript
export interface TestRunResult {
  httpStatus: number;
  durationMs: number;
  status: 'passed' | 'failed' | 'needs_baseline' | 'dependency_failed';
  assertionsPassed: boolean;
}

export interface TestEntry {
  // --- existing fields (unchanged) ---
  name: string;
  file: string;           // relative path from cwd
  collection: string;
  staticPath: string;     // raw request.path from YAML
  method: string;         // normalized to uppercase
  tags: string[];
  matchedSpecKey?: string; // "GET /api/graph/nodes" — set after matching

  // --- NEW: response assertion metadata ---
  expectedStatus?: number;          // response.status from YAML
  shapeAssertions: string[];        // response.shape[] entries (may be empty)
  snapshotEnabled: boolean;         // response.snapshot === true
  postScriptAssertCount: number;    // heuristic: count of `assert(` in post script body
  hasPreScript: boolean;            // pre: field is present and non-empty
  hasPostScript: boolean;           // post: field is present and non-empty

  // --- NEW: request metadata ---
  requestBodyFields: string[];      // top-level keys from inline body or fixture file
  requestParams: string[];          // keys from request.params + query string params

  // --- NEW: run result (populated only with --last-run, Story 10) ---
  runResult?: TestRunResult;
}
```

---

## Acceptance Criteria

- [ ] `TestEntry` in `src/commands/coverage/types.ts` is updated to the interface above.

- [ ] `collectTestEntries()` in `src/commands/coverage/test-collector.ts` is updated to populate all new fields for every test YAML it parses.

- [ ] **`expectedStatus`**: read from `parsed.response?.status`. If absent or not a number, leave `undefined`.

- [ ] **`shapeAssertions`**: read from `parsed.response?.shape`. If it is an array of strings, use it. If absent or not an array, use `[]`.

- [ ] **`snapshotEnabled`**: `true` if `parsed.response?.snapshot === true`, otherwise `false`.

- [ ] **`hasPreScript`**: `true` if `parsed.pre` is a non-empty string, otherwise `false`.

- [ ] **`hasPostScript`**: `true` if `parsed.post` is a non-empty string, otherwise `false`.

- [ ] **`postScriptAssertCount`**: count occurrences of the substring `'assert('` in `parsed.post` (case-sensitive). If no post script, `0`. This is a heuristic — it may over-count if `assert(` appears in a comment or string literal, but that is acceptable (over-reporting is better than under-reporting).

- [ ] **`requestBodyFields`**: extracted from the inline body or fixture file:
  - If `parsed.request.body?.inline` is an object, use `Object.keys(parsed.request.body.inline)`.
  - If `parsed.request.body?.file` is a string, attempt to read the fixture file relative to the test YAML's directory. If the file exists and is valid JSON, use `Object.keys(parsedFixture)`. If the file does not exist or is not valid JSON, use `[]` (do not throw).
  - If neither is present, use `[]`.
  - Only top-level keys are collected (no deep traversal).

- [ ] **`requestParams`**: extracted from two sources, merged and deduplicated:
  1. Keys from `parsed.request.params` (if it is an object).
  2. Query string parameters parsed from `parsed.request.path` — extract the `?key=value` portion if present, parse with `new URLSearchParams(queryString)`, collect all keys.
  - Result is a deduplicated `string[]`.

- [ ] **`runResult`**: always `undefined` at collection time. Populated later by the run-loader (Story 10).

- [ ] All existing fields (`name`, `file`, `collection`, `staticPath`, `method`, `tags`, `matchedSpecKey`) are populated exactly as before — no regression.

- [ ] Files that fail to parse (invalid YAML) are still silently skipped, same as current behavior.

- [ ] Fixture file read failures (missing file, invalid JSON) are silently swallowed — `requestBodyFields` falls back to `[]`.

---

## Example: What Gets Extracted

Given this test YAML:

```yaml
name: Create API Key
tags: [crud, validation]
request:
  method: POST
  path: /api/apikeys
  body:
    inline:
      name: "test-key"
      scopes: ["read"]
      expiresAt: null
response:
  status: 201
  shape:
    - "$.id"
    - "$.keyPrefix"
    - "$.createdAt"
post: |
  const body = ctx.response.body as any;
  ctx.assert(!!body.id, 'id must be present');
  ctx.assert(body.keyPrefix.length > 0, 'keyPrefix must be non-empty');
  ctx.vars.createdKeyId = body.id;
```

The resulting `TestEntry` gains:
```
expectedStatus:       201
shapeAssertions:      ["$.id", "$.keyPrefix", "$.createdAt"]
snapshotEnabled:      false
hasPreScript:         false
hasPostScript:        true
postScriptAssertCount: 2
requestBodyFields:    ["name", "scopes", "expiresAt"]
requestParams:        []
```

---

## Notes for Implementer

- The fixture file path resolution: `join(dirname(testFilePath), parsed.request.body.file)`. The `testFilePath` is the absolute path to the YAML file being parsed — already available in the loop as `filePath`.
- `postScriptAssertCount` uses simple substring counting: `(script.match(/assert\(/g) ?? []).length`. Do not use a regex that tries to exclude comments — the heuristic is intentionally simple.
- `requestParams` from query strings: split `staticPath` on `?`, take the second part if present, parse with `new URLSearchParams(qs).keys()` collected into an array.
- The `runResult` field is typed as optional (`runResult?: TestRunResult`) — the run-loader in Story 10 will mutate entries in-place after collection.
- Do not change the matcher or reporters in this story — they receive `TestEntry[]` and the new fields are simply ignored until later stories use them.
