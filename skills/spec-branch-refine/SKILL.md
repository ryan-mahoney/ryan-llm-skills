---
name: spec-branch-refine
description: This skill should be used when the user asks to run the end-of-process branch correctness loop — review the whole branch, fix the findings, re-review, and repeat until clean or an iteration cap is reached. The in-process, file-backed replacement for an external review daemon's refine loop. It drives spec-branch-review and spec-branch-fix in alternation, holds the cross-iteration convergence and dedup state, and stops on a clean verdict, on no progress, or at the cap. Run it once after the last implemented step, or standalone at any time. Trigger on "refine the branch", "review-fix loop the branch", "run the branch correctness loop", "iterate review and fix until clean", or "spec branch refine".
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [max-iterations=<n>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "7"
---

# Spec Branch Refine

> **`.specs/` is standalone working state and is often gitignored.** Read and write it directly; do not depend on git history to recover it. Diffing implementation code is unaffected.

Drive the final branch review loop to convergence. Alternate `spec-branch-review`
(find correctness, integration, and bounded guardrail defects) and `spec-branch-fix` (apply fixes), re-reviewing after each fix, until
the branch is clean or a cap is reached. This is the in-process, file-backed
equivalent of an external review daemon's refine — no daemon, just the two leaf
skills and their file contract.

The leaf skills stay single-pass and stateless; this driver owns everything that
spans iterations: counting, convergence, and the anti-thrash dedup memory (which
lives in the `branch-<k>-fix.md` dismissal signatures that `spec-branch-review`
reads on the next pass).

## Operating Context

```txt
spec-branch-refine
  └─ iter i: spec-branch-review (iter i) → [if needs-fix] spec-branch-fix (iter i) → i+1
     stop when: verdict pass · no progress · i == max
```

Run this skill once after the last implemented step. The
review's bounded guardrail lens consumes only spec acceptance/step obligations,
criteria `Statement:` values, and live invariants; those findings use the same loop
and verdict as correctness findings. It is also the right standalone entry point for "clean up this
branch before I open a PR."

## Non-Interactive Operation

This skill runs to completion without user interaction. Drive the loop, make
well-grounded decisions, and report at the end. Stop only when a required input is
genuinely missing and cannot be inferred (no resolvable spec), or when a stop
condition below is met.

## Resolve Inputs

- **Spec.** Resolve explicit `spec=<path>` or `.specs/<feature>/` first, then the
  folder named in the conversation or `Spec folder:` footer. If exactly one
  `.specs/*/spec.md` exists, use it. Stop on ambiguity. `<spec-dir>` is the resolved
  `.specs/<feature>/` folder.
- **Max iterations.** `max-iterations=<n>`, default **10**. This caps **total review
  iterations**: the loop runs at most `n` reviews (and therefore at most `n-1` fixes,
  since the final review is what detects the cap). Defining the cap on reviews makes
  the `i == max-iterations` check below exact.

## The Loop

Start at `i = 1` (or one past the highest existing `branch-<k>` artifacts if a prior
refine was interrupted — resume rather than overwrite). Then:

1. **Review.** Run `spec-branch-review` for iteration `i` per its contract. It
   writes `<spec-dir>/reviews/branch-<i>-review.md` and dedupes against prior
   dismissals itself.
2. **Read the verdict.** Parse the review file's leading `review:` YAML block — the
   `verdict` and the set of actionable finding `signature`s. The prose is never
   parsed for control flow.
3. **Stop on clean or cap** — these two stops apply before any fix:
   - **Clean** — `verdict: pass` (no actionable findings). Stop; the branch is clean.
   - **Cap** — `i == max-iterations`. Stop; report the residual actionable findings.
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
5. **Fix.** Run `spec-branch-fix` for iteration `i`. Pass the **recurrence set** as a
   *terminalize* instruction: each of those signatures must reach a terminal state
   this iteration — resolved by a genuinely *different* change, or **dismissed** with a
   class — and may not be marked `fixed` again with the same approach. `spec-branch-fix`
   writes `branch-<i>-fix.md` (with `material_change`), applies fixes, runs tests, and
   commits the code changes.
6. **Advance.** `i = i + 1`; go to step 1.

Computing recurrence *before* the stalled stop is the fix for the ordering bug: a
recurring finding always reaches the fixer with its terminalize instruction, and the
loop only declares "stalled" when a fix truly changed nothing — never while a
different fix or an explicit dismissal is still available.

## Artifact Policy

Review and fix artifacts are durable iteration memory and are always written to
`<spec-dir>/reviews/`. Do not stage or commit `.specs` unless the repository
explicitly tracks it. A review pass whose only output is these artifacts produces
no commit; only code changes made by `spec-branch-fix` are committed.

## Reporting

Report:

1. Spec path and `max-iterations`.
2. How many iterations ran, and why the loop stopped: **clean** / **cap** /
   **stalled**.
3. Per-iteration one-liners: actionable count in, fixes applied, dismissals.
4. Final verdict and any residual findings (actionable left at cap/stalled, plus
   advisory findings never required to fix), with their `file:symbol` and signature.
5. The review/fix artifact paths written under `<spec-dir>/reviews/`.
6. The commit hashes produced (fix commits), or note `none` when review/fix
   artifacts were the only changes.

A first-iteration `pass` is the common, good outcome on a well-built branch: report
"clean after 1 review, no fixes needed."

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
