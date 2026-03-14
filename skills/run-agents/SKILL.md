---
name: run-agents
description: This skill should be used when the user asks to "execute the spec", "run the plan", "implement the issue", or "run all steps". Implements all steps from a GitHub issue spec.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Run

You are an **orchestrator**. Delegate implementation of each spec step to a dedicated subagent.  
You do not write production code directly unless subagent execution is unavailable.

Use surgical, low-risk changes. Do not add complexity, unnecessary conditions, or unnecessary backward compatibility.  
Do not run the entire test suite unless explicitly required.

SPEC: `gh issue view $1`

Always follow the project's engineering standards: `docs/engineering-standards.md`

## Inputs

- Issue spec: `gh issue view $1`
- Engineering standards: `docs/engineering-standards.md`

## Before Starting

1. Read `docs/engineering-standards.md` fully.
2. Read the issue spec via `gh issue view $1`.
3. Parse and isolate ALL implementation steps from the issue spec.
4. Announce which steps will be executed, in order.

## Execution Model: One Dedicated Subagent Per Step

For each step, run one subagent dedicated to that step.

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Implement issue #$1 step <step-id>",
  prompt: "<STEP_PROMPT>"
)
```

### STEP_PROMPT template

```txt
You are implementing a single step from a GitHub issue spec.

Issue: #$1
Step to implement: <exact step text>

Required reads before coding:
1. docs/engineering-standards.md
2. Full issue spec from: gh issue view $1
3. Any files needed to implement this step (read only what is relevant).

Rules:
- Implement ONLY this step. Do not do future steps.
- Keep changes simple, explicit, and fail-fast.
- No speculative abstractions or over-engineering.
- Prefer minimal, surgical edits.
- Follow existing project patterns.
- Add/adjust tests only when needed for this step.
- Do not run the entire test suite; run only targeted tests for changed behavior.

Output requirements:
1. Summary of what changed and why.
2. Exact files modified.
3. Commands run for verification and their outcomes.
4. Any assumptions or risks.
```

## After Each Subagent Returns

1. Verify changed files match the step scope.
2. Verify standards compliance (simple, explicit, no over-engineering).
3. Run targeted tests/checks yourself if needed.
4. If incomplete or incorrect, run one fix-up subagent for that same step.

## Fix-Up Subagent (Per Step)

If verification fails, invoke:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Fix issue #$1 step <step-id>",
  prompt: "Previous implementation for step <step-id> is incomplete or failing.
Errors/findings: <list>
Read docs/engineering-standards.md and relevant files again.
Fix only what is required for this step. Keep changes minimal.
Run targeted verification and report results."
)
```

Allow up to 2 fix-up attempts per step. If still failing, stop and report blockers clearly.

## Completion

After all steps succeed:

1. Provide a concise per-step completion report.
2. List modified files.
3. List targeted tests/checks run and outcomes.
4. Call out any follow-up risks or manual checks.
