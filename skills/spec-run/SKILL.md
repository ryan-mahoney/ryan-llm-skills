---
name: spec-run
description: "Implement every step from a standalone spec package while escalating only unresolved consequential decisions. Use when the user asks to run or execute a prepared spec. Treat prepared subspecs as launchpads, preserve reviewable checkpoint commits, continue through imperfect results, review each finished step in the background and fix its findings between steps, and hand completed step review/fix cycles and evidence to publication without an automatic final branch review. Run a concurrency-ready package as managed dependency waves."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[workspace/slug or spec package folder]"
license: MIT
metadata:
  version: "38"
---

# Spec Run

## Context budget

Use [context management](../../pi/extensions/context-budget/README.md). Keep the
coordinator on progress, decisions, review outcomes and artifact pointers; leave source
investigation and implementation history in the assigned worker. Read references only
for the current stage. Give each fresh worker its relevant contracts, current decisions,
source paths, preservation constraints and stop rule; never copy the whole parent chat.
Use bounded searches and source ranges; keep full logs and reports in artifacts. Native
compaction is a backstop and must preserve pending obligations and evidence revisions.
An oversized-request stop is not permission to retry the same payload: recover from
canonical artifacts in a fresh session, preserving checkout changes and writer locks.

## Prepared Pi startup

Use the [prepared Pi entry](../spec-end-to-end/SKILL.md#prepared-pi-entry):
`spec_dispatch action=startup` resolves and launches prepared work in one call.
Pass the default/strong owners and optional explicit override; use recorded tiers,
without another Jev difficulty call. Runtime receipts replace repeated mechanical
startup checks. Existing progress returns for bounded ledger/review reconciliation;
worker completion never waives review or required fixes. This route supersedes the
manual structural-readiness and first history-index build below. Preparation already
owns full package validation; the runtime checks required input paths and index shape.
Load the detailed reference for the stage you are doing, not every linked reference
before dispatch. The owner consumes implementation/evidence policy; the coordinator
reads the background-review section before scheduling its first review.

## Connection interruptions

Connection errors, WebSocket failures and provider timeouts are transport observations,
not evidence that step difficulty or model capability was misclassified. Preserve the
checkout, retained sessions, model assignments and existing evidence. Let an in-flight
provider retry finish; never launch a competing worker. After a terminal transport
failure and confirmed coordinator exit, allow at most one coordinator retry with a new
attempt ID and the same owner/editor, resuming the current diff and outstanding work.
If it fails again, record the connection blocker and resume after recovery; do not
reset budgets, replay completed edits or promote models to repair connectivity.
The whole-step deadline remains a safety bound, not a network-health diagnosis.


Apply [Verification and Review](../../rules/verification-and-review.md) for focused-check scheduling
and batched Jev verification/review-triage checkpoints.

Execute the package produced by `spec-write` within its sourced context and authority. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Prepared inputs record accepted intent; implementation may adapt to repository reality while preserving acceptance and authority.

On the serial path, run steps sequentially with a retained implementation session. On the wave path, follow [Run Managed Waves](#run-managed-waves). In Pi, use the
repo-owned `spec_dispatch` runtime and synchronous owner-side `spec_editor` under
[Paired execution](../spec-step-run/references/paired-execution.md). Reuse its disk sessions
across related steps. Keep separate objectives and commits; session reuse does not
batch steps. Reviewers remain independent and fixers run only between steps.

Use the assigned default owner unless the run supplies a stronger owner or explicit
step overrides. In that case, read [Step owner routing](references/owner-routing.md)
and select at dispatch time; retain a separate session for each selected owner model.

For a concrete discovery gap worth delegating, use [Optional Pi scouting](references/scouting.md)
with the installed scout profile and Luna. Coordinator, owner and reviewer can request
scouting; it is not a startup gate or a replacement for direct source reads. Pass the
run's SCOUT_AGENT as `spec_dispatch.scout_model` and in reviewer assignments.

On harnesses without nested agents, retain one direct implementation worker where
resumption is supported, or follow `spec-step-run` locally. Honor explicit model/mode
directives. In Pi, profile/model setup failures require diagnosis, not an unannounced
switch to a different model or execution mode.

Set an explicit run deadline on every step-worker launch; never rely on the harness default, which can be as short as 30 minutes and interrupts larger or visual steps mid-edit. Use about 2 hours per step unless the run records a different budget. When the harness supports it, also request a checkpoint before the deadline (about 10 minutes) so the worker commits coherent work and records a `checkpoint` outcome instead of timing out with uncommitted changes. For Pi, pass `timeout_ms: 7200000` to `spec_dispatch` unless the run records another budget; the runtime cancels live process groups at that deadline. Do not add nested subagent launch options. Record the chosen budget in the run ledger, and treat a deadline hit as an interruption to resume, not a step failure.

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

Run the first step of [Spec Location](../spec-end-to-end/references/spec-location.md): `spec-location check` on an explicit `workspace/slug`, package folder, or file in one, then the package named in the conversation or the `Spec folder:` footer. Read `locations.json`; every path below comes from it. Do not ask for confirmation; choose the strongest title/footer/context match. Return `no-artifact` only when no intended package can be identified.

Reuse the just-produced `spec-write` handoff: `package_ref`, `package_dir`, shared context,
step index, owned evidence and the next ready card. Dispatch without model capability
probes, baseline broad checks, later-stage pre-reading or generated workflow files.
Workers consume their assigned cards and applicable criteria/invariants. Use the history
index for prior results instead of rescanning all learning and review prose.

## Check Structural Readiness

On the manual/non-runtime path before first dispatch, require the context, spec/index, evidence plan, and exactly one
ready card per indexed step. Check matching step IDs, owned evidence, and concrete
verification contracts. Use the evidence-plan validator for its schema when needed.
Missing or contradictory inputs return to `spec-write`; never invent a technical brief
to compensate. Preserve completed code and resume after the actual gap is resolved.

Do not compute hashes or require `preparation.json`. Ignore obsolete hash fields in
legacy packages. Do not repeat the package check on every dispatch; check the next
card and revisit structure only after re-preparation or an observed contradiction.

## History Index

The managed Pi runtime builds and refreshes history/progress on handoffs and observed
learning/review/fix changes; do not duplicate these writes. Read `runtime/progress.json`
for facts and missing handoffs. A refresh error is visible uncertainty, never empty history.
Outside that runtime, build the index before first dispatch and refresh after learning/review/fix artifacts
change. Reuse that refresh at the next dispatch; do not build it again merely to advance:

```bash
node ~/.agents/skills/spec-run/scripts/build-history-index.mjs --spec-dir <package_dir>
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

## Run Managed Waves

Run a package whose prepared steps carry wave metadata as managed dependency waves. This
section is the wave path; the serial sections below still describe ordinary sequencing,
review and fixes for their own path. Use the repo-owned `spec_dispatch` runtime with
native wave events; do not drive the run by hand.

**Entry.** Call `spec_dispatch action=startup` with `execution: auto` plus the run's owner,
strong owner, editor, `review_model` (required on the wave path), optional
`fix_model_override`, `workflow_id` and `timeout_ms`. Never pass `checkout` or
`owner_override`; the wave path refuses an owner override as `owner-override-serial-only`.
Read the returned receipt and route on its selected path:

| Signal | Action |
| --- | --- |
| Waves selected (receipt carries `wave_id`, `record_path`, `requested_width`, `admitted_width`) | Go idle and await attention events. |
| Serial selected, reason `legacy-serial` or `multiple-targets` | Follow [Execute One Step At A Time](#execute-one-step-at-a-time). |
| `needs_preparation` | Return to `spec-write` to regenerate `wave_checks`/`setup`; use `execution: serial` only on explicit operator direction. |
| `setup-required` | Report its remedy (`node ~/.agents/scripts/spec-observe/cli.mjs runtime-host setup`, run only with host-setup authority) and stop dependent dispatch. |
| Active serial run or claim conflict (`serial-run-active`, `wave-active`, `package-owned`, `package-owner-unknown`) | Reconcile the named run or owner; never start a duplicate. |
| Any other or unknown result | Report blocked with its receipt. |

**Width.** Requested width equals the ready-wave width. Admission is limited by memory,
tasks, an explicit lower operator cap (`max_parallel`, 1-16) and the
`software_ceiling: 16`. Excess members queue with a visible reason. Do not edit
pi-subagents or extension settings.

**Progress.** After startup the runtime's event handler drives implementation, review,
fix, confirmation, seal, candidate checks and promotion. Do not call `advance` to make
progress; use it only when a receipt names it after restart or replay. Do not launch wave
reviewers or fixers through `subagent`; the runtime runs native reviewer and fixer roles
with REVIEW_AGENT and the fix-owner precedence in [Background Step Review](#background-step-review).

**Attention events** (`spec-wave` messages whose JSON `kind` is `barrier-reached`,
`member-blocked`, `promotion-result` or `setup-required`): record
`spec_sentinel_checkpoint` with obligation key `wave:<wave_id>`. For a blocked member, read
its `blocking_reason` from the receipt's `members` preview (blocked members listed first)
or the record at `record_path`, and never construct a member launch. `confirmation-failed`
→ `spec_dispatch action=advance` with `wave_id`, `step`, `attempt_kind: review-repair`
and sourced `instructions`. `undeclared-write` → `advance` with `wave_id`, `step` and
`adaptations: [{path, reason}]`. Any other reason → report the member blocked with its
record. A member waiting on input is queued with reason `input-pending`: answer it through
the package inbox with the Answer A Startup Clarification sourcing rule, then call
`advance` with `wave_id` and no `step`. As built at e43500d, every wave receipt carries one
`next_action` string naming the first blocked member's route (`spec_dispatch advance
step=<n> attempt_kind=review-repair instructions=<repair>` or `spec_dispatch advance
step=<n> adaptations=[...]`, otherwise diagnose and `recover` or `advance`); follow it.
Attention messages still carry only `reason`, so take `next_action` from a `status` call
with `wave_id` when needed. As built at 89c6665, `next_action` for an open or running wave
with a member queued `input-pending` is `input-pending: consume the inbox, then advance
(step <n>; package <p>, wave <id>)` (lowest such step); blocked and repairing waves still
name the blocked route first, and other running waves read `running: await native wave
events; do not poll`.

**Holds and cancellation.** Route overseer holds as usual; holds pause admission.
`spec_dispatch action=cancel` with `wave_id` (and `step` for one member) drains before
releasing.

**Restart.** A fresh long-lived coordinator calls startup again; startup recovers the one
non-terminal wave in place and returns its receipt with `loaded: true`. Call `recover` only
when named; never launch a replacement writer while an old lifecycle is live or unknown.
As built at 89c6665, adoption keeps the record's claim-creation epoch on the package
claim, so the restarted coordinator also opens the package's later waves. With no
non-terminal wave, startup from the coordinator that holds the package claim (same
session, live PID and start time) resumes the highest integrated wave whose successor
never opened (for example after a next-wave `setup-required` outcome is repaired) instead
of returning `needs_reconciliation`. As built at 5f6a094 (C10-8 fixed), a coordinator that
died after a wave integrated and before its successor opened is resumed by the next
session's startup when the package claim still names the record's token, creation epoch
and session and the record's stored coordinator `process_identity` (valid pid and start
time) is observed dead for that exact pid: startup adopts it through the existing
`recover` path with its continuation deferred (claims rebound, process identity repaired,
no member relaunched; an expired wave deadline does not block an integrated record), then
opens the successor under the supplied `workflow_id`. A live or unconfirmed other owner is
never adopted, and startup then returns `needs_reconciliation`; report it blocked with the
record and never start wave 1 again. As built at 9bcf62d, a workspace assignment launch or
relaunch for the package (`launchAssignment`/`createAssignmentRelaunch` ->
`scripts/workspaces/worker-guard.mjs` `assertNoAssignmentWorkers`) is refused with code
`run-active` and a `reason` while any non-terminal wave's coordinator is alive
(`coordinator-live`) or unconfirmed (`coordinator-unknown`), while any run record's
`service`/`command_service` unit without a confirmed `phase_drain` is populated
(`worker-live`, detail = unit) or unclassifiable (`worker-unknown`), or when a wave record
is unreadable or `runtime/waves` is a symbolic link or not a directory (`record-invalid`,
5f6a094). A confirmed `runtime/runs/<id>-phase-drain.json` receipt is not re-inspected, so
a drained phase does not block relaunch after a reboot (5f6a094). The message names the
wave, step and unit and suggests `systemctl --user status <unit>` or
`spec_dispatch recover`. Follow that message; never retry the relaunch to get past it.

**Drafts.** Push through `spec-pr mode=draft` only at an integrated barrier.

**Status.** Use `spec_dispatch action=status` with `wave_id`, and Sentinel. A sibling's
completion never makes the package idle. As built at 9bcf62d: Sentinel's snapshot has one
`waves` row per record (`wave_id, state, member_count, active_count, sealed_count,
blocked_count, queued_count, cancelled_count, omitted_count, record_path`, at most 32
listed members with active, blocked and cancelled first) and the text line `<package_ref>
· Wave <id> <state> · <n> members · <a> active · <s> sealed · <b> blocked · omitted <o>`;
each member run is a current assignment while its wave is non-terminal.
`runtime/progress.json` lists every member under `waves`.
`node ~/.agents/scripts/spec-observe/cli.mjs metrics --package <package dir>` reports
per-wave widths, `peak_observed_overlap`, phase and integration times and
`barrier_waits`; an unreadable wave record adds `{path, code: 'INVALID_WAVE_RECORD'}` to
its `errors`, and a truncated record scan adds `WAVE_RECORDS_TRUNCATED` (5f6a094). As built
at 5f6a094, Sentinel matches a candidate check phase to its wave's candidate instead of
reporting it `wave-member-unknown`.

## Execute One Step At A Time

This section is the serial path.

On resume, reconcile the ledger with canonical learning records and Git commits in
the selected checkout. Reuse completed `as-specified`/`adapted` steps whose recorded
commits and acceptance evidence still apply; a filename alone does not prove completion.
Resume interrupted/checkpoint work when its gap is still owned by that step, or carry
the explicit later-owner handoff forward. Do not replay completed steps or reviews.
Read a checkpoint's `checkpoint_reason`, `remaining_work` and `next_action` before
redispatch. For legacy handoffs, derive the action from recorded gaps and unresolved
owned gates. Assign that concrete repair, check or decision; never ask an owner only
to re-record the same completion. A ready unattempted gate belongs in the current
assignment, not a routine checkpoint. Preserve useful partial receipts and genuine
blockers, interruptions, deadlines and transfers without an automatic retry loop.

Normally select remaining assigned steps in ascending order. Before dispatch, use their prepared dependency boundaries and current producer evidence to determine which are executable. When a known outside dependency blocks the earliest step's implementation or required gate, preserve that step's ID, learning/checkpoint, acceptance obligations, and blocked/pending evidence; select only an already prepared independent step whose contracts and proof do not rely on the missing producer. Pass that exact canonical card to dispatch instead of relying on startup's first-unfinished selection. Do not renumber steps, infer dependencies beyond the prepared `requires` edges, overlap writers, or expand this package to build the outside producer.

Record the missing contract/capability, authoritative producer, availability evidence needed, blocked gates, and next reconciliation action in the existing ledger/learning. An unchanged pending prerequisite remains blocked; neither elapsed time nor another worker's exit establishes it. Do not repeat a knowingly impossible gate or use a fabricated mock/adapter as proof of an unavailable real transport. Reconcile new authoritative producer evidence before returning to dependent work. When no prepared independent work remains, report the concrete blocker and required external evidence without claiming completion.

For each selected executable step:

1. Wait for the prior implementation assignment and its editor to finish. Run completed
   review fixes before assigning the next step; never overlap writers.
2. Reuse the current history index, refreshing only after its source artifacts change.
   Supply the target checkout, next-card path, index path,
   newly routed messages/constraints, and any intervening fix commits. Do not restate
   the technical brief or the skill. Require affected source refresh after external fixes.
   Include current prerequisite results/revisions and unresolved obligations. New steps
   default to separate retained pairs (`session_scope: step`); retries retain that step's
   context. Preserve an explicit package-scope override and existing active assignments.
   Historical blockers need current contradictory evidence to override this handoff.
3. Select the owner under the run's routing policy, or use its single assigned owner.
   In Pi, invoke `spec_dispatch` with the package (`package_dir`)/card, explicit model assignments,
   and constraints. Do not pass `checkout` or `branch`; the runtime takes each target's worktree and branch from
   `locations.json` (`targets[].worktree`, `targets[].branch`) and retains owner/editor disk sessions. To use a specific
   existing worktree, record it first with `node ~/.agents/scripts/spec-location/cli.mjs worktree <package ref> <target id> <path>`.
   Use its tool schema; do not launch this pair through `subagent` or build a shell dispatch workflow.
4. Await the native completion event. After interruption, inspect the exact known runtime
   ID only to recover state. Cancel through the runtime and establish actual owner/editor
   termination before replacement, escalation or a fixer. Failed or unknown cancellation
   retains checkout ownership. Preserve working changes and accepted commits; do not
   hard-reset or replay work to reconstruct a session. On non-Pi harnesses, resume an
   inactive eligible worker or restore canonical inputs after confirming no writer remains.
5. Consume the learning and commit, perform the completion check below, launch its
   independent background review, and continue. Within publication authority, push useful
   coherent checkpoints through `spec-pr mode=draft` so the operator can follow progress.

In managed Pi, checkpoint at the existing dispatch, completion, review, fix and
publication handoffs, not per tool call and not by polling. Reuse the run ID as the
`workflow_id`: `spec_sentinel_checkpoint` records the stable implementation/review/fix/publish
obligation key, the current revision and input revision, declared native workers and
hash-bound inbox outcomes, while `spec_dispatch` carries that ID so its receipt and any
terminal `reconcile:<assignment-id>` obligation stay bound. A `reconcile:<assignment-id>`
obligation is pending review/fix work, never a completed or accepted step. Before a
legitimate blocked or yield return, checkpoint the current obligation and worker states so
the next coordinator resumes without replaying work; do not keep a second ledger inside
managed Pi.
Checkpoint artifact references are readable package paths, not content fingerprints.
Do not compute hashes for them; intentional card edits do not invalidate the reference.
Inbox outcome hashes remain a separate direction-identity contract. A dispatch receipt
with `bookkeeping_error` still identifies a real existing run: reconcile that run's
checkpoint and await it if active, never launch a replacement based on the warning.

Read `spec-step-run` once per implementation session and reload only changed guidance.
The prepared card owns planned verification; execution expands it for a concrete new
failure or gap, not for a risk-label checklist. Keep the owner responsible for decisions
and the editor responsible for execution; do not add another implementation judge.

`spec-step-run` owns implementation, test writing, focused unit/integration feedback,
required runtime/visual observations, deferred final-check handoffs, the step learning, staging the coherent artifact, and the conventional step
commit for `as-specified`, `adapted`, or `checkpoint` work. When repository policy requires generated
output separately, preserve that commit and the deliberate change commit within the same step;
the learning lists both and binds evidence to final step HEAD. The orchestrator does not
second-guess the implementation at the next stage transition.

## Completion Check

Managed receipts separate `state` (process lifecycle) from `handoff.status`. `completed` with
`handoff_incomplete` means the process exited but the canonical structured handoff is missing
or inconsistent. Preserve the commit and checks, arrange only a bounded handoff repair at a safe
worker boundary, and retain the obligation in progress. Do not keep a settled worker running or
restart implementation for paperwork. Legacy receipts remain `legacy_unchecked`; reconcile
existing records without pretending the new validator ran. `recorded` validates structure,
identity and evidence references, not implementation quality or review acceptance.

Read the returned outcome, learning path, and commit. Confirm the record exists, the
commit belongs to the selected checkout, and required evidence is present or honestly
pending. Derive progress from those records rather than requesting a second report.
Do not review the code again, rerun worker checks, require new tests by count, or require
positive risk/correctness narratives. Stop substantive checking once the record is
consistent; independent review owns defect detection.

Use `~/.agents/scripts/spec-facts/cli.mjs git --repo <checkout>` for needed Git facts;
add `--base <review-base> --head <review-head>` for an explicit comparison. Reuse the
returned snapshot when applicable. This is not another per-step prerequisite or a
substitute for evidence. See `~/.agents/docs/spec-workflow-efficiency.md` for existing
deterministic helpers; do not rebuild their logic in prompts or ad hoc shell workflows.

A claimed complete step cannot also report missing required implementation, unreachable
promised behavior, or failed required focused/visual evidence. Ask for a truthful
`checkpoint` outcome and retain useful work. Route `decision-required` or
`needs-spec-correction` before dependent work. Continue other meaningful steps within
existing authority, carrying unresolved gaps to the responsible step owner before publication.

## Answer A Startup Clarification

Recognize a `decision-required` handoff whose learning lists startup clarification gaps
with no commit or edits. Answer each gap from a sourced decision: `context.md`,
`locations.project_context`, the spec and card, prior learnings, or repository facts;
name the source with the answer. When no source settles a gap, decide it under the shared
contract's Decide, Record, Continue rule and record the decision; escalate through the
top-level `decision-required` path only when it needs authority the run lacks. When an
answer would change prepared intent or acceptance, record `needs-spec-correction` and
return to spec-write instead of redispatching. Before redispatch, honor any hold or
direction routed to this step under the overseer `inbox` contract above (the top-level
coordinator owns intake; a delegated stage does not consume inbox files) and do not
redispatch a held step until released. In managed Pi with a `workflow_id`, record
`spec_sentinel_checkpoint` against the current native input revision because the human
answer is native input. Read the prior attempt's `owner_model`, `editor_model`,
`scout_model`, `child_extensions`, `session_scope`, `timeout_ms` and `workflow_id` from
its run record (`runtime/runs/<run_id>.json`, also returned by `action: status`). Then
call `spec_dispatch` with `action: start`, the same `package` and `step`,
the recorded owner as `owner_model` or `owner_override`, the recorded `editor_model`,
`scout_model`, `child_extensions`, `session_scope` and `timeout_ms`, plus the
`workflow_id`, a new `assignment_id` such as `step-003-clarified-1`,
`attempt_kind: implementation`, and `instructions` equal to the prior direction followed by one
`Clarification: Q: <question> A: <answer> Source: <decision or file>` line per gap.
The attempt ID must be 1-128 characters of ASCII letters, digits, underscore or hyphen with no file extension.
Expect the runtime to reuse the retained owner and editor sessions because the session
key excludes `instructions`, and to refuse the old attempt ID. Record the question,
answer, source and new attempt ID in the checkpoint decisions, or in `run-ledger.md`
outside managed Pi. Allow one clarification redispatch per step for the same question;
beyond it, treat a repeated startup question as a human decision or
`needs-spec-correction`. Do not rerun `action: startup` for this: without a step it
returns `needs_reconciliation`, and with the step it dispatches under the default
step-path attempt ID with its own preamble instead of your `Clarification:` lines.

## Background Step Review

This section is the serial path; wave members are reviewed inside their own checkout before seal (see [Run Managed Waves](#run-managed-waves)).

Review each finished step while the next one is being implemented. These step review/fix
cycles are the default review process; no final integrated branch review follows. As in explicit branch refinement,
the reviewer and fixer are separate agents that communicate only through review and fix
files. This coordinator schedules them and reads verdicts. It does not review code itself.

The agent that dispatches step workers owns these launches. If it cannot launch
subagents, retain an explicit review gap and report the missing capability. Do not silently
skip step review or replace it with an automatic branch audit.

**Launch a review after each step.** Pin the review base and head to full commit SHAs
after mechanical verification at step completion, before dispatching
another writer. If review must wait for a formatting correction, record its explicit
commit separately; do not later substitute a moving `HEAD`. Identify the step commits
and intervening fixes in the review packet, with their existing decision records.
Preserve coverage of those fixes while avoiding repeated findings already resolved;
assess their effect on this step and route remaining ownership explicitly.

Once the review range is pinned, launch one background reviewer for the commits from
the previous review's `head` (or the branch base for the first review) to the pinned
step-completion head. That range includes any step-fix commits
made since the previous review. The reviewer needs to read files, run `git`, and write to
`package_dir`, and it must not edit code. Require it to read
`~/.agents/skills/spec-branch-review/SKILL.md` and follow Step Scope with
`scope=step step=<NNN> since=<pinned base sha> head=<pinned head sha>`. Pass the target checkout, `package_dir`, and the model assigned to step review. Don't wait for it: it reads fixed commits,
so the next step worker can edit the checkout while it runs. Reviews may overlap.

In the same turn, when undispatched steps remain, launch one background card refresher for the
same pinned range with the review model, following [Card Refresh](references/card-refresh.md). It
writes only to `package_dir`: the cards of undispatched steps and `reviews/step-<NNN>-consumer-review.md`.
Treat a consumer review with actionable findings like a `needs-fix` step review: its findings join
that step's fix set. Declare any path it reports in `spec-steps.json` before dispatching that step.

**Record results.** When a reviewer finishes, read only the leading `review:` YAML block
of its file: verdict and finding identities. Derive actionable counts from
`findings[].actionable`; explanations remain in the review for the fixer. Accept the
review skill's legacy format on resumed runs. Do not copy findings into prompts. Record the run ID, range, and verdict in the ledger.

**Fix between steps.** The fix owner applies Jev review-triage once to each actionable
findings set before deciding repairs; the coordinator does not duplicate that call.
Select the fix model for each reviewed step before launching its fixer. An explicit
user fix-model override takes precedence; otherwise use that step's recorded effective
owner selector, including any strong-owner selection, promotion, or per-step pin.
Use the owner of the corresponding reviewed step, not the currently running step,
editor, reviewer, or coordinator. Record the exact selector and its source in the
existing ledger and pass it explicitly on every fixer launch, retry, and resume.
Preserve all provider/model segments and the thinking suffix exactly; never shorten
or reconstruct a selector from a model basename. If the recorded owner is missing,
resolve it from that step's dispatch receipt or existing assignment before launching;
if it cannot be resolved, report the missing assignment instead of inheriting a default.
Fixers do not use cheap-first escalation, model inventory probes, or automatic fallback.
An unavailable selected model is a launch/configuration error; preserve the assignment
and diagnose it under the existing setup-error policy.
Before dispatching the next step, take each completed step review
with `verdict: needs-fix` and no complete `step-<NNN>-fix.md` (missing, or with a nonempty
`pending`), oldest first. Plan it with
`node ~/.agents/skills/spec-branch-fix/scripts/fix-packets.mjs --review <review path>`,
excluding IDs the fix file already decides. In `single` mode (at most three non-HIGH
findings in one file) run one `spec-branch-fix review=<package_dir>/reviews/step-<NNN>-review.md`
fixer. In `split` mode run one fresh fixer per packet, in order, and pass the packet text
unchanged in the task. After each packet, confirm its commit touches only the packet's files,
rerun the step's focused gate on the committed tree, and only then launch the next packet.
A packet that returns without a commit or decisions is split by finding and relaunched
fresh; never resume that session. On 2026-10-15 one fixer given seven findings landed
nothing in 39 minutes, while single-group packets landed in 2-10 minutes each.
Only one agent writes to the checkout at a time, so never run a fixer alongside a
step worker. If a later step review raises a signature again after an earlier step fix
marked it `fixed`, pass it as a terminalize instruction, as `spec-branch-refine` does.
Fix commits become part of the next review's range. Route a fixer's `decision-required`
or `needs-spec-correction` the same way as a step's. Handle a review that is still
running at the next step boundary rather than waiting for it.

**Failures.** If a reviewer fails or times out, record it, relaunch it once, and
continue independent work. If the retry also fails, report the unresolved scoped review
gap; it prevents ready status, but not a truthful draft push. Resume only missing step reviews.

**After the last step.** Wait for running reviews, then run any pending step fixes
before the Completion Gate, including fixes for the last step. Resolve every actionable
finding with a recorded fix or justified dismissal and affected focused evidence, then
run the bounded final fix review over the trailing fixes.

If run directives explicitly select branch refinement, record
`final-fix-review: deferred-to-branch-refinement` and launch nothing; refinement's first
review owns the uncovered commits. Otherwise compute `<base>..HEAD` at the current
pre-rebase HEAD, where `<base>` is the highest pinned step-review head in the ledger —
the `commit:` of the highest completed `reviews/step-<NNN>-review.md`. If no pinned
step-review head can be resolved, record a blocked scoped gap; never guess the range. An
empty range records `final-fix-review: not-needed` and dispatches no reviewer. A
non-empty range launches one `spec-branch-review` Step Scope review with
`step=final-1 since=<base> head=<HEAD>` under the **In Pi** reviewer launch rules
(profile, assigned review model, `timeoutMs: 2700000`), with no writer overlap. A
`final-1` `pass` records `final-fix-review: pass`. A `needs-fix` runs
`spec-branch-fix review=<package_dir>/reviews/final-1-review.md`; the final fixer follows
the **Fix between steps** override precedence, explicit selector passing and
missing-assignment handling, except its default owner is the recorded effective owner of
the highest-numbered indexed step.

A committed fix launches `step=final-2 since=<final-1 head> head=<HEAD>`: a `pass`
records `pass-after-fix`; a `needs-fix` records `blocked` with the remaining signatures.
A fix with `commit: none` launches no confirmation and records `pass-after-fix` when
every actionable finding is fixed or carries a supported terminal dismissal, else
`blocked`. `final-1` and `final-2` verdict in-range `fixed` decisions under Step Scope's
`fix_verdicts` rule; the fixer applies Load Prior Dismissals and the terminalize rule as
between steps.

The bound is artifact existence: at most `reviews/final-1-review.md`,
`reviews/final-1-fix.md` and `reviews/final-2-review.md`. An existing record is
consumed and never relaunched. On resume, consume the existing `final-1` review/fix
records and launch only the missing record: after a committed `final-1` fix, launch the
missing `final-2`, while a `needs-fix` `final-1` without its fix record may run that one
fixer. Treat commits beyond the last reviewed head as an
uncovered `blocked` gap only after a terminal `pass`, a `commit: none` fix or `final-2`,
never between a committed `final-1` fix and its still-missing confirmation; an uncovered
gap is never a new launch. Only a written review record consumes a review pass: a failed
or timed-out launch gets the existing single relaunch and consumes no pass, and a second
failure records `blocked`. No launch follows `final-2`. Record the run ID, range, commit
count, elapsed time and verdict of each final launch in the ledger. Report
`step-review-coverage: complete` when step reviews cover every step's commits, `partial`
when some are uncovered, and `none` when no review ran.

**In Pi.** Launch reviewers and fixers as async single-agent `subagent` runs with an
explicit `cwd`. Use the installed `spec-stage-reviewer` profile for reviews; it supports
both Pi tools and the provider adapter's command/patch replacement tools. Pi's builtin
`reviewer` is analysis-only and cannot own the artifact-writing stage. Keep the provider
extension available in the async child and state the no-code-edit rule in the task.
Use `agent: spec-step-fixer` for step fixes, with `context: fresh`, `async: true`,
an explicit checkout `cwd`, and the provider extension available. Never use the generic
read-only `worker` for a fixer. The known profile retains edit/write and apply_patch;
do not probe it before each launch. A missing tool reported at runtime is a launch
error, not authority to switch the assigned model. Pass the role's
assigned model as `model` (`provider/model[:thinking]`, preserving any additional
provider/model segments). Every fixer launch must include `model` with the selector
chosen above; omission would inherit an unrelated agent or coordinator default and
is a launch configuration defect. Keep reviewer and fixer sessions separate even
when their assigned model selectors match. Give reviews `timeoutMs: 2700000`. Give fixers the step-worker budget and
`checkpointBeforeDeadlineMs`. Don't call `bg_wait` for reviewers, because Pi wakes the
parent when a child completes. After a resume, check
`subagent({ action: "status" })` against the ledger's run IDs before relaunching.

## Completion Gate

On the wave path, the bounded final fix review range starts at the last promoted candidate head (`target.candidate_commit` of the last `integrated` wave record, as built) instead of the highest step-review head; every earlier commit is covered by member reviews and the wave integration review. Group wave-check receipts under their original gate IDs with the candidate `observedCommit` and `applicability`; never relabel member results. Return `ready-for-publication` only when every wave record is `integrated`. Promoted candidates are the reviewed boundaries; only later commits are uncovered. As built at 9bcf62d (`completion.mjs` `recordCheckpoint`), a complete `implementation` or `publication` checkpoint throws `Progress predates wave records; refresh progress before closing this stage`, `Wave records are unreadable; integrated completion cannot be established` or `Wave <id> is <state>; publication consumes only integrated canonical target heads` (any wave neither `integrated` nor `cancelled`), and `unfinishedPreparedSteps` counts a wave member finished only when it is `sealed` in its latest containing wave and that wave is `integrated`. The skill's every-record-integrated rule stays stricter than the checkpoint; name these messages when telling the coordinator what a refused checkpoint means.

After all indexed steps have run and the step reviews and fixes have finished, map each acceptance criterion and claim to its commits and verification results, each Executable Evidence Plan gate (`EV-n`) to its produced artifact, and each pre-mortem item (`PM-n`) to its implemented disposition. Route missing focused coverage to the owning step; do not hide gaps or discard useful commits.

Assemble focused results and remaining automated commands, test files, setup, expected
results, and output paths for publication, deduplicating shared commands. Preserve the
observed revisions as `observedCommit` and record `applicability` when reusing a result
for a different candidate `commit`. Do not duplicate worker
checks in this coordinator or dispatch a final testing step; broad suites belong to CI or
the operator after publication and are never collected here. The responsible step/fix owner closes concrete focused acceptance/failure gaps. Keep actual automated/smoke results distinct from unexecuted gates.

Then atomically write both `merge-evidence.md` and version 2 `merge-evidence.json` in `package_dir`. These are the evidence assembly bound to current HEAD. Record default review completion under the shared **Step Review Completion** contract; the next stage presents this evidence in a work tour, without another review.

The Markdown begins with a level-1 heading and contains:

- **What was built** — one paragraph plus the commit list.
- **Right problem** — each acceptance criterion mapped to the requirement it serves and the commits/tests covering it.
- **Correct** — the verification evidence: exact commands and outcomes from step learnings, test files added, smoke observations, and any outstanding focused commands and their responsible owner.
- **Safe** — each pre-mortem item with its implemented disposition; residual accepted risks stated plainly.
- **Evidence index** — each EV item with claim/failure mapping, exact command, environment, artifact, status, observed result, proof boundary, and bound commit.
- **QA tour input** — deterministic entrypoints, fixtures, scenarios, expected results, automated EV coverage, captures, and optional exploration-only questions. No required manual QA.
- **Gaps** — missing coverage, unproduced evidence, and open findings assigned to their step/fix owner.

`merge-evidence.json` identifies `context.md` by canonical path, mirrors every CL/FH/EV item and its phase from `evidence-plan.json`, adds actual statuses, commands/outcomes/artifacts/proof boundaries, step commits, QA inputs, separate deployment readiness/authority/observations, merge gaps and later-phase gaps, and the full current `commit`. Add `audit` with `scope: steps`, `verdict: pass`, current `commit`, and `artifact: merge-evidence.md` only when the shared Step Review Completion conditions hold and `final-fix-review` is `not-needed`, `pass`, `pass-after-fix` or `deferred-to-branch-refinement`. The Markdown includes a compact **Step review completion** section linking original review ranges, fix decisions, and affected evidence, with one row per `final-<k>` review (range, verdict, fix record) and the `final-fix-review` outcome line. Use existing records; do not create another review/report. Ignore legacy `readyForAudit` as a routing instruction.

State gaps honestly. Return `outcome: ready-for-publication` when every indexed step and
its review/fix cycle is complete and required focused evidence is current. CI status is
read once at publication and reported, never gated on. Otherwise return a truthful
`checkpoint` with the remaining scoped work; a `final-fix-review: blocked` outcome
returns `checkpoint` with the exact remaining signatures or uncovered range. Do not
invoke a tour, branch refinement, or publication here; those are separately resumable
top-level stages.

## Report

Return outcome, merge-evidence paths, current HEAD, step-review coverage,
`final-fix-review`, retained owner and editor IDs by model assignment, and unresolved
decisions or gaps. Keep step results
and commands in the indexed records. On completion, end with `next: spec-work-tour`; do not claim an audit/deploy verdict
or produce work-tour/GitHub artifacts in this stage.
