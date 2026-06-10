---
name: run-spec
description: This skill should be used when the user asks to "execute the spec", "run the plan", "implement the issue", "run all steps", or "run spec". Implements all steps from a GitHub issue spec.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Run Spec

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
- If the step cannot be implemented as written (a referenced file, type, or
  signature does not exist or does not match the spec), STOP and report the
  discrepancy. Do not improvise an alternative design.
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

Verification is mechanical — scope, tests, build. Do not re-review the design; the spec already passed review.

1. Verify changed files match the files named in the step. Out-of-scope changes fail verification.
2. Run the tests named in the step and confirm they pass. If the step names no tests, run the project's compile/lint check on the changed files.
3. If the subagent reported a spec discrepancy, treat it as a spec defect (see Fix-Up Subagent), not a failed implementation.
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

If a step fails because the spec conflicts with the codebase (not because the subagent erred), do not burn fix-up attempts. Stop, post an issue comment describing the discrepancy (`gh issue comment $1 --body "..."`) so the spec can be corrected upstream, and report it as a spec defect.

## Acceptance Gate

After all steps succeed, verify the spec's Acceptance Criteria:

1. For each criterion, run the tests that the steps' `Covers: AC-n` tags map to it. Do not run the entire test suite — only the mapped tests.
2. Report criterion-by-criterion pass/fail.
3. A failing criterion means the work is not complete. Treat it like a failed step: one fix-up subagent scoped to the covering step(s), then stop and report if still failing.

## Completion

After the acceptance gate passes:

1. Per-step completion report with commit hash.
2. List of all modified files.
3. Acceptance criteria results (criterion-by-criterion).
4. Targeted tests/checks run and outcomes.
5. Follow-up risks or manual checks needed.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
