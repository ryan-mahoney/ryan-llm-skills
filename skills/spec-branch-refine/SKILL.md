---
name: spec-branch-refine
description: "Run the final independent branch evidence loop: audit the integrated implementation and claim/gate evidence, fix defects, and repeat within a bounded number of review/fix rounds. Use after implementation and before the ready work tour and final PR readiness."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [max-iterations=<n>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "15"
---

# Spec Branch Refine

Apply [Verification and Review](../../rules/verification-and-review.md) for CI/operator ownership
and batched Jev verification/review-triage checkpoints.

> **`.specs/` is standalone working state and is often gitignored.** Read and write it directly; do not depend on git history to recover it. Diffing implementation code is unaffected.

Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Drive the final branch evidence loop to convergence. Alternate the independent `spec-branch-review` audit and `spec-branch-fix`, re-auditing while rounds remain. Each iteration includes its fix pass; stop after the final
fix and verification without requiring an extra review.

The leaf skills stay single-pass and stateless; this driver owns everything that
spans iterations: counting, convergence, and the anti-thrash dedup memory (which
lives in the `branch-<k>-fix.md` dismissal signatures that `spec-branch-review`
reads on the next pass).

## Operating Context

```txt
spec-branch-refine
  └─ iter i: spec-branch-review (iter i) → [if needs-fix] spec-branch-fix (iter i) → i+1
     stop when: verdict pass · no progress · final fix completed
```

Run this skill once after the last implemented step. The
review's bounded guardrail lens consumes only spec acceptance/step obligations,
criteria `Statement:` values, and live invariants; those findings use the same loop
and verdict as correctness findings. It is also the right standalone entry point for "clean up this
branch before I mark the PR ready."

## Routed Overseer Messages

When the end-to-end coordinator forwards archived message paths, follow the
[routing contract](../spec-end-to-end/references/overseer-inbox.md#checkpoints-and-routing).
Pass `review` messages unchanged to the active or next reviewer and `fix` messages
to the active or next fixer. Retain pending routes and include recipient outcomes
in the normal handoff. If that recipient will not run, return the unresolved route
to the parent; do not invent another round or reset the budget. Reviewers interpret
messages independently and cannot be instructed to return a particular verdict.
Continue iterations without parent acknowledgment unless a relevant hold or
consequential decision blocks dependent work. A delegated stage does not consume
inbox files or write the top-level ledger; a top-level coordinator executing this
stage locally retains its existing intake ownership.

## Autonomous Convergence

Drive the loop within sourced project context and operational authority. Resolve ordinary repair
decisions autonomously. Route a consequential `decision-required` result to the top-level
coordinator, or handle the check-in directly when standalone. Continue independent work without
repeating unresolved reviews. Pending later-phase authorization is not a merge blocker. Stop dependent work for a consequential decision, a required missing input, a necessary
spec correction, or a convergence stop condition below.

## Resolve Inputs

- **Spec.** Resolve explicit `spec=<path>` or `.specs/<feature>/` first, then the
  folder named in the conversation or `Spec folder:` footer. If exactly one
  `.specs/*/spec.md` exists, use it. Stop on ambiguity. `<spec-dir>` is the resolved
  `.specs/<feature>/` folder.
- **Max iterations.** `max-iterations=<n>`, a positive integer, default **10** for
  direct invocation. Each iteration is one review followed by its fix pass when needed:
  at most `n` reviews and `n` fixes. `max-iterations=2` means review → fix → review → fix.
  A clean review stops early without an unnecessary fix. `spec-end-to-end` supplies **1**
  when step reviews cover every step's commits and **2** otherwise, unless the user
  explicitly chooses another limit.

## The Loop

Before assigning the review stage, apply the
[agent capability check](../spec-end-to-end/SKILL.md#delegate-with-compact-handoffs).
Its owner needs command execution and write access to canonical review/evidence
artifacts, even though it must not edit implementation code. Do not assign the whole
stage to an analysis-only reviewer and then inherit its missing execution or writing
work. Choose a capable stage owner before dispatch; scoped analysis helpers may
remain read-only.

Start at `i = 1`. On resume, reconcile the latest review/fix artifacts and HEAD:
finish an interrupted iteration's pending fix before advancing; never skip its fix or
repeat a completed review. The cap applies to the whole run, not each resumption. If
completed iterations already meet or exceed the cap, assemble the completion record
without launching another review. A stale review after unrelated code changes is a
handoff gap, not permission to silently reset the budget. Then:

1. **Review.** Run `spec-branch-review` for iteration `i` per its contract. The first
   review consolidates valid focused and final-commit CI results and owns outstanding
   focused gates; pending gates and `readyForAudit: false` are expected on entry. Push
   coherent revisions within authorized publication scope to start CI. Collect the relevant
   existing configured required CI results before final readiness; avoid consuming another
   review round merely to await them. Without CI, broad testing is operator-managed outside
   agent evidence and creates no local-suite or completion prerequisite. Let review close actual evidence gaps without a duplicate broad pass. It
   writes `<spec-dir>/reviews/branch-<i>-review.md` and dedupes against prior
   dismissals itself.
2. **Read the verdict.** Parse the review file's leading `review:` YAML block — the
   `verdict` and the set of actionable finding `signature`s. The prose is never
   parsed for control flow.
   If the review or preceding fix reports an unresolved consequential decision or required spec
   correction, preserve its findings and return `decision-required` or `needs-spec-correction` to
   the coordinator. Do not burn review iterations waiting for the same missing decision.
3. **Stop on clean** — when `verdict: pass` and `evidence_verdict: proven` cover
   applicable merge claims at current HEAD, write the completion record with
   `outcome: proven` and hand off to `spec-work-tour`.
4. **Compute recurrence, then check stalled** — this order is what prevents both the
   premature stop and the oscillation:
   - **Recurrence set** = actionable signatures in `branch-<i>` that `branch-<i-1>-fix.md`
     marked `fixed` (not dismissed). These are findings a fix *claimed* to resolve but
     that came back.
   - **Stalled** — stop *only* when the previous iteration made **no material change**
     (`branch-<i-1>-fix.md` has `material_change: false`) **and** the actionable set is
     unchanged from `branch-<i-1>`. That is a genuine dead end: fixing produced nothing
     and the same bugs remain. An identical actionable set after a fix that *did* change
     code is **not** stalled — it gets another iteration, with the recurrence set
     terminalized (next bullet).
5. **Fix.** Run `spec-branch-fix` for iteration `i`; its owner performs Jev review-triage
   once for this actionable findings set before choosing repairs or dispositions. Pass the **recurrence set** as a
   *terminalize* instruction: each of those signatures must reach a terminal state
   this iteration — resolved by a genuinely *different* change, or **dismissed** with a
   class — and may not be marked `fixed` again with the same approach. `spec-branch-fix`
   writes `branch-<i>-fix.md` (with `material_change`), applies fixes, runs tests, and
   commits the code changes. Push coherent fixes within authorized publication scope so
   CI runs on the new SHA; final readiness waits for its relevant required results.
   If correction changes a sourced obligation or evidence plan, return to its owning planner,
   re-prepare, and rerun only affected proof before the next audit. Do not escalate verification
   without a named remaining failure or use the loop to authorize live operations.
6. **Check the cap after fixing.** If `i >= max-iterations`, inspect the fix decisions
   and existing verification evidence. Every actionable finding must be fixed or have
   a supported terminal dismissal; `unfixable`, missing decisions, unauthorized risk
   acceptance, failed/pending required merge gates, and stale evidence remain blockers.
   If those checks pass, return `outcome: verified-at-cap`; otherwise return
   `outcome: cap` with the remaining gaps. Do not run a final review, restart refinement, or rerun
   passing tests just to assemble the handoff.
7. **Advance.** Otherwise, `i = i + 1`; go to step 1.

Computing recurrence *before* the stalled stop is the fix for the ordering bug: a
recurring finding always reaches the fixer with its terminalize instruction, and the
loop only declares "stalled" when a fix truly changed nothing — never while a
different fix or an explicit dismissal is still available.

## Completion Handoff

Always write canonical `reviews/refinement-completion.md` atomically, with a heading,
a fenced YAML record, and concise per-round findings/decisions/evidence references:

```yaml
refinement:
  outcome: verified-at-cap # proven | verified-at-cap | cap | stalled | decision-required | needs-spec-correction
  max_iterations: 2
  iterations_completed: 2
  commit: <full final HEAD>
  review: <latest review artifact path>
  fix: <latest fix artifact path or none>
  independent_post_fix_review: false
  evidence_verdict: proven # proven | incomplete
  unresolved: []
```

Use `proven` and `independent_post_fix_review: true` only for a passing independent
review bound to final HEAD. `verified-at-cap` means findings were resolved and required
executable gates pass at final HEAD, but the final fixes were not independently
re-reviewed. Preserve the original review's SHA and verdict; never rewrite it into a
post-fix pass. Any unresolved current or earlier actionable finding blocks completion.
A `commit: none` in a no-code fix record does not remove the requirement to bind this
completion record and valid evidence to actual HEAD.

Both successful outcomes hand off to `spec-work-tour` under the shared contract's
Bounded Refinement Completion policy. Other outcomes preserve useful work and report
the blocker. Finishing the iteration budget does not make an unresolved defect pass.

## Artifact Policy

Review and fix artifacts are durable iteration memory and are always written to
`<spec-dir>/reviews/`. Do not stage or commit `.specs` unless the repository
explicitly tracks it. A review pass whose only output is these artifacts produces
no commit; only code changes made by `spec-branch-fix` are committed.

## Reporting

Report:

1. Spec path and `max-iterations`.
2. How many iterations ran, and why the loop stopped: **proven** / **verified-at-cap** / **cap** /
   **stalled** / **decision-required** / **needs-spec-correction**.
3. Per-iteration one-liners: actionable count in, fixes applied, dismissals.
4. Latest audit verdict and its SHA, whether final fixes were independently re-reviewed, and any residual findings (actionable left at cap/stalled, plus advisory
   findings never required to fix), with their `file:symbol` and signature.
5. The review/fix artifact paths written under `<spec-dir>/reviews/`.
6. The commit hashes produced (fix commits), or note `none` when review/fix
   artifacts were the only changes.
7. On `proven` or `verified-at-cap`, the completion record, exact bound commit, and
   `next: spec-work-tour`.

A first-iteration proven pass is the common outcome on a well-built branch. Do not invoke
`spec-work-tour`; it is the next explicit top-level stage.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
