---
name: spec-end-to-end
description: "Run the complete standalone spec-driven workflow from a feature goal or existing .specs package through architecture, specification, preparation, branch or worktree setup, implementation, evidence refinement, work tour, and a published pull request. Use when the user says \"do the spec workflow end to end\", \"take this from idea to PR\", \"run the whole spec process\", \"finish this spec and open a PR\", or asks for the full workflow with modifiers such as a named subagent or worktree."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "14"
---

# Spec End To End

Apply [Verification and Review](../../rules/verification-and-review.md) for CI/operator ownership
and batched Jev verification/review-triage checkpoints.

Own one continuous run from the user's goal to a published pull request. Compose the sibling spec
skills; do not reimplement their stage logic. Continue autonomously until `spec-pr` returns a PR URL
with the requested readiness, or a stage produces a concrete blocker. An early draft starts
CI but does not end the run. This workflow ends at publication; merge, deployment,
and production verification remain separate actions under existing authority.

## Engineering Decision Handoffs

Read [Engineering Decisions Through The Standalone Workflow](../spec-work-tour/references/standalone-engineering-decisions.md).
Carry domain rules and concrete counterexamples from architecture into AC/CL/FH/EV evidence;
carry accepted deferred work into the final tour and PR. Use existing stage artifacts and verdicts.
Stage owners check rule coverage, ordinary-entry proof, and scope limits. The parent
checks the returned outcome, artifact locations, revision bindings, and unresolved decisions;
it does not repeat the stage's substantive review. Stage owners assess resumed
packages by material coverage, not new headings or a blanket artifact rewrite. Follow the combined planning stage below.

## Preserve User Directives

Treat workflow modifiers in the request as run-wide constraints. Examples include:

- use or avoid a worktree;
- keep work in the current checkout;
- delegate named stages to a named subagent or agent type;
- include or skip the optional architecture critique;
- assign a model or provider to a role such as step implementation, step review, step
  fix, branch review, or branch fix;
- target a specific base branch, repository, feature package, or PR shape.

Record role model assignments in the ledger as exact `provider/id[:thinking]` values
and pass each one on every launch for that role. In Pi, check the IDs once with
`subagent({ action: "models" })` before implementation. Unassigned roles use Pi's
agent and settings defaults.

Honor explicit directives over the defaults below. Use delegation only when the user requests it,
a leaf skill requires it, or the active harness instructions independently require it. The
top-level agent retains orchestration ownership: verify every delegated handoff and decide whether
the next stage may proceed.

## Resolve The Run

1. Resolve the repository root and read all applicable `AGENTS.md` files.
2. Read [Project Context And Authority](references/project-context.md). Resolve the project context
   and write or validate the feature's sourced `context.md` snapshot before architecture. Ask only
   unresolved consequential questions; continue independent local work. Existing packages must
   acquire this context before resuming. Record user decisions once for reuse across specs.
3. Resolve the goal, existing `.specs/<feature>/` package, and any implementation branch or
   worktree from the request and repository state.
4. Inspect existing pipeline artifacts. Resume at the earliest incomplete, stale, invalid, or
   explicitly requested stage; do not recreate current valid artifacts merely to replay the list.
5. Keep one canonical feature slug and spec-package path in the primary repository through the
   run. Apply [Workspace Handoff](references/workspace-handoff.md) before resolving paths. A
   worktree changes the code execution root, never the location of `.specs/`.
6. Maintain one compact stage ledger with `pending`, `running`, `complete`, or `blocked` status,
   the code checkout and primary-repository spec path, worker/session IDs, decisions, revision-bound evidence references,
   unresolved findings, consequential decisions/authority sources, and the next action. Update it at material handoffs and give concise
   progress updates. Keep any harness goal objective short and stable; reference the ledger and
   spec package instead of expanding the objective with execution history.

After continuation or compaction, reconcile the ledger with current artifacts and Git state before
resuming. Reopen settled decisions only when new evidence invalidates them.

If multiple feature packages or goals match and repository evidence cannot disambiguate them, stop
with the exact ambiguity. Do not choose by modification time.

## Receive Overseer Messages

Before implementation begins, read [Overseer Inbox](references/overseer-inbox.md).
Initialize the canonical feature's `inbox/` and `processed/` folders and record the
run ID and paths in the ledger. Messages arrive during implementation and review,
never during planning. The parent owns intake and routing; addressed workers own
interpretation and action. Pass archived message paths without translating their
technical content. Check during available waits and stage handoffs, then reconcile
pending deliveries before publication. Do not require parent acknowledgment at each
step or review iteration. File delivery does not wake a stopped agent.

## Resolve The Starting Stage

Use the architecture workflow and resume from the earliest stage that does not already have current,
valid output:

- **Feature goal:** run `spec-architect-initial`, optionally `spec-architect-critics`, then
  `spec-write`.
- **Existing proposal:** begin with the optional critique decision, then run `spec-write`.
- **Existing spec:** run `spec-write` to complete or refresh planning when cards or the
  preparation manifest are missing, stale, or explicitly selected for re-planning. Reuse
  a valid prepared package and begin at its earliest incomplete downstream stage.

For a legacy package, preserve its accepted behavior, resolve the sourced context, and use
`spec-write` once to upgrade and prepare the existing package. Do not replay
architecture solely because artifact versions changed; revisit only decisions invalidated by facts.

Run an optional critique when the user requests it, the proposal recommends it, or the change is
materially cross-cutting, security-sensitive, data-sensitive, dependency-heavy, irreversible, or
architecturally novel in the resolved context. A file type or maturity label alone is not a trigger.

## Delegate With Compact Handoffs

When delegation is authorized, use existing stage and prepared-step boundaries. Preserve sequential
steps, dedicated step workers, commit boundaries, and independent reviewer separation. Before
delegating a stage that itself requires workers, verify the harness supports the needed nesting and
tool access; otherwise retain that stage's coordination locally.

Select agents by required capabilities before dispatch, not by names such as
"reviewer" or "explorer". The branch-review stage owner must read the checkout and
canonical spec package, execute required verification commands, and write review
and evidence artifacts in the primary repository's spec folder. A restriction on
editing implementation code does not mean the stage can use a filesystem-read-only
agent. Check the harness's declared tools and writable roots before assignment;
if unclear, resolve that capability gap before starting substantial review work.
Use a capable general-purpose agent with the review role's code-edit prohibition
when available. Analysis-only reviewers may assist with scoped findings, but cannot
own the whole stage. If an explicitly requested agent type lacks a required capability,
surface that mismatch rather than silently substituting it or having the parent
transcribe its output to complete the stage.

Give each stage coordinator the canonical checkout and spec-package paths, assigned
stage, owning skill path, run-wide constraints, and completion return contract. When
delegation is requested, delegate whole implementation and refinement stages when
the harness supports their workers; the parent need not manage every implementation
step or review iteration. In Pi, run `spec-run` in the top-level agent. It launches
step workers, background step reviewers, and step fixers, and a Pi child can launch
subagents only when the parent grants it fanout and the `subagent` tool.

For an implementation worker, pass the checkout, canonical subspec path, owning
skill path, and paths to any newly routed messages. The subspec and its referenced
package are the technical handoff. Workers load requirements, context, rules,
evidence obligations, and prior learnings in `learnings/` (or historical root-level
files) themselves. Do not copy step text or
reconstruct those documents in prompts. Missing or contradictory prepared inputs
return to their owner; the parent does not compensate with an improvised technical
brief. Preserve explicit user constraints not already captured in the package.

Keep investigation, implementation, verification, and routine repair with the assigned worker under
the owning skill's rules. Preserve its permitted checkpoint outcomes and escalation policy. Resume
the same worker for follow-up within that assignment when supported. Coordinate at handoffs,
blockers, consequential check-ins, or cross-stage decisions; use completion notifications or blocking task calls when
available instead of routine status polling or duplicating the worker's work.

Keep full required reports and logs in canonical artifacts. Request a conversational handoff of
about 200 words containing outcome, assigned unit, changed-file summary, checkout and tested
revision, verification results and evidence paths, gaps, and decisions needed. Expand for mandatory
report fields or material issues; brevity never hides failures or replaces required artifacts.

## Execute The Pipeline

For a delegated stage, require its owner to read and follow the sibling skill in full;
the parent need not also load its implementation instructions. Read that skill in full
when executing the stage locally. Use the routing and completion contracts below to
coordinate delegated work. Execute these stages in order, skipping only current valid stages or optional stages
excluded by the routing policy above:

1. Run `spec-architect-initial` when a current proposal does not already exist.
2. Run `spec-architect-critics` when the optional critique policy applies.
3. Run `spec-write` once through both internal phases. Require `outcome: prepared`,
   granular ready execution cards, and the current hash-bound `preparation.json`.
4. Establish the implementation checkout directly as top-level orchestration work. Honor an
   explicit branch/worktree directive, reuse a clearly matching checkout when present, and use
   ordinary Git judgment otherwise. Read [workspace-handoff.md](references/workspace-handoff.md)
   before creating or reusing a worktree. Do not invoke a branch-management skill merely to run
   commands a capable agent already knows how to run.
5. Run `spec-run` from the implementation checkout. It owns prepared step implementation,
   per-step commits, background step reviews and the fixes between steps, evidence
   production, and pre-audit merge-evidence assembly. This run's PR scope authorizes early
   draft publication at the first meaningful coherent checkpoint and subsequent useful pushes;
   apply `spec-pr mode=draft` without waiting for final local regression or a ready tour.
6. By default, run `spec-branch-refine max-iterations=1` when `spec-run` reports
   `step-review-coverage: complete`, and `max-iterations=2` otherwise. One round is a
   review and its fix, with no further review. The branch review reuses step reviews,
   so that round covers unreviewed commits, cross-step integration, duplication, and the
   required gates while reusing CI-owned broad-suite results. Collect relevant CI for the
   final pushed commit before final readiness when CI is configured. Without CI, broad
   testing is operator-managed outside agent evidence and does not block completion.
   Do not duplicate broad suites locally.
   Honor an explicit user limit instead. Accept `proven`
   or `verified-at-cap` only with the completion record and passing required evidence
   bound to current HEAD; preserve the final fixes' review status honestly. Carry the
   round budget through resumption, tour, and publication; downstream stages must not
   reset it or start another refinement loop.
7. Run `spec-work-tour`. It owns the final JSON/HTML evidence and separate release states and must
   finish with merge `verdict: ready` bound to the same HEAD. Deployment readiness, authority,
   and post-deployment observations are separate; pending later-phase gates do not force execution.
8. Run `spec-pr mode=ready` from the same checkout to update the draft after final-commit
   configured required CI passes and acceptance/review gaps close. Without CI, broad
   operator testing remains outside recorded evidence and is not a completion blocker.
   Preserve an explicit request for draft-only
   publication; report its remaining readiness limits honestly.

After every stage, check the returned outcome, required artifact existence, relevant
revision bindings, unresolved decisions, and next stage. Inspect the declared
completion record rather than relying on a conversational success assertion. Stage
owners validate detailed preparation and evidence; the independent reviewer owns
correctness and proof assessment. Do not reread every subspec, inspect source code,
or rerun tests to reconstruct those judgments. Ask the same owner to repair a
missing or contradictory handoff. Investigate further only for a concrete mismatch,
stale record, explicit escalation, or newly identified risk. Preserve the selected
review budget and bounded-completion policy across handoffs.

Resolve worker `decision-required` outcomes at the top level using the shared context contract.
Do not ask users to review specs or code. Surface the concrete consequential choice and preserve
already-authorized work. Never infer permission from a gate or broaden a release process to pass it.

Never convert `blocked` into success or continue past a failed required gate for the current phase. A later-phase failure that disproves
a merge claim is also a merge blocker; merely pending authorized release work is not. Preserve intermediate
checkpoint outcomes where the owning skill permits them. If a stage invalidates an earlier
artifact, return to the owning stage, refresh it, and then resume the ordered pipeline.

## Worktree Ownership

The top-level agent decides how to operate in a selected worktree. It may set tool working
directories explicitly, continue locally, or delegate later stages when authorized. Do not open an
editor, create a new editor window, start a replacement agent session, or install a continuation
hook as part of worktree setup.

Treat the selected worktree as the execution root for code, Git, builds, and tests. Re-read
checkout-local instructions there. Read and write every `.specs/` artifact in the primary
repository, including logs and tour outputs. Pass both absolute roots to every worker. Ignore
any `.specs/` copy in the worktree, including one created by checking out tracked files.

## Completion

Complete only when `spec-pr` reports the published PR URL and the branch evidence remains bound to
the published HEAD. Return a compact summary containing:

```txt
outcome: published | blocked
start: goal | proposal | spec | prepared
feature: <slug>
checkout: <absolute repository or worktree path>
spec-folder: <absolute feature path in the primary repository>
stages: <completed stages>
pr: <url | none>
blocker: <none | exact stage and reason>
deployment: <ready | blocked | not-assessed | not-applicable>
authorization: <not-requested | required | granted | not-applicable>
post-deploy: <not-run | passed | failed | not-applicable>
```

Do not treat local implementation, passing tests, a ready work tour, a pushed branch, or a draft PR
without the requested publication outcome as end-to-end completion.
