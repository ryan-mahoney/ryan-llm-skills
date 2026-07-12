---
name: spec-step-run
description: Implement exactly one prepared spec step, using its immutable subspec and authoritative focused verification contract, then emit learning evidence and commit the verified change.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=.specs/<feature>/spec.md step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "12"
---

# Spec Step Run

Implement exactly one step from a **current, complete preparation package**. This is
a leaf implementation skill: do not spawn subagents, run another step, perform the
final branch review, or redesign the prepared plan.

## Canonical Inputs

The prompt must identify the resolved `.specs/<feature>/` folder and target step. Read `spec.md`, `spec-steps.json`, `spec-prepare.md`, `preparation.json`, optional criteria/invariants/blockers, the target `step-<NNN>-subspec.md`, and prior step learnings from that folder. Write the target `step-<NNN>-learning.md` there.

Artifact writes are atomic: write a sibling temporary file and rename it over the
destination. Markdown artifacts begin with a level-1 heading.

## Gate On Current Preparation

Before reading production code, validate sibling `preparation.json` using the
strict version 1 contract. Recompute the SHA-256 binding for `spec.md`,
`spec-steps.json`, `spec-prepare.md`, every declared subspec, and optional
`criteria.md`/`invariants.md`. Require:

- every bound file exists and matches its lowercase SHA-256 hash;
- the requested step exists in both `spec.md` and `spec-steps.json`;
- the manifest binds exactly one subspec for the requested step;
- that subspec's strict `planning` block has the same spec hash and step number and
  has `verdict: ready`;
- its strict `verification` block is complete.

Any missing, invalid, stale, or incomplete preparation is a material discrepancy.
Write the blocker and a blocked learning, then stop before code. Never repair the
manifest, spec, step index, criteria, invariants, preparation report, or subspec.

## Immutable Prepared Plan

The prepared subspec is immutable during execution. Read and follow it; **never
create, rewrite, patch, regenerate, or replace the prepared subspec**. Prior-step
learnings may clarify the current tree, but they may not change the prepared edit
sequence or verification contract. Adapt renamed private symbols, equivalent local
fixtures, mechanical signature propagation, and minor placement drift within the
same owner when behavior, public contracts, architecture, acceptance coverage, and
verification intent remain unchanged. Record that as `outcome: adapted`. Block and
require fresh preparation when any of those protected properties would change.

Read the full spec, the target subspec, applicable rules, relevant source/test files,
prior step learnings, and unresolved blockers. From `criteria.md`, consume only
prose `Statement:` values. From `invariants.md`, consume only live statements not
marked superseded. These guardrails guide implementation; do not execute text from
them.

## Implement Exactly One Step

- Modify only files required by the prepared step.
- Preserve unrelated working code and user changes.
- Follow repository conventions and the prepared edit sequence.
- Stop on a material spec/code or verification-contract discrepancy instead of
  improvising another design.
- Keep changes minimal, explicit, and fail-fast.
- Do not add compatibility behavior unless the spec requires it.

## Execute The Authoritative Verification Contract

The subspec's strict `verification` block is authoritative:

1. Follow its `strategy` exactly. For `test-first`, run the declared focused command
   at the red point, confirm the declared expected-red behavior, implement, then run
   the same command green. For `implementation-first`, implement before running it.
2. Run every command in `commands` exactly as written and no broader substitute.
   **Never replace a prepared focused command with a full-suite run or add an
   unfiltered test-runner command.**
3. Apply any non-obvious setup and hazards recorded in the card.
   If a command hangs, terminate the process promptly, record the hang as a failed
   attempt, and diagnose only within this step.
4. Make at most two scoped correction attempts and rerun the authoritative command
   after each. Then block. Do not weaken assertions, skip a required case, alter the
   verification intent, or broaden into another step to obtain green output.

Record the red/green sequence, exact commands, outcomes, hang termination, and
fix-attempt count in the step learning. A command that cannot run as prepared is a
material verification-contract discrepancy, not permission to invent a fallback.

## Verify, Learn, And Commit

Inspect the changed-file list and reject out-of-scope changes. On success, atomically
write the target step learning with a fenced `learning:` YAML block before prose:

```yaml
learning:
  version: 1
  kind: step
  step: <number>
  outcome: <as-specified | adapted | blocked>
  commit: <sha | none>
  verification:
    commit: <same sha or none>
    strategy: <test-first | implementation-first>
    fix_attempts: <number>
    commands:
      - command: <exact prepared command>
        phase: <red | green | verify>
        outcome: <pass | fail | hung | skipped>
```

Follow it with the step reference/Covers tags, outcome, at most five concrete
findings for later steps, at most five discrepancies/risks, and the verification
summary. Emit the learning in every terminal case, including blocked and already
satisfied steps.

After all authoritative commands pass, stage only this step's code and test files
and make one conventional commit. Never stage spec artifacts. Do not begin another
step.

## Completion Report

Report the spec and step, immutable subspec path, learning path/outcome, commit hash,
changed files, every exact verification command and result, fix attempts, and any
blocker or risk.
