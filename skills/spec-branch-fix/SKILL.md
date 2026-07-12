---
name: spec-branch-fix
description: This skill should be used when the user or the spec-branch-refine loop asks to fix, apply, or act on a branch correctness review for one iteration — coupled to spec-branch-review only through the review file. It parses the review's YAML block, decides per finding whether to fix or dismiss (recording a dismissal class that controls re-raise suppression), applies the actionable fixes across the branch, runs tests, writes reviews/branch-<i>-fix.md in the feature document folder, and commits the code changes (spec/review artifacts live outside the checkout and are never committed). Trigger on "fix the branch review", "apply the branch review", "address the branch findings", or "spec branch fix".
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [iter=<n>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "7"
---

# Spec Branch Fix

> **Spec artifacts live in the feature document folder — outside the git checkout.** Read and write them directly on the filesystem at the absolute paths you are given; do not run `git diff`/`log`/`status`/`show` on artifact paths to read, compare, or recover them — they are not in any repository, so git returning nothing there is expected, not an error. This is scoped to spec artifacts; diffing the code under review is unaffected.

Apply one iteration of the final branch review. `spec-branch-review` wrote
`reviews/branch-<iteration>-review.md`; this skill reads it, decides what to act on,
fixes the actionable findings across the branch, and records its decisions in
`reviews/branch-<iteration>-fix.md`.

The two skills are coupled **only** through the review file, and this skill never
re-reviews — `spec-branch-refine` runs the next `spec-branch-review` as the
independent check that fixes landed.

## Operating Context

The fix stage of one branch-loop iteration:

```txt
spec-branch-refine (loop) → spec-branch-review → spec-branch-fix → re-review …
                            (find bugs)           (this skill)
```

Single pass per call: decide, fix the actionable findings, verify, commit, stop.
The loop driver decides whether another iteration runs.

## Non-Interactive Operation

This skill runs to completion without user interaction. Decide each finding from the
review text, the diff, and the code. Stop only when a required input is genuinely
missing and cannot be inferred; report what is missing and halt.

## Resolve Inputs

- **Spec.** As `spec-branch-review` resolves it: the
  **# Canonical spec artifact paths** stanza when present (use its exact absolute
  `spec` path and `artifactsRoot`), else `spec=<path>` or a supplied feature document folder, else
  the conversation, else the directory containing the active working document file.
  `<spec-dir>` is the feature document folder — outside the git checkout. Never
  fall back to a spec folder inside a git checkout.
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
| `intentional` | The code is deliberate as written. | Yes |
| `accepted-risk` | Real, but accepted for now. | Only with `approved: true` on the decision |
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
- `accepted-risk` suppresses re-raise **only** when you set `approved: true` on that
  decision — use it only for a risk with genuine sign-off. Without `approved: true`
  the next review re-raises the finding, which is the safe default.

## Apply The Fixes

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

Run the project's relevant tests for the changed code — targeted where possible,
broadening to the suite the changes plausibly affect. The test run is the oracle.
Make at most **two** fix-up attempts for a fix that breaks verification. If a
finding cannot be resolved without breaking the build or exceeding reasonable scope,
revert that change and dismiss it as `unfixable` (a class that does **not** suppress
re-raise, so the next review still surfaces it).

## Emit The Fix File

Write to:

```txt
<spec-dir>/reviews/branch-<iteration>-fix.md
```

This lives in the `reviews/` subfolder of the feature document folder, next to the
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

Review and fix artifacts are part of the product — iteration and dismissal memory,
and the human audit trail — so they are **always written**, to the `reviews/`
subfolder of the feature document folder, outside the git checkout. They are never
committed to the repository and must never be force-added into it. After
verification passes, stage the changed code/tests and commit:

```txt
fix(<scope>): address branch review (iter <iteration>)
```

If nothing actionable was fixed (`material_change: false`), there is no code
change — spec/review artifacts live outside the checkout, so a review pass with no
code changes produces no commit. Leave the artifacts on disk and report that they
were written to the feature document folder.

## Completion Report

Report:

1. Spec path and iteration.
2. Review file consumed and fix file written.
3. Per-finding decisions (fixed / dismissed + class) in one line each.
4. Verification commands and outcomes.
5. Commit hash (the `fix(...)` commit, or `none` when only review/fix artifacts —
   which live outside the checkout and are never committed — changed) and
   `material_change`.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
