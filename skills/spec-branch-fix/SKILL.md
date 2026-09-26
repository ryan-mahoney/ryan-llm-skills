---
name: spec-branch-fix
description: "Fix one iteration of branch code or executable-evidence findings, reproduce affected gates, record every decision, and commit coherent corrections for independent re-audit."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [iter=<n>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "12"
---

# Spec Branch Fix

> **`.specs/` is standalone working state and is often gitignored.** Read and write it directly; do not depend on git history to recover it. Diffing implementation code is unaffected.

Apply one iteration of the final branch review. `spec-branch-review` wrote
`reviews/branch-<iteration>-review.md`; this skill reads it, decides what to act on,
fixes the actionable findings across the branch, and records its decisions in
`reviews/branch-<iteration>-fix.md`.

The two skills are coupled **only** through the review file, and this skill never
re-reviews — `spec-branch-refine` runs the next `spec-branch-review` as the
independent check that fixes landed.

Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Evidence findings are first-class: correct the implementation, test/gate, artifact, claim mapping, or proof boundary that made the evidence invalid, then reproduce the affected gate.

## Operating Context

The fix stage of one branch-loop iteration:

```txt
spec-branch-refine (loop) → spec-branch-review → spec-branch-fix → re-review …
                            (find bugs)           (this skill)
```

Single pass per call: decide, fix the actionable findings, verify, commit, stop.
The loop driver decides whether another iteration runs.

## Autonomous Repair

Read the sourced `context.md` and current project policy. Decide ordinary repairs from the
review, diff and evidence. Route unresolved consequential choices as `decision-required` to the
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

## Read The Review

Parse the review file's leading **`review:` YAML block** first — that is the
machine-readable contract; the prose below it is only explanation. Take `verdict`
and each finding's `id`, `severity`, `category`, `actionable`, `file`, `line`,
`symbol`, and `signature`.

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

Apply the Critique And Branch Audit section of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
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
- A branch fix may legitimately span files from several steps — that is expected,
  since the whole-branch pass catches integration bugs isolated per-commit passes
  could not. Still keep each change tied to a specific finding.

If a finding's context is unclear, read the relevant source first.

## Verify

Confirm actual targets/effects and authority. Run the project's relevant tests and affected
applicable merge EV gates — targeted where possible,
broadening to the suite the changes plausibly affect. Tests are evidence, not an infallible oracle; confirm the fixed gate can reject its named failure hypothesis and update generated evidence artifacts honestly.
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
followed by prose. Every dismissed finding must carry its `signature` and
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
  commit: <hash or none>
```

## Decisions
- F1 · fixed — thread resolved root to caller (src/foo.ts:resolveRoot, L42)
- F2 · dismissed (intentional) — wrapper intentional

## Verification
<commands> → <outcomes>; <n> fix-up attempt(s)

Fix: <spec-dir>/reviews/branch-<iteration>-fix.md (iteration <iteration>)
````

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

After a fix commit, reassemble `merge-evidence.json` and `merge-evidence.md` for the new
HEAD using the current re-prepared evidence plan plus reproduced affected merge gates and honest
later-phase statuses. Keep deployment readiness, authority and observations separate. Mark untouched
gates stale unless their result remains valid across this exact change and that judgment
is recorded with a concrete dependency boundary. The next independent audit must never
consume evidence still bound to the pre-fix SHA.

## Completion Report

Report:

1. Spec path and iteration.
2. Review file consumed and fix file written.
3. Per-finding decisions (fixed / dismissed + class) in one line each.
4. Verification commands and outcomes.
5. Commit hash (the `fix(...)` commit, or `none` when only review/fix artifacts
   changed) and
   `material_change`.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
