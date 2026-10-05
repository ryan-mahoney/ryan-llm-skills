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
  version: "30"
---

# Spec Run

Apply [Verification and Review](../../rules/verification-and-review.md) for CI/operator ownership
and batched Jev verification/review-triage checkpoints.

Execute the package produced by `spec-write` within its sourced context and authority. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Prepared inputs record accepted intent; implementation may adapt to repository reality while preserving acceptance and authority.

Run steps sequentially with a retained implementation session. In Pi, dispatch
`spec-step-owner`, explicitly authorizing it to direct one `spec-step-editor` under
[Paired execution](../spec-step-run/references/paired-execution.md). Resume that owner
across related steps. Keep separate objectives and commits; session reuse does not
batch steps. Reviewers remain independent and fixers run only between steps.

On harnesses without nested agents, retain one direct implementation worker where
resumption is supported, or follow `spec-step-run` locally. Honor explicit model/mode
directives. In Pi, profile/model setup failures require diagnosis, not an unannounced
switch to a different model or execution mode.

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

Read the shared context, spec/index, evidence plan, and preparation outcome once.
Workers consume their assigned cards and applicable criteria/invariants. Use the history
index for prior results instead of rescanning all learning and review prose.

## Check Structural Readiness

Before first dispatch, require the context, spec/index, evidence plan, and exactly one
ready card per indexed step. Check matching step IDs, owned evidence, and concrete
verification contracts. Use the evidence-plan validator for its schema when needed.
Missing or contradictory inputs return to `spec-write`; never invent a technical brief
to compensate. Preserve completed code and resume after the actual gap is resolved.

Do not compute hashes or require `preparation.json`. Ignore obsolete hash fields in
legacy packages. Do not repeat the package check on every dispatch; check the next
card and revisit structure only after re-preparation or an observed contradiction.

## History Index

Build the index before first dispatch and after each completed step or fix:

```bash
node ~/.agents/skills/spec-run/scripts/build-history-index.mjs --spec-dir <canonical-spec-dir>
```

The generated `history-index.json` points to canonical learning/review/fix records,
including historical root-level learnings. It preserves navigation to unresolved or
unknown records without deciding that a defect is fixed. Pass the path, not its contents.
If generation fails, report the input problem and use original records for affected
history; never interpret failure as an empty history or reuse a stale index as current.

## Preserve Preparation As Evidence

Keep prepared subspecs immutable as historical inputs. Neither the orchestrator nor an implementation agent rewrites them during execution, but expected targets and edit sequence may adapt within the sourced context and applicable
acceptance obligations. Changed intent or proof requires correction and re-preparation.

Do not invoke a separate planner or implementation judge. The shared Jev checkpoints
are advisory scheduling/triage calls and are permitted; they neither plan the step nor
replace its independent review. Step reviews and fixes run outside the step worker under [Background Step Review](#background-step-review); they do not change what a worker does. Let `spec-step-run` use repository evidence and best engineering judgment to add files, tests, commands, repairs, integration work, or work expected in a later step when that produces a more coherent outcome. Ordinary implementation departures belong in the learning. Consequential context, authority,
or risk changes return to the coordinator as `decision-required`; resolve them under the shared
contract before dependent work and re-prepare when intent or proof changes.

## Execute One Step At A Time

On resume, reconcile the ledger with canonical learning records and Git commits in
the selected checkout. Reuse completed `as-specified`/`adapted` steps whose recorded
commits and acceptance evidence still apply; a filename alone does not prove completion.
Resume interrupted/checkpoint work when its gap is still owned by that step, or carry
the explicit later-owner handoff forward. Do not replay completed steps or reviews.

For each remaining assigned step in ascending order:

1. Wait for the prior implementation assignment and its editor to finish. Run completed
   review fixes before assigning the next step; never overlap writers.
2. Refresh the history index. Supply the checkout, canonical next-card path, index path,
   newly routed messages/constraints, and any intervening fix commits. Do not restate
   the technical brief or the skill. Require affected source refresh after external fixes.
3. Launch the owner once with its assigned model, explicit `cwd`, `context: "fresh"`,
   and the deadline above. In Pi, authorize one nested editor explicitly. Thereafter use
   `subagent({ action: "resume", id: "<latest-owner-run-id>", message: "<next assignment>" })`.
   Track the latest owner and editor IDs in the existing ledger: resume may return new IDs.
4. After interruption, check the exact known ID using `action: "status"`. Resume only
   an inactive eligible worker. If retention is unavailable, record that reason and
   restore a fresh same-role worker from canonical inputs after confirming no writer
   remains active. Reset for demonstrated context confusion or an explicit model change,
   not simply at a step boundary. Do not silently change a stored model contract.
5. Consume the learning and commit, perform the completion check below, launch its
   independent background review, and continue. Within publication authority, push useful
   coherent checkpoints through `spec-pr mode=draft` so CI runs alongside remaining work.

Read `spec-step-run` once per implementation session and reload only changed guidance.
The prepared card owns planned verification; execution expands it for a concrete new
failure or gap, not for a risk-label checklist. Keep the owner responsible for decisions
and the editor responsible for execution; do not add another implementation judge.

`spec-step-run` owns implementation, test writing, focused unit/integration feedback,
required runtime/visual observations, deferred final-check handoffs, the step learning, staging the coherent artifact, and the conventional step
commit for `as-specified`, `adapted`, or `checkpoint` work. When repository policy requires generated
output separately, preserve that commit and the deliberate change commit within the same step;
the learning lists both and binds evidence to final step HEAD. The orchestrator does not
second-guess the implementation before final branch refinement.

## Completion Check

Read the returned outcome, learning path, and commit. Confirm the record exists, the
commit belongs to the selected checkout, and required evidence is present or honestly
pending. Derive progress from those records rather than requesting a second report.
Do not review the code again, rerun worker checks, require new tests by count, or require
positive risk/correctness narratives. Stop substantive checking once the record is
consistent; independent review owns defect detection.

A claimed complete step cannot also report missing required implementation, unreachable
promised behavior, or failed required focused/visual evidence. Ask for a truthful
`checkpoint` outcome and retain useful work. Route `decision-required` or
`needs-spec-correction` before dependent work. Continue other meaningful steps within
existing authority, carrying unresolved gaps to final refinement.

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
of its file: verdict and finding identities. Derive actionable counts from
`findings[].actionable`; explanations remain in the review for the fixer. Accept the
review skill's legacy format on resumed runs. Do not copy findings into prompts. Record the run ID, range, and verdict in the ledger.

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
observed revisions as `observedCommit` and record `applicability` when reusing a result
for a different candidate `commit`. Do not duplicate worker
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

`merge-evidence.json` identifies `context.md` by canonical path, mirrors every CL/FH/EV item and its phase from `evidence-plan.json`, adds actual statuses, commands/outcomes/artifacts/proof boundaries, step commits, QA inputs, separate deployment readiness/authority/observations, merge gaps and later-phase gaps, and the full current `commit`. Use `readyForAudit: true` only when every required merge gate passed and later-phase procedures are honestly recorded; this is not the deploy verdict.

State gaps honestly. Finish this stage with `outcome: ready-for-refinement` when every indexed step
has been dispatched and both merge-evidence files are bound to current HEAD. Do not run
`spec-branch-refine` or `spec-work-tour`; they are separate top-level stages so their outcomes remain
visible and independently resumable.

## Report

Return outcome, merge-evidence paths, current HEAD, step-review coverage, retained owner
and editor IDs, and unresolved decisions or gaps. Keep step results and commands in the
indexed records. End with `next: spec-branch-refine`; do not claim an audit/deploy verdict
or produce work-tour/GitHub artifacts in this stage.
