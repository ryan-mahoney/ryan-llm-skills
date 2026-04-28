---
name: specops-run-spec
description: This skill should be used when the user asks to "run the spec", "implement the spec", or "execute the spec". Implements every step in a SpecOps implementation spec by delegating each step (or logical group of adjacent steps) to a sequential subagent, conventional-committing each one independently, and — when `roborev` is on the path — running `roborev check` on every commit and `roborev fix` (with spec context, so the fix cannot silently drift the implementation away from the spec) on any commit that fails.
disable-model-invocation: true
argument-hint: "[spec-file]"
---

# SpecOps Run Spec

Implement every step from a SpecOps implementation spec. Each step (or logical group of adjacent steps) is delegated to a sequential subagent. After each subagent completes, stage the changes, write a conventional commit, and proceed to the next.

If `roborev` is available on the path, run `roborev check` on each new commit and `roborev fix` on any commit that fails the check.

Use surgical, low-risk changes. Do not add complexity, unnecessary conditions, or unnecessary backward compatibility. Do not run the entire test suite.

SPEC: `$1` — path to a SpecOps implementation spec (typically under `docs/specops/specs/`).

If `$1` is missing, ask the user.

## Before Starting

1. Read the spec file at `$1`. If the file does not exist, stop and report.
2. Locate the **Implementation Steps** section (Section 7 of a `specops-make-spec` output). Each numbered step contains: what to do, why, signatures/contracts, and tests.
3. Build the ordered list of every step in spec order.
4. Optionally cluster contiguous steps into logical groups when grouping reduces churn — for example, a contracts/types step and the immediately-following pure-domain step on the same module. Do not group across architectural boundaries (contracts → I/O → wiring stay separate). When in doubt, keep steps individual.
5. Detect roborev: run `command -v roborev` (or equivalent). Record `ROBOREV_PRESENT=true|false` for the run.
6. Confirm the working tree is clean. If it is not, stop and report — partial uncommitted changes will get folded into the first commit and corrupt traceability.
7. Announce the full step list, any groupings, and the roborev status before delegating.

## Execution Model: Sequential Subagent Per Step or Group

Process steps (or groups) one at a time. Do not parallelize — each step's commit may modify files the next step depends on, and the working tree must be clean between subagents.

For each step or group, invoke:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Implement spec step <step-id>",
  prompt: "<STEP_PROMPT>"
)
```

### STEP_PROMPT Template

```txt
You are implementing one step (or logical group of adjacent steps) from a SpecOps implementation spec.

Spec file: <spec-path>
Step(s) to implement: <step numbers>
Step content (verbatim from Section 7 of the spec):
<paste exact step text — what to do, why, signatures/contracts, tests>

# Your task
1. Read the step(s) and evaluate whether the prescribed approach still fits the current state of the codebase. Adapt if the spec is out of date relative to what's already there; flag any adaptation in your return summary with rationale.
2. Implement the step(s) with surgical, low-risk changes.
3. Run only the targeted tests relevant to the changed behavior. Do NOT run the full test suite.
4. Do NOT stage or commit. The orchestrator handles staging, commits, and roborev.

# Implementation principles
- Fail fast on invalid inputs. No defensive fallbacks or "just in case" logic unless explicitly required.
- Prefer raising errors over silent failures, default values, or swallowing exceptions.
- Simple over clever. Boring, maintainable code beats clever optimizations.
- Build for today. Design for current requirements, not imagined future ones.
- Concise and idiomatic. Write code like a senior engineer, not a tutorial.
- Small functions under 10–15 lines. Extract helpers liberally.
- Single responsibility per function.
- Rule of three: do not abstract until there are three uses.
- Contextual error messages: what failed, what was expected, how to fix.
- Propagate errors; do not suppress.
- Follow existing project patterns and conventions.

Do not:
- Add try/catch unless explicitly required.
- Create interfaces with only one implementation.
- Add comments explaining what code obviously does.
- Write defensive "safety" logic for scenarios that indicate bugs.

# Return
Return a concise summary:
- Files changed (list).
- Any adaptation from the spec's prescribed approach, with rationale.
- Targeted tests run and their result.
- Any blockers or follow-ups for the orchestrator.
```

## Per-Step Workflow

For each step (or group), in order:

1. Confirm the working tree is clean. If it is not (e.g., the previous step left untracked changes), stop and report.
2. Spawn the subagent with the step prompt above.
3. When it returns, review the summary. If the subagent reports a blocker or its targeted tests fail, run one fix-up subagent (see template below). If still failing, stop and report; do not commit a partial implementation.
4. Stage the changed files.
5. Write a conventional commit message: `type(scope): description (spec: <spec-basename> step <N>)` where:
   - `type` reflects the change (feat, fix, refactor, chore, test).
   - `scope` is the module or area touched, derived from changed files or the spec's Architecture section.
   - `description` is a short imperative summary of the step's outcome.
   - For grouped steps, include the range: `step <N>-<M>`.
6. Commit.
7. If `ROBOREV_PRESENT`:
   a. Run `roborev check` on the new commit (e.g., `roborev check HEAD`).
   b. If the check fails:
   i. Construct the Roborev Fix Context (see template below) for the step(s) just committed.
   ii. Run `roborev fix` on the commit, passing the context. Use whichever input mechanism the local roborev supports — common patterns are a `--context-file <tmp-path>` flag, an inline `--message` flag, or stdin. Roborev's fix typically amends the commit or appends a fix-up; let it complete without intervention.
   iii. Re-run the step's targeted tests. If they now fail, roborev's fix conflicted with the spec — stop and report; do not proceed to the next step.
   iv. Re-run `roborev check`. If the check still fails, or if roborev itself reports that a finding was deferred due to spec conflict, stop and report.
8. Move to the next step or group.

Allow at most one fix-up subagent invocation per step. If still failing after the fix-up, stop and report.

## Fix-Up Subagent Template

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Fix spec step <step-id>",
  prompt: "Previous implementation of step <N> from <spec-path> is incomplete or failing.
Findings: <list>
Targeted test failures or blockers: <list>
Re-read the step and the relevant files.
Apply only the changes needed to satisfy the step's acceptance criteria and targeted tests.
Do NOT stage or commit.
Return: what changed and why."
)
```

## Roborev Fix Context

When `roborev check` fails and `roborev fix` is invoked, pass spec context so roborev does not apply changes that conflict with the spec or its intent. Without this, roborev can silently "fix" behaviors the spec requires (a verbose log line, a non-defensive failure path, an explicit retry policy) and the resulting commit will pass `roborev check` but no longer match the spec.

The exact mechanism for passing context depends on the local roborev installation — common patterns are a `--context-file <path>` flag, an inline `--message` flag, or stdin. Use whichever the project's roborev supports. The content below is what to pass, regardless of mechanism.

### Context template

```txt
This commit implements step(s) <N> from a SpecOps implementation spec. Apply only fixes that are consistent with the spec's behavioral intent. Do not apply any fix that would change observable behavior in a way the spec does not prescribe.

# Spec
Path: <spec-path>
Step(s) implemented in this commit:

<verbatim copy of the relevant step(s) from Section 7 of the spec — same content the implementing subagent received>

# Spec context for fix decisions
- The spec's Acceptance Criteria (Section 5) define correct behavior. Do not apply a fix that would cause any acceptance criterion to fail.
- The spec's Architecture (Section 4) defines the public API shape and contracts. Do not change function signatures, exported types, or module boundaries except as the cited step requires.
- The spec's Notes (Section 6) flag intentional trade-offs. Do not "fix" a behavior the spec explicitly accepts.
- Side effects and error handling described in the spec (logging, retries, atomic writes, ordering guarantees) are required. Do not remove, weaken, or reorder them.
- Defensive code that the spec does not prescribe is also not the goal. Do not add try/catch, fallbacks, default values, or null checks that the spec does not require — fail-fast behavior on invalid inputs is intentional.
- Naming, types, and shapes that come directly from the spec (Section 3 data models, Section 4 architecture) are normative. Do not rename or restructure them to match a stylistic preference.

# If a finding conflicts with the spec
If a finding can only be resolved by violating the spec, do NOT apply the fix. Leave the finding open and report it as deferred so the orchestrator can surface it to the user. A spec conflict is a signal that either the spec or the finding needs human judgment — not an automatic edit.
```

The orchestrator constructs this content fresh for each commit (steps differ; spec sections referenced may differ). Write it to a temp file, pass it via the chosen mechanism, and clean up the temp file after the fix completes.

## Completion

After all steps complete (or the run halted on a blocker):

1. Per-step status: implemented / fix-up applied / blocked.
2. List of commits created (sha + subject).
3. For each commit when `ROBOREV_PRESENT`: roborev outcome — pass / fixed / deferred-due-to-spec-conflict / failed.
4. Any spec adaptations the subagents flagged for review.
5. Any blockers that halted the run, with the failing step and the reason.

## Implementation Principles (Orchestrator)

The orchestrator follows the same principles it passes to subagents. In particular:

- One commit per step or logical group. No squashing across boundaries; granularity makes roborev failures localizable and bisecting cheap.
- No partial commits. If a step fails, halt — do not commit half-finished work to "save progress."
- Do not run the full test suite between steps. Targeted tests only.
- Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution to commit messages.

## Quality Bar

- Each commit is independently maintainable and reviewable.
- Each commit is obvious about what it does and why (commit message + spec reference).
- Each commit is obvious about when it breaks (targeted tests, roborev check).
- Tests verify behavior, not implementation.

---

## Where this fits in the SpecOps pipeline

This skill is the code-generation step. It runs after the implementation spec has been verified:

1. Generate analysis spec from legacy source.
2. `specops-ambiguity-audit` — harden the analysis spec.
3. `specops-spec-coherence` — cross-spec consistency, implementation order.
4. Domain experts verify the analysis spec set.
5. Generate implementation specs in dependency order (`specops-make-spec`, `specops-orchestrate-spec-create`).
6. `specops-spec-conformance` — implementation specs faithful to analysis.
7. **`specops-run-spec`** (this skill) — implement the verified spec, one step per commit.
8. `specops-integration-test` — add integration tests for normative pathways.
9. `specops-implementation-drift` — re-analyze code, diff against analysis, generate corrections, iterate.

Steps 7–9 alternate as the migration evolves: drift surfaces correction specs, this skill runs the corrections one step at a time, integration tests update for newly-completed pathways, drift runs again.
