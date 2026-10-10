# Adjacent capabilities through a thin Sentinel router

Status: shared contracts record. The contracts under "Settled contracts" below
are settled and owned by the named packages; implementation remains with those
packages. The surrounding rationale is the architecture direction, not the
implementation specification.

Bring Adjacent's core capabilities into a system where Sentinel routes work between
conversations, workspaces, repositories, and independently running agents. Keep the
heavy application layer optional and defer it: a richer interface can build on these
boundaries later without becoming the owner of agent execution.

The useful capabilities are organizing material around work, grouping repositories
through a kit, discussing that work in persistent threads, launching agents, and
revisiting their progress and results. They do not require recreating every agent's
conversation and terminal experience inside an application.

## Component responsibilities

| Component | Responsibility |
| --- | --- |
| Sentinel | Route requests, resolve workspace and kit context, launch or locate agents, and expose structured status and guarded supervision. |
| Pi over RPC | Serve threaded conversations presented by Sentinel or a future application interface. |
| Interactive Pi | Execute an agent assignment and provide its native terminal interface for direct interaction. |
| tmux | Host persistent terminals that can be attached to and detached from without stopping Pi. |
| Tailscale and SSH | Reach the host from other devices: SSH into tmux sessions, and proxy the Sentinel dashboard over the tailnet with device identity as the access boundary. |
| Workspace storage | Retain research, briefs, notes, artifact references, and associations among threads, kits, and assignments. |
| Repository and workflow records | Retain code, implementation specs, execution receipts, and acceptance evidence in their established locations. |

Sentinel should compose these capabilities through small adapters. The conversation
backend, terminal host, and presentation layer should not require one another to
remain alive for an independently launched agent to continue working.

## Two interaction paths

### Threaded conversations over RPC

Use RPC for discussions within Sentinel: exploring ideas, comparing research,
developing a brief, and preparing an assignment. Each thread has its own persisted
Pi session and associations with relevant workspace material and kits.

Settled (C-8, owned by adj5): each thread gets its own `pi --mode rpc` child,
started lazily in the thread's execution directory with
`--session-dir <workspace>/sessions/<thread-id>` and `--session-id <thread-id>`
for both new and existing threads. Never use `switch_session`. This removes every
switching hazard the earlier design listed: output cannot land in another thread,
a cancelled switch cannot receive the next prompt, and cwd-scoped tools,
extensions, and context files are correct by construction.

Response scheduling stays serialized: one in-flight model response across all
threads, with additional sends queued and given a visible waiting state. Raising
that limit later changes no contract. Framing splits stdout on LF only; Node
`readline` is not used because it also splits on U+2028/U+2029, which are valid
inside JSON strings.

A thread process exits (stdin closed) after `agent_settled` plus an idle period.
History always comes from the session file, so browsing a thread never requires a
live process. The thread record is `<workspace>/threads/<thread-id>.json` with
`thread_id`, `workspace_id`, `title`, `execution_dir`, `session_file`, context
references, optional model settings, and `created_at`.

This path retains a need for response streaming, history display, cancellation,
and error handling. Relevant Adjacent RPC code may be reusable, but the conversation
backend does not own the lifecycle of every execution agent.

### Independent agents in tmux

Starting an agent launches interactive Pi in a detached tmux terminal, with an
explicit assignment and execution directory. The operator can attach to the same
live instance, interact through Pi's normal interface, and detach while it keeps
working. Finishing a model response should leave interactive Pi available for
further conversation.

Launch in interactive mode. Wrapping an RPC or print-mode process in tmux does not
turn it into an interactive Pi session. Detaching preserves the live process;
quitting Pi ends it. tmux survives terminal disconnection, not machine shutdown or
process failure. Persisted Pi sessions support subsequent recovery, which is a
different operation from attaching to a live terminal.

Sentinel should retain a mapping among assignment, Pi session, tmux session/pane,
workspace, execution directory, and workflow identity where applicable. Structured
extension messages and durable receipts should drive supervision; terminal output
scraping and simulated typing should not become the primary control protocol.

## Workspaces, kits, and artifacts

Preserve the part of Adjacent that gives work a home outside an individual
repository. Research and planning can precede code, and a task can involve several
repositories.

- A **workspace** associates research, notes, briefs, specs or spec references,
  conversations, assignments, and resulting artifacts.
- A **kit** groups related repositories and describes their roles and shared
  context. It supplies context for work without making one repository the implicit
  home of every document.
- A **thread** records a conversation and its associated workspace context.
- An **assignment** records the work delegated to an agent, its relevant inputs,
  execution location, session identity, and results.

Settled (C-2 through C-5, owned by adj3):

- A workspace is one directory under a storage root, `<root>/projects/<id>/`,
  containing exactly one `kit.yaml` (version 1). The kit is the workspace's
  repository section; `repositories: []` is valid, so a workspace can exist before
  any repository. Cardinality is one workspace to one kit, and no second manifest
  lists repositories. New workspace-owned material lives in ordinary
  subdirectories (`briefs/`, `notes/`, `threads/`, `assignments/`, `sessions/`);
  existing `context/`, `sources/`, and `migration/` keep their meaning.
- The storage root resolves from `ADJACENT_STORAGE_ROOT`, else
  `~/Documents/adjacent-storage`. Status and startup never create it; only an
  explicit setup command creates missing layout, and it refuses when a needed path
  has the wrong type. Writes are additive only, and new-file publication is
  exclusive: a temp file is linked into place and `EEXIST` is refused (never
  `rename` as a no-clobber primitive). Kit edits go through an explicit operator
  preview/apply step, and `.adjacent/state.sqlite3` stays Adjacent-owned and is
  opened read-only.
- Workspace ids match `[a-z0-9][a-z0-9-]*` and are unique within one storage
  root; two directories declaring the same id make both invalid and visible.
  A directory/id mismatch on existing storage is report-only, and consumers use
  the physical canonical directory rather than reconstructing a path from the id.
  Repository ids are unique within one kit. Thread and assignment ids are full
  UUIDs and globally unique.
- A repository reference is `{workspace id, repository id}`. Resolution
  canonicalizes the kit's absolute path and reports `ok`, `missing`, or `not_git`;
  a missing repository keeps its association and is never replaced by another
  checkout. A present `remote` that differs from the checkout's `origin` is `ok`
  with a visible mismatch attention. An optional free-text `role:` is added per
  repository entry. Implementation specs stay in the repository's primary checkout
  `.specs/`; a workspace references them by repository id plus package-relative
  path and never copies them. Avoid duplicate authoritative copies of
artifacts merely to display them in Sentinel.

The existing implementation-spec contract remains in force: `.specs/` belongs in
the primary repository checkout, including when code runs in a worktree. External
research and briefs can feed or reference those specs. Moving implementation specs
outside repositories would require a separate workflow decision.

## Remote access from other devices

Two remote needs exist: interacting with a running Pi, and reading what Sentinel
observes. Both run on the one machine that hosts the agents, and both are reached
over Tailscale rather than exposed on a public interface. The machine must stay
awake and on power; tmux survives a dropped connection, not sleep, and in-flight
model calls fail when the host sleeps.

### Interacting with Pi

Tailscale SSH into the host, then attach to the assignment's tmux session. This is
the same live interactive Pi the launch created, so the operator sees its history,
can send prompts, and can detach without stopping it. Launching remotely is the same
launch contract run over SSH: create a detached tmux session in the execution
directory and start interactive Pi with the assignment. No network service beyond
sshd and tailscaled is required for this path, and no Pi RPC port is ever exposed on
the tailnet.

This is sufficient from a laptop or tablet terminal. It is workable but awkward from
a phone, which is the main reason the threaded RPC path remains in the design.

### Reading Sentinel

Sentinel exposes two forms of observation: atomic JSON snapshots per observer under
the agent directory, and a dashboard that reads those snapshots every few seconds
and renders packages, activity, obligations, incidents, coverage and freshness.
The standalone `spec-observe` CLI reads the same snapshots without Pi.

Settled (C-6 and C-9, owned by adj2 and adj4): one long-lived **Sentinel host**
Node process, outside any Pi session, owns read-only observation: the reader
child, its own snapshot publisher, and the dashboard. The dashboard binds the
fixed loopback port 4319. The host is installed as a launchd user agent only by
an explicit operator command that writes the plist; nothing installs it
implicitly. The host claims a single-owner record keyed by `{pid, process start
time}`; a live foreign owner blocks a second host, and a dead or reused PID is
reclaimed.

Intervention authority stays where it is today: an explicit native `/sentinel`
command inside an interactive Pi session, which may itself run in tmux. The host
never holds or restores intervention authority, and a host restart restores
observation only. Losing the host stops observation and the dashboard; it never
signals independent agents or tmux sessions. The native in-session observer and
its dashboard keep working unchanged.

Remote reading publishes the loopback dashboard through `tailscale serve`, so
Tailscale terminates TLS and the tailnet ACL decides who can connect. The
dashboard accepts the tailnet hostname in its Host and Origin checks and does not
bind to `0.0.0.0`. No Pi RPC port is exposed on the tailnet.

The one write action, **Mark complete**, remains an open question: whether it is
reachable remotely at all, and if so, how it reuses the same-origin token and
operator-decision guards, is unresolved.

Observation remains read-only facts. Reaching the dashboard from another device does
not grant intervention authority, and a stale snapshot viewed remotely is no more
proof of a live observer than it is locally.

## Handoff and supervision

A typical flow is to discuss an idea in a thread, save a brief or assignment with
the relevant kit and artifact references, then launch an independent tmux agent.
The discussion remains available while the agent executes. Assignment results and
artifact references can return to the workspace without streaming the agent's
entire conversation into Sentinel.

Settled (C-7, owned by adj4 with adj6 reconciliation): the assignment record is
created with exclusive create before any process starts, with states `launching`,
`live`, `launch_failed`, `launch_unknown`, and `ended`; `live` becomes `ended`
only after confirmed process exit. A separate storage-root-wide
 execution-directory reservation, keyed by sha256 of the canonical execution
directory and acquired atomically with a token, is retained by `launching`,
`live`, and `launch_unknown`. It is never reclaimed on age or a missing terminal
alone, only after both process and terminal absence are confirmed, and an
unreadable identity is treated as unknown rather than gone. Shortened tmux names
require full-assignment matching and refuse collisions, and at most one
`launching`/`live` assignment may exist per canonical execution directory. The
launcher does not take the `spec_dispatch` writer lease. A retry is a new id with
`attempt_kind: "launch-retry"` and `supersedes`, allowed only when the old tmux
session is absent and the old Pi process is confirmed gone. Recovery must never
terminate independent agents. RPC's advertised `sessionFile` is recorded even
before the file exists, and missing, unreadable, and created remain distinct
states.

Define the boundary between operator control and automatic intervention explicitly.
Attaching a terminal is not itself permission to intervene or proof that the
operator has taken control. A hold/takeover mechanism must coordinate those actions
and respect existing user stops, execution leases, and workflow guards.

Launching must also distinguish an existing live assignment from a retry. A missing
terminal, quiet output, or stale receipt does not prove that workers have stopped.
Recovery must confirm the relevant process and worker state before launching a
replacement writer. Agent completion remains distinct from acceptance or a passing
review.

The supervision controller must have a lifecycle independent of any RPC
conversation session. Loss of the controller can end automatic intervention
without being interpreted as a request to stop independent agents. Restoring
observation does not by itself restore intervention authority.

## Existing foundation

The current [Pi runtime](../pi/extensions/spec-runtime/README.md) already provides
workspace discovery, observation, diagnosis, guarded intervention, and communication
with participating coordinators. Its retained owner/editor sessions use fresh
processes per assignment; they are not persistent interactive terminals. The
proposed tmux path initially concerns the coordinator or standalone agent, not a
replacement for that internal worker lifecycle.

## Settled contracts

The contracts below are the corrected C-1 through C-10. Each names its owner
package(s); implementation belongs to those packages, and this document records
the shared contract rather than an implementation plan.

### C-1 Capability disposition

| Adjacent capability (module) | Disposition | Owner | Notes |
| --- | --- | --- | --- |
| Project catalog and kit manifests (`projects.ex`, `projects/kit.ex`) | Adapt | adj3 | Reimplement as a Node stdlib reader of the same directory format (C-2, C-3). |
| Content resolution and file preview (`projects/content.ex`, `file_preview*.ex`) | Adapt | adj3 | Extend the existing package-file authorization to workspace roots; no second file server. |
| Thread data layer, Thread process, command delivery and attribution (`threads.ex`, `threads/thread.ex`, `command.ex`, `record.ex`) | Replace | adj5 | Pi's own prompt/steer/follow_up queue plus the persisted session file replace the commands table; Adjacent's attribution rules are reference material only. |
| Pi adapter (`pi.ex`, `pi_ex`) | Replace | adj5 | Node child process with LF-only JSONL framing (C-8); argument lists, per-process cwd/env, no shell strings. |
| Session reader (`pi/session.ex`) | Adapt | adj5 | Extend the existing observer session reader; no second parser. Unreadable is never empty, a missing file is an empty session, and a torn tail is tolerated. |
| Single-owner claim (`threads/recovery.ex` `app_owner`) | Adapt | adj2 | Reuse the `{pid, start time}` identity claim for the Sentinel host (C-6). |
| Recovery walk that terminates recorded Pi on restart (`threads/recovery.ex`) | Replace | adj4, adj6 | Counterexample to preserve against: independent agents are located and adopted, never killed on controller restart (C-6, C-7). |
| Worker widget decoding (`threads/workers.ex`) | Replace | adj6 | Sentinel already observes `spec_dispatch` run records and process groups. |
| Thread observation, presentation, snapshot (`threads/observation.ex`, `presentation.ex`, `snapshot.ex`) | Replace | adj2, adj6 | Sentinel snapshots and dashboard. |
| Workflow projection (`workflows.ex`) | Replace | -- | Already owned by `scripts/spec-observe/sentinel.mjs`. |
| Bundled skills copy and fingerprint (`skills.ex`, `priv/agent`) | Replace | adj4 | Use globally installed skills; no bundle copy, so no drift fingerprint. |
| Skill and target selection (`home_live.ex` launch form, `Projects.targets/1`) | Adapt | adj4 | Assignment records skill, target and authority explicitly (C-7). |
| Model selection (`pi_model_picker.ex`, `pi_selection.ex`, `pi_model_default` table) | Adapt | adj4 | Assignment carries optional explicit provider/model/thinking; otherwise Pi settings decide. No default table. |
| Storage setup rules (`storage.ex`) | Retain | adj3 | Status never creates; only explicit setup creates; never deletes or truncates. |
| SQLite coordination store | Replace | adj3, adj7 | Files under the workspace root; the three existing thread rows are imported read-only by adj7. |
| Dictation (`transcription.ex`) | Defer | -- | Deferred scope. |
| LiveView application UI (`home_live.ex`, `thread_conversation_component.ex`, explorer/repository components, recovery feedback) | Defer | -- | Minimal Sentinel dashboard entry points only. |

### C-2 Workspace and kit relationship

A workspace is one directory `<root>/projects/<id>/` containing exactly one
`kit.yaml` (version 1). The kit is the workspace's repository section;
`repositories: []` is valid, so a workspace can exist before any repository.
Cardinality is one workspace to one kit, and there is no second manifest that also
lists repositories. New workspace-owned material lives in ordinary subdirectories
of the workspace (`briefs/`, `notes/`, `threads/`, `assignments/`, `sessions/`).
Existing `context/`, `sources/`, and `migration/` keep their meaning. Owner: adj3.

### C-3 Storage root, creation and write rules

The root resolves from `ADJACENT_STORAGE_ROOT`, else `~/Documents/adjacent-storage`.
Startup and status never create the root or any directory; only an explicit setup
command creates missing layout, and it refuses when a needed path has the wrong
type. Writes are additive only: create new files atomically in new paths, or
rewrite files the new system created. Never delete, rename, truncate, or rewrite
pre-existing Adjacent files, `kit.yaml` included, except through an explicit
operator command that shows the change first. Exclusive new-file publication is
mandatory: create a temporary file and `link()` it into place, refusing `EEXIST`;
never use `rename` as a no-clobber primitive. No kit edit bypasses the operator
preview/apply boundary. `.adjacent/state.sqlite3` is Adjacent-owned and opened
read-only. No program write into the store happens before the storage-root backup
prerequisite is resolved. Owner: adj3.

### C-4 Identity rules

A workspace id matches `[a-z0-9][a-z0-9-]*` and is unique within one storage root.
Two directories declaring the same id make both invalid and visible; neither is
chosen. Workspaces created by the new system use a directory name equal to the
id; an existing directory/id mismatch is reported, not renamed, and consumers use
the physical canonical directory rather than reconstructing a path from the id.
Repository ids are unique within one kit. Thread and assignment ids are full UUIDs
and globally unique. Owner: adj3.

### C-5 Repository references and roles

A repository reference is `{workspace id, repository id}`. Resolution uses the
kit's absolute `path`, physically canonicalized, and confirms it is a Git
checkout. Status is `ok`, `missing`, or `not_git`; a missing repository keeps its
association and is never replaced by searching for another checkout. When
`remote` is present and differs from the checkout's `origin`, status is `ok` with
a visible remote-mismatch attention. An optional free-text `role:` (for example
`app`, `marketing`, `design-system`) is added per repository entry.
Implementation specs stay in the repository's primary checkout `.specs/`; a
workspace references them by repository id plus package-relative path and never
copies them. Owner: adj3.

### C-6 Controller placement

One long-lived Sentinel host Node process, outside any Pi session, owns read-only
observation (the reader child plus its own snapshot publisher) and the dashboard
on the fixed loopback port 4319. It is installed as a launchd user agent only by
an explicit operator command that writes the plist; nothing installs it
implicitly. The host claims a single-owner record keyed by `{pid, process start
time}`; a live foreign owner blocks a second host, and a dead or reused PID is
reclaimed.

Intervention authority (shadow/recover) stays where it is today: an explicit
native `/sentinel` command inside an interactive Pi session, which may itself run
in tmux. The host never holds or restores intervention authority; host restart
restores observation only. Losing the host stops observation and the dashboard
and never signals independent agents, tmux sessions, or `spec_dispatch` workers.
The native in-session observer and its dashboard keep working unchanged; several
observers publish separate snapshot files. The host also owns discussion RPC
children (C-8); their loss interrupts a response but never an independent agent.

Ownership coordination uses only Node's stdlib `node:sqlite` (no npm dependency):
`BEGIN IMMEDIATE` transactions compare PID, process start time, and token; a
confirmed-dead owner is reclaimed and release requires a matching token. The host
stores `coordination.sqlite` under the canonical agent directory
(`spec-sentinel`), while adj4 derives its database uniquely at the physical
storage root (`.sentinel/coordination.sqlite`) with no agent-directory or
database override. No second authoritative workspace/thread/assignment database
and no writable Adjacent SQLite are introduced. Root coordination creation is
authorized additive state after the backup prerequisite is resolved; startup,
status, and default-root auto-setup never create it. False or degraded liveness
is unknown and refuses reclaim. Exact acquisition, publication, and release proof
belongs to adj2. Observer UUIDs remain per instance; host exclusivity does not
require overwriting another observer's snapshot. Owners: adj2 (host), adj6
(supervision).

### C-7 Assignment identity, launch, and mapping record

The assignment record `<root>/projects/<workspace>/assignments/<assignment-id>.json`
is created with exclusive create before any process starts. It carries the
assignment id (UUID unless supplied), workspace id, brief, skill, instructions,
optional provider/model/thinking, canonical absolute execution directory,
optional repository id, spec package and workflow id, publication authority,
attempt kind and `supersedes`, contract digest, derived tmux session
(`adj-<first 12 hex of assignment id>`) and socket, Pi session directory and
advertised file, Pi path/pid/start, brief sha256, optional project trust, launch
error, ended-observed time, and state and timestamps. Locating a tmux session is
a lookup by the derived name, never a scan.

States are `launching` to `live`, `launch_failed`, or `launch_unknown`, and
`live` to `ended` only after confirmed process exit. An interrupted `launching`
record stays `launch_unknown` until the derived tmux session and Pi process are
checked. Repeat with the same id and same contract digest returns the existing
record and current live status; the same id with a different contract is an
error.

adj4 also owns a separate storage-root-wide execution-directory reservation,
indexed by `sha256` of the canonical execution directory and acquired atomically
with a token and a full-assignment record. `launching`, `live`, and
`launch_unknown` retain it. It is never reclaimed on age or a missing terminal
alone, only after both process and terminal absence are confirmed; an unreadable
identity is unknown, never gone. Shortened tmux names require full-assignment
matching and refuse collisions. At most one `launching`/`live` assignment may
exist per canonical execution directory. The launcher does not take the
`spec_dispatch` writer lease, so a coordinator launched in tmux must still
acquire it for its own steps. A retry is a new id with
`attempt_kind: "launch-retry"` and `supersedes`, allowed only when the old tmux
session is absent and the old Pi process is confirmed gone. Recovery must never
terminate independent agents.

RPC's advertised `sessionFile` is recorded even before the file exists, and
missing, unreadable, and created remain distinct states. Owners: adj4 (launcher),
adj6 (reconciliation).

### C-8 Discussion RPC scheduling and context isolation

One `pi --mode rpc` child per thread, started lazily in the thread's execution
directory with `--session-dir <workspace>/sessions/<thread-id>` and
`--session-id <thread-id>` for both new and existing threads. Never use
`switch_session`. This removes every switching hazard: output cannot land in
another thread, a cancelled switch cannot receive the next prompt, and cwd-scoped
tools, extensions, and context files are correct by construction.

Serialization is a global limit of one in-flight model response across all
threads; additional sends queue with a visible waiting state. Raising the limit
later changes no contract. A thread process exits (stdin closed) after
`agent_settled` plus an idle period. History always comes from the session file,
so browsing never needs a live process. Stdout is split on LF only; Node
`readline` is not used because it also splits on U+2028/U+2029, which are valid
inside JSON strings. The removed switch/cancellation experiment is not part of
the contract.

The SessionManager boundary is explicit: its file is created on the first user or
assistant message, not on arbitrary metadata. Metadata-only appends do not
persist, and the advertised filename is not proof of a persisted session. Thread
record: `<workspace>/threads/<thread-id>.json` with `thread_id`, `workspace_id`,
`title`, `execution_dir`, `session_file`, context references, optional model
settings, and `created_at`. Owner: adj5.

### C-9 Remote access boundary

Services bind loopback; `tailscale serve` publishes the dashboard; the tailnet
ACL is the access boundary; no Pi RPC port is ever exposed; remote reach grants
no intervention authority. Remote launch and attach are the same CLI commands
over Tailscale SSH. Owners: adj2, adj4.

### C-10 Durable contracts record

The settled C-1 through C-9 replace the earlier "next design decisions" list as
the "Settled contracts" section of this document, written for a human reader.
Dependent package proposals cite `adj1 C-n`, and this committed document is the
shared reference. Owner: adj1 (this package).

## Observed compatibility evidence

Pi 1.1.0, verified through copied RPC sessions and the installed SessionManager:

- Copied version-3 history restores exactly through `get_messages`, including raw
  U+2028 and U+2029, under LF-only framing.
- Each RPC child keeps its own session id and session file and serves cwd-scoped
  commands without `switch_session`.
- A new UUID session advertises `<session-dir>/<timestamp>_<uuid>.jsonl` before the
  file exists.
- A metadata-only append creates no file; the first user append creates
  newline-terminated version-3 JSONL.
- Invalid and chmod-000 session copies exit nonzero with stderr.

Adjacent store, read read-only with `sqlite3 -readonly`:

- Three referenced threads resolved to three session files. Two threads share one
  session directory and are selected by thread id.
- All three files are version 3, with 77, 3, and 13 messages respectively.
- Every copy restored with an exact role/text projection through RPC.
- The session originals and the SQLite file digest were unchanged after the run,
  and no migration was needed.

tmux 3.8 on a unique socket:

- The short-lived launch helper exits while Pi stays running as a direct child of
  the tmux server.
- `extended-keys=on` and `extended-keys-format=csi-u` hold on that socket only.
- `/usr/bin/script` attach followed by `detach-client` preserves Pi pid, start
  time, pane, and server identity.
- Killing only the owned server leaves no owned process behind.

Observed create-on-open hazard: `pi --session <missing path>` starts successfully
with a fresh empty session. Callers must verify the session file themselves and
must never treat that success as restored history.

## Unverified assumptions

- No workspace-store write or import has been performed; the storage-root backup
  prerequisite still stands.
- Host ownership transactions, launchd installation, Tailscale exposure, and
  remote attach remain unobserved.
- The application UI remains unobserved.
- Multi-thread RPC serialization under load remains unobserved.
- tmux behavior on other machines remains unobserved.

## Decisions and unresolved authority

- The project-policy reconciliation supersedes the earlier configuration and
  storage objections to these contracts. Recording it here makes no project-policy
  change.
- The backup prerequisite for the storage root remains; no program writes into
  the store before it is resolved.
- tmux 3.5+ is now installed (3.8 observed) and belongs to operator setup.
- Remote write-action authority (whether **Mark complete** is reachable remotely
  and under which guards), deployment, and the application UI remain unresolved.

The direction is to retain Adjacent's organization and conversation capabilities
while allowing agent execution to remain independently usable through Pi and tmux.
