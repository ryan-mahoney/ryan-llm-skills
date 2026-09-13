---
name: spec-end-to-end
description: Run the complete standalone spec-driven workflow from a feature goal or existing .specs package through architecture, specification, preparation, branch or worktree setup, implementation, evidence refinement, work tour, and a published pull request. Use when the user says "do the spec workflow end to end", "take this from idea to PR", "run the whole spec process", "finish this spec and open a PR", or asks for the full workflow with modifiers such as a named subagent or worktree.
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "4"
---

# Spec End To End

Own one continuous run from the user's goal to a published pull request. Compose the sibling spec
skills; do not reimplement their stage logic. Continue autonomously until `spec-pr` returns a PR URL
or a stage produces a concrete blocker.

## Preserve User Directives

Treat workflow modifiers in the request as run-wide constraints. Examples include:

- use or avoid a worktree;
- keep work in the current checkout;
- delegate named stages to a named subagent or agent type;
- include or skip the optional architecture critique;
- target a specific base branch, repository, feature package, or PR shape.

Honor explicit directives over the defaults below. Use delegation only when the user requests it,
a leaf skill requires it, or the active harness instructions independently require it. The
top-level agent retains orchestration ownership: verify every delegated handoff and decide whether
the next stage may proceed.

## Resolve The Run

1. Resolve the repository root and read all applicable `AGENTS.md` files.
2. Resolve the goal, existing `.specs/<feature>/` package, and any implementation branch or
   worktree from the request and repository state.
3. Inspect existing pipeline artifacts. Resume at the earliest incomplete, stale, invalid, or
   explicitly requested stage; do not recreate current valid artifacts merely to replay the list.
4. Keep one canonical feature slug and spec-package path through the run. After a worktree handoff,
   the destination package is canonical.
5. Maintain one compact stage ledger with `pending`, `running`, `complete`, or `blocked` status,
   the canonical checkout, worker/session IDs, decisions, revision-bound evidence references,
   unresolved findings, and the next action. Update it at material handoffs and give concise
   progress updates. Keep any harness goal objective short and stable; reference the ledger and
   spec package instead of expanding the objective with execution history.

After continuation or compaction, reconcile the ledger with current artifacts and Git state before
resuming. Reopen settled decisions only when new evidence invalidates them.

If multiple feature packages or goals match and repository evidence cannot disambiguate them, stop
with the exact ambiguity. Do not choose by modification time.

## Resolve The Starting Stage

Use the architecture workflow and resume from the earliest stage that does not already have current,
valid output:

- **Feature goal:** run `spec-architect-initial`, optionally `spec-architect-critics`, then
  `spec-write`.
- **Existing proposal:** begin with the optional critique decision, then run `spec-write`.
- **Existing spec:** when current `spec.md`, `spec-steps.json`, and `evidence-plan.json` exist,
  begin with their earliest invalid or incomplete downstream stage.

Run an optional critique when the user requests it, the proposal recommends it, or the change is
materially cross-cutting, security-sensitive, data-sensitive, dependency-heavy, irreversible, or
architecturally novel.

## Delegate With Compact Handoffs

When delegation is authorized, use existing stage and prepared-step boundaries. Preserve sequential
steps, dedicated step workers, commit boundaries, and independent reviewer separation. Before
delegating a stage that itself requires workers, verify the harness supports the needed nesting and
tool access; otherwise retain that stage's coordination locally.

Give each worker the canonical checkout and spec paths, assigned stage or step, owning skill path,
required constraints, and return contract. Require it to read and follow the owning skill in full.
Reference accessible documents instead of copying them unless the dispatch contract requires exact
text. Do not assume workers inherit the parent conversation.

Keep investigation, implementation, verification, and routine repair with the assigned worker under
the owning skill's rules. Preserve its permitted checkpoint outcomes and escalation policy. Resume
the same worker for follow-up within that assignment when supported. Coordinate at handoffs,
blockers, or cross-stage decisions; use completion notifications or blocking task calls when
available instead of routine status polling or duplicating the worker's work.

Keep full required reports and logs in canonical artifacts. Request a conversational handoff of
about 200 words containing outcome, assigned unit, changed-file summary, checkout and tested
revision, verification results and evidence paths, gaps, and decisions needed. Expand for mandatory
report fields or material issues; brevity never hides failures or replaces required artifacts.

## Execute The Pipeline

Before each stage, read that sibling skill's `SKILL.md` completely and follow it as the authority
for the stage. Execute these stages in order, skipping only current valid stages or optional stages
excluded by the routing policy above:

1. Run `spec-architect-initial` when a current proposal does not already exist.
2. Run `spec-architect-critics` when the optional critique policy applies.
3. Run `spec-write`.
4. Run `spec-prepare`.
5. Establish the implementation checkout directly as top-level orchestration work. Honor an
   explicit branch/worktree directive, reuse a clearly matching checkout when present, and use
   ordinary Git judgment otherwise. Read [workspace-handoff.md](references/workspace-handoff.md)
   before creating or reusing a worktree. Do not invoke a branch-management skill merely to run
   commands a capable agent already knows how to run.
6. Run `spec-run` from the implementation checkout. It owns prepared step implementation,
   per-step commits, evidence production, and pre-audit merge-evidence assembly.
7. Run `spec-branch-refine`. It owns the independent review/fix loop and must finish with an audit
   pass plus `evidence_verdict: proven` bound to current HEAD.
8. Run `spec-work-tour`. It owns the final JSON/HTML evidence and deployment verdict and must
   finish with `verdict: ready` bound to the same HEAD.
9. Run `spec-pr` from the same checkout and publish the pull request.

After every stage, inspect its declared outputs and outcome against the owning skill's handoff
contract. A worker's success assertion is insufficient: check required evidence and revision
bindings. Preserve all required reads, checks, independent audits, and integration verification;
do not add a duplicate implementation review or rerun verification merely to repeat worker
evidence. Expand inspection for missing, inconsistent, stale, or risk-bearing evidence.

Never convert `blocked` into success or continue past a failed gate. Preserve intermediate
checkpoint outcomes where the owning skill permits them. If a stage invalidates an earlier
artifact, return to the owning stage, refresh it, and then resume the ordered pipeline.

## Worktree Ownership

The top-level agent decides how to operate in a selected worktree. It may set tool working
directories explicitly, continue locally, or delegate later stages when authorized. Do not open an
editor, create a new editor window, start a replacement agent session, or install a continuation
hook as part of worktree setup.

Treat the selected worktree as the execution root for every later stage. Re-read checkout-local
instructions there and never write subsequent artifacts back to the source checkout's inert
handoff copy.

## Completion

Complete only when `spec-pr` reports the published PR URL and the branch evidence remains bound to
the published HEAD. Return a compact summary containing:

```txt
outcome: published | blocked
start: goal | proposal | spec | prepared
feature: <slug>
checkout: <absolute repository or worktree path>
stages: <completed stages>
pr: <url | none>
blocker: <none | exact stage and reason>
```

Do not treat local implementation, passing tests, a ready work tour, a pushed branch, or a draft PR
without the requested publication outcome as end-to-end completion.
