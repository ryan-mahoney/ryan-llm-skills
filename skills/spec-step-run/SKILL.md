---
name: spec-step-run
description: This skill should be used when the user or an external task-runner asks to implement, run, execute, or complete exactly one step from a reviewed project-local spec, given only a step marker: the spec path plus the target step number/text. Self-sufficient by design — it resolves every related artifact (criteria.md, invariants.md, prior-step learnings, subspec, blockers.md, applicable rules) deterministically from the spec directory and needs no other context from the caller. Performs the same single-step planning, implementation, verification, and commit workflow as spec-run, but never runs every step or the whole acceptance gate. Built for externally-orchestrated, isolated per-step runs: it consumes earlier steps' learning files and always emits its own at learnings/<step>-learning.md that spec-step-judge and later steps consume.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=<path/to/spec.md> step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "7"
---

# Spec Step Run

Implement exactly one step from a reviewed local spec. This is the one-step
variant of `spec-run`: read the spec and its related files, create or update
the step subspec, implement only that step, verify targeted behavior, emit a
per-step learning file, and commit only that step's changes.

Do not run other implementation steps. Do not perform the final all-criteria
acceptance gate. Do not resolve a GitHub mirror or guess the latest spec.

This skill is the implementation half of an externally-orchestrated per-step
pipeline: `spec-write` produces the spec and an external task-runner dispatches
each step to this skill in isolation, with no `spec-run` orchestrator carrying
state between steps. Because nothing else carries that state, this skill is
self-contained: it reconstructs what earlier steps did by reading their learning
files, and the learning file it emits is the durable channel by which
`spec-step-judge` and later steps see what this step discovered.

## Run Directly — No Subagents

Do this skill's work directly in your own context. Do **not** spawn subagents,
fan out parallel agents, or delegate the run to another agent. This is a leaf
skill: the external task-runner already dispatches it in isolation, one step at a
time, so a nested agent adds no isolation — only the failure modes of delegation
(needless fan-out, or a child whose completion goes unnoticed). Read, plan,
implement, verify, and commit the step yourself.

## Required Inputs

This skill takes one thing: a **step marker**. Everything else is derived. Stop
before coding if either part of the marker is missing or unreadable:

1. `spec`: path to the local `spec.md`.
2. `step`: the exact step number, stable step id, or full step text to implement.

Do not expect the caller to pass anything else. A dumb sequential orchestrator
invokes this skill once per step with only the marker, carrying no state between
runs. Resolve every related artifact yourself from the spec directory
(`<spec-dir>` = the folder containing `spec.md`):

- `criteria`:   `<spec-dir>/criteria.md`
- `invariants`: `<spec-dir>/invariants.md`
- `subspec`:    `<spec-dir>/subspecs/<step-number>-spec.md`
- `blockers`:   `<spec-dir>/blockers.md`
- prior learnings: `<spec-dir>/learnings/<k>-learning.md` for every earlier step `k`
- rules: the local paths listed in the spec's Applicable Rules section

Treat a missing sibling artifact as non-blocking absence, not an error: a fresh
spec has no learnings yet, and not every spec has criteria. Never block waiting for
a path the caller did not give you.

## Resolve The Step

Read the full local spec and isolate its Implementation Steps section. Locate the
single requested step by number/id first, then by exact text match.

Before coding, confirm the resolved step:

- exists in the spec,
- has a `Covers: AC-n` tag or traces to a stated architectural need,
- names no file, type, or signature that contradicts the current code unless the
  step itself creates it.

If multiple steps match, stop and ask the caller to provide a unique step
identifier. If no step matches, stop and report the missing step.

## Load Prior Step Context

A dumb orchestrator carries no memory between steps, so this skill must reconstruct
what earlier steps did before touching code. Read, in order:

1. **Adaptations.** Any `## Adaptations` section in `spec.md`. `spec-step-judge`
   edits future step text and logs it here. The step text you implement is the
   *current* text in `spec.md`, already incorporating any adaptation — honor it over
   any earlier version.
2. **Prior learnings.** Every `<spec-dir>/learnings/<k>-learning.md` for each step
   `k` ordered before this one. Distill their *Findings for later steps* and
   *Discrepancies & risks* into a short prior-step context block: renamed or new
   symbols, changed signatures, relocated code, steps rendered unnecessary, and
   newly required prerequisites. These describe the code as it actually is now and
   override the spec's original assumptions where they conflict.
3. **Blockers.** `<spec-dir>/blockers.md`. If an unresolved blocker names this step,
   or names a prerequisite this step needs, stop now: emit a `blocked` step learning
   (see Emit Step Learning) and report. Do not implement on top of a known blocker.

Two early exits before any code:

- **Already done.** If `<spec-dir>/learnings/<step-number>-learning.md` already
  exists with a terminal outcome and the step's targets are already satisfied in the
  working tree, report already-complete and stop. Do not produce a duplicate commit.
- **Rendered unnecessary.** If prior findings say this step is no longer needed,
  confirm against the current code. If it is genuinely satisfied, write an
  `as-specified` learning recording why, and skip implementation rather than forcing
  an empty change.

Carry the distilled prior-step context into the subspec and the implementer prompt.

## Load Guardrails

Read the sibling `criteria.md` and `invariants.md` when they exist. Extract a short
guardrail list for this step:

- From `criteria.md`, use only prose `Source:` lines. Never copy `Check:` commands,
  grep patterns, or expected hit sets into the implementation prompt.
- Include high-risk ownership, placement, layering, data-flow, or cross-phase
  constraints. Skip trivia and criteria already fully pinned by the target step's
  `Covers:` tags.
- From `invariants.md`, include live invariant statements not marked superseded.

If no guardrails apply, omit the guardrail block entirely.

## Load Applicable Rules

Resolve the local rule paths listed in the spec's Applicable Rules section. This is
best-effort: silently skip any listed rule file that is missing.

Pass rule paths through to the implementer to read directly. Do not inline rule
contents into the prompt.

## Subspec

Before coding, produce a minimal, code-grounded subspec for this one step,
following the `spec-subspec-write` contract.

Write it to:

```txt
<spec-dir>/subspecs/<step-number>-spec.md
```

If the step does not have a numeric identifier, write:

```txt
<spec-dir>/subspecs/step-<short-slug>-spec.md
```

The subspec must capture target files/symbols as they exist now — reconciled with
the prior-step context, since earlier steps may have moved or renamed them —
concrete edit sequence, targeted tests, assumptions, and hard stop conditions. A
hard blocker in the subspec stops implementation.

When the step adds new code, search for existing implementations and precedents
first, using the available repository-search tools — grep/ripgrep for symbols or
literals, and any semantic or codebase search the harness offers for behavior and
precedent — so you reuse or extend rather than duplicate.

## Execution

Implement the step directly, under the working contract below. The contract is
self-directed — your own checklist for this run — not a prompt to hand to a
subagent; do not delegate implementation.

```txt
You are implementing exactly one step from a repository-local implementation spec.

Spec file: <absolute spec path>
Step to implement: <exact resolved step text>
Subspec file: <absolute subspec path>

Prior-step context — what earlier steps already changed (omit when empty). Treat
this as the current state of the code; where it conflicts with the spec's original
wording for this step, follow the prior finding and note the conflict:
<one fact per line>

Conformance guardrails (omit when empty):
<one guardrail per line>

Applicable rules (read each file before coding; omit when empty):
<one path per line>

Before coding, read:
1. The full local spec file.
2. The subspec file.
3. Any rule files listed above.
4. The source and test files needed for this step.

Rules:
- Implement ONLY this step. Do not do previous or future steps.
- Verify the prior-step context against the actual files before relying on it; it
  reflects what earlier steps reported, not necessarily the final tree.
- Verify any external API behavior you depend on against its source or type
  definitions before relying on it — confirm what the call actually does at runtime
  (callback payloads, iteration/streaming order, delta vs cumulative, mutation,
  error modes), not merely that it typechecks. Never assume library behavior from
  memory.
- If the step cannot be implemented as written because a referenced file, type,
  signature, or project convention does not exist or conflicts with the code,
  STOP and report the discrepancy.
- Keep changes minimal, explicit, and fail-fast.
- Follow existing project patterns.
- Add or adjust tests only when needed for this step.
- Run only targeted verification for changed behavior.
- Never run the full test suite here; it is reserved for the branch-level stage.
- Do not add AI attribution, generated-by footers, or co-author trailers.

Output:
1. Subspec path used.
2. Summary of changes and why.
3. Exact files modified.
4. Commands run and outcomes.
5. Assumptions, risks, or spec discrepancies.
6. Learnings for later steps: concrete facts discovered while implementing that
   could change a not-yet-run step — a renamed or new symbol, a changed
   signature, relocated code, a step rendered unnecessary, a newly required
   prerequisite — or "none".
```

## Verify And Commit

After implementation, verify mechanically:

1. Inspect `git diff --name-only` and ensure changes are scoped to the target step.
   The subspec and step learning files are allowed.
2. Run the tests named by the step or subspec — scoped to those specific files or
   filters, nothing broader. If none are named, use judgment to run the narrowest
   meaningful check for the changed files (typically a typecheck or compile), not the
   test runner. **Never run the entire test suite** here (no unfiltered test-runner
   invocation) — it is the branch-level stage's job, and running it per step
   multiplies memory across concurrent runs.
3. If verification fails, make at most two fix-up attempts scoped to this same
   step. Do not broaden into neighboring steps.
4. If the issue is a spec/code discrepancy, record it in `<spec-dir>/blockers.md`,
   write a `blocked` step learning file (see Emit Step Learning), and stop.
5. Otherwise write the step learning file (see Emit Step Learning), even when
   nothing was learned.
6. Stage only this step's files — including the subspec and learning file — and
   commit with a conventional commit message.

Do not start another implementation step after the commit.

## Emit Step Learning

Always write a step learning file after verification — even when nothing was
learned. The external task-runner runs each step in isolation, so this file is the
only durable channel by which `spec-step-judge` and later steps see what this step
discovered. Write it in every terminal case, including a `blocked` stop.

Write it to:

```txt
<spec-dir>/learnings/<step-number>-learning.md
```

When the step has no numeric identifier, use
`<spec-dir>/learnings/step-<short-slug>-learning.md`. Create the `learnings/`
folder if it does not exist.

The orchestrator writes this file, distilled from the implementer's reported
learnings and the verification outcome — not the implementer. Keep it minimal; use
`None` for an empty list rather than dropping the section. Required fields:

1. **Step reference** — number/id, a one-line objective, and the `Covers:` tags.
2. **Outcome** — one of `as-specified`, `adapted`, or `blocked`, plus one line.
3. **Findings for later steps** — concrete discoveries that could change a
   not-yet-run step: a renamed or new symbol, a changed signature, relocated code,
   a step rendered unnecessary, a newly required prerequisite. State the fact and
   the future assumption it touches. `None` when the step landed as the spec
   assumed.
4. **Discrepancies & risks** — spec/code mismatches, assumptions made under
   ambiguity, conflicts between the spec and prior-step context and how you resolved
   them, and any weak or skipped verification. `None` when empty.
5. **Verification** — the targeted commands run, their outcomes, and the number of
   fix-up attempts, so the judge can weigh confidence.

End the file with a single locator line:

```txt
Learning: <spec-dir>/learnings/<step-number>-learning.md (step <step-number>)
```

A purely `as-specified` step with no findings is the common case and stays terse:
`Outcome: as-specified`, both lists `None`, and the verification line.

## Be Terse

Spend words on the durable artifacts — the subspec and the step learning file —
and on the verification record; those are load-bearing for later steps and the
judge. Everywhere else omit needless words: skip preamble, do not restate these
instructions or narrate what you are about to do, and keep the completion report a
terse list, not an essay. Terseness must never drop a required field or a
cross-step finding.

## Completion Report

Report:

1. Spec path and resolved step.
2. Subspec path.
3. Learning file path and its outcome (`as-specified`, `adapted`, or `blocked`).
4. Commit hash, if committed.
5. Files changed.
6. Verification commands and outcomes.
7. Any assumptions, blockers, or follow-up risks.
