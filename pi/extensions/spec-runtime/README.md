# Pi spec step runtime

This extension runs prepared steps: one step per assignment on the serial path, or every admitted member of a dependency wave on the wave path, each with a retained owner and a fresh editor session per assignment. `spec-run`
still chooses the step and owner tier, evaluates the result, requests independent
review, and advances the package. No model discovery, baseline test suite, generated
workflow script, or separate editor reconnaissance pass is part of startup.

Install the pinned watcher dependency before loading the extension:

```sh
npm ci --prefix ~/.agents/pi/extensions/spec-runtime --ignore-scripts
```

`~/.agents/sync.sh` links this directory into Pi's extension directory and installs
this dependency automatically (`scripts/install-deps.sh`); the manual command above
is only needed for a standalone checkout. Restart or
reload Pi to load it. Existing unmanaged subagents are outside its lifecycle control;
finish or stop those workers before assigning their worktree to this runtime.

## Dispatch contract

Call `spec_dispatch` once:

```json
{
  "action": "start",
  "package": "sample-workspace/feature",
  "step": "<storage root>/projects/sample-workspace/specs/feature/step-001-subspec.md",
  "owner_model": "deepseek/deepseek-flash:max",
  "editor_model": "deepseek/deepseek-flash:low"
}
```

`package` is a `workspace/slug` ref or the package folder (or a file inside it) in the
adjacent storage root; spec-location (`scripts/spec-location`) maps it to paths, and a
refusal (wrong host, missing locations, legacy location) is returned as an error with
its code and remedy. The step must be a file of that package. A step runs in one
target repository: the step's `repository` in `spec-steps.json` (required when the package has
several targets, optional for one). A missing or unknown value is refused as
`step-repository-missing` or `step-repository-unknown` before any worktree is created. The
target's primary checkout, branch and git common directory come from `locations.json`. The
worktree is that target's `worktree` when recorded; otherwise the runtime creates a sibling
named `<repository>-<slug>` on the target branch (`base` defaults to `HEAD`) and records it with
spec-location. Other targets' worktrees are created only when a step targets them. The run
record gains `target` (the repository id), and `checkout` is that target's worktree. Owner and
editor sessions run there; the prompt lists the other targets' recorded worktrees as read-only
context, and retained sessions are keyed by target so they never cross repositories. A caller
cannot supply a checkout. A worktree on another branch or in another repository is an
error. The runtime does not overwrite changes. Repository setup happens only when the
actual step needs it.

`instructions` carries scoped direction, acceptance requirements and publication
authority. `timeout_ms` defaults to two hours for the complete owner assignment.
`assignment_id` identifies an attempt and defaults to the step path. Repeating the
same attempt returns its receipt, including after later steps complete. Reusing an
ID with a changed model, worktree, extension list, step, or instructions is an error. A
startup clarification redispatch therefore uses a new attempt ID on the same step with the
answer in `instructions`. Retained sessions are reused because `instructions` is part of the
launch contract but not the session key. Use a new
assignment ID for an intentional correction/retry, or an owner transfer. A different
step is a new assignment. Never use a new ID to bypass an active run.

Optional `attempt_kind` records why an assignment exists: `implementation`,
`verification-continuation`, `implementation-repair`, `review-repair`, or `launch-retry`.
It does not authorize another attempt. Omitted legacy reasons remain unknown.
New steps default to `session_scope: "step"`, separating retained owner
sessions by canonical step while retaining owner context across that step's retries.
Every editor packet starts fresh; its actual transcript path is returned and appended
to `runtime/runs/<run-id>-editor-sessions.json`. The legacy `editor_session` remains
a directory anchor. Observation metrics include all recorded editor sessions. Explicit
`"package"` preserves cross-step reuse. Supply a concise current dependency handoff;
existing attempt receipts and active sessions retain their recorded scope. A new retry
ID on the same step inherits its latest recorded scope when omitted. Changing
an explicitly supplied scope or attempt kind changes the launch
contract and cannot reuse an existing assignment ID. Models and thinking effort
are never changed by this option. No existing transcript is removed or rewritten.

The returned receipt contains the run ID, state, checkout, session files, event log,
and next action. Return control and await the completion message. `status` is an
explicit recovery operation, not a polling loop:

```json
{"action":"status","package":"sample-workspace/feature","run_id":"<id>"}
```

Once runtime returns a run, a later checkpoint or monitor bookkeeping failure returns
that same receipt with `bookkeeping_error`, not a launch refusal. Reconcile the named
run and await it if active; do not start a replacement. Checkpoint artifacts are readable
package-contained paths. Legacy artifact `sha256` fields are ignored; intended edits
do not invalidate a checkpoint. Inbox direction identity hashes are unchanged.

Partial handoffs can carry `checkpoint_reason` (`blocker`, `deadline`, `decision`,
`owner-transfer`, `interruption`) and concrete `remaining_work`. Legacy handoffs remain
readable; gaps and unresolved owned evidence supply the continuation action. Ready,
unattempted gates remain work for the current owner, not a routine reason to exit.
These fields neither approve acceptance nor trigger automatic redispatch.

Cancellation revokes the run's writer role, signals every tracked process group, and waits for
termination. It returns `cancelled` only after those groups have stopped:

```json
{"action":"cancel","package":"sample-workspace/feature","run_id":"<id>"}
```

`completed` means that the owner process produced a final response and its managed
process groups exited. It does **not** certify acceptance, a passing review, or
publication readiness. `failed` retains the actual model/process failure. `blocked`
retains the writer reservation because termination is uncertain. A failed stop never
authorizes a replacement.

## Wave dispatch

Wave dispatch is the concurrent sibling of the serial contract above; both share the
process lifecycle, session reuse and receipt rules. Call `spec_dispatch` with
`execution: "waves"` (or `"auto"`, which admits a wave when the package declares one):

```json
{
  "action": "startup",
  "package": "sample-workspace/feature",
  "execution": "auto",
  "isolation": "auto",
  "owner_model": "deepseek/deepseek-flash:max",
  "strong_owner_model": "deepseek/deepseek-flash:max",
  "editor_model": "deepseek/deepseek-flash:low",
  "review_model": "deepseek/deepseek-flash:max",
  "fix_model_override": "deepseek/deepseek-flash:low",
  "workflow_id": "<id>",
  "timeout_ms": 7200000
}
```

`isolation` accepts `overlayfs` (primary), `worktree` or `auto`. `fix_model_override` is
optional; `review_model` and `strong_owner_model` are the native reviewer/fixer and
owners selectors. `workflow_id` binds the assignment to the durable wave record.

Wave controls parallel the serial actions, keyed by `wave_id`:

```json
{"action":"advance","package":"sample-workspace/feature","wave_id":"<id>","expected_generation":3}
{"action":"recover","package":"sample-workspace/feature","wave_id":"<id>","expected_generation":3}
{"action":"cancel","package":"sample-workspace/feature","wave_id":"<id>","step":4}
{"action":"status","package":"sample-workspace/feature","wave_id":"<id>"}
```

`advance` is idempotent reconciliation for restart, replayed events or operator
intervention, not a required clock for ordinary progress; `cancel` is package-wide
when `step` is omitted and member-scoped otherwise. The wave receipt exposes:

```json
{
  "execution": "waves",
  "wave_id": "<id>",
  "generation": 3,
  "state": "running",
  "requested_width": 9,
  "admitted_width": 5,
  "software_ceiling": 16,
  "effective_limits": {
    "software_ceiling": 16,
    "explicit_cap": null,
    "memory": {"pool_bytes": 8589934592, "per_lifecycle_bytes": 1073741824, "slots": 8},
    "tasks": {"pool": 1024, "per_lifecycle": 128, "slots": 8},
    "binding": "memory",
    "source": "host"
  },
  "members": [
    {"step":4,"phase":"implementation","run_id":"<id>","checkout":"<path>",
     "base_commit":"<sha>","sealed_head":null,"review_artifacts":[],
     "blocking_reason":null,"backend":"overlayfs","fallback_reason":null,
     "snapshot_id":"<id>","upper_id":"<id>","active_phase":"<invocation-id>",
     "git_dir":"<path>"}
  ],
  "member_count": 9,
  "omitted_count": 4,
  "record_path": "<package>/runtime/waves/<id>.json",
  "next_action": "await-completion"
}
```

`software_ceiling: 16` is fixed. `effective_limits` is an object, not a list; memory and
tasks are kept as separate entries because their pools are measured in different units
(bytes vs. tasks) and are consumed by different admission paths, so a single shared
"limit" field could not represent both. The values shown are illustrative, not
machine-specific. `requested_width` is the declared wave width and `admitted_width` the
resource-eligible subset; `omitted_count` bounds how much of the member summary is
omitted. The summary is bounded; `record_path` resolves every member and no bounded preview supplies the
authoritative active-worker set.

Selection

With `execution: auto`, a concurrency-ready single-target package on a passing Linux runtime host runs waves. Legacy packages return serial with reason `legacy-serial`; multi-target packages return `multiple-targets`. Incomplete wave metadata returns `needs_preparation` under auto, or `needs-preparation` under explicit `execution: waves`. Missing host capability returns `setup-required` with a remedy and stops dependent dispatch; neither incomplete metadata nor missing capability silently runs serial.

The index `setup` declaration prepares the target snapshot. Its prepared output is published once per snapshot
identity as the frozen lower every member starts from, in kernel OverlayFS or the
worktree fallback. Members run in kernel OverlayFS (R59) through the fixed
unprivileged bubblewrap adapter (R62); the worktree fallback (R60) applies only before
writes and requires a recorded reason. Each attempt uses a private Git directory (R61),
imported unchanged at seal; every member starts at its frozen accepted base and canonical
locations and user work are preserved.

One coordinator per package and one writer per checkout are held by token-bound
claims in the ownership registry at
`~/.pi/agent/spec-runtime/ownership/claims.json` with its `registry.lock`; `run.json` is
a latest observation only and never the authority for who owns a package or checkout.
The wave path uses `acquirePackage`; the serial path does not.

Reviewer and fixer are native roles with stage tools, `spec_stage_complete` and
context-budget installation; the coordinator hosts the in-process event handler and is
the sole phase-progression owner. Progression is event-driven with an idle long-lived
coordinator: routine phase completions, launches and capacity updates are recorded and
displayed with `triggerTurn: false`, and only deduplicated attention events (barrier
reached, member blocked, promotion result, asynchronous setup-required) use
`triggerTurn: true`. No coordinator model turn or tool call is required after startup.

Completed members flow into candidate integration; `wave_checks` run through
`runCommand` against an existing required merge step-owned gate and promotion is
guarded by expected-old. Enabling waves needs the real-OverlayFS rehearsal (R63);
fallback success never satisfies it. See [Linux host setup](../../../docs/linux-host-setup.md)
(R64) for host setup and Node PATH.

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
for larger artifacts. Before the owner starts, the runtime writes `runtime/context/step-NNN.md`
(R57): changes since the card was written, prerequisite exports and `introduced` blocks
from `requires`, an anchor map of `writes`, and test names, recording
`context_pack_written` or `context_pack_failed`. `spec_editor` accepts `context` (R58)
ranges `{path, start, end}` (checkout or package files only, at most 600 lines per range
and 120,000 characters in total) attached as exact current lines. It also accepts
`reasoning` (`off`, `low`, `high`, `max`), which overrides the editor thinking level for
that packet only. `packets` carries 2-4 closed packets
`{assignment, paths, context?, reasoning?}` run concurrently: disjoint `paths` share the
checkout, while overlapping `paths` run in isolated packet workspaces and merge back by
per-file three-way merge in packet order; a conflicting packet applies nothing and
returns `conflicting_paths` and its `patch`. Every editor packet starts fresh.
`spec_editor` waits for the editor to exit and returns its final
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

There are no lock directories. On the serial path, each run records `coordinator_pid`
(the dispatching process) in `runtime/run.json`; the serial concurrency check is built on
that record. Dispatch refuses `run-active` while the latest run is
`running`, `cancelling` or `blocked` and that pid is alive. If the pid is dead the
runtime marks that run `stale` and proceeds; it does not stop the old run's process
groups. A run holds the writer role while its own record is `running` or `blocked` and
no `runs/<id>-revoked.json` marker exists; tools check this before each call. Only the
wave path calls `acquirePackage` (via `waves.mjs` `openWave`) to bind claims in the
ownership registry at `~/.pi/agent/spec-runtime/ownership/claims.json` with its `registry.lock`; the serial `start`/`startup` path does
not. Two
coordinators dispatching in the same instant are not serialized. Owner, editor and shell process groups are registered before execution;
a stdin gate prevents an unregistered child from starting useful work. Revocation
blocks new tool calls and prevents unopened gates from proceeding. Managed shell
timeouts terminate their process groups. Editor descendants still alive at handoff
revoke the run and block the next editor. The overall deadline cancels the run.
Normal Pi session shutdown also cancels its managed runs.

A native `agent_settled` event with `aborted: false` and a complete final response
starts a 15-second shutdown grace period. If the print worker still owns a live
process, the launcher records `worker_shutdown_cleanup` and terminates only that
invocation's tracked group (TERM, then KILL). It waits for actual exit; new model/tool
activity cancels the grace timer. Active managed descendants or unconfirmed cleanup
require normal runtime cancellation. The result retains its full text and cleanup flag;
the existing handoff validation and independent review obligations still apply.

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
keeps the owner running so it can correct the command. Unconfirmed cleanup revokes
the run and emits a fatal lifecycle receipt; the coordinator is notified and cancels
its live managed groups before another writer can start. Existing editor-exit protection
remains strict. Deliberately detached/escaped groups remain outside this cooperative model.
Hard resets are rejected for managed step commands; return recovery decisions to the
coordinator. Existing project external-action policies still apply.

An abrupt coordinator crash cannot establish termination. A newly started coordinator
will not kill a process merely from a persisted PID; it only marks the dead
coordinator's run `stale`. Inspect and stop any recorded workers of a stale run
yourself. Reload after normal shutdown can resume the retained sessions using a new
attempt ID.

Records stay in the spec package (`<storage root>/projects/<workspace>/specs/<slug>/`); `runtime/` is machine-local and never synced:

| Path under `runtime/` | Contents |
| --- | --- |
| `run.json` | Latest assignment's durable receipt (`package_ref`, `coordinator_pid`) |
| `runs/<id>.json` | Historical assignment and exact paths |
| `assignments/*.json` | Persistent attempt lookup and launch contract |
| `events.jsonl` | Timestamped starts, editor results, deadlines, cancellation, completion |
| `sessions/<pair>/owner.jsonl`, `editor.jsonl` | Native retained Pi sessions |
| `runs/<id>-processes/*.json` | Process group lifecycle registry |
| `runs/<id>-*.jsonl`, `.stderr`, `-command-<uuid>.log` | Detailed diagnostics, read only for concrete failures; legacy runs may use `-commands.log` |
| `waves/<wave-id>.json` | Retained version 1 wave record and generation authority |
| `context/step-NNN.md` | Per-step context pack (R57) written at owner start |

`progress.json`, when present, gains `waves`, `waves_truncated` and per-run `wave_id`
and `phase` so aggregate progress cannot lose concurrent events.

`~/.pi/agent/spec-runtime/<id>.json` indexes each manifest, `package_ref` and parent session for
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
its coordinator, use `/spec-monitor workspace/slug`. This only observes
that package's current run; it does not claim the package, own its workers, cancel
them on observer shutdown, or auto-follow later runs. `/spec-monitor off` hides it.
Normal dispatch and restored dispatch receipts attach automatically. Runs started
before this monitor was installed use a bounded 64 KiB tail of each role's newest
native stream and incremental file-change notifications. Large/incomplete historical
events can be unavailable; legacy activity timestamps use stream modification time.
The widget does not infer missing activity. No browser UI is involved.

## Observe-only host entry

The ordinary host lives in `sentinel-host.mjs` and composes the shared claim, the
headless observer and the owned dashboard without Pi or authority callbacks:

```js
import { createSentinelHost } from './sentinel-host.mjs';
const { receipt, close } = await createSentinelHost({ agentDir, root, port: 0 });
// receipt: { type: 'ready', state, snapshot_path, dashboard_url, dashboard_state }
await close(); // one shared, bounded shutdown promise; releases the claim
```

Importing the module creates nothing. The guarded CLI accepts only
`--agent-dir`, `--root`, `--port` and `--public-host`, rejects unknown,
duplicate, missing or invalid values before any observation effect, installs
SIGTERM/SIGINT handling before initialization resolves, and prints one JSON
ready line. The host is observe-only: it never arms policy, starts workers,
writes completion records or opens a browser, and shutdown is bounded. Ordinary
Pi observation, commands and lifecycle behavior are unchanged. See
[the scripts README](../../../scripts/spec-observe/README.md#observe-only-host-operator)
for defaults, ownership, heartbeat, local-only completion and the operator-only
launchd/Serve procedures.

## Workspace sentinel status

`/sentinel status` (also `/spec-sentinel status`) shows a bounded read-only snapshot across automatically discovered
repositories: repository common directory, canonical package, checkout, workflow
id, assignment id, coordinator session, execution state, obligation, activity hint,
coverage and factual conditions such as `reconciliation-pending` or `quiet-activity`.
Bare invocation starts observe mode. Startup and reload are silent and dormant: no
scans, watchers, timers or sentinel UI until explicitly invoked. Control participants
can join an already active global controller; saved files never activate one.
Cold status is a bounded one-shot read: it closes its read-only helper before returning
and starts no watchers, reconciliation timers, widget or dashboard. Active status
preserves monitoring; `status --all` never overwrites its live snapshot. After `off`,
explicit status/inspect reads remain available without restarting observation.

Repositories are discovered beneath `~/Documents`, including grouped and nested
repositories. No registration is required. `/spec-sentinel root ~/Projects` saves a
different search folder in `<agentDir>/spec-sentinel/discovery.json`. The root can itself
be a repository. Optional legacy `add` enrollments still supplement discovery.

Frequent updates use the managed run index and runtime receipts; directory discovery is
cached for five minutes per session. The index is read during bounded reconciliation,
never watched. Chokidar recursively watches only canonical `.specs` trees with symlink
following disabled; repository roots and source trees are not watched. Discovery
reads directory metadata, skips hidden/dependency/build/cache folders and symlinks, and
has caps of eight levels, 2,000 directories, 20,000 entries and a two-second cooperative
budget. Limits and unreadable paths remain explicit coverage gaps. Canonical validation
still rejects linked-worktree spec copies. Repository identity queries are asynchronous,
time-limited and shared across sibling packages within each refresh to avoid blocking
Pi's main thread with repeated synchronous Git calls. Discovery grants no intervention authority.

The widget shows the workspace rows; when a single run is observed it collapses to
the header line because that run's own widget already shows it. `/spec-sentinel
inspect ID` names one run or condition by assignment id, workflow id, package or
condition id/kind. Chokidar events are coalesced at 250 ms and status is
reconciled every 15 s. `/spec-sentinel off` hides the widget and status and disposes
only this session's observers and timers; it never cancels, stops or messages
workers. The CLI equivalent is `node
~/.agents/scripts/spec-observe/cli.mjs sentinel status [--root PATH | --package PATH] [--format
text|json] [--agent-dir PATH]`, which works without a Pi session.

Coverage is `complete|partial|stale|unavailable` with explicit omission reasons;
missing, oversized or replaced sources stay unknown or stale, never healthy. No
model call, transcript read or recovery authority is introduced here: completion,
exit and silence remain non-acceptance facts.

## Global runtime modes

Start sentinel once from any directory, including a Pi session with no repository:

```text
/sentinel start
/sentinel observe
/sentinel shadow
/sentinel recover
/sentinel recover --model deepseek/deepseek-flash:max
/sentinel observe --root "/Users/name/Projects"
/sentinel status
/sentinel stop
/sentinel off
```

`/sentinel` is the native command; `/spec-sentinel` remains an alias. Bare invocation
and `start` mean observe; `stop` means off. For natural-language start/status/stop
requests, the `sentinel_lifecycle` tool accepts only `observe`, `status` and `off`
and invokes the same controller. It cannot arm shadow or recover; those require
an explicit native command. The tool returns bounded status, freshness and available
snapshot/dashboard paths, without source or transcript inspection or shell daemons.

Shadow runs bounded diagnosis and reports proposed
interventions; recover allows guarded continuation/cancellation. `deepseek/deepseek-flash:max` is the
diagnostic default. Root/model overrides apply to that invocation.
No operator-created policy, target workflow or expiry is needed. Repository discovery
uses `~/Documents` by default (or a legacy saved root), independently of Pi's cwd.

The monitor distributes its explicit mode through pi-intercom's native extension channel.
All connected coordinators with the updated runtime participate, including later joins.
Each coordinator resolves its own checkpoints and handles, preserving local action guards;
workspace scope never means adopting another process's disk PID or bypassing user holds.
Intercom's existing routing scopes remain in force. Disconnected, older and non-Pi sessions
remain observable from receipts but are not controllable endpoints. Global modes report
an unavailable broker rather than silently degrading to one-project recovery.

No timers, watchers, scans or sentinel UI start merely because Pi opens. Coordinators
register an inert communication capability. Explicit activation lasts until off, a mode
replacement, controller shutdown or connection loss, with no clock expiry. Off from a
participant requests global revocation; closing an ordinary participant leaves the
controller running. Switching to observe revokes global effects. An explicit mode command
can restart observation after off. Diagnostic and intervention reports return to the
monitor; ordinary control traffic neither enters transcripts nor starts model turns.

Retained default budgets are still two diagnoses and two actual effects per workflow;
monitoring itself does not expire. Global shadow action observations have separate
receipts and do not consume real action slots or prevent later recovery of that obligation.
All targets keep identity checks, duplicate prevention, diagnostic cooldowns, and conservative
handling of unknown action outcomes. A recover activation can resume an already-idle
coordinator only from its retained completed native boundary and freshly checked guards.

### Legacy policy compatibility

The existing `enable /absolute/policy.json` and `disable` interface remains supported for
scoped callers. Its file schema, eight-hour expiry and explicit scoped identity validation
are unchanged. Those requirements do not apply to the global runtime-mode interface.

## Provider recovery

Managed owners and editors using the `primalabs` provider recover transient request
failures in their existing native session. This includes the gateway's HTTP 400
`no healthy deployments` response and normal-stop responses containing only reasoning
or whitespace, with no answer or tool call. These empty responses and errors Pi does
not recognize receive three retries after 5, 10 and 20 seconds. Recognized errors first use Pi's configured
retry budget and backoff; those failed responses count toward the three retries,
so the extension does not add a second full budget. After exhaustion, the runtime
selects exactly `deepseek/deepseek-flash` and retains the thinking level and context
policy. A response with an answer or tool call ends the failure streak.
Authentication, billing, model configuration, context limits, aborts and failed
verification commands do not trigger this recovery.

The session records each retry and fallback; `runtime/events.jsonl` exposes them as
`provider_recovery` events with the worker role. Raw errors remain in the transcript
but are omitted from the next model request. Successful tool results and the original
assignment stay in context. No replacement process or step replay is launched.
The fallback remains selected for that retained session, including resume; it never
cycles back to the unavailable provider. Missing fallback configuration or failure
of the fallback stops normally. Cancellation interrupts the backoff, and writer
lease checks run again before continuation. This policy does not enable Sentinel
or change reviewer routing. Existing processes need a fresh launch to load it.

## Bounded continuation

When explicitly enabled in recover mode, the coordinator may propose exactly one
additional model turn at the Pi settle boundary. The handler admits only a completed
settlement with a ready open obligation, an exactly reconciled native input revision,
zero UI prompt depth, no `context.pendingMessages`, a nonblocking inbox, no nonterminal
or malformed declared worker, no active managed Runtime handle, and an active
authority that permits `continue`; prior handlers' `continue:true` and every explicit stop
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

## Diagnosis and guarded cancellation

Global shadow/recover modes enable diagnosis by default; only recover executes actions.
Legacy scoped policies can still select diagnosis separately. Diagnosis runs only for a complete repeated-failure incident with a
complete fingerprint through a bounded (at most 16 KiB) tool-free advisory packet, one
active job per coordinator, a five-minute cooldown, one attempt per incident generation
and at most two attempts per workflow; its JSON is labelled `note_verified:false` and
never grants authority.
Recovery cancellation is permitted only for the current repeated-failure incident with a
retained positive `cancel-candidate`/`repeated-unchanged-failure` diagnosis matching the
current complete checkout digest, reconciled input, nonblocking inbox, checkpoint
worker/checkout, the exact original in-memory Runtime handle/lease and an idle writer
slot with remaining capacity. A durable cancel intent is reserved immediately before the
existing `Runtime.cancel`; only confirmed process-group termination becomes `applied`,
while failed/unknown termination keeps the writer reservation and is never replayed.
Retained state lives under `runtime/sentinel/<workflow-id>/`: `verification-incidents.json`,
`diagnoses/<incident-id>.json`, and `intents/<id>.json` with `effect-slots/` and
`diagnostic-slots/`. A disk PID from another process is not an owned handle; the runtime
never adopts it, deletes locks, transfers an owner or launches a replacement. Shadow mode
writes `shadow-would-cancel` and leaves the worker alive. Cancellation/shadow notices return to the global monitor; no diagnosis or shadow
observation adds a model-visible conversation message.

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
They cover idempotence, conflicting writers (live and dead coordinators), a retained run on failed stop, the single-target limit, surviving
owner/editor descendants, cancellation recovery, shell timeouts, assignment deadlines,
provider failures, worktree creation from the target, and revocation during launch.
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
Each new verification receipt also generates a Markdown execution summary returned
as `verification_artifact`. It contains the command, observed revisions, exit status,
raw-log path, UTC `started_at`/`observed_at` and monotonic `elapsed_ms` (including any
managed server lifecycle). The learning's commands reuse these fields. Legacy timing
stays null. Reference the summary from a named evidence artifact instead of manually
transcribing execution metadata. Proof boundaries and applicability remain owner
judgments; a successful command never establishes independent acceptance.
`spec_verify` returns `receipt_id` and retains observed HEAD/dirty state, exit status and raw-log
path. A passed command is not automatically a passed EV: the owner maps it to the obligation
and states the proof boundary. Earlier/dirty-tree evidence requires applicability, not a rerun.
External evidence remains explicitly owner-reported with command, actual SHA and artifact.

Artifact paths are absolute, package-relative (a bare relative path resolves against the step target's worktree), `<repo id>:<path>` (in that target's worktree), or the legacy
`.specs/<slug>/<rest>` form, which maps to `<package folder>/<rest>`. `pr-url.json` is
`{ package_ref, targets: { <repo id>: { url, number?, branch?, mode? } } }`; the final checkpoint summary
uses the URL when the package has one target. With several targets, the final checkpoint stays open (`pr-missing: <ids>`) until every target has a URL in `pr-url.json`.

Process `state: completed` means the worker exited. `handoff.status: recorded` means its structured
record exists and matches the canonical learning. It does not accept implementation or independent
review. Missing/changed handoffs yield `handoff_incomplete`. Continued editing/checking invalidates the submission; resubmit afterward. Old attempts are
`legacy_unchecked` and retain their existing manual reconciliation route. No automatic repair loop
or new model dispatch is introduced.

`runtime/progress.json` is a generated ledger of attempts, handoffs, check-receipt counts,
review/fix artifact references and coordinator stage decisions. `spec_checkpoint` records the
remaining judgment-bearing stage status, next action, decisions and canonical artifact references.
Stage receipts live in `runtime/stages/`; preserve explicit holds/authority there or in their
referenced canonical records. Artifact presence is not a passing review. The existing
`run-ledger.md`, if present, remains a legacy source and is not overwritten.
Completing implementation or publication also requires successful handoffs for every
prepared step in `spec-steps.json`, including steps with no attempted run yet.

An explicitly started end-to-end coordinator registers `spec_workflow` after its workflow
checkpoint, with the user's whole objective, authority limits and final stage
(`implementation`, `work-tour` or `publication`). A native session entry retains this
contract across compaction and resume. At a completed, idle response boundary, unfinished
work receives a continuation only when the same coordinator has reconciled current input,
the inbox is clear, all declared workers are terminal, and its checkpoint is ready or
prematurely complete. Holds, blockers, errors, aborts and pending input prevent continuation.
Final completion requires all prepared step handoffs and a complete final-stage receipt;
publication additionally requires a recorded PR URL for every target. These facts preserve
the existing review and acceptance responsibilities; they do not certify those judgments.

Keep this objective to the stable outcome and authority limits. Progress, checkout
revisions and model routing come from canonical records and reconciled directions.
`update: {expected_revision, authority}` replaces obsolete wording after a reconciled
user/inbox change; `expected_revision` is the returned `objective_revision` (legacy
entries start at 1). The append-only replacement survives resume without replenishing
the current obligation's nudges. A stale revision is refused.

At most two continuations are allowed per unchanged obligation revision. The allowance
persists through resume and repeated registration. A repeated stall produces a visible
warning while retaining the unfinished objective. This is the coordinator continuing its
own work: it does not activate Sentinel observation, diagnosis or recovery, grant publication
authority, restart a closed process, or recover failed requests. Sentinel activation cannot
trigger this separate continuation path. Ordinary unregistered sessions remain unchanged.

Recording `spec_checkpoint` with stage `publication` (including the `spec-pr` alias) and status
`complete` also closes the package's sentinel workflows. For each workflow this coordinator
registered for the package (or, after a session restart, each `runtime/sentinel/<workflow_id>`
checkpoint it owns), the runtime resolves every declared worker still shown as active against
`runtime/runs/*.json` (matching run `id` or `assignment_id`; `completed`, `failed` and `cancelled`
map to worker states). If every worker is terminal, it records a `complete` sentinel checkpoint
with obligation `publication-complete`, the carried inbox outcomes, and the current native input
revision, so the observer moves the package to recently completed without a further prompt. A
workflow with a running or receipt-less worker, a `user-held` or `decision-required` state, or an
unresolved inbox direction is left unchanged. The tool result lists each outcome under `sentinel`;
a skipped active worker carries a `next` hint to reconcile it and record the final checkpoint
explicitly. Failure here never fails `spec_checkpoint`. `publication-draft` and other stages do not
trigger it.

The coordinator watches canonical learning/review/fix directories and runtime records, coalesces
notifications, and repairs missed events with a 15-second metadata reconciliation. History-index
and progress writes are serialized per process. Errors remain visible; the watcher never triggers
a model turn. Each model request gets one ephemeral current-obligation reminder, replacing its
predecessor, so compaction cannot remove the source of that reminder. Coordinator bindings are
persisted as Pi custom entries and restored on session resume. This is not a sentinel, daemon,
auto-restart loop, or guarantee that a closed session continues running.

Existing live Pi processes keep their loaded extension, and a reload can retain imported
module code. A fresh coordinator process and new assignments reliably load these changes;
verify the registered tools and retained workflow contract before claiming continuation is
active. Do not restart an active writer to pick up bookkeeping or continuation changes.

### Recent activity and public sentinel snapshots

Sentinel's default view filters out spec packages without any file or directory
modifications in the last 24 hours. Nested edits count; uncertain scans stay
visible. This does not mark work complete or change recovery authorization.
`/spec-sentinel status --all` (or `cli.mjs sentinel status --all`) includes history.
Inactive `.specs` trees stay watched so new activity brings them back into view.

An invoked observer exports an atomic, owner-readable JSON snapshot each refresh to
`<agent-dir>/spec-sentinel/<workspace-key>/observers/<observer-id>.json`.
`/spec-sentinel status` prints the path. Each observer has its own file; loading the
extension alone writes nothing. The versioned envelope carries publication time,
sequence, observing/off/closed state, mode, any read-failure note, and the existing
structured workspace snapshot. Consumers should check publication and coverage
timestamps because a crashed observer cannot mark its file closed. These snapshots
are read-only facts for dashboards and tooling, never recovery authority. See the
[skill](../../../skills/spec-sentinel/SKILL.md#json-snapshots-for-other-tools) for fields.

Sentinel isolates discovery, Git reads and Chokidar in a child process
with ignored terminal streams. Scans expire after ten seconds, retaining stale
facts and retrying after a cooldown; off/close stops that helper. The terminal
widget is bounded to eight short lines and unchanged observations skip redraws.
This contains scan/watcher hangs without affecting native recovery ownership.

The default view also excludes recorded completed workflows. A terminal step
receipt alone is insufficient; completion comes from a complete workflow checkpoint
or legacy ready-tour/publication records at the same commit. A subsequent dispatch
or noncomplete workflow checkpoint keeps reopened work visible. History remains
available with `status --all`. Active observers additionally check scoped canonical
PR publication records against authoritative merged PR metadata and the associated
local branch head (or confirmed branch absence). Before API calls, a bounded local
fallback can match the exact conventional PR merge commit on the fetched origin
base and its second parent to the current branch. It records local Git evidence
separately from remote metadata and rejects unpublished local merges or ancestry
alone. Both cold and active local cache reads validate the fetched base tip. Stale planned steps, learnings and
premerge worker states do not prevent lifecycle reconciliation; newer dispatches or
noncomplete postmerge checkpoints keep reopened work current. Observe mode keeps merge evidence in memory; shadow/recover may
persist only the dedicated canonical `sentinel-merge.json` lifecycle record. This
does not rewrite acceptance, worker receipts or workflow checkpoints. Reopened
work invalidates old merge evidence. Cold status never invokes merge commands.
See the dashboard documentation for polling, eligibility and viewer bounds.

Repository identity observation reads bounded Git metadata (`.git`, worktree gitdir,
`commondir`, and `HEAD`) directly, without spawning Git. A failed identity/discovery
read retains prior work with stale coverage instead of replacing it with a healthy
empty workspace. Isolated snapshots include `reader` PID, runtime/version and scan
duration to distinguish a current reader from an old observer. The managed runtime
index discovers active packages outside the default Documents tree automatically.

Interactive sentinel startup opens a visual dashboard backed by saved
snapshot JSON. The localhost service belongs to that explicit monitor activation;
mode changes reuse it, off/shutdown stop it, and extension loading remains inert.
`/spec-sentinel status` includes the URL. Dashboard failure does not stop monitoring.
The self-contained UI and manual viewer command are documented in
[spec-observe](../../../scripts/spec-observe/README.md#sentinel-dashboard).
The dashboard's explicit **Mark complete** action saves separate package lifecycle
metadata without stopping workers or changing acceptance evidence. The action
does not require complete monitoring coverage or a matching page revision.
Existing worker/checkpoint updates preserve the decision; a dispatch started after
the decision makes work current again.
