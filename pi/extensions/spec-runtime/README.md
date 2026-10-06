# Pi spec step runtime

This extension runs one prepared step with a retained owner/editor pair. `spec-run`
still chooses the step and owner tier, evaluates the result, requests independent
review, and advances the package. No model discovery, baseline test suite, generated
workflow script, or separate editor reconnaissance pass is part of startup.

`~/.agents/sync.sh` links this directory into Pi's extension directory. Restart or
reload Pi to load it. Existing unmanaged subagents are outside its lifecycle control;
finish or stop those workers before assigning their checkout to this runtime.

## Dispatch contract

Call `spec_dispatch` once:

```json
{
  "action": "start",
  "package": "/repo/.specs/feature",
  "step": "/repo/.specs/feature/step-001-subspec.md",
  "checkout": "/worktrees/feature",
  "owner_model": "deepseek/deepseek-flash:max",
  "editor_model": "openrouter/inception/mercury-2.5:high"
}
```

The package and step must be canonical primary-checkout paths. An explicit existing
checkout is reused after repository identity validation. If the path is absent, the
runtime creates a worktree. With no `checkout`, the default is a sibling named
`<repository>-<feature>` on branch `spec-<feature>`. Optional `branch` and `base`
control a new worktree; `base` defaults to `HEAD`. An explicit branch mismatch is
an error. The runtime does not overwrite changes or change an existing checkout's
branch. Repository setup happens only when the actual step needs it.

`instructions` carries scoped direction, acceptance requirements and publication
authority. `timeout_ms` defaults to two hours for the complete owner assignment.
`assignment_id` identifies an attempt and defaults to the step path. Repeating the
same attempt returns its receipt, including after later steps complete. Reusing an
ID with a changed model, checkout, extension list, step, or instructions is an error. Use a new
assignment ID for an intentional correction/retry, or an owner transfer. A different
step is a new assignment. Never use a new ID to bypass an active lease.

The returned receipt contains the run ID, state, checkout, session files, event log,
and next action. Return control and await the completion message. `status` is an
explicit recovery operation, not a polling loop:

```json
{"action":"status","package":"/repo/.specs/feature","run_id":"<id>"}
```

Cancellation revokes the lease, signals every tracked process group, and waits for
termination. It returns `cancelled` only after those groups have stopped:

```json
{"action":"cancel","package":"/repo/.specs/feature","run_id":"<id>"}
```

`completed` means that the owner process produced a final response and its managed
process groups exited. It does **not** certify acceptance, a passing review, or
publication readiness. `failed` retains the actual model/process failure. `blocked`
retains the writer reservation because termination is uncertain. A failed stop never
authorizes a replacement.

## Optional scouting

`scout_model` carries the initial SCOUT_AGENT selector; default is
`openai-codex/gpt-6-luna:low`. It is part of the assignment contract. Owners receive
`spec_scout(task)` backed by pi-subagents' structured foreground leaf API, using the
installed `scout` profile. The owner process explicitly loads the installed
`~/.pi/agent/npm/node_modules/pi-subagents/index.js`; editors do not. Configure the
[read-only scout override](../../../skills/spec-run/references/scouting.md) before use.
No mandatory model probe or scout launch is added to startup.

Scout calls have a two-minute deadline, exact request correlation, cancellation on
abort/shutdown, fresh context and no conversational intercom bridge. Responses over
8,000 characters have a truncation notice and a complete result file under runtime/runs.
A failed scout is never acceptance evidence and does not trigger another provider.
The independent `spec-stage-reviewer` profile can separately call `subagent` with
allowed descendant profile `scout`; it retains responsibility for the review verdict.

## Owner and editor

The owner receives `read`, `grep`, `find`, `ls`, `spec_editor`, `spec_answer`, `spec_verify`, `spec_scout`, and `spec_advice`. It chooses the implementation
approach, then sends a short `Change/Edits/Preserve/Return` packet for a bounded
transformation. The editor chooses local implementation details and batches related edits. Missing
source facts are read directly by the owner; facts-only editor assignments are reserved
for blocking information requiring the editor's tools. The editor normally reads and
edits in one assignment. Returns should be compact (about 4,000 characters), with paths
for larger artifacts. `spec_editor` waits for the editor to exit and returns its final
response plus full-output paths. Responses over 8,000 characters have an explicit
truncation notice and `result_truncated: true`; `full_result_path` contains the complete
plain-text response for targeted reads without another editor call. The owner assesses that
result before assigning the next transformation; the same editor session is resumed.
The editor writes code (including assigned tests) but does not run executable verification.
The owner uses `spec_verify(command, timeout)` for necessary focused checks and diagnostics;
this tool shares the editor slot and refuses to run while editing or a question pause is
active. It uses managed deadlines, cancellation and output logs. Source edits and commits
through `spec_verify` are prohibited by role instructions, not a shell sandbox. Broad
suites remain CI/operator-owned; no per-packet check is required.
For relevant UI work, the owner uses the existing `uishot` skill through `spec_verify`
and `see` for image inspection or vision relay. No new capture tool or dependency is
required. Reviewers reuse revision-applicable images and capture only missing evidence
against a stable target. The editor receives the resulting concrete corrections.
Commit is a separate assignment after owner acceptance. These scope and commit rules
are agent instructions, not a shell-level restriction on Git commands.

For a consequential implementation question, the editor calls `spec_question`. The
adapter uses the installed `pi-intercom` extension's message channel, scoped to this
run and exact owner/editor identities. `spec_editor` yields that question to the
owner while the same editor process waits. The owner calls `spec_answer` with the
request ID and answer; that tool resumes waiting for the original editor. Neither
side launches a replacement. Broad intercom discovery, broadcast, and session-control
tools are excluded. Missing delivery or an expired question is an error, not approval.

Sessions are reused across steps for the same checkout, model pair, and explicit
child-extension list. Switching owner tier creates a different pair; the prior pair
can be reused later. Native Pi `--session` files preserve conversation context.
Each assignment uses a new process, so this is session reuse rather than keeping an
idle model process alive. Owner/editor profile instructions are in `pi/agents/`.

Children disable extension/skill/template discovery. Native provider credentials
and model configuration remain available. Install `pi-intercom@0.16.1` and configure
it, plus any needed provider compatibility extensions, once in
`~/.pi/agent/spec-runtime.json`:

```json
{
  "child_extensions": [
    "/absolute/path/to/provider-compat/extensions/index.ts",
    "/absolute/path/to/pi-intercom/index.ts"
  ]
}
```

A call's `child_extensions` replaces that default. Supply pi-intercom and required
provider compatibility extensions, not goal continuation or alternative worker
orchestration extensions.
The child tool guard restricts tools to its assigned role even if another extension
registers more. A configured model is validated by actual dispatch; unknown models
and missing credentials produce a specific failure without speculative discovery.

## Lifecycle and records

Exclusive directories in the checkout's Git directory and the canonical package's
runtime directory reserve both code and shared artifacts across coordinators.
Owner, editor and shell process groups are registered before execution;
a stdin gate prevents an unregistered child from starting useful work. Revocation
blocks new tool calls and prevents unopened gates from proceeding. Managed shell
timeouts terminate their process groups. Editor descendants still alive at handoff
revoke the lease and block the next editor. The overall deadline cancels the run.
Normal Pi session shutdown also cancels its managed runs.

This is lifecycle enforcement for cooperative managed workers, not an OS security
sandbox. Deliberately detached external services and writers started outside the
runtime are not covered. Do not leave background services alive after a managed shell
call. For owner-run UI evidence, pass `spec_verify.server` with a foreground server
`command`, a loopback HTTP(S) `ready_url` on an owned free port, and optional
`readiness_timeout` (default 60 seconds). The outer `command` performs capture after
readiness. The runtime cleans up its server group on success, failure and interruption,
before releasing the verification slot. Close any browser created by the capture.
A readiness URL already returning success is rejected without touching that server.

Ordinary commands run with Bash `pipefail` (also exported to nested Bash shells) and
retain raw logs; callers should omit output-tail pipelines. A leaked command group is
terminated with bounded TERM/KILL handling and returned as an error. Confirmed cleanup
preserves the owner lease so it can correct the command. Unconfirmed cleanup revokes
the lease and emits a fatal lifecycle receipt; the coordinator is notified and cancels
its live managed groups before another writer can start. Existing editor-exit protection
remains strict. Deliberately detached/escaped groups remain outside this cooperative model.
Hard resets are rejected for managed step commands; return recovery decisions to the
coordinator. Existing project external-action policies still apply.

An abrupt coordinator crash cannot establish termination. A newly started coordinator
will not kill a process merely from a persisted PID or automatically remove a stale
lease. Recover the original coordinator when possible; otherwise inspect and stop the
recorded workers before manually reconciling the reservation. The runtime never treats
an unverified stale record as permission to write. Reload after normal shutdown can
resume the retained sessions using a new attempt ID.

Records stay in the canonical package:

| Path under `runtime/` | Contents |
| --- | --- |
| `run.json` | Latest assignment's durable receipt |
| `runs/<id>.json` | Historical assignment and exact paths |
| `assignments/*.json` | Persistent attempt lookup and launch contract |
| `events.jsonl` | Timestamped starts, editor results, deadlines, cancellation, completion |
| `sessions/<pair>/owner.jsonl`, `editor.jsonl` | Native retained Pi sessions |
| `runs/<id>-processes/*.json` | Process group lifecycle registry |
| `runs/<id>-*.jsonl`, `.stderr`, `-command-<uuid>.log` | Detailed diagnostics, read only for concrete failures; legacy runs may use `-commands.log` |

`~/.pi/agent/spec-runtime/<id>.json` indexes each manifest and parent session for
future discovery. Session/log content can contain repository and command details;
keep runtime records local and out of published artifacts unless intentionally reviewed.

## Live monitor

An interactive Pi coordinator shows a widget after dispatch: step elapsed time,
owner and editor activity, time since their last observable event, public task or
decision excerpts, editor tool/file targets, and the last observed error category.
Owner waits for the editor and editor waits for a decision are labeled explicitly.
The monitor cannot expose private reasoning; its focus text comes from public
responses and assignments. Commands, source/replacement bodies, tool outputs, and
raw provider errors are excluded. Public excerpts are bounded and common credential
patterns are redacted; treat repository/task names as local information.

The one-second timer only updates displayed durations. Native JSON stream events
produce atomic `runs/<id>-activity/{owner,editor}.json` snapshots, watched by the UI;
there are no model calls or status polling. Idle means **no observed event**, not
proof of a stuck or terminated process. A provider error remains visible separately
from resumed activity. Terminal run states stop the timer and label worker activity
as historical; completion still does not certify acceptance.

To observe an existing run from a separate newly loaded Pi session without stopping
its coordinator, use `/spec-monitor /absolute/repo/.specs/feature`. This only observes
that package's current run; it does not acquire its lease, own its workers, cancel
them on observer shutdown, or auto-follow later runs. `/spec-monitor off` hides it.
Normal dispatch and restored dispatch receipts attach automatically. Runs started
before this monitor was installed use a bounded 64 KiB tail of each role's newest
native stream and incremental file-change notifications. Large/incomplete historical
events can be unavailable; legacy activity timestamps use stream modification time.
The widget does not infer missing activity. No browser UI is involved.

## Workspace sentinel status

`/spec-sentinel status` shows a bounded read-only snapshot across enrolled
repositories: repository common directory, canonical package, checkout, workflow
id, assignment id, coordinator session, execution state, obligation, activity hint,
coverage and factual conditions such as `reconciliation-pending` or `quiet-activity`.
It is also the default when the command has no argument.

`/spec-sentinel add /absolute/primary` validates a primary checkout and writes one
enrollment record per root at
`<agentDir>/spec-sentinel/<workspace-key>/enrollments/<sha256(common dir)>.json`,
mode `0600`, containing `{ version, root, common, enrolled_at }`. Only this direct
command writes that record; it grants read observation and nothing else. At most 20
roots are recorded, and a `.specs` copy in a linked worktree is rejected. Managed
index pointers and packages dispatched in the session are observation candidates
only and never enroll a repository.

The widget shows the workspace rows; when a single run is observed it collapses to
the header line because that run's own widget already shows it. `/spec-sentinel
inspect ID` names one run or condition by assignment id, workflow id, package or
condition id/kind. Directory invalidation is coalesced at 250 ms and status is
reconciled every 15 s. `/spec-sentinel off` hides the widget and status and disposes
only this session's observers and timers; it never cancels, stops or messages
workers. The CLI equivalent is `node
~/.agents/scripts/spec-observe/cli.mjs sentinel status [--package PATH] [--format
text|json] [--agent-dir PATH]`, which works without a Pi session.

Coverage is `complete|partial|stale|unavailable` with explicit omission reasons;
missing, oversized or replaced sources stay unknown or stale, never healthy. No
model call, transcript read or recovery authority is introduced here: completion,
exit and silence remain non-acceptance facts.

## Scoped authority (enable/disable)

`/spec-sentinel enable /absolute/policy.json` arms a live, session-local capability
for the coordinator session; `/spec-sentinel disable` revokes it and `/spec-sentinel
off` revokes it before hiding observation. Only this native command can arm it: a
fresh session, reload, checkpoint, model output or copied/forged file never arms it.
The policy file must be an absolute regular non-symlink JSON file of at most 16 KiB
with exactly this schema:

```json
{
  "version": 1,
  "package": "/repo/.specs/feature",
  "workflow_id": "wf-example",
  "checkout": "/worktrees/feature",
  "coordinator_session": "<native SDK session identity>",
  "mode": "shadow",
  "actions": ["continue"],
  "expires_at": "2026-01-01T00:00:00.000Z",
  "max_effects": 1,
  "max_diagnostics": 1,
  "diagnosis": { "model": "provider/model:thinking" },
  "authority_reference": "user:enable"
}
```

The package, workflow, checkout and native session must match the retained checkpoint.
`expires_at` must be a future exact ISO-8601 UTC timestamp no later than eight hours.
`max_effects` and `max_diagnostics` are integers 0..2; `actions` holds unique
`continue`/`cancel`; `cancel` requires a diagnosis selector and a diagnosis selector
requires a nonzero diagnostic budget. `diagnose` is reported only when configured.

Budgets are finite and retained per workflow: two effect slots (continue/cancel share
them) and two diagnostic slots, at most one continuation per obligation revision and
one cancellation per incident generation, plus at most one diagnosis per incident
generation with a five-minute cooldown. Re-enabling never resets consumed capacity. A
duplicate same-kind/subject reservation returns its retained receipt without repeating
the effect. Reservations are published durably (slot first, then an immutable intent)
before any effect; an orphan/malformed/corrupt record or an unfinished intent from a
previous authority stays spent and blocks as unknown. `/spec-sentinel disable` revokes
the live capability synchronously and reports a persistence failure while remaining
disarmed; `/spec-sentinel off` revokes first and then hides observation, reporting both
facts. Step 5 performs no continuation, cancellation, diagnosis or model effect; any
actual effect belongs to later steps under this guarded authority.

## Bounded continuation

When explicitly enabled in recover mode, the coordinator may propose exactly one
additional model turn at the Pi settle boundary. The handler admits only a completed
settlement with a ready open obligation, an exactly reconciled native input revision,
zero UI prompt depth, no `context.pendingMessages`, a nonblocking inbox, no nonterminal
or malformed declared worker, no active managed Runtime handle, and an armed unexpired
policy that permits `continue`; prior handlers' `continue:true` and every explicit stop
state veto. It re-reads all guards and requires the same checkpoint/obligation revision,
then durably reserves the continuation (one per obligation revision) before returning
`{entries:[...event.entries, visible custom_message], continue:true}`. The visible
`custom_message` has `customType: "spec-sentinel"` and `display:true`, names the
workflow, obligation key/summary, the actual checkpoint path and revisions, a source
digest and an artifact count, and instructs reconciliation before acting. An initial
`event.context.canContinue === false` is not a veto; Pi recomputes eligibility after the
proposed entries. A second settlement with the same obligation is a duplicate and does
not refill the budget. In shadow mode the reservation is recorded as terminal `blocked`
with reason `shadow-would-continue` and no custom entry or extra turn is produced. A
`requested` record means the continuation was proposed; `applied` means the requested
turn started (delivery only), never that work was accepted, and ambiguous requested
effects are not retried.

## Workflow metrics

`/spec-metrics /absolute/canonical/package` displays a read-only aggregate from native
Pi transcripts and runtime records, without a model turn. It covers the most recent
coordinator session and linked owner/editor/reviewer/scout sessions; retained workers
are filtered to that coordinator's assignment windows. The CLI supports all-session
and JSON reports. See [workflow metrics](../../../scripts/spec-observe/README.md#workflow-metrics)
for timing, cost and test-count coverage. The command does not start, stop or message workers.

## Focused verification

Managed commands keep separate raw logs and return exact short output or bounded
start/diagnostic/end excerpts for large output, with actual exit code, signal and
timeout errors. See [deterministic facts](../../../scripts/spec-facts/README.md).
Owners can call `spec_advice(task, input)` directly for Jev scheduling or review triage
with its shared version-1 contract. It uses the assigned checkout, excludes active
editor/check work and returns uncertainty unchanged, without automatic retries.
It executes no candidate commands and cannot certify passes. Other roles retain the
existing Jev CLI/MCP route. See [workflow efficiency](../../../docs/spec-workflow-efficiency.md).
Install its locked local dependencies once with
`npm ci --prefix ~/.agents/scripts/jev --ignore-scripts`; unavailable advice uses the
documented owner fallback rather than blocking implementation.

```sh
node --test pi/extensions/spec-runtime/runtime.test.mjs
node --test pi/extensions/spec-runtime/monitor.test.mjs
node --test pi/extensions/spec-runtime/communication.test.mjs
node --test pi/extensions/spec-runtime/intercom.integration.test.mjs
```

The tests use real local subprocesses with fake model output, not model services.
They cover idempotence, conflicting writers, retained locks on failed stop, surviving
owner/editor descendants, cancellation recovery, shell timeouts, assignment deadlines,
provider failures, canonical worktree paths, and lease revocation during launch.
The communication tests cover the owner/editor question contract. The integration test
uses the installed pinned pi-intercom broker/client in a temporary isolated directory;
it exercises a real scoped question/reply roundtrip without models or live-session messages.

### Dispatch inputs and environment handoff

`startup`, `start`, `status`, and `cancel` accept either the canonical feature directory
or its `spec.md`; both resolve to the same package and assignment identity. Other files
are rejected. `owner_override` takes precedence over `owner_model` in both launch paths.
`strong_owner_model` remains the optional prepared-tier route used by `startup`.

Each launch returns and passes the owner a compact `environment` observation: checkout,
primary repository, existing `deps`/`node_modules` and build paths at those roots, plus
configured Mix dependency/build paths. This performs no installs or readiness probes.
An existing path does not prove compatible dependencies or authorize shared writable
build output. Use repository setup policy; do not search the filesystem root.

Managed UI verification uses one call, for example:

```json
{
  "command": "node /absolute/canonical/package/evidence/capture.mjs",
  "timeout": 120,
  "server": {
    "command": "PORT=4345 mix phx.server",
    "ready_url": "http://127.0.0.1:4345/",
    "readiness_timeout": 60
  }
}
```

Use the project's isolated fixture environment, loopback endpoint and an owned free
port. The server log path is returned separately from the capture log. The example
selects no production data or fixture setup for the caller. Readiness and capture have
separate finite deadlines; the whole assignment deadline remains in force.


## Structured handoffs and durable progress

New assignments carry `completion_contract: 1`. `spec_complete` is an owner-only tool, serialized
with editing/verification. It writes `learnings/step-NNN-learning.md` and a per-attempt structured
receipt. The owner supplies judgments (outcome, strategy, decisions, reusable symbols, gaps,
subsequent-step findings and EV assessments); the runtime supplies HEAD and recorded commands.
`spec_verify` returns `receipt_id` and retains observed HEAD/dirty state, exit status and raw-log
path. A passed command is not automatically a passed EV: the owner maps it to the obligation
and states the proof boundary. Earlier/dirty-tree evidence requires applicability, not a rerun.
External evidence remains explicitly owner-reported with command, actual SHA and artifact.

Process `state: completed` means the worker exited. `handoff.status: recorded` means its structured
record exists and matches the canonical learning. It does not accept implementation or independent
review. Missing/changed handoffs yield `handoff_incomplete` without retaining a settled process
lease. Continued editing/checking invalidates the submission; resubmit afterward. Old attempts are
`legacy_unchecked` and retain their existing manual reconciliation route. No automatic repair loop
or new model dispatch is introduced.

`runtime/progress.json` is a generated ledger of attempts, handoffs, check-receipt counts,
review/fix artifact references and coordinator stage decisions. `spec_checkpoint` records the
remaining judgment-bearing stage status, next action, decisions and canonical artifact references.
Stage receipts live in `runtime/stages/`; preserve explicit holds/authority there or in their
referenced canonical records. Artifact presence is not a passing review. The existing
`run-ledger.md`, if present, remains a legacy source and is not overwritten.

The coordinator watches canonical learning/review/fix directories and runtime records, coalesces
notifications, and repairs missed events with a 15-second metadata reconciliation. History-index
and progress writes are serialized per process. Errors remain visible; the watcher never triggers
a model turn. Each model request gets one ephemeral current-obligation reminder, replacing its
predecessor, so compaction cannot remove the source of that reminder. Coordinator bindings are
persisted as Pi custom entries and restored on session resume. This is not a sentinel, daemon,
auto-restart loop, or guarantee that a closed session continues running.

Existing live Pi processes keep their loaded extension. Use a fresh/reloaded idle coordinator and
new assignments to pick up the tools; do not restart active work solely for these bookkeeping changes.
