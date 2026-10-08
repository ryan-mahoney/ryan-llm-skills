---
name: spec-branch-fix
description: "Fix one iteration of branch code or executable-evidence findings, reproduce affected gates, record every decision, and commit coherent corrections for independent re-audit."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [iter=<n>] [review=<reviews/step-NNN-review.md>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "19"
---

# Spec Branch Fix

Apply [Verification and Review](../../rules/verification-and-review.md) for focused-check scheduling
and batched Jev verification/review-triage checkpoints.

> **`.specs/` is standalone working state and is often gitignored.** Read and write it directly; do not depend on git history to recover it. Diffing implementation code is unaffected.

Apply one iteration of the final branch review. `spec-branch-review` wrote
`reviews/branch-<iteration>-review.md`; this skill reads it, decides what to act on,
fixes the actionable findings across the branch, and records its decisions in
`reviews/branch-<iteration>-fix.md`.

The two skills are coupled **only** through the review file, and this skill never
re-reviews. Step fixes enter the next step review range when one remains; no extra
review of final step fixes is automatic. Explicit branch refinement runs another review
only while its selected round budget remains.

Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Evidence findings are first-class: correct the implementation, test/gate, artifact, claim mapping, or proof boundary that made the evidence invalid, then reproduce the affected gate.

## Routed Overseer Messages

When assigned message paths, follow the shared
[recipient contract](../spec-end-to-end/references/overseer-inbox.md#recipient-contract).
Read the originals yourself, act within this skill's role and sourced authority,
and record message outcomes in your existing report. Do not consume the inbox or
write the coordinator's ledger. Continue without parent approval unless a relevant
hold or consequential unresolved decision prevents dependent work.

## Operating Context

The fix stage of one branch-loop iteration:

```txt
spec-branch-refine (loop) → spec-branch-review → spec-branch-fix → re-review …
                            (find bugs)           (this skill)
```

Single pass per call: decide, fix the actionable findings, verify, commit, stop.
The loop driver decides whether another iteration runs.

## Autonomous Repair

Read the sourced `context.md` and current project policy. Run Jev review-triage once for
the actionable findings set before deciding fixes, dismissals, or deferrals. Decide ordinary
repairs from the review, diff and evidence. Route unresolved consequential choices as `decision-required` to the
coordinator (or handle the check-in when standalone); continue safe independent repairs. Do not
change project constraints or perform external operations merely to close a finding. Stop dependent work for a consequential decision or required input that cannot be resolved;
report the exact gap without discarding independent repairs.

## Resolve Inputs

- **Spec.** Resolve exactly as `spec-branch-review`: explicit `spec=<path>` or
  `.specs/<feature>/` first, then conversation/footer context, then the sole
  `.specs/*/spec.md` candidate. Stop on ambiguity. `<spec-dir>` is the resolved
  `.specs/<feature>/` folder.
- **Iteration.** Use `iter=<n>` when given. Standalone default: the highest existing
  `<spec-dir>/reviews/branch-<k>-review.md` that has **no** matching
  `branch-<k>-fix.md` yet.
- **Review.** `<spec-dir>/reviews/branch-<iteration>-review.md`. If it is missing,
  there is nothing to do: report and stop. Do not invent findings.

### Step Mode

`review=<spec-dir>/reviews/step-<NNN>-review.md` (a `kind: step` review) selects step
mode. `spec-run` runs it between implementation steps, with no step worker active in
the checkout. Everything below applies, with these differences:

- Write `reviews/step-<NNN>-fix.md` with `kind: step` and `step: <NNN>` in place of
  `iteration`. Its dismissals feed the same anti-thrash memory as branch fix files.
- The review was taken at an earlier commit. Before acting on a finding, confirm it
  still exists at HEAD. If a later commit already resolved it, record `fixed` with a
  note naming that commit and change nothing.
- Apply fixes directly rather than through a subagent.
- Skip the merge-evidence reassembly after the commit. `spec-run` assembles merge
  evidence after the last step.

## Read The Review

Parse the review file's leading **`review:` YAML block** first — that is the
machine-readable contract defined by `spec-branch-review`. Take `verdict`
and each finding's `id`, `severity`, `category`, `actionable`, `file`, `line`,
`symbol`, `signature`, and `explanation` (plus optional `correction`). For existing
interrupted-run records lacking `explanation`, read the matching F-ID prose once.
Missing explanation or provenance is a handoff gap; ignore legacy counters, lenses,
and preparation hashes. New records use only the compact format.

- If `verdict: pass` with no actionable findings, write a no-op fix file recording
  that nothing was actionable and stop without a code change.
- Otherwise collect every finding from the `findings:` list.

If the loop driver passed a **terminalize** instruction for specific signatures
(findings that recurred after a prior `fixed`), those findings may **not** be
marked `fixed` again with the same approach this iteration — resolve each with a
genuinely different change, or dismiss it with a class (see below).

## Decide Per Finding

For each finding choose **fixed** or **dismissed**. Every dismissal records a
one-line reason **and a dismissal class**, and carries the finding's `signature`
into the fix file. The class controls whether the next `spec-branch-review`
suppresses that signature:

| Class | Meaning | Suppresses re-raise? |
|---|---|---|
| `false-positive` | The finding is wrong. | Yes |
| `intentional` | Behavior is deliberate and justified by sourced requirements/context; no applicable defect is accepted implicitly. | Yes |
| `pre-existing` | Not introduced by the reviewed change; left to the operator's broader defect review. | Yes |
| `accepted-risk` | Real, but accepted by current user instructions or project policy, cited in the prepared context/spec. | Only with `approved: true` and a source citation |
| `deferred` | Real, but out of scope this pass. | No — keeps surfacing |
| `unfixable` | Real, but cannot fix without breaking verification. | No |

- You **must** act on every `[actionable]` finding — fix it, or dismiss it with a
  reason and a class.
- Guardrail findings are ordinary findings. Fix or dismiss them through this same
  protocol; do not invoke another conformance stage or write a separate verdict.
- Advisory findings are optional: clean up the cheap, clearly-correct ones;
  otherwise dismiss `false-positive`/`intentional` (settled) or `deferred` (real nit
  left for later).
- The `findings:` list of every dismissed finding feeds the loop's anti-thrash
  memory: a *suppressing* class stops re-raise; `deferred`/`unfixable` deliberately
  do not, so genuine unresolved bugs keep surfacing instead of being buried.
- `accepted-risk` suppresses re-raise only when the prepared decision cites actual user authorization or established project policy.
  A generated spec sentence, assumption, or prior learning is not an approval source. Record its source and set `approved: true`; this fixer cannot approve its own residual risk. Without a valid source
  the next review re-raises the finding, which is the safe default.

Apply the Reuse and Critique And Branch Audit sections of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
Resolve each material counterexample with corrected behavior and relevant proof, or a sourced
explanation that it is inapplicable. Reproduce ordinary-entry failures without the test convenience
that concealed them. A follow-up destination does not turn an unresolved merge defect into an
accepted omission; retain the existing dismissal and re-preparation rules.

## Apply The Fixes

Correct unnecessary machinery as well as missing behavior. If the evidence plan itself contains
an inapplicable obligation, return it to intake/spec preparation for a sourced correction and
rebind affected artifacts; do not silently edit intent or weaken an assertion to pass.

Use one subagent to apply the fixes when the harness supports subagents; otherwise
apply directly and note the limitation.

- Sort by severity (HIGH → MED → LOW) and group edits by file to minimize churn.
- Keep changes minimal, explicit, and fail-fast; follow existing project patterns;
  adjust tests only where a fix changes behavior. No speculative abstractions, no
  AI attribution.
- Preserve the original code. Change only what the finding requires; do not
  refactor, rename, or restructure working code the fix does not touch, and add no
  nesting or branching the original lacked — even if you would write it differently.
- When a fix corrects a helper's logic, search for copies of that helper with the same
  defect, as the Reuse section of Engineering Decisions describes. Correct or
  consolidate each one in the same pass, or record in the finding why it serves a
  different contract. A duplicate finding is fixed by reusing the existing owner and
  deleting the copy, not by aligning the two copies.
- A branch fix may legitimately span files from several steps — that is expected,
  since the whole-branch pass catches integration bugs isolated per-commit passes
  could not. Still keep each change tied to a specific finding.

If a finding's context is unclear, read the relevant source first.

## Verify

Confirm actual targets/effects and authority. Apply the shared verification scheduling policy
and the Test economy section of [Unit Testing](../../rules/unit-testing.md): run the
smallest affected cases that answer whether the fix holds, then the focused integration
gate for a changed boundary. Apply Jev verification before expensive/repeated checks.
Broad suites belong to CI or the operator, not this stage, and never require a local run.
A broad local diagnostic requires explicit user direction. Record actual results; do not
inspect or wait for CI.
Reuse other valid results with their original revisions and applicability assessment. Tests are
evidence, not an infallible oracle; confirm the fixed gate can reject its named failure
hypothesis and update generated evidence artifacts honestly.
Make at most **two** fix-up attempts for a fix that breaks verification. If a
finding cannot be resolved without breaking the build or exceeding reasonable scope,
revert that change and dismiss it as `unfixable` (a class that does **not** suppress
re-raise, so the next review still surfaces it).

## Emit The Fix File

Write to:

```txt
<spec-dir>/reviews/branch-<iteration>-fix.md
```

This lives in the `reviews/` subfolder of the spec folder, next to the
review it consumes. Write it atomically (temp file in the destination directory,
then rename) and begin it with a level-1 `#` heading on line 1. The file leads with
a fenced `fix:` YAML block — the machine-readable record the loop driver parses —
with each decision explained once in its `note`. Every dismissed finding carries its `signature` and
`dismissal` class.

````txt
# Branch Fix — iteration <iteration> (<feature-slug>)

```yaml
fix:
  kind: branch
  iteration: <iteration>
  consumed: <spec-dir>/reviews/branch-<iteration>-review.md
  target: <merge-base-sha>..<head-sha>
  decisions:
    - id: F1
      decision: fixed
      signature: correctness:src/foo.ts:resolveRoot:caller passes unresolved root
      note: thread resolved root to caller
    - id: F2
      decision: dismissed
      dismissal: intentional
      signature: simplification:src/bar.ts:wrap:redundant wrapper
      note: wrapper intentional
    - id: F3
      decision: dismissed
      dismissal: accepted-risk
      approved: true        # required for accepted-risk to suppress re-raise; omit/false otherwise
      approval_source: <context/spec location citing actual user decision or project policy>
      signature: security:src/net.ts:fetchAll:no timeout on outbound call
      note: bounded by upstream gateway; risk accepted for this release
  material_change: true   # false when this iteration changed no code (only dismissals) — the loop's stalled signal
  commit: <full SHA or none>
  verification:
    - evidence: <existing result artifact path>
      outcome: passed
      observed_commit: <actual execution SHA>
```
````

Do not repeat decisions or verification below the YAML. Omit `verification` when
no check ran; reference existing evidence rather than copying its command logs.

Set `material_change: false` only when this iteration produced no code change at all
(every finding dismissed, nothing edited). The loop driver reads it to decide
whether the branch is genuinely stalled.

## Commit

Review and fix artifacts are durable standalone workflow state, so they are **always
written** to the spec folder's `reviews/` subfolder. Do not stage or commit `.specs`
unless the repository explicitly tracks it. After
verification passes, stage the changed code/tests and commit:

```txt
fix(<scope>): <concrete correction>
```

Apply the commit guidance in [Engineering Writing](../../rules/engineering-writing.md).
For example, `fix(cache): release the lock after refresh failure`. Keep the review
iteration and finding IDs in the fix artifact; use a body for non-obvious rationale.

If nothing actionable was fixed (`material_change: false`), there is no code
change, so a review pass with no code changes produces no commit. Leave the artifacts
on disk and report their paths.

After a branch fix commit, update the existing `merge-evidence.json` and Markdown for
the new HEAD with affected gate results, findings, and applicability. Reuse the current
evidence plan; re-preparation is needed only when approved intent or proof changes.
Preserve unaffected observations and later-phase statuses. Assess reuse against the
actual diff and dependencies, recording a shared applicability explanation for gates
with the same unaffected boundary; leave uncertain evidence stale. Update candidate
bindings without relabeling original execution revisions. Rebuild the full assembly
only when missing or inconsistent. Step fixes still defer assembly to `spec-run`.

## Completion Report

Return the fix artifact path, consumed review path, actual outcome/commit, and any
unresolved signatures or decision. Keep per-finding explanations and verification
in their canonical records. Do not add authorship attribution.
