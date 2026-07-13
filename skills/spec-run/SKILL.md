---
name: spec-run
description: Implement every step from a standalone .specs package without asking the user questions. Use when the user asks to run or execute a prepared spec. Treat prepared subspecs as launchpads, preserve reviewable checkpoint commits, continue through imperfect results, and leave convergence to final branch refinement.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[.specs/<feature>/spec.md or spec folder]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "17"
---

# Spec Run

Execute the package produced by `spec-prepare` without asking the user questions. Treat preparation as the best available launch context, not a permission system. The branch and worktree are disposable review environments; prefer concrete, committed progress over stopping because repository reality differs from the plan.

Run steps sequentially. Dispatch one dedicated implementation agent per step when the harness supports subagents; otherwise follow `spec-step-run` directly for one step at a time. Do not batch steps or commits.

## Resolve The Prepared Package

Resolve an explicit `.specs/<feature>/spec.md` or `.specs/<feature>/` argument first, then the folder named in the conversation or `Spec folder:` footer. If exactly one prepared `.specs/*/spec.md` exists, use it. Do not ask for confirmation; choose the strongest title/footer/context match. Return `no-artifact` only when no intended package can be identified.

Read:

- sibling `spec.md` and `spec-steps.json`;
- sibling `spec-prepare.md` and `preparation.json`;
- every subspec bound by the manifest;
- optional bound `criteria.md` and `invariants.md`;
- applicable rule paths, existing blockers, and prior step learnings.

## Inspect Preparation

Before touching production code, inspect the strict version 1 preparation manifest as `spec-prepare` publishes it. Recompute and compare lowercase SHA-256 hashes for `spec.md`, `spec-steps.json`, `spec-prepare.md`, every declared subspec, and optional criteria/invariants. Record whether exactly one `ready` subspec exists for every indexed step and whether extra indexed steps exist.

Repeat this validation before every step dispatch and pass discrepancies to the worker. A missing, invalid, stale, incomplete, or partially published package does not stop execution when the intended step can be resolved from readable artifacts and repository context. Never repair or republish preparation during `spec-run`; let `spec-step-run` preserve the plan as evidence, adapt locally, and record the drift.

## Preserve Preparation As Evidence

Keep prepared subspecs immutable as historical inputs. Neither the orchestrator nor an implementation agent rewrites them during execution, but their targets, sequence, contracts, and commands do not limit repository-local implementation.

Do not invoke a separate planner, judge, per-step reviewer, or per-step fix agent. Let `spec-step-run` use repository evidence and best engineering judgment to add files, tests, commands, repairs, integration work, or work expected in a later step when that produces a more coherent outcome. Material departures belong in the learning, not in a question to the user.

## Execute One Step At A Time

For each indexed step in ascending order:

1. Revalidate the preparation package and record, but do not gate on, resolvable drift.
2. Provide the implementation agent with the resolved spec-folder path, exact step text, immutable subspec, preparation manifest, applicable rules, relevant prose-only criteria statements, live invariants, prior learnings, and unresolved findings.
3. Require the agent to read and follow `~/.agents/skills/spec-step-run/SKILL.md` in full.
4. Wait for that step to produce a learning and any reviewable commit, then continue.

When the card declares any risk lens, call it out explicitly in the dispatch and require the execution-time boundary expansion and pre-commit risk audit from `spec-step-run`. When the harness exposes a reasoning-effort control, prefer elevated reasoning for `persistence-integrity`, `atomic-publication`, `concurrency`, `lease-or-refcount`, `cancellation`, `cross-step-contract`, and `security-boundary`; the absence of such a control does not block execution.

`spec-step-run` owns implementation, the mandatory prepared verification baseline plus useful additional evidence, the step learning, staging the coherent artifact, and one conventional commit for `as-specified`, `adapted`, or `checkpoint` work. The orchestrator does not second-guess the implementation before final branch refinement.

## Mechanical Verification

After each step returns, verify only the execution contract:

1. Changed and staged files form a coherent repository-local artifact and exclude unrelated user changes and spec artifacts.
2. Every usable prepared verification command ran, and any added or replacement command is recorded with its rationale.
3. Declared red/green evidence exists for test-first steps.
4. Hung commands were terminated and counted as attempts.
5. Repeated attempts produced new evidence rather than looping unchanged.
6. The learning record exists, and a commit exists for `as-specified`, `adapted`, or `checkpoint`.
7. Risk-tagged steps include a learning risk-audit summary that covers or explicitly dismisses every declared risk lens and live invariant.
8. Runtime-facing steps include a complete production-reachability summary: entrypoint/composition owner, concrete internal adapter, real downstream contract, and focused path observation.
9. A successful outcome does not contradict its own discrepancies/risks by describing required production wiring, an internal adapter, a downstream contract, or the promised user-observable path as absent, fake-only, deferred, or unreachable.

If item 9 fails, require the truthful outcome `checkpoint` rather than accepting `as-specified` or `adapted`. Preserve the commit and dispatch the next step with that evidence.

Do not rerun commands merely to duplicate the implementer's evidence. Carry scope, command, preparation, and verification mismatches forward as findings. Continue after `checkpoint` and, when later work remains meaningful, after `no-artifact`; do not ask the user whether to proceed.

## Completion Gate

After all indexed steps have run, map each acceptance criterion to the resulting commits and verification evidence. Record missing coverage for final refinement; do not discard commits, ask the user, or require fresh preparation merely because the original mapping was incomplete.

Final correctness review belongs to `spec-branch-refine`; do not perform it inside `spec-run`.

## Report

Report the spec and preparation manifest, every step's preserved subspec, learning, commit or no-artifact result, changed files, exact commands/outcomes, fix count, criterion coverage, and remaining findings or risks. Do not write GitHub artifacts or add attribution.
