# Design: Agent Test Type (LLM-as-Judge Evaluation)

> Status: Design Draft — 2026-08-13
> Participants: shogun-sword (designer), enigma-cerebrus (coordinator)

---

## Overview

A new test type — `agent` — that tests AI agent workflow responses. The test
defines a prompt, parameters, a target model, and an expected result. After
execution, the test engine hands the expected result and the actual result to
a **third-party evaluator agent** (an LLM acting as judge) which returns a
grade (e.g., 80%, 90%) and pass/fail verdict — not just a binary match.

This is fundamentally different from shogun's existing deterministic assertion
model (status code → jq shape → snapshot diff). Those are deterministic; this
is probabilistic.

---

## Open Design Questions

These are the decisions we need to make before writing any code. We will
work through them one at a time.

1. **Does shogun call the LLM directly, or does it call an evaluation endpoint?**
   - Option A: Shogun becomes an LLM client (adds OpenAI/Anthropic SDK dependency)
   - Option B: Shogun calls an internal evaluation endpoint (stays shell-first HTTP)
   - Option C: Shogun shells out to an external evaluator CLI
   - *Status: Under discussion*

2. **What is the evaluator's response contract?**
   - What JSON shape does the evaluator return?
   - Is it configurable or enforced by shogun?
   - *Status: Proposed — see "Evaluator Response Contract" below*

3. **How do we handle non-determinism?**
   - LLM-as-judge is non-deterministic. Same test could pass/fail across runs.
   - Options: temperature 0, retry threshold, score banding, accept flakiness
   - *Status: Open*

4. **How does this fit into the existing type system?**
   - New `evaluation` field in `AssertionResults`?
   - New `TestResult` fields for grade/reasoning?
   - Does `status` still work (passed = grade >= min_pass)?
   - *Status: Proposed — see "Type System Fit" below*

5. **What does the YAML schema look like?**
   - The `agent:` + `expected:` + `evaluate:` blocks
   - How much is inline vs config-level?
   - *Status: Proposed — see "Proposed YAML Schema" below*

6. **The snapshot problem — what is the baseline?**
   - No `expected/` directory for agent tests
   - The "baseline" is the semantic description in the YAML
   - No `shogun snapshot` for agent tests
   - *Status: Proposed*

7. **Cost and rate limiting**
   - LLM evaluation calls cost money and time
   - Need cost tracking? Rate limiting? Caching?
   - *Status: Open*

---

## Proposed YAML Schema (Draft)

```yaml
name: Agent Explains Code Correctly
description: Tests that the agent can explain a function's purpose
type: agent

agent:
  # The endpoint to send the prompt to
  endpoint: /api/agents/chat
  model: gpt-4o
  temperature: 0.3
  max_tokens: 1024
  prompt: |
    Explain what the following function does and identify any bugs:

    function add(a, b) {
      return a - b;  // BUG: should be a + b
    }

  # Optional: additional context/parameters
  parameters:
    system_prompt: "You are a code review assistant."
    context_files:
      - path: src/utils.ts

# What we expect the agent to produce
expected:
  description: |
    The agent should identify that the function is named "add" but
    uses subtraction (-) instead of addition (+). It should explain
    that this is a bug and suggest changing `a - b` to `a + b`.

  # Could also be a concrete expected output for more deterministic cases
  # expected_output: |
  #   The function `add` contains a bug...

# How the evaluation should work
evaluate:
  evaluator_model: gpt-4o
  evaluator_endpoint: /api/agents/evaluate
  criteria:
    - "Correctly identifies the subtraction bug"
    - "Suggests the fix (change - to +)"
    - "Explains the function's intended purpose"
  scale: percentage    # percentage | pass_fail | rubric
  min_pass: 80
  evaluator_system_prompt: |
    You are evaluating an AI assistant's response. Compare the actual
    response to the expected response and the provided criteria.
    Return a JSON object with a grade (0-100) and reasoning.
```

---

## Evaluator Response Contract (Draft)

The evaluator agent returns structured JSON:

```json
{
  "grade": 85,
  "passed": true,
  "reasoning": "The agent correctly identified the subtraction bug and suggested the fix, but missed mentioning the function's intended purpose.",
  "criteria_results": [
    { "criterion": "Correctly identifies the subtraction bug", "met": true },
    { "criterion": "Suggests the fix (change - to +)", "met": true },
    { "criterion": "Explains the function's intended purpose", "met": false }
  ]
}
```

Shogun enforces this contract — the evaluator prompt instructs the model to
return this specific JSON shape, and shogun parses it.

---

## Type System Fit (Draft)

New `evaluation` field in `AssertionResults`:

```typescript
interface AssertionResults {
  status?: boolean;
  shape?: ShapeAssertionResult[];
  snapshot?: boolean;
  snapshotDiff?: string | null;
  postScript?: boolean;
  postScriptError?: string;
  // New for agent tests:
  evaluation?: {
    grade: number;           // 0-100
    passed: boolean;
    reasoning: string;
    criteriaResults?: { criterion: string; met: boolean }[];
    evaluatorModel?: string;
    durationMs?: number;
  };
}
```

`TestResultStatus` stays the same — `passed` means grade >= min_pass, `failed`
means grade < min_pass.

---

## Core Insight

> This is a new **assertion mechanism**, not a new execution mechanism.
> The execution is still "make an HTTP call and get a response." The
> innovation is in the evaluation phase — replacing deterministic assertions
> with LLM-as-judge.

The existing shogun execution flow (pre-script → curl → assert → post-script)
still applies. The `agent` test type plugs into the same runner loop — it
just has a different assertion phase.

---

## Decisions Log

| # | Question | Decision | Date |
|---|----------|----------|------|
| 1 | Shogun calls LLM directly vs evaluation endpoint | Under discussion | 2026-08-13 |
| 2 | Evaluator response contract | Proposed (JSON above) | 2026-08-13 |
| 3 | Non-determinism handling | Open | — |
| 4 | Type system fit | Proposed (evaluation field) | 2026-08-13 |
| 5 | YAML schema | Proposed (draft above) | 2026-08-13 |
| 6 | Snapshot / baseline approach | No snapshots for agent tests | 2026-08-13 |
| 7 | Cost and rate limiting | Open | — |
