# Adjacent capabilities through a thin Sentinel router

Status: proposed architecture direction, not an implementation specification.

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

Pi supports `new_session` and `switch_session`; the latter loads a session file.
Sentinel can map its thread identifier to that file. This is a session transition,
not a thread ID attached to each independent prompt. See the
[Pi RPC command reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md).

A single reusable RPC process is a plausible starting point for serialized
conversations. Selecting another thread in the interface should not automatically
switch the backend while it is producing a response. The interface can display
stored history independently; sending a message in another thread must wait for
the backend or use another process. Concurrent responses would require additional
backends under this model.

Session switching must preserve the correct association between output and thread,
and the caller must check whether the switch succeeded or was cancelled. Workspace
context, working directory, tools, and extension configuration need explicit
handling; changing the conversation session is not proof that all execution context
changed with it.

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

These are conceptual boundaries; their storage schema and the relationship between
workspaces and kits remain to be designed. Avoid duplicate authoritative copies of
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

The current dashboard is not reachable remotely as built:

- It is a child of an explicit observe activation inside an interactive Pi session
  and stops when that session ends, when Sentinel is turned off, or when its
  controller shuts down. A fresh Pi session starts nothing.
- It binds to loopback and rejects any Host or Origin header other than `localhost`
  or `127.0.0.1` for its own port.
- Its one write action, **Mark complete**, requires the live local dashboard and a
  same-origin action token.

Remote reading therefore needs three changes, in order of necessity:

1. Keep the loopback bind and publish it through `tailscale serve`, so Tailscale
   terminates TLS and the tailnet ACL decides who can connect. Accept the tailnet
   hostname in the Host and Origin checks; do not bind to `0.0.0.0`.
2. Give the dashboard a lifecycle independent of any one Pi session, such as a
   launchd-managed observer process, so the information remains available when no
   interactive session is open. This is the same role change the routing proposal
   implies for Sentinel as a whole and should be designed once.
3. Decide whether **Mark complete** remains available remotely. Reading is low risk;
   the write action should stay behind the same-origin token and should reuse the
   same operator-decision guards regardless of where the request originates.

Observation remains read-only facts. Reaching the dashboard from another device does
not grant intervention authority, and a stale snapshot viewed remotely is no more
proof of a live observer than it is locally.

## Handoff and supervision

A typical flow is to discuss an idea in a thread, save a brief or assignment with
the relevant kit and artifact references, then launch an independent tmux agent.
The discussion remains available while the agent executes. Assignment results and
artifact references can return to the workspace without streaming the agent's
entire conversation into Sentinel.

Define the boundary between operator control and automatic intervention explicitly.
Attaching a terminal is not itself permission to intervene or proof that the
operator has taken control. A hold/takeover mechanism must coordinate those actions
and respect existing user stops, execution leases, and workflow guards.

Launching must also distinguish an existing live assignment from a retry. A missing
terminal, quiet output, or stale receipt does not prove that workers have stopped.
Recovery must confirm the relevant process and worker state before launching a
replacement writer. Agent completion remains distinct from acceptance or a passing
review.

The supervision controller must have a lifecycle independent of the RPC conversation
session being switched. Loss of the controller can end automatic intervention
without being interpreted as a request to stop independent agents. Restoring
observation does not by itself restore intervention authority.

## Existing foundation and remaining decisions

The current [Pi runtime](../pi/extensions/spec-runtime/README.md) already provides
workspace discovery, observation, diagnosis, guarded intervention, and communication
with participating coordinators. Its retained owner/editor sessions use fresh
processes per assignment; they are not persistent interactive terminals. The
proposed tmux path initially concerns the coordinator or standalone agent, not a
replacement for that internal worker lifecycle.

The next design decisions are:

- Workspace and kit storage, artifact ownership, and portable repository references.
- The launch contract and durable mapping between assignments and live terminals.
- RPC serialization, context isolation, and when additional conversation processes
  are warranted.
- Controller placement and explicit operator hold/resume behavior.
- Observer and dashboard daemon lifecycle outside a Pi session, and the tailnet
  exposure of the dashboard, including whether its write action is reachable remotely.
- How a future application presents threads, files, and agent status through these
  same interfaces.

The direction is to retain Adjacent's organization and conversation capabilities
while allowing agent execution to remain independently usable through Pi and tmux.
