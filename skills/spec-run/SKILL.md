---
name: spec-run
description: Implement every step from a current standalone .specs package produced by spec-prepare. Use when the user asks to run or execute a prepared spec. Consume immutable prepared subspecs, execute steps sequentially through spec-step-run, verify the recorded focused commands mechanically, and commit each successful step separately; never plan, rewrite preparation artifacts, or perform per-step review passes.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[.specs/<feature>/spec.md or spec folder]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "14"
---

# Spec Run

Execute a **current, complete package already produced by `spec-prepare`**. Preparation owns spec correction, repository grounding, step-index reconciliation, guardrail derivation, subspec planning, and verification design. Reuse those results exactly. Do not repeat any of that work during execution.

Run steps sequentially. Dispatch one dedicated implementation agent per step when the harness supports subagents; otherwise follow `spec-step-run` directly for one step at a time. Do not batch steps or commits.

## Resolve The Prepared Package

Resolve an explicit `.specs/<feature>/spec.md` or `.specs/<feature>/` argument first, then the folder named in the conversation or `Spec folder:` footer. If exactly one prepared `.specs/*/spec.md` exists, use it. Stop on ambiguity rather than choosing by modification time or using an issue mirror.

Read:

- sibling `spec.md` and `spec-steps.json`;
- sibling `spec-prepare.md` and `preparation.json`;
- every subspec bound by the manifest;
- optional bound `criteria.md` and `invariants.md`;
- applicable rule paths, existing blockers, and prior step learnings.

## Gate On Preparation

Before touching production code, validate the strict version 1 preparation manifest exactly as `spec-prepare` publishes it. Recompute and require matching lowercase SHA-256 hashes for `spec.md`, `spec-steps.json`, `spec-prepare.md`, every declared subspec, and optional criteria/invariants. Require exactly one `ready` subspec for every indexed step and no extra indexed step.

Repeat this validation before every step dispatch. A missing, invalid, stale, incomplete, or partially published package blocks execution. Direct the caller to rerun `spec-prepare`; never repair, regenerate, or republish preparation during `spec-run`.

## Preserve Prepared Ownership

Treat every prepared subspec and its strict `planning` and `verification` blocks as immutable inputs. Neither the orchestrator nor an implementation agent may create, rewrite, patch, regenerate, replace, or supplement a subspec.

Do not invoke `spec-subspec-write`, a planner, a judge, a per-step reviewer, or a per-step fix agent. Do not re-ground the spec, redesign its steps, derive new guardrails, invent tests, or replace focused commands. Let `spec-step-run` adapt private mechanical drift within its protected behavioral boundaries; drift that changes behavior, public contracts, architecture, acceptance coverage, or verification intent is a blocker requiring fresh preparation.

## Execute One Step At A Time

For each indexed step in ascending order:

1. Revalidate the complete preparation package.
2. Provide the implementation agent with the resolved spec-folder path, exact step text, immutable subspec, preparation manifest, applicable rules, relevant prose-only criteria statements, live invariants, prior learnings, and unresolved blockers.
3. Require the agent to read and follow `~/.agents/skills/spec-step-run/SKILL.md` in full.
4. Wait for that step to reach a terminal result before continuing.

`spec-step-run` owns implementation, the authoritative focused verification commands, bounded fix attempts, the step learning, staging only that step's code/tests, and one conventional commit. The orchestrator must not perform a second implementation or fix pass.

## Mechanical Verification

After each step returns, verify only the execution contract:

1. Changed and staged files are scoped to the prepared step.
2. Every exact prepared verification command ran in the required phase and no broader or full-suite substitute ran.
3. Declared red/green evidence exists for test-first steps.
4. Hung commands were terminated and counted as attempts.
5. Fix attempts did not exceed the shared `spec-step-run` limit of two.
6. The learning record and exactly one step commit exist.

Do not rerun commands merely to duplicate the implementer's evidence. Rerun only when the returned record is incomplete or internally inconsistent and the exact prepared command can resolve that evidence gap without changing code. Any scope, command, preparation, or verification mismatch blocks the run; do not dispatch the next step.

## Completion Gate

After every step succeeds, map each acceptance criterion to its prepared covering steps and their recorded focused verification. Do not run new acceptance commands, reopen implementation, or spend additional fix attempts here. Missing coverage is a preparation defect: record it as a blocker and require fresh `spec-prepare`.

Final correctness review belongs to `spec-branch-refine`; do not perform it inside `spec-run`.

## Report

Report the spec and preparation manifest, every step's immutable subspec, learning, commit, changed files, exact commands/outcomes, fix count, criterion coverage, and remaining blockers or risks. Do not write GitHub artifacts or add attribution.
