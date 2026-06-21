---
name: spec-run
description: This skill should be used when the user asks to "execute the spec", "run the plan", "implement the spec", "implement the issue", "run all steps", or "run spec". Implements all steps from .specs/<slug>/spec.md, honoring criteria/invariants guardrails, using a subagent per step when the harness supports subagents, and committing each verified step separately.
mode: coding
scope: document
capability: orchestrator
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, GitHub issue number, optional criteria.md/invariants.md paths]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "7"
---

# Spec Run

You are an orchestrator. Implement every step in a reviewed implementation spec. Delegate each spec step to a dedicated subagent when the current harness supports subagents. Do not write production code directly unless subagent execution is unavailable.

Use surgical, low-risk changes. Do not add complexity, unnecessary conditions, or unnecessary backward compatibility.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When something is unclear or underspecified, make a reasonable, well-grounded decision from the available context — the conversation, the repository, existing conventions, and the spec's own intent — then proceed. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when a required input is genuinely missing and cannot be inferred (for example, no spec to work from). In that case, report what is missing and halt — do not ask for it interactively.

## Orchestration Contract

These requirements are part of the skill itself. Enforce them even when the user only says `spec-run <target>` and does not repeat them at invocation time:

1. Resolve and read the local `spec.md` before doing implementation work.
2. Always look for conformance guardrails: use any explicit `criteria.md` or `invariants.md` paths in the invocation, otherwise use sibling files beside the resolved spec.
3. Use one dedicated subagent per implementation step whenever the current harness supports subagents. If no subagent mechanism is available, say so before coding and again in the final report.
4. Have each step produce its own subspec before coding, per the Per-Step Sub-Planning section.
5. Verify, stage, and commit each successful step before starting the next one. Do not batch multiple implementation steps into one commit.

## Resolve the Spec

Treat `$ARGUMENTS` as the full invocation string, not just a single token. It may contain prose such as `<spec path>; also be mindful of <invariants-path> and <criteria-path>; commit each step; use subtasks`.

First scan the invocation for local markdown paths, whether absolute or repository-relative, and strip surrounding quotes plus trailing punctuation such as `;`, `,`, or `.`. Classify them before resolving the spec:

- `criteria_path`: any path whose basename is `criteria.md`.
- `invariants_path`: any path whose basename is `invariants.md`.
- `spec_path`: any path whose basename is `spec.md`; if none exists, the first markdown path not already classified.

Explicit `criteria_path` and `invariants_path` values are guardrail inputs only; they do not change the feature slug. If an explicit guardrail path is missing or unreadable, stop before coding and report the bad path. If a default sibling guardrail path is missing, skip it silently.

Resolve the spec target in this order:

1. If `spec_path` was extracted, use that file.
2. If `$ARGUMENTS` is a path to another markdown file, use that file.
3. If `$ARGUMENTS` names a folder under `.specs/`, use `.specs/<feature-slug>/spec.md`.
4. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and use the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md`.
5. If no argument is provided, use the most recently modified `.specs/*/spec.md`.

If no local spec can be resolved, stop and report the missing input. Local `spec.md` is canonical; GitHub issues are optional mirrors.

Capture the feature slug from the `Spec folder:` footer or parent folder. Capture a GitHub issue number only when it is provided or can be verified from an available mirror.

## Before Starting

1. Read the full local spec file.
2. Parse and isolate all Implementation Steps from the spec.
3. Confirm every step has a `Covers: AC-n` tag or traces to a stated architectural need.
4. Announce which steps will be executed, in order.

If the spec references files, types, or signatures that do not exist and are not explicitly part of a prior step, treat that as a spec defect and stop.

## Load Conformance Guardrails

Always perform this pass before launching step subagents. If `spec-criteria` was run, a compiled conformance checklist exists at `.specs/<feature-slug>/criteria.md`, with a cross-phase ledger at `.specs/<feature-slug>/invariants.md`. These let implementers avoid the behaviorally-silent conformance slips that pass tests but violate the spec's ownership and placement directives.

Use explicit `criteria_path` and `invariants_path` values from the invocation when present. Otherwise, look for `.specs/<feature-slug>/criteria.md` and `.specs/<feature-slug>/invariants.md`.

Default sibling guardrails are best-effort and never blocking. Most violations are cheap to fix at audit time, so a missing or unreadable default checklist must not stop or delay `spec-run`:

- If no default `criteria.md` and no default `invariants.md` exist, skip this section silently and proceed. Do not run `spec-criteria`, do not warn, do not block; `spec-audit` is the backstop either way.
- If a default file exists but cannot be parsed, skip that file silently and proceed.
- If an explicit guardrail path was supplied and cannot be read or parsed, stop before coding and report the path.
- Read both guardrail files independently when available. A missing `criteria.md` does not prevent using `invariants.md`, and a missing `invariants.md` does not prevent using `criteria.md`.

When a checklist is found, extract guardrails with two deliberate limits:

1. **Prose only, never the check.** Take each criterion's `Source:` quote (the spec sentence). Never include the `Check:` command, grep pattern, or expected hit set. The implementer must satisfy the *property*, not the proxy — handing it the grep invites letter-not-spirit evasion and destroys the audit's independence as verification.
2. **High-risk constraints only.** Include only `X`-mode (cross-phase ownership) criteria and `invariants.md` entries not marked superseded, plus any `D`/`S` criterion whose violation would be expensive to fix once later code depends on it (ownership, placement, layering). Skip `G` trivia and anything already pinned by an acceptance criterion (`T`). These are the "built on the wrong foundation" failures worth preventing up front; the rest stays a pure end-audit.

Collect the selected `Source:` quotes and live invariant statements verbatim into a short guardrail list. This list is injected into every step's prompt (below). If the list is empty after filtering, omit the guardrail block from the prompt entirely.

## Load Applicable Rules (Optional)

If the spec has an Applicable Rules section listing rule files, resolve each path. Best-effort and never blocking: if the section is absent, "N/A", or a listed file is missing, skip it silently and proceed.

Pass the resolved paths into every step's prompt (below). Step subagents read the rule files themselves — do not inline rule contents into the prompt. If no paths resolve, omit the rules block from the prompt entirely.

## Per-Step Sub-Planning

Before writing code for a step, each step subagent first produces a minimal,
code-grounded plan for that one step at `.specs/<feature-slug>/subspecs/<step-number>-spec.md`,
following the `spec-subspec-write` skill. The parent `spec.md` decided *what* and
*why*; the subspec commits to *how* — the concrete edit sequence against the code as
it exists now, grounded by reading only the files that step touches (not a repo
re-analysis), plus the spec-subspec-write new-code checks (reuse search and model
file) when the step creates new code. The subagent then implements against its own
subspec.

This is always-on and best-effort: write the subspec, then implement. The subspec is
a planning artifact, never a gate — a thin subspec for a trivial step is fine, and a
failure to write one does not block the implementation.

## Execution Model: One Subagent Per Step

For each step, run one subagent dedicated to that step. Subagent use is not an optional enhancement for this skill: if a subagent mechanism exists, use it for every implementation step and fix-up. If the harness has no subagent mechanism, report that limitation before direct implementation.

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

Applicable rules (read each file before coding; they set the design, copy, or
testing conventions this work must follow; omit this block when none apply):
<APPLICABLE_RULE_PATHS — one path per line, or omitted>

Before coding, read:
1. The full local spec file.
2. Any source files needed to implement this step.

Plan before coding (per the spec-subspec-write skill):
- First write a minimal, code-grounded plan for THIS step to
  <absolute path to .specs/<feature-slug>/subspecs/<step-number>-spec.md>.
- Ground it by reading ONLY the files this step names plus their immediate
  neighbors (direct callers/callees and the existing test file). Do not re-survey
  the repo or re-derive the architecture; spec.md already did that.
- Exception when this step creates a new function, helper, or file: apply the
  spec-subspec-write new-code checks — a targeted search for an existing
  equivalent (reuse or extend it if found; if the spec mandates a new
  implementation anyway, record the conflict instead of silently duplicating)
  and one model file to match for layout, naming, and error idioms.
- Capture: target files/symbols as they exist now, the ordered concrete edit
  sequence, the specific test cases + target test file, and any stop conditions.
- Then implement against your own subspec. If grounding reveals a spec/code
  mismatch, STOP and report it instead of improvising.

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
1. Path to the subspec written for this step.
2. Summary of what changed and why.
3. Exact files modified.
4. Commands run for verification and their outcomes.
5. Any assumptions, risks, or spec discrepancies.
```

## After Each Subagent Returns

Verification is mechanical: scope, tests, build. Do not re-review the design; the spec already passed review.

1. Verify changed files match the files named in the step. Out-of-scope changes fail verification. The step's own `.specs/<feature-slug>/subspecs/<step-number>-spec.md` is a planning artifact, not a production change, and does not count as out of scope.
2. Run the tests named in the step and confirm they pass. If the step names no tests, run the project's compile/lint/type check that is narrowest for the changed files.
3. If the subagent reported a spec discrepancy, treat it as a spec defect, not a failed implementation.
4. If incomplete or incorrect, run one fix-up subagent for that step.
5. Once verified, inspect `git status` and stage only this step's changed files, then commit:
   - Conventional commit message: `type(scope): description`.
   - If a GitHub issue number is known, append `(#<issue-number>)`.
   - Type reflects the nature of the change: `feat`, `fix`, `refactor`, `chore`, or `test`.

Each step gets its own commit. Do not start the next implementation step until the current step has passing targeted verification and its own commit hash.

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
