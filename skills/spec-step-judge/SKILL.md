---
name: spec-step-judge
description: This skill should be used when the user or an external task-runner asks to judge, evaluate, review, or "close out" a single already-implemented spec step — applying scoped corrections only if the step fell short, then adapting not-yet-run steps to what that step learned. It is the judging half of an externally-orchestrated, isolated per-step pipeline that pairs with spec-step-run (no spec-run orchestrator). Given only a step marker (spec path plus step), it is self-sufficient: it resolves the step's learning file, subspec, criteria.md, invariants.md, blockers.md, and applicable rules deterministically from the spec directory and needs no other context from the caller. Reads the step's learning file, evaluates the committed change against its Covers criteria and guardrails, fixes only that step when it failed, and rewrites the content of not-yet-run steps in spec.md — adding to, reducing, or replacing a future step's content, but never changing how many steps remain — with an Adaptations log, when learnings warrant. Trigger on "judge this step", "evaluate the step implementation", "review the implemented step", "apply step learnings", "adapt future steps", or "spec step judge".
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=<path/to/spec.md> step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "8"
---

# Spec Step Judge

Judge exactly one already-implemented step, then close the cross-step feedback
loop. `spec-step-run` implements a single step in isolation and emits a learning
file; this skill is its partner: evaluate that step, correct it only if it fell
short, and make the not-yet-run steps adaptive to what was learned.

## Operating Context

This is the judging half of an externally-orchestrated per-step pipeline.
`spec-write` produces `spec.md`; an external task-runner dispatches each step to
`spec-step-run`, then to this skill, in full contextual isolation. `spec-run` is
not in the loop, so no in-context orchestrator carries state between steps — the
per-step learning files and `spec.md` are the only shared state.

Three jobs, in order:

1. **Evaluate** the implemented step (judge).
2. **Correct** — only if the step fell short, and only that step.
3. **Adapt** the not-yet-run steps from this step's learnings — only when a
   learning materially changes a future step.

A clean step that taught nothing is a no-op success: no correction, no adaptation.

This skill never runs, dequeues, or schedules the next step. The external
task-runner owns ordering and dispatch.

## Run Directly — No Subagents

Do this skill's work directly in your own context. Do **not** spawn subagents,
fan out parallel agents, or delegate the run to another agent. This is a leaf
skill: the external task-runner already dispatches it in isolation, one step at a
time, so a nested agent adds no isolation — only the failure modes of delegation
(needless fan-out, or a child whose completion goes unnoticed). Evaluate,
correct, and adapt yourself.

The judge-versus-patcher independence the prior version got from separate
subagents is preserved by **sequence** instead: complete and record the verdict
before you touch any code, and never revise the verdict to justify a correction.
A frozen verdict keeps both honest without a nested agent.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask
clarifying questions, request confirmation, or wait for input mid-run. When
something is unclear, make a reasonable, well-grounded decision from the available
context — the step text, the learning file, the committed diff, the guardrails,
and the repository — then proceed, and summarize every such judgement call in the
final report. Stop only when a required input is genuinely missing and cannot be
inferred; report what is missing and halt.

## Required Inputs

This skill takes one thing: a **step marker**. Everything else is derived. Stop
before judging if either part of the marker is missing or unreadable:

1. `spec`: path to the local `spec.md`.
2. `step`: the exact step number, stable step id, or full step text that was just
   implemented.

Do not expect the caller to pass anything else. A dumb sequential orchestrator
invokes this skill once per step with only the marker, carrying no state between
runs. Resolve every related artifact yourself from the spec directory
(`<spec-dir>` = the folder containing `spec.md`):

- `learning`:   `<spec-dir>/learnings/<step-number>-learning.md` — the file
  `spec-step-run` emitted for this step. If it is absent, evaluate from the
  committed diff alone and flag the missing learning in the report — do not block.
- `subspec`:    `<spec-dir>/subspecs/<step-number>-spec.md`
- `criteria`:   `<spec-dir>/criteria.md`
- `invariants`: `<spec-dir>/invariants.md`
- `blockers`:   `<spec-dir>/blockers.md`
- rules: the local paths listed in the spec's Applicable Rules section

Treat a missing sibling artifact as non-blocking absence, not an error. Never block
waiting for a path the caller did not give you. The learning file is the one input
worth reading whenever it exists, because it drives adaptation.

## Resolve The Step And Its Change

Read the full local spec and isolate its Implementation Steps section. Locate the
single requested step by number/id first, then by exact text match. If multiple
steps match, stop and ask for a unique identifier. If none match, stop and report
the missing step.

Then find the commit that implemented it. `spec-step-run` commits each step
separately and stages the step's `subspecs/<n>-spec.md` and
`learnings/<n>-learning.md` alongside the code. Identify the step's commit as the
one that adds its learning file (`git log --oneline -- <learning-path>`); fall back
to the most recent commit touching the step's named files. Read the diff with
`git show <commit>`.

Before judging, read: the resolved step text and its `Covers:` tags, the subspec,
the learning file, and the guardrails. Extract guardrails with the same limits
`spec-step-run` uses — only prose `Source:` lines from `criteria.md` (never
`Check:` commands, grep patterns, or expected hit sets) and live `invariants.md`
entries not marked superseded.

## Evaluate The Step

Evaluate first, directly, and finish it before any correction: complete the
evaluation, settle on a verdict, and record it — only then may you touch code.
This time-ordering, not a separate agent, is what keeps the judge independent of
the patcher; do not revise the verdict afterward to justify a fix.

The evaluation is verification, not redesign — the spec already passed review.
Judge on three axes:

1. **Scope** — the committed change stays within the step's intent; no
   out-of-scope edits. The step's subspec and learning files do not count as
   out-of-scope.
2. **Conformance** — the change satisfies the step's `Covers:` criteria and the
   high-risk guardrails (ownership, placement, layering), and the learning's
   discrepancies do not reveal a behaviorally-silent spec violation.
3. **Verification** — re-run the targeted tests named by the step or subspec and
   confirm green. If the step names none, run the narrowest typecheck, compile, or
   test command for the changed files.

Verdict, one of:

- `pass` — scope clean, conforms, targeted verification green.
- `needs-correction` — what is wrong, plus the targeted fix, scoped to this step.
- `blocked` — a spec defect: honoring the step is wrong or contradicts the code.

### Judge Contract

Follow this as your own evaluation checklist — it is self-directed, not a prompt
to hand to a subagent.

```txt
You are judging a single, already-committed implementation step. You evaluate;
you do not edit anything.

Spec file: <absolute spec path>
Step judged: <exact resolved step text>
Step commit: <commit hash> (inspect with `git show <hash>`)
Subspec file: <absolute subspec path, or "none">
Learning file: <absolute learning path, or "missing">

Conformance guardrails (omit when empty):
<one prose Source quote or live invariant per line>

Read before judging:
1. The resolved step text and its Covers: tags in the spec.
2. The step's committed diff.
3. The subspec and learning file, when present.

Evaluate on three axes — do NOT re-open the design:
- Scope: changes confined to this step's intent (subspec/learning files excepted).
- Conformance: satisfies the Covers criteria and the guardrails above; the
  learning reveals no silent spec violation.
- Verification: re-run the step's targeted tests (or the narrowest check for the
  changed files) and confirm they pass.

Output:
1. Verdict: pass | needs-correction | blocked.
2. For needs-correction: precisely what is wrong and the smallest fix, scoped to
   this step only.
3. For blocked: why honoring the step is a spec defect.
4. Verification commands run and their outcomes.
```

## Apply Corrections — Only If Needed

- `pass` → skip this section entirely. A no-op is a success state.
- `needs-correction` → make one correction pass scoped to **this step only** — a
  fix-up, not a redesign. Up to two attempts. Never broaden into neighboring or
  future steps. Keep changes minimal, explicit, and fail-fast. Re-run the targeted
  verification as the oracle, then commit on its own:
  `fix(<scope>): <step-id> <short description>`.
- `blocked` (spec defect) → do not bend the code to a wrong step. Record it in
  `<spec-dir>/blockers.md` and stop both the correction and the adaptation tracks: a step the
  judge could not validate is not a safe basis for adapting later steps. Report and
  halt.

Keep judgement and correction separate in time, not in agents: the verdict is
fixed before any edit, and once correcting you do not re-judge to bless your own
work — the targeted test re-run is the independent oracle.

### Correction Contract

Follow this as your own correction checklist — self-directed, not a prompt to hand
to a subagent.

```txt
The judge found this step's implementation incomplete or non-conforming.

Spec file: <absolute spec path>
Step: <exact resolved step text>
Findings to fix: <the judge's needs-correction findings>

Fix ONLY what these findings require, scoped to this step. Do not touch other
steps. Keep changes minimal and fail-fast. Follow existing project patterns.
Adjust tests only where this fix changes behavior. Run only targeted verification
for the changed code and report the commands and outcomes.
```

## Adapt Not-Yet-Run Steps — Only When Learnings Warrant

This is the deliberate, bounded exception to the ecosystem's frozen-spec rule.
Everywhere else `spec.md` is frozen after review; here the judge edits it so the
isolated future steps inherit what an earlier step learned. Bound it tightly.

Read the learning file's **Findings for later steps**. If it is `None`, skip this
section — there is nothing to adapt.

"Not-yet-run" means steps after the current one that have no emitted
`learnings/<n>-learning.md` yet. Never touch an already-run step, its code, or its
committed history.

You may rewrite the *content* of a not-yet-run step — adding to it, trimming it, or
replacing it outright — so it stays implementable as written against the discovered
reality. The one hard invariant: **the number of remaining steps does not change.**
The external orchestrator owns the step count and addresses steps by number, so you
adapt within the existing slots and never add, remove, insert, or renumber a step.

For each finding that materially changes a future step — a renamed or new symbol
the step references, a changed signature, relocated code, a step rendered
unnecessary, a newly required prerequisite — make the minimal edit to that future
step's content in `spec.md`. Three shapes of edit, all count-preserving:

- **Add / replace** — expand or rewrite a future step's content to match reality:
  new symbol names, a changed signature, relocated code, or a different
  implementation path that still satisfies the same criteria.
- **Reduce to obsolete** — a step the learning makes unnecessary keeps its number
  and is marked obsolete in place, with the reason. Its slot stays; its work
  empties. Never delete the step.
- **Absorb a prerequisite** — fold newly required prerequisite work into the
  content of the not-yet-run step that needs it (or the earliest not-yet-run step
  that can carry it). If no existing future step can absorb it, do NOT add a step:
  record it as an escalation in the report (and in `<spec-dir>/blockers.md` when it
  blocks a later step) and leave the count unchanged.

Constraints:

- **Preserve traceability.** Never change a step's `Covers:` tags or the
  Acceptance Criteria intent. You may refine *how* a step is done, not *what* it
  must satisfy.
- **Re-score complexity and re-flag visual when they shift.** When an adaptation
  materially changes a future step's difficulty — adds or removes scope, new
  abstractions, integration risk — update that step's `Complexity:` tag
  (`easy`/`medium`/`hard`) to match the adapted work, so per-step model routing stays
  accurate. Likewise, when an adaptation changes whether the step does user-facing
  visual-design work, update its `Visual:` tag (`yes`/`no`). Leave a tag untouched
  when the adaptation does not change that axis. Note any tag change in the
  `## Adaptations` entry.
- **Keep `spec-steps.json` in sync.** `spec-write` emits a derived step index at
  `<spec-dir>/spec-steps.json` (`steps[]` of
  `{step, name, description, difficulty, visualDesign}`) that the external
  task-runner routes on. Whenever you edit a not-yet-run step in `spec.md` — rewrite
  its content, reduce it to obsolete, re-score its `Complexity:`, or re-flag its
  `Visual:` — update that step's matching entry (by `step` number) in
  `spec-steps.json` so its `name`, `description`, `difficulty`, and `visualDesign`
  reflect the adapted step. `difficulty` must equal the new `Complexity:` tag and
  `visualDesign` must equal the new `Visual:` flag (`yes` → `true`). If a flip
  changes the spec-wide roll-up — no step is `Visual: yes` anymore, or one is for the
  first time — also update the footer's `Visual design:` line. Never change the entry
  count or step numbers — the same fixed-step-count invariant applies to the index.
  This is best-effort: if `spec-steps.json` does not exist, skip silently and do not
  create one; `spec.md` stays canonical.
- **Keep the step set fixed.** Never add, delete, insert, or renumber a step; the
  remaining step count must stay constant. Every edit lands inside an existing
  not-yet-run step.
- **Log every edit.** Append (create if absent) an `## Adaptations` section at the
  end of `spec.md`. One entry per edit: the source step and its learning path, the
  future step(s) changed, what changed, and why. This restores the provenance the
  frozen-spec discipline otherwise guarantees.

Commit the spec edits separately from any code correction:
`chore(spec): adapt step(s) <n>[,m] from step <k> learnings`.

Perform these edits directly — you already hold the learning and the future step
text. Do not delegate spec rewriting.

## Verify And Commit

- Code corrections and spec adaptations are **separate** commits, each conventional
  and scoped.
- Confirm `git diff --name-only` for each commit is confined to its track: a
  correction touches only the step's code and tests; an adaptation touches only
  `spec.md` and, when it exists, the sibling `spec-steps.json`.
- The judge writes no learning file of its own. The step's learning file stays as
  `spec-step-run`'s record; the judge's actions are captured by the correction
  commit, the `## Adaptations` log, and the completion report.

## Boundaries

- Edits only the just-run step's code (a scoped fix-up), not-yet-run step *content*
  in `spec.md`, and the matching entries in the sibling `spec-steps.json` when it
  exists. Never edits completed steps' code, the Acceptance Criteria intent, or any
  `Covers:` tag, and never adds, removes, inserts, renumbers, or otherwise changes
  the number of steps (in `spec.md` or the index).
- Judging and patching are separated in sequence — the verdict is recorded before
  any edit; the targeted test re-run is the oracle, never self-assessment.
- Does not run, dequeue, or schedule the next step — the external task-runner owns
  ordering.
- No new scope. Does not fix correctness, style, or performance issues unrelated to
  this step or unsupported by its learnings; confine any incidental concern to a
  single note in the report.

## Completion Report

Report:

1. Spec path and resolved step.
2. Learning file consumed and its outcome, or "missing — judged from the diff".
3. Verdict: `pass`, `corrected`, or `blocked`.
4. Correction commit hash and files, or "none needed".
5. Adaptations: each future step edited with its reason, plus the adaptation commit
   hash — or "none".
6. Verification commands and outcomes.
7. Blockers, escalations, and any follow-up risks.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
