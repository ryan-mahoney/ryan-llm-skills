---
name: spec-run
description: This skill should be used when the user asks to "execute the spec", "run the plan", "implement the spec", "implement the issue", "run all steps", or "run spec". Implements all steps from .specs/<slug>/spec.md, using a subagent per step when the harness supports subagents.
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
---

# Spec Run

You are an orchestrator. Implement every step in a reviewed implementation spec. Delegate each spec step to a dedicated subagent when the current harness supports subagents. Do not write production code directly unless subagent execution is unavailable.

Use surgical, low-risk changes. Do not add complexity, unnecessary conditions, or unnecessary backward compatibility.

## Resolve the Spec

Resolve the spec target in this order:

1. If `$ARGUMENTS` is a path to a markdown file, use that file.
2. If `$ARGUMENTS` names a folder under `.specs/`, use `.specs/<feature-slug>/spec.md`.
3. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and use the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md`.
4. If no argument is provided, use the most recently modified `.specs/*/spec.md`.

If no local spec can be resolved, stop and report the missing input. Local `spec.md` is canonical; GitHub issues are optional mirrors.

Capture the feature slug from the `Spec folder:` footer or parent folder. Capture a GitHub issue number only when it is provided or can be verified from an available mirror.

## Before Starting

1. Read the full local spec file.
2. Parse and isolate all Implementation Steps from the spec.
3. Confirm every step has a `Covers: AC-n` tag or traces to a stated architectural need.
4. Announce which steps will be executed, in order.

If the spec references files, types, or signatures that do not exist and are not explicitly part of a prior step, treat that as a spec defect and stop.

## Load Conformance Guardrails (Optional)

If `spec-criteria` was run, a compiled conformance checklist exists at `.specs/<feature-slug>/criteria/phase-<n>.md` (or `criteria.md`), with a cross-phase ledger at `.specs/<feature-slug>/invariants.md`. These let implementers avoid the behaviorally-silent conformance slips that pass tests but violate the spec's ownership and placement directives.

**This step is best-effort and never blocking.** Most violations are cheap to fix at audit time, so a missing or unreadable checklist must not stop or delay `spec-run`:

- If no `criteria/` file and no `invariants.md` exist, skip this section silently and proceed. Do not run `spec-criteria`, do not warn, do not block — `spec-audit` is the backstop either way.
- If the files exist but cannot be parsed, skip silently and proceed.
- Resolve the phase loosely: a phase marker in `spec.md`, else `criteria.md`, else the single `criteria/phase-*.md` if exactly one exists. If the phase is ambiguous (multiple phase files, no marker), skip silently — do not guess.

When a checklist is found, extract guardrails with two deliberate limits:

1. **Prose only, never the check.** Take each criterion's `Source:` quote (the spec sentence). Never include the `Check:` command, grep pattern, or expected hit set. The implementer must satisfy the *property*, not the proxy — handing it the grep invites letter-not-spirit evasion and destroys the audit's independence as verification.
2. **High-risk constraints only.** Include only `X`-mode (cross-phase ownership) criteria and `invariants.md` entries not marked superseded, plus any `D`/`S` criterion whose violation would be expensive to fix once later code depends on it (ownership, placement, layering). Skip `G` trivia and anything already pinned by an acceptance criterion (`T`). These are the "built on the wrong foundation" failures worth preventing up front; the rest stays a pure end-audit.

Collect the selected `Source:` quotes verbatim into a short guardrail list. This list is injected into every step's prompt (below). If the list is empty after filtering, omit the guardrail block from the prompt entirely.

## Execution Model: One Subagent Per Step

For each step, run one subagent dedicated to that step.

Preferred generic invocation for Codex, Claude, OpenCode, and harnesses with a generic subagent facility:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Implement <feature-slug> step <step-id>",
  prompt: "<STEP_PROMPT>"
)
```

Augment CLI adapter:

- Use the `spec-step-implementer` subagent when it is configured under `~/.augment/agents/` or `./.augment/agents/`.
- Ask that subagent to implement exactly one step using the same Step Prompt below.
- If Augment subagents are unavailable in the current client, implement the step directly and report that subagent execution was unavailable.

### Step Prompt Template

```txt
You are implementing a single step from a repository-local implementation spec.

Spec file: <absolute path to .specs/<feature-slug>/spec.md>
GitHub mirror: <issue number or "none">
Step to implement: <exact step text>

Conformance guardrails (ownership/placement constraints this step must respect;
omit this block entirely when the guardrail list is empty):
<CONFORMANCE_GUARDRAILS — one Source quote per line, or omitted>

Before coding, read:
1. The full local spec file.
2. Any source files needed to implement this step.

Rules:
- Implement ONLY this step. Do not do future steps.
- If the step cannot be implemented as written because a referenced file, type,
  signature, or project convention does not exist or does not match the spec,
  STOP and report the discrepancy. Do not improvise an alternative design.
- Keep changes simple, explicit, and fail-fast.
- No speculative abstractions or over-engineering.
- Prefer minimal, surgical edits.
- Follow existing project patterns.
- Add or adjust tests only when needed for this step.
- Do not run the entire test suite; run only targeted tests for changed behavior.

Engineering principles:
- Fail fast on invalid inputs. No defensive fallbacks unless explicitly required.
- Prefer raising errors over silent failures or default values.
- Simple over clever. Boring, maintainable code.
- Build for today, not imagined futures.
- Concise and idiomatic code. Small functions under 10-15 lines where practical.
- Single responsibility per function.
- Clear but concise naming.
- Rule of three: do not abstract until 3 uses.
- Contextual error messages: what failed, what was expected, how to fix.
- Propagate errors; do not suppress them.
- Do not add try/catch unless explicitly needed.
- Do not create interfaces with only one implementation.
- Do not add comments explaining what code obviously does.

Output requirements:
1. Summary of what changed and why.
2. Exact files modified.
3. Commands run for verification and their outcomes.
4. Any assumptions, risks, or spec discrepancies.
```

## After Each Subagent Returns

Verification is mechanical: scope, tests, build. Do not re-review the design; the spec already passed review.

1. Verify changed files match the files named in the step. Out-of-scope changes fail verification.
2. Run the tests named in the step and confirm they pass. If the step names no tests, run the project's compile/lint/type check that is narrowest for the changed files.
3. If the subagent reported a spec discrepancy, treat it as a spec defect, not a failed implementation.
4. If incomplete or incorrect, run one fix-up subagent for that step.
5. Once verified, stage the changed files and commit:
   - Conventional commit message: `type(scope): description`.
   - If a GitHub issue number is known, append `(#<issue-number>)`.
   - Type reflects the nature of the change: `feat`, `fix`, `refactor`, `chore`, or `test`.

Each step gets its own commit. This enables per-step review.

## Fix-Up Subagent

If verification fails, invoke one fix-up subagent:

```txt
Previous implementation for step <step-id> is incomplete or failing.

Spec file: <absolute path to spec.md>
Errors/findings: <list>

Read the local spec and relevant source files. Fix only what is required for
this step. Keep changes minimal. Run targeted verification and report results.
```

Allow up to 2 fix-up attempts per step. If still failing, stop and report blockers.

If a step fails because the spec conflicts with the codebase, do not burn fix-up attempts. Record the discrepancy in `.specs/<feature-slug>/blockers.md`. If a GitHub issue mirror is available, also post the blocker as an issue comment with `gh issue comment <issue-number> --body "..."`.

## Acceptance Gate

After all steps succeed, verify the spec's Acceptance Criteria:

1. For each criterion, run the tests that the steps' `Covers: AC-n` tags map to it. Do not run the entire test suite unless the spec explicitly names it as the only meaningful verification.
2. Report criterion-by-criterion pass/fail.
3. A failing criterion means the work is not complete. Treat it like a failed step: one fix-up subagent scoped to the covering step or steps, then stop and report if still failing.

## Completion

After the acceptance gate passes, report:

1. Spec path and GitHub mirror, if any.
2. Per-step completion report with commit hash.
3. List of all modified files.
4. Acceptance criteria results, criterion-by-criterion.
5. Targeted tests/checks run and outcomes.
6. Follow-up risks or manual checks needed.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
