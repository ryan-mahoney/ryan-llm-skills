---
name: spec-run-glm-mimo
description: Use this OpenCode-specific variant when the user asks to run a spec with GLM 5.2 planning/orchestration and Xiaomi MiMo-25 implementation. It follows spec-run semantics, but routes planning through GLM 5.2 and implementation through Xiaomi MiMo-25.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, GitHub issue number, optional criteria.md/invariants.md paths]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec Run GLM MiMo

This is a variant of `spec-run`, not a replacement for it.

First read `/Users/ryanmahoney/.agents/skills/spec-run/SKILL.md` in full and
follow its canonical orchestration contract unless this file explicitly overrides
it. Keep all `spec-run` guarantees: resolve and read the local `spec.md`, load
guardrails, run one step at a time, verify each step, stage only that step's
files, and commit each successful step separately.

## Resume From A Step

This variant accepts resume language in `$ARGUMENTS`, including:

- `start from step <number>`
- `resume from step <number>`
- `starting at step <number>`
- `steps <number>-end`

When such a phrase is present, execute only that step number and every later
implementation step. Treat earlier steps as already handled by the previous run:

- Do not re-run, re-plan, re-verify, stage, or commit earlier steps.
- Do not edit earlier-step subspecs.
- Announce the skipped step range before launching the first resumed step.
- In the final report, list skipped earlier steps separately from completed
  resumed steps.

If the requested starting step does not exist in the spec's Implementation Steps,
stop before coding and report the bad step number. If no resume phrase is present,
run the full canonical `spec-run` sequence.

## GLM MiMo OpenCode Routing

Use the global OpenCode agents configured in `~/.config/opencode/opencode.jsonc`:

- `spec-run-glm-mimo-orchestrator`: primary orchestration agent using
  `zai-coding-plan/glm-5.2`.
- `spec-run-glm-mimo-planner`: subagent for per-step subspec planning using
  `zai-coding-plan/glm-5.2`.
- `spec-run-glm-mimo-implementer`: subagent for implementation and fix-ups using
  `xiaomi-token-plan-sgp/mimo-v2.5`.

If those specialized agents are unavailable, fall back to canonical `spec-run`
subagent behavior and report that the GLM 5.2 / Xiaomi MiMo-25 split was unavailable.

## Per-Step Flow

For each implementation step:

1. Run `spec-run-glm-mimo-planner` with the Planning Prompt below.
2. If the planner reports a hard blocker or spec/code mismatch, treat it as a
   spec defect and stop before implementation.
3. Run `spec-run-glm-mimo-implementer` with the Implementation Prompt below.
4. Perform the normal `spec-run` post-step verification, staging, and commit.

## Planning Prompt

```txt
You are planning a single implementation step from a repository-local spec.

Spec file: <absolute path to .specs/<feature-slug>/spec.md>
GitHub mirror: <issue number or "none">
Step to plan: <exact step text>
Subspec output: <absolute path to .specs/<feature-slug>/subspecs/<step-number>-spec.md>

Conformance guardrails (ownership/placement constraints this step must respect;
omit this block entirely when the guardrail list is empty):
<CONFORMANCE_GUARDRAILS - one Source quote per line, or omitted>

Applicable rules (read each file before planning; omit this block when none apply):
<APPLICABLE_RULE_PATHS - one path per line, or omitted>

Follow the spec-subspec-write skill for this one step:
- Read the full local spec file.
- Ground the plan by reading only the files this step names plus their immediate
  neighbors.
- Do not re-survey the repo or re-derive architecture.
- When this step creates new code, apply the spec-subspec-write new-code checks:
  targeted reuse search plus one model file.
- Write the subspec to the exact Subspec output path above.
- Capture target files/symbols as they exist now, concrete edit sequence, test
  plan, and hard stop conditions.

Rules:
- Do not edit production code.
- Do not implement the step.
- If grounding reveals a spec/code mismatch, stop and report it.

Output requirements:
1. Path to the subspec written for this step.
2. One-line summary of the planned edit sequence.
3. Any assumptions, risks, blockers, or spec discrepancies.
```

## Implementation Prompt

```txt
You are implementing a single step from a repository-local implementation spec.

Spec file: <absolute path to .specs/<feature-slug>/spec.md>
GitHub mirror: <issue number or "none">
Step to implement: <exact step text>
Subspec file: <absolute path to .specs/<feature-slug>/subspecs/<step-number>-spec.md>

Conformance guardrails (ownership/placement constraints this step must respect;
omit this block entirely when the guardrail list is empty):
<CONFORMANCE_GUARDRAILS - one Source quote per line, or omitted>

Applicable rules (read each file before coding; omit this block when none apply):
<APPLICABLE_RULE_PATHS - one path per line, or omitted>

Before coding, read:
1. The full local spec file.
2. The already-written subspec file for this step.
3. Any source files needed to implement this step.

Rules:
- Implement only this step. Do not do future steps.
- Implement against the subspec. Do not rewrite it unless it is missing or
  contradicted by the current code.
- If the step cannot be implemented as written because a referenced file, type,
  signature, or project convention does not exist or does not match the spec,
  stop and report the discrepancy. Do not improvise an alternative design.
- Keep changes simple, explicit, and fail-fast.
- No speculative abstractions or over-engineering.
- Prefer minimal, surgical edits.
- Follow existing project patterns.
- Add or adjust tests only when needed for this step.
- Do not run the entire test suite; run only targeted tests for changed behavior.

Output requirements:
1. Path to the subspec used for this step.
2. Summary of what changed and why.
3. Exact files modified.
4. Commands run for verification and their outcomes.
5. Any assumptions, risks, or spec discrepancies.
```

## Fix-Ups

If verification fails, use `spec-run-glm-mimo-implementer` for fix-ups. The
planner agent is only for subspec creation.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
