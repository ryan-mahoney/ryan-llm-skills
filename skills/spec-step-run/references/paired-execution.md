# Paired execution in Pi

Use the repo-owned `spec-runtime` extension for assigned Pi implementation pairs.
The coordinator starts an asynchronous owner with `spec_dispatch`; the owner invokes
`spec_editor` synchronously. Native `pi --print --mode json` processes reuse explicit
disk sessions. Do not use nested `pi-subagents` launches or resume IDs for implementation/editing.
Use `spec_dispatch(action: start)` with `package` (absolute canonical folder), `step`
(absolute subspec), `owner_model` and `editor_model` (`provider/id[:thinking]`). Optional
`checkout`, `branch`, `base`, `assignment_id` and `instructions` carry existing directives.
`timeout_ms` bounds the whole assignment (default `7200000`, two hours).
When exposed by the loaded tool schema, set `attempt_kind` to the actual reason:
`implementation`, `verification-continuation`,
`implementation-repair`, `review-repair`, or `launch-retry`. This is observation metadata,
not permission to retry. Before an explicit provider change, supply its known required
trusted provider extension in `child_extensions`; managed children disable discovery.
An explicit checkout is reused; omitting it creates a sibling worktree. The owner calls
`spec_editor(assignment: <bounded instructions>)`. Read the
[runtime API](../../../pi/extensions/spec-runtime/README.md) only for setup/recovery detail.
Consult the extension's tool schema for arguments; do not generate a shell orchestration
workflow or inspect installed models before trying the assigned tool. Optional
`scout_model` carries SCOUT_AGENT. The owner can call `spec_scout(task)` for bounded
read-only discovery using the installed scout profile; direct reads remain the default.
No general subagent tool is exposed to the owner or editor.

The profiles come from `pi/agents/`. The owner uses the assigned capable model; the
editor defaults to `openrouter/inception/mercury-2.5:high`. Preserve exact selectors and
explicit overrides. Diagnose actual launch failures on this route; do not silently
substitute models or providers. Non-Pi harnesses retain the direct worker route.

For an explicitly selected context experiment, `session_scope: step` retains the pair
within one canonical step and its retries, while separating it from other steps.
The default `package` preserves current session reuse. Supply a concise handoff of
dependency contracts, settled decisions, relevant evidence and unresolved obligations.
Do not switch scope mid-step or discard a live session. Compare comparable completed
steps using elapsed time, reported context/cost, repairs and independent review findings.
Change one variable at a time; lower thinking effort is a separate explicitly selected
experiment, never an automatic fallback or a reason to waive review.

## Bounded assignments

Pass the canonical package and assigned card/step, checkout when already selected,
run constraints, history-index path and intervening commits. The runtime can establish
an isolated worktree when checkout is omitted. Keep all `.specs/` access in the primary
repository. Use the prepared card as the execution plan.

Dispatch the first bounded edit once the prepared card and decisive source facts settle
its approach. Later edit details can wait until that batch returns; exhaustive step-wide
discovery is not a prerequisite. The owner retains all decisions, one writer and checks
only after the editor returns.

The owner settles behavior and architectural boundaries, while the editor chooses local
implementation details and edit strategy. Send a bounded transformation using a short
plain-text packet inside `assignment`; related functions/files can be edited together:

```text
Change: One concrete behavior or move.
Edits: Affected files/symbols and chosen approach; pseudocode only when ambiguity warrants it.
Preserve: Specific behavior/coverage this change must retain; current scope exclusions.
Return: Relevant diff and result, or the unresolved decision; stop here, no commit.
```

For example, after inspecting a selected-record update handler:

```text
Change: Ignore updates for a record that is no longer selected.
Edits: In src/selection.ts, onUpdate: before changing state, compare update.recordId
with state.selectedRecordId. If different, return the existing state unchanged.
In test/selection.test.ts, use the existing A/B fixture: select B, deliver A's update,
and assert both selected ID and displayed content still belong to B.
Preserve: Keep the matching-record path unchanged. Do not alter subscriptions or fixtures.
Return: Changed hunks and unresolved gaps. Stop; no verification, commit or unrelated repairs.
```

Use real inspected symbols in a live packet. The owner retains the verification plan.
Reuse session context and canonical references; do not prepend the entire history or
repeat stable policy. Put current preservation and stop constraints at the end.
Include relevant source/scout pointers so the editor starts at the affected region.
Reference settled card contracts instead of restating their full implementation. A
dependency question that needs many reads is a bounded scout assignment: request its
exact contract and decisive excerpts, then inspect those. Avoid front-loading later
transformations or collecting full-file context before the first coherent edit.
Carry settled reuse decisions in `Edits`/`Preserve`: exact helper, shared-value, or
component owners and the reuse/extend action. Resolve missing ownership for this
transformation only; let the editor choose details within those boundaries.
Within a retained step, reuse known policy and exact source plus successful replacements;
refresh only changed or uncertain text. Do not require post-edit file inventories,
line counts or repeated status/diff calls just to populate a return. Broad mechanical
edits may warrant a focused readback; preserve that judgment rather than imposing a
hard read budget.
Test assignments name one behavior scenario or closely coupled cases, observable
expectations; the editor can choose among existing fixture conventions. Several files may
belong to one assignment; neither a per-file handoff nor a fixed number of calls is required.

The owner reads/searches the relevant source directly to choose the approach. The editor
reads current source while implementing it. Reserve a facts-only assignment for a
specific blocking fact unavailable through the owner's tools, such as command output;
request a bounded answer, not a source inventory. Routine assignments should make
changes rather than relay file contents between models. Do not delegate "restore every
handler," "finish extraction and wiring," or "implement all acceptance tests and fix
production until they pass." The owner must name the particular move, wiring change
or test case and resolve its approach first. Calling a broad repair a single coherent
transformation does not make it suitable for the editor.

For extractions, name the callbacks/helpers to move and their source/destination, then
assign wiring or obsolete-code removal when the relevant behavior is established.
Combine mechanically inseparable edits. Do not require tests on intentionally incomplete
intermediate states; keep required checks with the assignment that makes the behavior
executable. The owner retains every remaining acceptance obligation in the existing
step context rather than narrowing the overall step to the current packet.

The editor completes that assignment and returns the relevant diff and unresolved gaps.
It does not run tests, compile/build checks, lint checks or other executable verification.
Reading changed regions/diffs and formatting affected files are part of editing.
The owner uses `spec_verify(command, timeout)` for necessary focused checks, diagnostics
and evidence after the editor returns, following the shared verification/Jev policy.
The runtime rejects verification while the editor is active, including question pauses.
Use `spec_advice(task, input)` for the Jev checkpoint with the shared version-1 input;
the runtime supplies the checkout and excludes concurrent editing. Do not ask the editor
to prepare a JSON file for this call. Uncertain advice falls back to owner judgment.
Managed command results retain actual exit status and a separate raw-log path. Long
output includes bounded deterministic excerpts; read missing log ranges instead of
rerunning a check merely to recover diagnostics.
Do not verify every assignment automatically: batch until the behavior is executable,
reuse valid evidence, and leave broad suites to CI/operator policy. The owner diagnoses
failures and sends bounded corrections; the editor does not run fix-until-green loops.
When a repair leaves the same failure, establish the first unproven boundary before
another structural rewrite. Use a scout for unfamiliar cross-file tracing; if execution
evidence is missing, group the diagnostic edits into one assignment, then have the owner
run the focused reproduction. Avoid one editor handoff per log line or speculation.
This changes who runs checks, not the acceptance obligations. It may make ordinary repairs within scope, but may not weaken
behavior or remove acceptance coverage to obtain a pass. The owner assesses the result
and chooses the next assignment using those returned facts, without repeating discovery
or successful checks. This is implementation acceptance, not another independent review.

Commit is a separate assignment after the owner assesses the completed changes and
required evidence. It may include canonical learning/evidence finalization and must
preserve evidence revisions; it does not authorize new implementation or renewed tests
without a concrete need. A general instruction to implement the step does not grant
the editor commit authority. Do not depend on asynchronous steering to stop an editor
before it commits or crosses an assignment boundary.

The editor uses `spec_question` for a concrete unresolved engineering choice. Through
pi-intercom's scoped extension channel, `spec_editor` returns `needs_decision` to the
owner while the same editor waits. The owner calls `spec_answer` with the exact request
ID; it publishes the answer and resumes waiting for that editor's completion or next
question. Do not use conversational intercom `ask` in busy print sessions. Questions
have finite readiness/response deadlines and cancellation; communication failure
returns an unresolved exception, never permission to guess or replace the editor.
The owner resolves concrete contradictions,
consequential choices, repeated failures without a new diagnosis, and acceptance gaps.
For unresolved escalation, it returns a `checkpoint` and concrete question to the
coordinator; missing authority returns `decision-required`. Managed Pi children have
no supervisor messaging tool. A necessary fact missing at step startup is returned the
same way before the first editor dispatch; the coordinator redispatches the step with
the answer in instructions under a new attempt ID, and the retained sessions are reused
(Clarification: lines in the new prompt). It does not duplicate discovery, baseline tests or
successful verification. The editor
uses contextual patches for existing files and coherent writes for small new files.
An anchor mismatch calls for a scoped reread; repeated edit failure without a new
diagnosis returns the error and current fragment to the owner. The owner batches focused checks after coherent edits rather than adding a per-file
verification ceremony.

Keep larger diffs, diagnostics and successful logs in canonical artifacts. Lead returns
with outcome, changed symbols and unresolved exceptions; state verification not run. Aim for at most
4,000 characters, with only decision-relevant hunks and absolute paths for the rest.
If the runtime marks a result truncated, read the needed portion of its full-result file;
do not ask the editor to reconstruct it. No routine progress narration is required.

## Completion, retention and cancellation

The runtime sends the coordinator a native completion event. Wait for that event;
do not poll status, tail transcripts, or infer completion from quiet output. Use `spec_dispatch(action: status, package: <canonical folder>, run_id: <known ID>)`
only to recover after interruption or diagnose an actual failure.

Owner and editor disk sessions stay attached to their exact model assignments across
turns and steps. Refresh affected source after intervening commits; reuse valid evidence
with its original revision. A changed model uses a distinct session. Context compaction
must preserve requirements and unresolved work; it never authorizes a Git reset.

The runtime holds an exclusive checkout lock through the owner and editor process
group. `spec_dispatch(action: cancel)` takes the canonical package and known run ID.
Cancellation must establish actual process termination before any replacement
writer or review fixer starts. Failed or unknown cancellation retains the lock: report
the gap and diagnose it rather than starting another worker. A completed owner has no
active editor. Return the runtime/session references, learning, commit and unresolved
issues for the existing ledger. Never hard-reset, discard, or overwrite accepted commits
or another worker's changes to recreate a prior session state.
