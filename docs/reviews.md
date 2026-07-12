# Spec Branch Review

The consolidated spec workflow has one correctness boundary after all prepared steps
are implemented: `spec-branch-refine`. It alternates `spec-branch-review` and
`spec-branch-fix` until the branch is clean, progress stalls, or the iteration cap is
reached.

Per-step judges, reviews, and fix passes no longer exist. `spec-run` performs only
mechanical verification of the immutable contracts produced by `spec-prepare`.

## Artifact Locations

Spec and review artifacts live together in the standalone feature package:

```text
.specs/<feature>/
├── spec.md
├── spec-prepare.md
├── criteria.md                 # optional prose guardrails
├── invariants.md               # optional live invariants
├── step-<NNN>-subspec.md       # immutable prepared plans
├── step-<NNN>-learning.md      # execution evidence
├── spec-steps.json
├── preparation.json
└── reviews/
    ├── branch-<i>-review.md
    └── branch-<i>-fix.md
```

`.specs/` is usually gitignored. A worktree handoff copies the complete feature
folder, preserves its relative references, and makes the destination copy active.

## Review Stages

`spec-branch-review` reviews the committed merge-base-to-HEAD diff in four stages:

1. **Stage A — orientation:** resolve the prepared spec, branch range, commit list,
   prior iteration state, and applicable rules.
2. **Stage B — per-commit passes:** inspect each commit in isolation for correctness,
   security, maintainability, and contract inconsistencies.
3. **Stage C — integrated branch:** inspect the final branch state for producer/consumer
   agreement, cross-commit interactions, dangling references, duplication, and risks
   that isolated passes cannot see.
4. **Stage D — bounded guardrail lens:** compare the branch with prose `Statement:`
   values from `criteria.md` and live entries in `invariants.md`.

Guardrail mismatches are ordinary structured findings. They do not create a separate
audit verdict, executable check program, or remediation lifecycle.

The review writes `reviews/branch-<i>-review.md` with a machine-readable YAML block,
ordinary prose evidence, and either `clean` or `needs-fix`.

## Fix And Convergence

`spec-branch-fix` consumes only the current branch review. For each finding it either:

- applies the smallest scoped correction and verifies the affected behavior; or
- records a typed dismissal so the refine loop can suppress settled false positives
  without hiding deferred or unresolved defects.

It writes `reviews/branch-<i>-fix.md` and commits code changes, never review artifacts.

`spec-branch-refine` owns cross-iteration state: finding identities, dismissals,
recurrence, progress, and the cap. It stops when the review is clean, no meaningful
progress is possible, or the bounded iteration limit is reached.

## Ownership Boundaries

- `spec-prepare` owns spec correction, prose guardrails, step planning, and the final
  preparation manifest.
- `spec-run` and `spec-step-run` own prepared execution and focused verification.
- `spec-branch-review` owns findings and never edits code.
- `spec-branch-fix` owns corrections and never rewrites the review verdict.
- `spec-branch-refine` owns convergence and termination.

Preparation artifacts are immutable during execution and review. Drift in a prepared
target, command, or hash is a blocker that requires a fresh `spec-prepare` run.
