---
name: spec-step-fix
description: This skill should be used when the user or an external task-runner asks to fix, apply, or act on a single step's correctness review — given only a step marker (spec path plus step). The mutating counterpart to spec-step-review: it reads reviews/<step>-review.md, decides per finding whether to fix or dismiss, applies the actionable fixes scoped to that step, runs targeted tests, writes reviews/<step>-fix.md, and commits code plus any review artifacts that are tracked or not ignored. Self-sufficient by design — resolves the review file and the step's files deterministically from the spec directory. It is coupled to spec-step-review only through the review file. Trigger on "fix the step review", "apply the step review", "address the step's findings", or "spec step fix".
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=<path/to/spec.md> step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "6"
---

# Spec Step Fix

Apply a single step's correctness review. This is the mutating half of the per-step
*correctness* loop: `spec-step-review` wrote `reviews/<step-number>-review.md`; this
skill reads it, decides what to act on, fixes only that step's code, and records
its decisions in `reviews/<step-number>-fix.md`.

The two skills are coupled **only** through the review file. This skill never
re-reviews — it trusts the review's findings and the targeted tests are the oracle.
Keeping the reviewer and the fixer apart is what keeps both honest.

## Operating Context

The correctness-fix stage of the per-step pipeline:

```txt
spec-step-run → spec-step-judge → spec-step-review → spec-step-fix
(implement)     (conformance)      (find bugs)        (this skill)
```

The external review orchestrator schedules this skill right after `spec-step-review`.
Single pass: decide, fix the actionable findings, verify, commit, stop.

## Run Directly — No Subagents

Do this skill's work directly in your own context. Do **not** spawn subagents,
fan out parallel agents, or delegate the run to another agent. This is a leaf
skill: the external task-runner already dispatches it in isolation, one step at a
time, so a nested agent adds no isolation — only the failure modes of delegation
(needless fan-out, or a child whose completion goes unnoticed). Decide each
finding, edit, verify, and commit yourself.

## Non-Interactive Operation

This skill runs to completion without user interaction. Decide each finding from
the review text, the diff, and the code; do not pause for confirmation. Stop only
when a required input is genuinely missing and cannot be inferred; report what is
missing and halt.

## Required Inputs

A **step marker** is the only input. Everything else is derived:

1. `spec`: path to the local `spec.md`.
2. `step`: the exact step number, stable step id, or full step text.

Resolve from the spec directory (`<spec-dir>` = the folder containing `spec.md`):

- `review`:  `<spec-dir>/reviews/step-<step-number>-review.md` — the file this skill
  acts on. **If it is missing, there is nothing to do**: report that no review
  exists for the step and stop. Do not invent findings.
- `subspec`: `<spec-dir>/subspecs/<step-number>-spec.md` (for context).
- `learning`: `<spec-dir>/learnings/<step-number>-learning.md` (for context).

## Read The Review

Parse the review file's leading **`review:` YAML block** first — that is the
machine-readable contract; the prose below it is only explanation. From the YAML
take `verdict` and each finding's `id`, `severity`, `category`, `actionable`,
`file`, `line`, `symbol`, and `signature`.

- If `verdict: pass` with no actionable findings, write a no-op fix file (see Emit)
  recording that nothing was actionable, and stop without a code change.
- Otherwise collect every finding from the `findings:` list.

## Decide Per Finding

For each finding, choose one decision:

- **fixed** — an actionable finding (or an advisory one you choose to clean up) that
  you will change.
- **dismissed** — record both a one-line reason **and a dismissal class**, and carry
  the finding's **signature** into the fix file. The class controls whether the
  branch loop suppresses the signature on later reviews:

  | Class | Meaning | Suppresses re-raise? |
  |---|---|---|
  | `false-positive` | The finding is wrong. | Yes |
  | `intentional` | The code is deliberate as written. | Yes |
  | `accepted-risk` | Real, but accepted for now. | Only with `approved: true` on the decision |
  | `deferred` | Real, but out of this step's scope. | No — branch review keeps it |
  | `unfixable` | Real, but cannot fix without breaking verification. | No |

You **must** act on every `[actionable]` finding — fix it, or dismiss it with a
reason and a class. Advisory findings are optional: fix the cheap, clearly-correct
ones; otherwise dismiss them `false-positive`/`intentional` (if settled) or
`deferred` (if a real nit left for later) so the record is complete.

## Apply The Fixes

Apply the fixes directly. Constraints:

- Scope changes to **this step's** code and its tests. Do not wander into other
  steps. If a finding truly requires touching another step's code, dismiss it as
  out-of-scope and note it for the branch review.
- Keep changes minimal, explicit, and fail-fast. Follow existing project patterns.
  No speculative abstractions, no AI attribution.
- Adjust tests only where a fix changes behavior.

If a finding's context is unclear, read the relevant source before changing it.

## Verify

Run the step's targeted tests — those named by the step or its subspec, scoped to
those specific files or filters. If none are named, use judgment to run the narrowest
meaningful check for the changed files (typically a typecheck or compile), not the
test runner. **Never run the entire test suite**: per-step verification stays
targeted; the full suite is reserved for the branch-level stage (running it here
multiplies memory use across concurrent steps and projects). The targeted re-run is
the oracle, not self-assessment. Make at most **two** fix-up attempts for a fix that
breaks verification. If a finding cannot be resolved without breaking the build or
exceeding scope, revert that change and dismiss it as `unfixable` (a reason that
does **not** suppress re-raise — the branch review will see it again), and continue.

## Emit The Fix File

Write decisions and outcomes to:

```txt
<spec-dir>/reviews/step-<step-number>-fix.md
```

(Use `step-<short-slug>-fix.md` for a non-numeric step.) The file leads with a
fenced `fix:` YAML block — the machine-readable record — followed by prose. Every
dismissed finding must carry its `signature` and `dismissal` class so downstream
dedup works.

````txt
# Step Fix — step <step-number> (<feature-slug>)

```yaml
fix:
  kind: step
  step: <step-number>
  consumed: <spec-dir>/reviews/step-<step-number>-review.md
  target: <commit-sha being fixed>
  decisions:
    - id: F1
      decision: fixed
      signature: correctness:src/foo.ts:loopBound:off-by-one in loop bound
      note: corrected loop bound
    - id: F2
      decision: dismissed
      dismissal: intentional
      approved: false       # only meaningful for accepted-risk; set true to suppress re-raise
      signature: simplification:src/bar.ts:wrap:redundant wrapper
      note: wrapper kept for the API surface
  commit: <hash or none>
```

## Decisions
- F1 · fixed — corrected loop bound (src/foo.ts:loopBound, L42)
- F2 · dismissed (intentional) — wrapper kept for the API surface

## Verification
<targeted commands> → <outcomes>; <n> fix-up attempt(s)

Fix: <spec-dir>/reviews/step-<step-number>-fix.md (step <step-number>)
````

## Commit

Review and fix artifacts are part of the product — iteration memory, dismissal
memory, and the human audit trail — so they are **always written**. Commit them
only when they are already tracked or are not ignored by Git. Before staging
artifact paths, check `git ls-files --error-unmatch <path>` and
`git check-ignore -q <path>`; never use `git add -f` / `--force` to override an
ignore rule for `.specs/` artifacts. After verification passes, stage this step's
changed code/tests plus any committable `reviews/step-<step-number>-review.md`
and `-fix.md`, and commit:

```txt
fix(<scope>): address step <step-number> review
```

Append `(#<issue-number>)` if a GitHub issue number is known from the spec footer.
If nothing actionable was fixed (all dismissed / `verdict: pass`), there is no code
change. If the review artifacts are committable, commit them on their own so the
audit trail is durable:

```txt
chore(reviews): record step <step-number> review
```

If the only changes are ignored, untracked `.specs/` review artifacts, do not make
a commit. Leave the artifacts on disk and report that they were written locally but
not committed because the repository ignores them.

## Be Terse

Spend words on the durable artifact — the fix file: its YAML decisions and the
one-line note per finding. Everywhere else omit needless words: skip preamble, do
not restate these instructions or narrate intent, and keep the completion report a
terse list, not an essay. Terseness must never drop a per-finding decision, a
dismissal class, or a signature.

## Completion Report

Report:

1. Spec path and resolved step.
2. Review file consumed and fix file written.
3. Per-finding decisions (fixed / dismissed) in one line each.
4. Verification commands and outcomes.
5. Commit hash (the `fix(...)` or no-op `chore(reviews): ...` commit), or `none`
   when only ignored local review artifacts changed.
6. Anything deferred to the branch review (out-of-scope / `deferred` / `unfixable`).
