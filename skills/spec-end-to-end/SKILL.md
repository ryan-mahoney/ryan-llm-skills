---
name: spec-end-to-end
description: "Run the complete standalone spec-driven workflow from a feature goal or existing .specs package through architecture, specification, preparation, branch or worktree setup, implementation and step review/fix cycles, evidence assembly, work tour, and a published pull request. Use when the user says \"do the spec workflow end to end\", \"take this from idea to PR\", \"run the whole spec process\", \"finish this spec and open a PR\", or asks for the full workflow with modifiers such as a named subagent or worktree."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "20"
---

# Spec End To End

## Standing Run Defaults

For a prepared Pi run, reuse its recorded branch/worktree and completed work; create
an isolated branch/worktree only when none is assigned. Resume the first unfinished
obligation from current receipts and the ledger, including outstanding review or fixes.
Use configured difficulty routing and retained owner/editor pairs through the managed
Pi runtime. `REVIEW_AGENT` selects independent step reviews; `SCOUT_AGENT` selects
optional bounded source discovery for owners and reviewers. Reuse deterministic fact,
history and rendering helpers. The owner calls `spec_advice` at shared Jev checkpoints;
use the installed Mercury clerk only for useful bounded prose transformation under
the compact-delegation contract below. These are defaults, not instructions that a
user must repeat in every prompt. Explicit model and run directives take precedence.

An invocation requesting continuation through PR publication authorizes ordinary
task-owned commits, safe pushes and PR creation/update within that outcome. Reuse
that authority; ask only for a consequential unresolved decision or action outside
the request. Complete independent step review/fix cycles and required evidence, then
publish. No final branch review or merge is automatic.

## Prepared Pi entry

For an explicitly prepared package after `spec-write`, read applicable `AGENTS.md`
and honor user directives, then call `spec_dispatch action=startup` with `package`,
`owner_model` (DEFAULT_OWNER/IMPLEMENT_AGENT), `editor_model`, and optional
`strong_owner_model`, `scout_model`, checkout/branch/base and step override.
Omit `step` on first entry. `owner_override` pins a selected step's owner.
This route takes precedence over the general startup reading sequence below.

The runtime resolves canonical paths, uses the prepared index, routes hard steps,
creates/reuses the checkout, acquires the writer lease and starts the pair in one call.
It returns pending inbox messages or existing progress instead of replaying work.
On resume, consume that receipt and only the ledger/history entries needed to resolve
its next obligation. A completed worker still needs its independent review/fix cycle.
Pass an explicit `step` after reconciliation; a retry needs a new `assignment_id`.
Preserve the recorded owner on an interrupted step with `owner_override`.

In managed Pi, reuse the existing stage-ledger run ID as the checkpoint `workflow_id`.
Register it with `spec_checkpoint` before dispatch: supply the stable obligation key for
this stage, the current checkpoint revision, the current native input revision, declared
native workers, and per-original ID/hash/outcome inbox references. Pass that same
`workflow_id` to `spec_dispatch`; it validates the registered owner and binds the real
dispatch receipt to it. Consume returned checkpoint revisions and a terminal
`reconcile:<assignment-id>` obligation as pending acceptance/review work, never as
completion. The handwritten stage ledger remains the fallback only outside managed Pi;
do not keep a second ledger inside it.

Trust the receipt's mechanical checks for that launch. Do not re-check Git paths,
leases, model availability, installed profiles or nesting without a specific error
or changed input. Owners read their card and applicable implementation policy.
The coordinator loads review guidance when scheduling review, and assembly/tour/PR
references at those stages. Do not pre-read scouting, paired-execution internals,
architecture, publication or efficiency references to launch prepared work.
Required repository rules and unresolved authority, inbox holds and known failures
still apply. Preparation gaps go back to preparation; no blanket revalidation or
reclassification of an already prepared package.


Apply [Verification and Review](../../rules/verification-and-review.md) for CI/operator ownership
and batched Jev verification/review-triage checkpoints.

Own one continuous run from the user's goal to a published pull request. Compose the sibling spec
skills; do not reimplement their stage logic. Continue autonomously until `spec-pr` returns a PR URL
with the requested readiness, or a stage produces a concrete blocker. An early draft starts
CI but does not end the run. This workflow ends at publication; merge, deployment,
and production verification remain separate actions under existing authority.

## Continue Through The Authorized Outcome

A harness goal is optional. Do not create one or change goal settings unless requested.
Keep the requested outcome and next action in the existing stage ledger; do not add
a second task list or rewrite the objective at every handoff.

When a stage returns, assess its handoff and perform the next authorized action in
the same turn. A plan, commit, passing check, stage checkpoint, tour, or early draft
is progress, not a reason to offer to continue or ask for routine permission. A worker
checkpoint returns control to the coordinator: resolve its question, route a concrete
repair, or advance when the owning skill permits it.

While a worker is active, do only independent authorized coordination. When none
remains, yield to its completion event or use the harness's blocking wait. Record the
worker ID and pending action once; do not produce repeated "waiting" turns, poll via
shell commands, or infer completion from silence. On completion, consume the handoff
and continue. Instructions do not create a wake mechanism: if the harness supplies
neither completion events nor blocking waits, leave an explicit resumable checkpoint
with the worker reference and next action rather than claiming unattended continuation.

In managed Pi, checkpoint at existing stage handoffs and before a legitimate blocked or
yield return, not per tool call and not by polling. Reuse the current `workflow_id` and
revision from the prior `spec_checkpoint`/`spec_dispatch` receipt; record the new stage's
stable obligation key, the current input revision, declared native workers and hash-bound
inbox outcomes. A returned `reconcile:<assignment-id>` obligation is pending
acceptance/review work, never completion; a process exit does not grant acceptance.

Treat an actionable failure as work to diagnose and route within the existing retry,
review and authority limits. Repeating an unchanged failed action is not progress.
Stop dependent work only for a concrete missing decision, authority, input or external
dependency, or an exhausted owning-stage budget. Complete independent authorized work
and report the exact blocker, attempted recovery and action needed to resume. Never
weaken acceptance, bypass a required gate or reset a budget to keep going.

Respect a user pause or cancellation immediately. Otherwise end the run only at its
requested verified outcome or an explicit unresolved blocker; an event wait remains
in progress. On resumption, take the next action from the ledger and current receipts
without replaying completed stages.

## Engineering Decision Handoffs

When planning or assembling final evidence, read [Engineering Decisions Through The Standalone Workflow](../spec-work-tour/references/standalone-engineering-decisions.md).
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
- assign a model or provider to a role such as step owner, step editor, step implementation, step review, step
  fix, branch review, or branch fix;
- target a specific base branch, repository, feature package, or PR shape.

Record role model assignments in the ledger as exact `provider/id[:thinking]` values
and pass each one on every launch for that role. Preserve explicit provider/model
selectors and resolve known role names directly; do not enumerate or test all models
and agents before implementation. Actual launch validates availability. Use discovery
only for an ambiguous selector or a concrete launch error, without silently substituting
a model. The Pi step editor defaults to `openrouter/inception/mercury-2.5:high`; other
unassigned roles use agent/settings defaults. A legacy step-implementation assignment
selects the capable owner model; an explicit editor assignment overrides Mercury.
Record owner/editor models separately.

Accept `DEFAULT_OWNER` (or legacy `IMPLEMENT_AGENT`) and optional `STRONG_OWNER`
assignments. Supplying a stronger owner enables difficulty routing for implementation
steps under [Step owner routing](../spec-run/references/owner-routing.md). Pass these
assignments and any explicit step overrides to `spec-run`; it owns selection and
escalation. Without a stronger assignment, preserve single-owner execution. Routing
does not change the models assigned to editors, reviewers, or review fixers.

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
6. In the managed Pi runtime, use `runtime/progress.json` as the generated workflow ledger.
   Worker lifecycle, verification receipts, canonical handoffs and review/fix artifact arrivals
   are recorded automatically. Use `spec_checkpoint` for stage status, material decisions,
   authority/hold references and next action; reference canonical artifacts instead of repeating
   their contents. Do not also maintain a duplicate handwritten ledger. Preserve any existing
   legacy ledger as a historical source and carry its unresolved obligations forward.
   Outside the managed runtime, maintain one compact stage ledger with `pending`, `running`, `complete`, or `blocked` status,
   the code checkout and primary-repository spec path, worker/session IDs, decisions, revision-bound evidence references,
   unresolved findings, consequential decisions/authority sources, and the next action. Update it at material handoffs and give concise
   progress updates. Keep any harness goal objective short and stable; reference the ledger and
   spec package instead of expanding the objective with execution history.

Managed Pi injects a concise state-derived reminder before model calls, including after
compaction; it starts no extra turns. Use the named receipts to resolve gaps rather than
reloading all procedure files. After continuation or compaction, reconcile the ledger with current artifacts and Git state before
resuming. Reopen settled decisions only when new evidence invalidates them.

If multiple feature packages or goals match and repository evidence cannot disambiguate them, stop
with the exact ambiguity. Do not choose by modification time.

## Receive Overseer Messages

For non-runtime startup or when the runtime reports pending messages, read [Overseer Inbox](references/overseer-inbox.md).
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
  required prepared inputs are missing, contradictory, or explicitly selected for re-planning. Reuse
  a valid prepared package and begin at its earliest incomplete downstream stage.

For a legacy package, preserve its accepted behavior, resolve the sourced context, and use
`spec-write` once to upgrade and prepare the existing package. Do not replay
architecture solely because artifact versions changed; revisit only decisions invalidated by facts.

Run an optional critique when the user requests it, the proposal recommends it, or the change is
materially cross-cutting, security-sensitive, data-sensitive, dependency-heavy, irreversible, or
architecturally novel in the resolved context. A file type or maturity label alone is not a trigger.

## Delegate With Compact Handoffs

When delegation is authorized, use existing stage and prepared-step boundaries. Preserve sequential
steps, retained implementation sessions per selected owner, commit boundaries, and independent reviewer separation.
Use known harness capabilities and installed role contracts without a startup probe.
Investigate nesting or tool access only after a concrete dispatch error; on a harness
known to lack nesting, retain that stage's coordination locally.

Use known role profiles with the tools the stage needs. Do not probe every profile
before dispatch. The independent review stage owner must read the checkout and
canonical spec package, execute required verification commands, and write review
and evidence artifacts in the primary repository's spec folder. A restriction on
editing implementation code does not mean the stage can use a filesystem-read-only
agent. Resolve a genuinely unknown capability contract when selecting a profile;
known installed profiles need no repeated capability audit.
In Pi, use `spec-stage-reviewer` with the explicit REVIEW_AGENT model. Its allowlist
includes both Pi tools and provider-adapter command/patch replacements; keep the
provider extension available in the child. On other harnesses use a capable
general-purpose agent with the review role's code-edit prohibition when available. Analysis-only reviewers may assist with scoped findings, but cannot
own the whole stage. If an explicitly requested agent type lacks a required capability,
diagnose that launch's tool/profile configuration while preserving the requested model.
Do not probe unrelated providers or substitute an explicitly selected model unless the
user supplied a fallback or approves the change. Announcing a substitution does not
authorize it. If the requested route remains unavailable, checkpoint that stage with
the concrete failure; do not claim the model itself lacks the capability or have the
parent transcribe its output to complete the stage.

When a clerical task needs a helper, consult `~/.agents/docs/spec-workflow-efficiency.md` for existing deterministic helpers
instead of reconstructing their work in prompts. An optional Pi `spec-clerk` subagent
can draft concise prose from explicitly supplied approved facts when this saves a
substantial writing pass. It uses Mercury by default, read-only tools, fresh context,
and a one-minute deadline. The coordinator assesses its draft before use; no mandatory
clerk, startup probe, engineering decisions or publication authority is added.

Give each stage coordinator the canonical checkout and spec-package paths, assigned
stage, owning skill path, run-wide constraints, and completion return contract. When
delegation is requested, delegate whole implementation and refinement stages when
the harness supports their workers; the parent need not manage every implementation
step or review iteration. In Pi, run `spec-run` in the top-level agent. It launches
retained owner/editor disk sessions through the repo-owned `spec_dispatch` and
synchronous `spec_editor` tools, plus independent background step reviewers and fixers.
Do not launch implementation pairs through nested `pi-subagents`. For manual dispatch or paired-execution recovery, use the installed profiles and [paired execution contract](../spec-step-run/references/paired-execution.md).
Only the editor writes implementation code while the pair is active.

For an implementation worker, pass the checkout, canonical subspec path, owning
skill path, and paths to any newly routed messages. The subspec and its referenced
package are the technical handoff. Supply the generated history-index path and
intervening fix commits; retained workers load only relevant original records and
refresh affected source. Do not copy step text or
reconstruct those documents in prompts. Missing or contradictory prepared inputs
return to their owner; the parent does not compensate with an improvised technical
brief. Preserve explicit user constraints not already captured in the package.

Keep investigation, implementation, verification, and routine repair with the assigned worker under
the owning skill's rules. Preserve its permitted checkpoint outcomes and escalation policy. Resume
the matching implementation owner/editor across its assigned steps when supported. Coordinate at handoffs,
blockers, consequential check-ins, or cross-stage decisions; use completion notifications or blocking task calls when
available instead of routine status polling or duplicating the worker's work.

Keep full required reports and logs in canonical artifacts. Request a conversational handoff of
only outcome, artifact paths, code revision, retained worker IDs, and unresolved
decisions or gaps. Do not repeat command lists, findings, or completed work narratives
already present in canonical records.

## Execute The Pipeline

For a delegated stage, require its owner to read and follow the sibling skill in full;
the parent need not also load its implementation instructions. Read that skill in full
when executing the stage locally. Use the routing and completion contracts below to
coordinate delegated work. Execute these stages in order, skipping only current valid stages or optional stages
excluded by the routing policy above:

1. Run `spec-architect-initial` when a current proposal does not already exist.
2. Run `spec-architect-critics` when the optional critique policy applies.
3. Run `spec-write` once through both internal phases. Require `outcome: prepared`,
   granular ready execution cards and consistent required package inputs. Preparation
   hashes and `preparation.json` are not prerequisites; reuse usable legacy cards.
4. Proceed from prepared handoff to the first editor assignment with only canonical
   path/context resolution and required readiness checks. Do not audit known model
   capabilities, run baseline broad checks, pre-read later-stage skills, or generate an
   orchestration workflow. In Pi, `spec_dispatch` can create the isolated worktree when
   checkout is omitted. Otherwise establish the implementation checkout directly as top-level orchestration work. Honor an
   explicit branch/worktree directive, reuse a clearly matching checkout when present, and use
   ordinary Git judgment otherwise. Read [workspace-handoff.md](references/workspace-handoff.md)
   before creating or reusing a worktree. Do not invoke a branch-management skill merely to run
   commands a capable agent already knows how to run.
5. Run `spec-run` from the implementation checkout. It owns prepared step implementation,
   per-step commits, background step reviews and the fixes between steps, evidence
   production, and merge-evidence assembly. This run's PR scope authorizes early
   draft publication at the first meaningful coherent checkpoint and subsequent useful pushes;
   apply `spec-pr mode=draft` without waiting for final local regression or a ready tour.
6. After the last step's independent review and fixes finish, apply `spec-pr`'s
   **Rebase Safely** procedure before final evidence/tour assembly. Refresh only affected
   evidence; route substantive conflict changes or uncovered implementation back to the
   owning step's review/fix cycle. Reuse unchanged reviewed work and original review ranges.
   Push every coherent task-owned commit, including final fixes, and collect configured
   required CI on the final candidate. Without CI, broad testing remains operator-managed
   outside agent evidence and does not block completion.
7. Run `spec-work-tour` from the completed step-review/fix records and current merge evidence.
   Require merge `verdict: ready` at current HEAD; deployment readiness, authority, and
   post-deployment observations remain separate. No final branch review is automatic.
   Invoke `spec-branch-refine` only for an explicit user request or sourced project requirement;
   a `REVIEW_AGENT` assignment, missing branch audit, or legacy default is not such a request.
   Preserve any explicitly selected refinement budget through resume and publication.
8. Run `spec-pr mode=ready` to publish/update the PR after applicable required CI and known
   acceptance/review gaps close. Reuse current step completion, evidence, and tour; do not
   add a review during publication or resume. Push all remaining task-owned commits and
   verify the remote HEAD matches. Preserve draft-only requests and keep unresolved required
   evidence honest in a draft. The operator/organization chooses subsequent PR review and
   merge; this workflow never merges automatically.

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

Complete only when `spec-pr` reports the published PR URL at the requested readiness
and the branch evidence remains bound to the published HEAD. Reconcile this run's
known worker and command IDs using completion receipts or a targeted status check;
required work must be finished and no run-owned worker or required command may still
be active. Retained inactive sessions are fine. Do not sweep unrelated processes,
add another code review, or rerun checks to establish this lifecycle state.

During finalization, report the remaining action plainly, such as "Required CI is
pending" or "Tour generated; publishing the PR." A tour-stage handoff is progress,
not the user-facing completion response. Deliver the final tour link with the verified
PR outcome after the run is quiescent. Return a compact summary containing:

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
