# Managed changeset writing

This contract governs new managed `spec-end-to-end` assignments and their review
and repair stages. It supersedes instructions that permit direct source editing,
ordinary editing subagents, editor commit packets, or unrestricted verification
commands. An already active run without `writing_route: changeset-v1` retains its
recorded legacy contract until it drains. Do not relabel its earlier edits.

## Ownership and planning

The step owner retains behavioral decisions, diagnosis, focused verification, and
acceptance. Difficulty routing and explicit owner/fix overrides remain unchanged.
Write planning always uses the exact configured `strong_owner_model`. New editing
assignments require that binding. A single-model run can explicitly assign the same
selector to both owner roles. Never infer the planner from the coordinator or editor.

- A default owner calls `spec_editor(assignment: <bounded change>)`. The runtime
  launches STRONG_OWNER with read-only discovery and the canonical step/stage context.
- An owner whose exact selector equals STRONG_OWNER can call `spec_editor(plan: <JSON>)`.
  Reuse its discovery. The runtime rejects a plan submitted under another selector.
- The plan declares operations, dependencies, source excerpts, and owned files.
  EDITOR_MODEL returns bounded V4A/JSON changes without tools or filesystem access.
- The runtime validates, stages, and publishes the batch. Source hashes include
  actual dirty bytes. A stale input or failed operation prevents publication.
- A planner gets one correction for an invalid plan. A transport/configuration
  failure is not a planning correction. Neither failure authorizes direct editing.

Do not send the full specification, raw test output, or review transcript to writers.
The owner diagnoses those observations and requests a specific correction through
the same entry point. Writers receive only the current bounded operation and source.

Use the selected lean route: hybrid V4A/JSON, seeded source moves, integrity/fidelity
checks, deterministic dependency handling, and up to eight concurrent operations.
Only a seam/fidelity failure permits the configured same-model retry. The measured
`:off` route permits a `:low` retry; other explicit thinking settings are retained.
Behavioral repair remains with the outer workflow. Jev verification and review-triage
checkpoints remain; writing-route advice is omitted.

## Verification, generation, and commits

Use `spec_verify(command, timeout, outputs?)` for focused checks and diagnostics.
Source is read-only on the Linux execution host. `outputs` names ignored directories
that contain no tracked source. Package evidence and an isolated temporary directory
are writable. A missing enforcement capability is an explicit failure, not permission
to run an unrestricted shell. Server commands use the same boundary.

Source-changing formatters and generators go through `spec_editor`. STRONG_OWNER
can declare `executor: generated` with `generator: {argv: [...]}`, declared inputs,
outputs, and dependencies. The runtime executes the existing repository command on
isolated staged source. Only declared text outputs can reach the publisher. Include
the command's scripts, configurations, and source dependencies as reads. No shell,
inline implementation, or agent command is permitted as a generator. Exact source
copy/move/delete operations can be mechanical; authored source text uses EDITOR_MODEL.

After assessing the diff and required evidence, use `spec_commit(message)`.
Inspect the complete message against the diff first. Commits include only published
changesets. Overlapping pre-existing edits or staged changes require reconciliation.
Source stays read-only during commits and hooks. A source-changing hook must use the
staged generation pathway. The runtime checks the committed parent, paths, modes,
and bytes against the published changes. A mismatch retains a reconciliation receipt
and prevents completion. Commit does not grant push or merge authority.

## Reviews and later repairs

Native wave reviewers and fixers retain their existing lifecycle and model selection.
The fixer owns triage and verification, but its edits use the same strong-planner and
editor service. It cannot edit source directly or restore files after an unfinished
packet. A failed batch leaves source unchanged; accepted earlier batches remain.

For serial stages, use `spec_stage` after the prior run drains:

```text
package: <canonical package>
prior_run_id: <recorded prior run>
assignment_id: <new stable attempt ID>
kind: review | review-fix | branch-fix | final-review | conflict-resolution
owner_model: <assigned reviewer or fix owner>
strong_owner_model: <recorded STRONG_OWNER>
editor_model: <recorded editor or explicit final-stage override>
base: <actual comparison base>
head: <full pinned review SHA; required for independent review>
review_path: <source review for review-fix or branch-fix>
packet_index: <canonical fix packet, default 1>
report_path: reviews/<assigned-report>.md
instructions: <owning skill, source records, review budget, scope, and authority>
```

`kind: review` uses a detached checkout at the pinned commit and the read-only
independent reviewer with `spec_stage_complete`. It can overlap the next serial step
without reading that step's dirty source.
Confirmation can supply `round` and `fix_path`. Fix stages use the native fixer and
`spec_stage_complete`, preserving the existing fix YAML, pending finding IDs, and
packet sequence. Final-review and conflict stages use a managed decision owner and
`spec_report`. This covers step fixes, trailing final-fix review repairs,
explicit branch refinement, optional final review, and conflict resolutions. Use
the real canonical step for context; do not fabricate a step card. Final review
requires the explicit FINAL_REVIEWER selector and preserves its assessment budget.
Do not launch ordinary final editors or implementation workers through `subagent`.

The decision owner records its assigned report through `spec_report`. Runtime facts
bind the report to the actual HEAD, selectors, and verification receipts. The report
is an assessment, not another independent post-fix review or a publication receipt.

## Coordinator operations

Once this coordinator owns a changeset run, direct write tools, generic shell tools,
and unmanaged subagents are unavailable. Use `spec_command` for bounded artifact or
infrastructure commands after workers drain. It requires the package and prior run
ID and enforces read-only source. This permits evidence/tour generation in the
canonical package without authoring implementation.

Use `spec_git` for authorized fetch, safe push, rebase, continue, or abort operations.
Supply the package, prior run ID, and explicit remote/branch/base where applicable.
The tool grants no publication authority. Rebase is a trusted deterministic Git
operation; substantive conflict edits still require a managed changeset.

For a conflict, launch `spec_stage(kind: conflict-resolution)`. Publish the resolved
source through `spec_editor`, then submit a checkpoint report that names the pending
Git continuation. Do not create a normal fix commit or restore the conflicted files.
After the stage drains, the coordinator uses `spec_git(action: continue)` with that
stage's run ID. The runtime stages only conflict paths matching its published edits.
Refresh affected evidence and route substantive changes through the existing review
process. A failed Git command never means the source is ready.

Other harnesses require an adapter to this service and capability contract. A direct
worker that can write code is not an equivalent fallback. Report the missing adapter.

## Telemetry and observation

Every invocation has an `edit_id` under `runtime/runs/<run-id>-edits/<edit-id>/`.
It records the request, planning attempts and corrections, raw/validated plans,
source hashes, writer requests/responses, operation results, candidate, publication,
and terminal summary. Full source and payloads remain in private local artifacts.
The shared event stream contains identifiers, selectors, outcomes, and measurements.

Events have schema version, edit/run/workflow/wave identity, sequence, timestamp,
trace elapsed time, and separate stage durations. Missing usage and cost remain
unknown. In-owner planning has no separately measured planning duration; inspect
the native owner session for that work. Never report it as zero-cost planning.

`/spec-metrics <package-ref>` includes a separate `changesets` section with per-edit
stage timing and model/cost coverage. Planner usage can overlap native session metrics;
do not add those totals. An applied or published edit is not verified acceptance.
Failed, cancelled, running, uncertain-publication, and observation-error states remain
visible. Inspect the named operation/call receipt for a specific failure; do not replay
an edit merely to reconstruct telemetry.

After instruction/profile changes run `sync.sh`. Restart an idle Pi session to load
runtime changes. Do not restart an active worker or migrate its contract in place.
