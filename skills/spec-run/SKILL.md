---
name: spec-run
description: "Implement every step from a standalone .specs package while escalating only unresolved consequential decisions. Use when the user asks to run or execute a prepared spec. Treat prepared subspecs as launchpads, preserve reviewable checkpoint commits, continue through imperfect results, review each finished step in the background and fix its findings between steps, and leave integration review and final checks to branch refinement."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[.specs/<feature>/spec.md or spec folder]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "29"
---

# Spec Run

Apply [Verification and Review](../../rules/verification-and-review.md) for CI/operator ownership
and batched Jev verification/review-triage checkpoints.

Execute the package produced by `spec-write` within its sourced context and authority. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Preparation is immutable intent and evidence provenance; implementation may adapt to repository reality, but it may not execute against stale or mismatched prepared inputs.

Run steps sequentially. Dispatch one dedicated implementation agent per step when the harness supports subagents; otherwise follow `spec-step-run` directly for one step at a time. Do not batch steps or commits.

Set an explicit run deadline on every step-worker launch; never rely on the harness default, which can be as short as 30 minutes and interrupts larger or visual steps mid-edit. Use about 2 hours per step unless the run records a different budget. When the harness supports it, also request a checkpoint before the deadline (about 10 minutes) so the worker commits coherent work and records a `checkpoint` outcome instead of timing out with uncommitted changes. Pi `pi-subagents` launches take `timeoutMs: 7200000` and `checkpointBeforeDeadlineMs: 600000`. Record the chosen budget in the run ledger, and treat a deadline hit as an interruption to resume, not a step failure.

When the end-to-end handoff includes an overseer mailbox, follow its
[routing contract](../spec-end-to-end/references/overseer-inbox.md). The top-level
coordinator owns intake; this stage routes received archived message paths to the
active or next addressed worker. Continue ordinary steps without parent approval.
Include unresolved message outcomes in the stage handoff. When delegated, do not
consume inbox files or write the top-level ledger. When the top-level coordinator
runs this stage locally, it retains its existing intake ownership. A direct invocation does not create another consumer.

Read the Assembly, Tour, And Publication section of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
Carry rule-to-proof links, ordinary-entry observations, and accepted deferred-work briefs from
step learnings into merge evidence. Keep current unmet obligations in Gaps. Do not edit immutable
prepared scope; route consequential changes for correction and re-preparation.

## Resolve The Prepared Package

Resolve an explicit `.specs/<feature>/spec.md` or `.specs/<feature>/` argument first, then the folder named in the conversation or `Spec folder:` footer. If exactly one prepared `.specs/*/spec.md` exists, use it. Do not ask for confirmation; choose the strongest title/footer/context match. Return `no-artifact` only when no intended package can be identified.

Read:

- sibling `context.md`, current project context, `spec.md`, `spec-steps.json`, and `evidence-plan.json`;
- sibling `spec-prepare.md` and `preparation.json`;
- the subspec index and manifest bindings; workers read their assigned subspecs in full;
- optional bound `criteria.md` and `invariants.md`;
- applicable rule paths, existing blockers, and prior learning paths in
  `<spec-dir>/learnings/` (or historical root-level files). Read outcome and evidence
  fields when scheduling or assembling evidence; leave relevance scanning to the worker.

## Inspect Preparation

Before touching production code, inspect the strict version 3 preparation manifest. Recompute and compare lowercase SHA-256 hashes for `context.md`, `spec.md`, `spec-steps.json`, `evidence-plan.json`, `spec-prepare.md`, every declared subspec, and optional criteria/invariants. Require evidence-plan version 2, then confirm its context path/hash matches this package's context and manifest.
Confirm exactly one `ready` subspec exists for every indexed step and evidence ownership matches all three sources.

Repeat validation before every step dispatch. A missing, invalid, stale, incomplete, or partially published package blocks further implementation: report the exact mismatch and require `spec-write` to republish. Never repair preparation during `spec-run`. Already committed step artifacts remain intact.

## Preserve Preparation As Evidence

Keep prepared subspecs immutable as historical inputs. Neither the orchestrator nor an implementation agent rewrites them during execution, but expected targets and edit sequence may adapt within the sourced context and applicable
acceptance obligations. Changed intent or proof requires correction and re-preparation.

Do not invoke a separate planner or implementation judge. The shared Jev checkpoints
are advisory scheduling/triage calls and are permitted; they neither plan the step nor
replace its independent review. Step reviews and fixes run outside the step worker under [Background Step Review](#background-step-review); they do not change what a worker does. Let `spec-step-run` use repository evidence and best engineering judgment to add files, tests, commands, repairs, integration work, or work expected in a later step when that produces a more coherent outcome. Ordinary implementation departures belong in the learning. Consequential context, authority,
or risk changes return to the coordinator as `decision-required`; resolve them under the shared
contract before dependent work and re-prepare when intent or proof changes.

## Execute One Step At A Time

For each indexed step in ascending order:

1. Revalidate the preparation package and record, but do not gate on, resolvable drift.
2. Run any pending step fixes and wait for them to finish (see Background Step Review).
3. Provide the absolute code checkout, canonical target subspec path, owning skill path, and any routed message paths or new run-wide constraints. The worker resolves the step and package from the subspec and scans prior learnings plus completed step review/fix records under `spec-step-run`. Do not restate the technical brief or curate a parallel copy of the requirements.
4. Require the agent to read and follow `~/.agents/skills/spec-step-run/SKILL.md` in full.
5. Wait for that step to produce a learning and any reviewable commit. Run mechanical verification,
   launch the background review for the new commits, and continue. When publication is already
   authorized, push meaningful coherent checkpoints and create/update a draft through
   `spec-pr mode=draft` so CI runs alongside the remaining work. Otherwise retain them locally.

The worker reads risk lenses from the card and applies the execution-time boundary expansion and pre-commit risk audit from `spec-step-run`; do not duplicate those instructions in the dispatch. When the harness exposes a reasoning-effort control, prefer elevated reasoning for `persistence-integrity`, `atomic-publication`, `concurrency`, `lease-or-refcount`, `cancellation`, `cross-step-contract`, and `security-boundary`; the absence of such a control does not block execution.

`spec-step-run` owns implementation, test writing, focused unit/integration feedback,
required runtime/visual observations, deferred final-check handoffs, the step learning, staging the coherent artifact, and the conventional step
commit for `as-specified`, `adapted`, or `checkpoint` work. When repository policy requires generated
output separately, preserve that commit and the deliberate change commit within the same step;
the learning lists both and binds evidence to final step HEAD. The orchestrator does not
second-guess the implementation before final branch refinement.

## Mechanical Verification

After each step returns, verify only the execution contract from its learning and
referenced artifact/commit metadata. The following are checks of recorded outcomes,
not a second code review or a reason to reread every subspec. Ask the worker to repair
missing or contradictory records; leave substantive correctness to branch review:

1. Changed and staged files form a coherent repository-local artifact and exclude unrelated user changes and spec artifacts.
2. Useful tests were written, affected unit/boundary checks and required visual/runtime observations have actual results, and remaining final checks have honest pending handoffs.
3. Scheduling adaptations to older cards are recorded; no red/green evidence is fabricated.
4. Commands had finite enforced deadlines; timeouts terminated owned processes and were recorded with elapsed time as failed attempts.
5. Repeated attempts name an affected change or concrete diagnostic reason; passing results were reused across step sections.
6. The learning record exists at `<spec-dir>/learnings/step-<NNN>-learning.md`, and a commit exists for `as-specified`, `adapted`, or `checkpoint`.
7. Risk-tagged steps include a learning risk-audit summary that covers or explicitly dismisses every declared risk lens and live invariant.
8. Runtime-facing steps include a complete production-reachability summary: entrypoint/composition owner, concrete internal adapter, real downstream contract, and focused path observation, including applicable ordinary-entry evidence without test-only prerequisites.
9. An implementation-complete outcome does not contradict its own discrepancies/risks by describing required production wiring, an internal adapter, a downstream contract, or the promised user-observable path as absent, fake-only, deferred, or unreachable.
10. Steps whose card carries `Evidence:` lines produced each merge artifact — in the commit or under `.specs/<feature>/evidence/` — or truthfully
   recorded the gap. Automated execution artifacts deferred to CI or branch review are expected
   pending handoffs and do not alone require checkpoint. Later-phase gates have concrete procedures/handoffs and honest statuses. Safe isolated
   pre-deploy checks may run; live operations awaiting a release or authority stay `pending`.

For an unresolved consequential decision or required spec correction, preserve that outcome and
route it before dependent work. Otherwise, if item 9 or 10 fails, require the truthful outcome `checkpoint` rather than accepting `as-specified` or `adapted`. Preserve the commit and dispatch the next step with that evidence.

Do not rerun commands merely to duplicate the implementer's evidence. Carry scope, command, preparation, and verification mismatches forward as findings. Continue after `checkpoint` and, when later work remains meaningful, after `no-artifact`; do not ask the user whether to proceed with already-authorized work. Route a
`decision-required` result to the coordinator and `needs-spec-correction` to its owning planner; never count affected work complete while its
consequential decision remains unresolved.

## Background Step Review

Review each finished step while the next one is being implemented, so the branch review
only has to cover integration, duplication, and final checks. As in branch refinement,
the reviewer and fixer are separate agents that communicate only through review and fix
files. This coordinator schedules them and reads verdicts. It does not review code itself.

The agent that dispatches step workers owns these launches. If it cannot launch
subagents, skip this section. Branch review then reviews every commit itself.

**Launch a review after each step.** Once a step passes mechanical verification, launch
one background reviewer for the commits from the previous review's `head` (or the branch
base for the first review) to current HEAD. That range includes any step-fix commits
made since the previous review. The reviewer needs to read files, run `git`, and write to
the canonical spec folder, and it must not edit code. Require it to read
`~/.agents/skills/spec-branch-review/SKILL.md` and follow Step Scope with
`scope=step step=<NNN> since=<sha> head=<full HEAD sha>`. Pass the checkout, the spec
folder, and the model assigned to step review. Don't wait for it: it reads fixed commits,
so the next step worker can edit the checkout while it runs. Reviews may overlap.

**Record results.** When a reviewer finishes, read only the leading `review:` YAML block
of its file: verdict, actionable count, and signatures. Do not read its prose or copy
findings into prompts. Record the run ID, range, and verdict in the ledger.

**Fix between steps.** The fix owner applies Jev review-triage once to each actionable
findings set before deciding repairs; the coordinator does not duplicate that call.
Before dispatching the next step, take each completed step review
with `verdict: needs-fix` and no `step-<NNN>-fix.md`, oldest first. Run
`spec-branch-fix review=<spec-dir>/reviews/step-<NNN>-review.md` and wait for it to
finish. Only one agent writes to the checkout at a time, so never run a fixer alongside a
step worker. If a later step review raises a signature again after an earlier step fix
marked it `fixed`, pass it as a terminalize instruction, as `spec-branch-refine` does.
Fix commits become part of the next review's range. Route a fixer's `decision-required`
or `needs-spec-correction` the same way as a step's. Handle a review that is still
running at the next step boundary rather than waiting for it.

**Failures.** If a reviewer fails or times out, record it, relaunch it once, and
continue. Commits that are still unreviewed are left for the branch review.

**After the last step.** Wait for running reviews, then run any pending step fixes
before the Completion Gate. The branch review covers fix commits made after the last
step review. Report `step-review-coverage: complete` when step reviews cover every
step's commits, `partial` when some are uncovered, and `none` when no review ran.

**In Pi.** Launch reviewers and fixers as async single-agent `subagent` runs with an
explicit `cwd`. Pi's builtin `reviewer` agent has no `bash` or `write` tool, so it
cannot write a step review; use `delegate` or a project review profile that has
`read`, `bash`, and `write`, and state the no-edit rule in the task. Pass the role's
assigned model as `model` (`provider/id[:thinking]`); otherwise the agent default
applies. Give reviews `timeoutMs: 2700000`. Give fixers the step-worker budget and
`checkpointBeforeDeadlineMs`. Don't call `bg_wait` for reviewers, because Pi wakes the
parent when a child completes. After a resume, check
`subagent({ action: "status" })` against the ledger's run IDs before relaunching.

## Completion Gate

After all indexed steps have run and the step reviews and fixes have finished, map each acceptance criterion and claim to its commits and verification results, each Executable Evidence Plan gate (`EV-n`) to its produced artifact, and each pre-mortem item (`PM-n`) to its implemented disposition. Record missing coverage for final refinement; do not hide gaps or discard useful commits.

Assemble focused results and remaining automated commands, test files, setup, expected
results, and output paths for branch review, deduplicating shared commands. Preserve the
observed revisions and assess applicability after later changes. Do not duplicate worker
checks in this coordinator or dispatch a final testing step; configured CI owns broad
checks, while absent CI leaves operator testing outside agent evidence without blocking
completion. Branch review consumes actual results and closes focused acceptance/failure gaps. Keep actual automated/smoke results distinct from unexecuted gates.

Then atomically write both `.specs/<feature>/merge-evidence.md` and version 2 `.specs/<feature>/merge-evidence.json`. These are the pre-audit evidence assembly bound to the exact current HEAD; final readiness still requires independent branch audit/refinement and a work tour.

The Markdown begins with a level-1 heading and contains:

- **What was built** — one paragraph plus the commit list.
- **Right problem** — each acceptance criterion mapped to the requirement it serves and the commits/tests covering it.
- **Correct** — the verification evidence: exact commands and outcomes from step learnings, test files added, smoke observations, and automated commands deferred to review.
- **Safe** — each pre-mortem item with its implemented disposition; residual accepted risks stated plainly.
- **Evidence index** — each EV item with claim/failure mapping, exact command, environment, artifact, status, observed result, proof boundary, and bound commit.
- **QA tour input** — deterministic entrypoints, fixtures, scenarios, expected results, automated EV coverage, captures, and optional exploration-only questions. No required manual QA.
- **Gaps** — missing coverage, unproduced evidence, and open findings carried to final refinement.

`merge-evidence.json` binds `context.md` by path/hash, mirrors every CL/FH/EV item and its phase from `evidence-plan.json`, adds actual statuses, commands/outcomes/artifacts/proof boundaries, step commits, QA inputs, separate deployment readiness/authority/observations, merge gaps and later-phase gaps, and the full current `commit`. Use `readyForAudit: true` only when every required merge gate passed and later-phase procedures are honestly recorded; this is not the deploy verdict.

State gaps honestly. Finish this stage with `outcome: ready-for-refinement` when every indexed step
has been dispatched and both merge-evidence files are bound to current HEAD. Do not run
`spec-branch-refine` or `spec-work-tour`; they are separate top-level stages so their outcomes remain
visible and independently resumable.

## Report

Report the spec and preparation manifest, every step result, exact commands/outcomes,
criterion/claim/failure/gate coverage, both merge-evidence paths, current HEAD, step
review and fix paths with their fix commits, `step-review-coverage` and any unreviewed
commits, and remaining gaps/risks. End with `next: spec-branch-refine`. Do not claim an audit or deployment verdict, write
work-tour/GitHub artifacts, or add attribution.
