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
  version: "20"
---

# Spec Run

Execute the package produced by `spec-prepare` without asking questions. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Preparation is immutable intent and evidence provenance; implementation may adapt to repository reality, but it may not execute against stale or mismatched prepared inputs.

Run steps sequentially. Dispatch one dedicated implementation agent per step when the harness supports subagents; otherwise follow `spec-step-run` directly for one step at a time. Do not batch steps or commits.

## Resolve The Prepared Package

Resolve an explicit `.specs/<feature>/spec.md` or `.specs/<feature>/` argument first, then the folder named in the conversation or `Spec folder:` footer. If exactly one prepared `.specs/*/spec.md` exists, use it. Do not ask for confirmation; choose the strongest title/footer/context match. Return `no-artifact` only when no intended package can be identified.

Read:

- sibling `spec.md`, `spec-steps.json`, and `evidence-plan.json`;
- sibling `spec-prepare.md` and `preparation.json`;
- every subspec bound by the manifest;
- optional bound `criteria.md` and `invariants.md`;
- applicable rule paths, existing blockers, and prior step learnings.

## Inspect Preparation

Before touching production code, inspect the strict version 2 preparation manifest. Recompute and compare lowercase SHA-256 hashes for `spec.md`, `spec-steps.json`, `evidence-plan.json`, `spec-prepare.md`, every declared subspec, and optional criteria/invariants. Confirm exactly one `ready` subspec exists for every indexed step and evidence ownership matches all three sources.

Repeat validation before every step dispatch. A missing, invalid, stale, incomplete, or partially published package blocks further implementation: report the exact mismatch and require `spec-prepare` to republish. Never repair preparation during `spec-run`. Already committed step artifacts remain intact.

## Preserve Preparation As Evidence

Keep prepared subspecs immutable as historical inputs. Neither the orchestrator nor an implementation agent rewrites them during execution, but their targets, sequence, contracts, and commands do not limit repository-local implementation.

Do not invoke a separate planner, judge, per-step reviewer, or per-step fix agent. Let `spec-step-run` use repository evidence and best engineering judgment to add files, tests, commands, repairs, integration work, or work expected in a later step when that produces a more coherent outcome. Material departures belong in the learning, not in a question to the user.

## Execute One Step At A Time

For each indexed step in ascending order:

1. Revalidate the preparation package and record, but do not gate on, resolvable drift.
2. Provide the implementation agent with the resolved spec-folder path, exact step text, immutable subspec, preparation manifest, applicable rules, relevant prose-only criteria statements, live invariants, the step's owned `Evidence:` obligations when present, prior learnings, and unresolved findings.
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
10. Steps whose card carries `Evidence:` lines produced each named artifact — in the commit or under `.specs/<feature>/evidence/` — or truthfully recorded the gap.

If item 9 or 10 fails, require the truthful outcome `checkpoint` rather than accepting `as-specified` or `adapted`. Preserve the commit and dispatch the next step with that evidence.

Do not rerun commands merely to duplicate the implementer's evidence. Carry scope, command, preparation, and verification mismatches forward as findings. Continue after `checkpoint` and, when later work remains meaningful, after `no-artifact`; do not ask the user whether to proceed.

## Completion Gate

After all indexed steps have run, map each acceptance criterion and claim to its commits and verification results, each Executable Evidence Plan gate (`EV-n`) to its produced artifact, and each pre-mortem item (`PM-n`) to its implemented disposition. Record missing coverage for final refinement; do not hide gaps or discard useful commits.

Then atomically write both `.specs/<feature>/merge-evidence.md` and strict version 1 `.specs/<feature>/merge-evidence.json`. These are the pre-audit evidence assembly bound to the exact current HEAD; final readiness still requires independent branch audit/refinement and a work tour.

The Markdown begins with a level-1 heading and contains:

- **What was built** — one paragraph plus the commit list.
- **Right problem** — each acceptance criterion mapped to the requirement it serves and the commits/tests covering it.
- **Correct** — the verification evidence: exact commands and outcomes from step learnings, test files added, red/green sequences for test-first steps.
- **Safe** — each pre-mortem item with its implemented disposition; residual accepted risks stated plainly.
- **Evidence index** — each EV item with claim/failure mapping, exact command, environment, artifact, status, observed result, proof boundary, and bound commit.
- **QA tour input** — deterministic entrypoints, fixtures, scenarios, expected results, automated EV coverage, captures, and optional exploration-only questions. No required manual QA.
- **Gaps** — missing coverage, unproduced evidence, and open findings carried to final refinement.

`merge-evidence.json` mirrors every CL/FH/EV item from `evidence-plan.json`, adds actual statuses, commands/outcomes/artifacts/proof boundaries, step commits, QA inputs, deployment facts, gaps, and the full current `commit`. Use `readyForAudit: true` only when every planned gate was produced and passed; this is not the deploy verdict.

State gaps honestly. Finish this stage with `outcome: ready-for-refinement` when every indexed step
has been dispatched and both merge-evidence files are bound to current HEAD. Do not run
`spec-branch-refine` or `spec-work-tour`; they are separate top-level stages so their outcomes remain
visible and independently resumable.

## Report

Report the spec and preparation manifest, every step result, exact commands/outcomes,
criterion/claim/failure/gate coverage, both merge-evidence paths, current HEAD, and remaining
gaps/risks. End with `next: spec-branch-refine`. Do not claim an audit or deployment verdict, write
work-tour/GitHub artifacts, or add attribution.
