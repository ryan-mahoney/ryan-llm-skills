---
name: run-agents
description: This skill should be used when the user asks to "execute the spec", "run the plan", "implement the issue", or "run all steps". Implements all steps from a GitHub issue spec.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Run

You are an orchestrator. Delegate implementation of each spec step to a dedicated subagent.
You do not write production code directly unless subagent execution is unavailable.

Use surgical, low-risk changes. Do not add complexity, unnecessary conditions, or unnecessary backward compatibility.

SPEC: `gh issue view $1`

## Before Starting

1. Read the issue spec via `gh issue view $1`.
2. Parse and isolate ALL implementation steps from the issue spec.
3. Announce which steps will be executed, in order.

## Execution Model: One Subagent Per Step

For each step, run one subagent dedicated to that step.

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Implement issue #$1 step <step-id>",
  prompt: "<STEP_PROMPT>"
)
```

### STEP_PROMPT Template

```txt
You are implementing a single step from a GitHub issue spec.

Issue: #$1
Step to implement: <exact step text>

Before coding, read:
1. Full issue spec from: gh issue view $1
2. Any source files needed to implement this step.

Rules:
- Implement ONLY this step. Do not do future steps.
- Keep changes simple, explicit, and fail-fast.
- No speculative abstractions or over-engineering.
- Prefer minimal, surgical edits.
- Follow existing project patterns.
- Add/adjust tests only when needed for this step.
- Do not run the entire test suite; run only targeted tests for changed behavior.

Engineering principles:
- Fail fast on invalid inputs. No defensive fallbacks unless explicitly required.
- Prefer raising errors over silent failures or default values.
- Simple over clever. Boring, maintainable code.
- Build for today, not imagined futures.
- Concise and idiomatic code. Small functions under 10-15 lines.
- Single responsibility per function.
- Clear but concise naming.
- Rule of three: do not abstract until 3 uses.
- Contextual error messages: what failed, what was expected, how to fix.
- Propagate errors, do not suppress.
- Do not add try/catch unless explicitly needed.
- Do not create interfaces with only one implementation.
- Do not add comments explaining what code obviously does.

Output requirements:
1. Summary of what changed and why.
2. Exact files modified.
3. Commands run for verification and their outcomes.
4. Any assumptions or risks.
```

## After Each Subagent Returns

1. Verify changed files match the step scope.
2. Verify compliance: simple, explicit, no over-engineering, follows project patterns.
3. Run targeted tests/checks if needed.
4. If incomplete or incorrect, run one fix-up subagent for that step (see below).
5. Once verified, stage the changed files and commit:
   - Conventional commit message: `type(scope): description (#$1)`
   - Type reflects the nature of the change (feat, fix, refactor, chore, test).
   - Reference the issue number.

Each step gets its own commit. This enables per-step review.

## Fix-Up Subagent

If verification fails, invoke:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Fix issue #$1 step <step-id>",
  prompt: "Previous implementation for step <step-id> is incomplete or failing.
Errors/findings: <list>
Read the issue spec via gh issue view $1 and relevant source files.
Fix only what is required for this step. Keep changes minimal.
Run targeted verification and report results."
)
```

Allow up to 2 fix-up attempts per step. If still failing, stop and report blockers.

## Completion

After all steps succeed:

1. Per-step completion report with commit hash.
2. List of all modified files.
3. Targeted tests/checks run and outcomes.
4. Follow-up risks or manual checks needed.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
