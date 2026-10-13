# Observe spec runs

This read-only CLI finds Pi sessions and measures orchestration without sending model
requests, executing logged commands, changing workers, or printing prompts and source
contents. Node.js is the only dependency.

## Sentinel dashboard

The dashboard is a Solid application with TypeScript components under
`frontend/src/`. It uses the existing Node HTTP routes and SSE thread stream.
Polling updates observed data; message and brief editors keep their own drafts
and mounted input elements.

The committed `dashboard.html` is the generated, self-contained deployment asset.
A host can pull the repository and serve it without installing frontend packages.
After changing frontend source, rebuild it:

```sh
npm ci --prefix scripts/spec-observe/frontend
npm run build --prefix scripts/spec-observe/frontend
```

The build checks TypeScript, bundles Solid and the styles, and writes
`dashboard.html`. Commit source and generated HTML together. Runtime assets do
not use a CDN. Snapshot import also works when the HTML is opened from disk.

Focused model tests run with `npm test --prefix scripts/spec-observe/frontend`.
The isolated browser journey runs with
`uv run --script scripts/spec-observe/frontend/browser-check.py` after starting
Chromium through the `uishot` skill. It uses temporary storage and simulated
workers to exercise polling, SSE, cursor selection, files, designs, dispatch,
retries, late responses and read-only imports. It replaces the old tests that
executed the handwritten renderer against a fake DOM; HTTP and file-boundary
tests remain in `dashboard.test.mjs`. The browser journey waits through real
five-second polls to detect editor replacement and reuses one isolated fixture
for its sequential interactions. Three independent desktop sibling checks cover the
retained journeys: `autocomplete-check.py`, `browser-handoff-check.py` and
`browser-session-check.py`. When `SENTINEL_EVIDENCE_DIR` names the package evidence
directory, each writes its `ev-3-autocomplete.json`, `ev-4-handoff.json` or
`ev-5-session.json` receipt and routes captures to `evidence/browser/`; otherwise
both fall back to `/tmp`.

In **Brief and assignment**, `/` suggests skills from the execution host's
installed Pi catalog, including configured user and project sources. `@` suggests
text files from the thread's selected repository and shared workspace material;
a whole-workspace thread searches its recorded repositories. Suggestions show
skill descriptions or file headings and source names. Arrow keys select an item,
Enter or Tab inserts it, and Escape closes the list. Enter accepts an open
suggestion before it saves the brief. Paths and email addresses remain ordinary text.

Selections are saved as canonical identities alongside the brief. Editing away a
selection marker removes its identity. The server resolves identities against the
target and captures selected skill instructions and file contents into the
assignment's brief snapshot. **What Pi will receive** shows this snapshot,
supporting-reference directories, source paths, and hashes before launch. The
preview digest covers the captured contents; a source edit requires a fresh
preview. Unsaved brief edits disable launch. Manually typed markers without a
selection remain ordinary prompt text.

Context supports up to 16 selections, 64 KiB per text file and 96 KiB total selected
contents. Binary files, generated session records, and outside-source symlinks
are excluded. Missing sources and unavailable Pi discovery remain visible;
suggestion queries do not start agents, load extensions, or install packages.
The browser implementation adapts Re-Story's composer reference contract and
file ranking for Solid's native textarea.

Focused reference checks run with
`node --test scripts/workspaces/references.test.mjs`. The autocomplete browser
journey runs with
`uv run --script scripts/spec-observe/frontend/autocomplete-check.py` using the
same isolated fixture. Its refresh wait protects cursor selection, and its delayed
searches protect against stale replies after edits or thread navigation.

In an interactive Pi session, starting `/spec-sentinel`, `observe`, `shadow`, or
`recover` starts an owned localhost dashboard and opens it in the default browser.
`/spec-sentinel status` prints its URL. `off` and session shutdown stop that service;
a status-only read after off does not reopen it. Loading Pi alone starts nothing.
Mode changes reuse the same dashboard. A failed browser launch leaves its URL
available to open manually, and a failed service launch does not stop observation.

The dashboard is a single persistent shell: a 196px rail links the seven destinations
**Specs**, **Epics**, **Agents**, **Conversations**, **Files**, **Designs** and
**Workspaces**, with the workspace scope control above them. Scope is either the
portfolio (`All workspaces`) or one concrete workspace kit; run and epic records match a kit
by its directory basename, while assignments match the kit id only, so a neighboring kit
cannot cross-match. Conversations, Designs and workspace Files require a concrete
workspace and otherwise render a searchable picker over the same catalog; package
Files are a portfolio exception (`source=package` plus an opaque object id) and need
no picker. Changing the scope clears incompatible object selections, and
Back/Forward as well as query history are honored: deliberate fields (`dest`, `ws`,
`id`, `tab`, `source`, `path`) push, while `q` and `filter` changes replace.

`frontend/src/route.ts` is the single hash-route owner for `dest`, `ws`, `id`, `tab`,
`source`, `path`, `filter` and `q`, encoded with `URLSearchParams`; an empty or
unknown destination canonicalizes to the Specs landing route. Examples: `#/specs`,
`#/workspaces`, `#/conversations?ws=fixture`, and the grammar example
`#/files?ws=alpha&id=fixture%2Fbrowser&tab=activity&source=spec&path=docs%2Fcaf%C3%A9+notes.md&filter=open&q=`.
The `id` value is a destination-specific opaque selection key; that example
illustrates encoding only and does not mean the route id is a package reference.

It reads existing JSON exports every five seconds, without new model
calls. Its file endpoints serve a package only when a published snapshot names it and it sits directly under `specs/` of a valid workspace (the workspace file gate). The imported file mode works without a server and exposes no mutation;
workspace surfaces need the live local dashboard. Local live session actions (copy the attach
command, end a session after identity confirmation) are the only worker-adjacent controls;
remote reads stay read-only under the same server action-token gating, and a scope
change never grants mutation authority. Task activity and obligation
text render Markdown emphasis, code, headings, lists and HTTP(S) links. Raw HTML
is displayed as text; other link schemes cannot execute. Existing public-hint
redaction and length limits still apply before display.

**Mark complete** in a current package's detail asks for confirmation, then saves
`sentinel-completion.json` in the package folder, bound to its `ws/slug` reference. The package moves to Recently
completed with an explicit **Marked complete** label. This records an operator's
lifecycle decision; workers continue and step evidence, checkpoints, and PR status
remain unchanged. Existing worker and checkpoint updates preserve the decision.
A dispatch started after the decision makes work current again. Removing the completion record also removes
that override on the next observation.

The action requires the live local dashboard and its same-origin action token.
It applies the operator's decision even when the displayed state has changed,
the coordinator process or worktree is gone, or lifecycle records are incomplete.
Canonical package authorization and symlink protection remain required; imported
snapshots are read-only. Saved completion appears immediately in the dashboard and
on subsequent Sentinel observations, without rewriting observer export files.
After installing this change, stop and restart Sentinel to load both the collector
and dashboard service.
A running record whose `coordinator_pid` is gone, or whose checkout is unavailable, is
labeled **Running unconfirmed** (`coordinator-gone` condition); it does not establish that a
worker is currently executing. The pid probe is host-local, so it assumes the observer runs on
the execution host.

The **Agents** view lists the tmux assignments observed under the configured
storage root. The list shows current rows first and groups ended or launch-failed
rows under **Recently ended**. Each row shows the full assignment UUID, one
display state — live, live (unrecorded), launching, launch unconfirmed, exited
(unrecorded), terminal lost, unknown, ended or launch failed — and a safe textual
next action (attach command, `adjacent locate <id>`, wait, do not relaunch,
history, or inspect recorded workers). Quiet session activity is informational
(no growth for 120 seconds); attached clients are presence only and never grant
control. Selecting an agent shows separate Execution, Lifecycle and Declared
evidence sections: Execution reports recorded versus observed state and coverage,
Lifecycle reports the linked workflow run, quiet, attachment and unconfirmed
workers, and Declared evidence reports a ready/blocked verdict at its declared
commit with `declared-artifact` scope, or `not-assessed` when no artifact was
read. Assignment coverage (`complete` or `partial`) explains missing probe reads.
The record view is read-only: it never invokes attach, takeover or resume and
never writes records. The local live session controls only copy the attach command
and end the session after the identity confirmation; the agent detail shows the
bounded last response, not the transcript, and remote or imported snapshots expose
no session controls. Older snapshots without `assignments`
simply show no agent rows.

Run cards and details show the assigned step’s position, name and total prepared
steps from the canonical primary package’s bounded `spec-steps.json` read. The
bar represents position in the sorted index (including sparse step numbers),
not accepted completion. Worker exit does not increase an accepted count.
Missing or invalid indices show unknown size; an empty index shows no prepared
steps. Snapshots expose these facts as `spec_progress`; `accepted_steps` remains
null because observation does not establish acceptance.

An active detail selection follows the package's current assignment on refresh,
so its progress advances when the next step starts. Filters appear as **Active**, **Blocked**, **Done**, and **Planned**.
Active is selected initially. Blocked includes current blocked or
decision-required obligations and current unresolved incidents; historical attempts
and generic coverage gaps stay available as evidence without becoming alerts.
The existing `attention` and `completed` filter links still select Blocked and Done.

**Planned** shows discovered package folders without an active obligation, an
attention condition, or confirmed completion. This includes folders without run
receipts and folders older than the activity window. Snapshots publish these
folders as `planned_packages`, separately from run and completion rows. Unreadable
lifecycle evidence prevents a folder from being classified as planned; workspace
coverage reports incomplete reads. Search and workspace scope apply to this view,
and planned folders can open their package files.

**Done** retains one entry per spec completed in the last seven days,
newest first, with its recorded completion time and completion basis. A complete
workflow checkpoint or matching ready-tour/non-draft PR publication establishes
completion; a worker exit alone does not. Reopened workflows, later dispatches,
unfinished workers and incomplete receipt reads prevent confirmed completion.
Completion alone does not establish merge status. A confirmed merged PR supplies
a separate `merged-pr` completion basis. Search also applies to this view.

Snapshots carry `recently_completed` separately from monitored `runs`, so history
does not create recovery conditions or consume the 50-assignment display limit.
History has its own 50-package cap and `completion_history` window/omission metadata;
older packages are checked after current run details, within the shared read budget.
One scan reads at most 16 MiB in total. Before any package is read, each package also
gets a 96 KiB floor (reserved up to half the total) for its current receipt, step index and
completion records, so earlier receipt-heavy packages cannot starve those lifecycle reads;
a package's unused floor returns to the shared pool when it finishes.
Recorded timestamps determine the window even when package files have older mtimes.
The dashboard uses authoritative observer snapshots, without accumulating browser
history. Older snapshots remain readable and explicitly show unavailable completion
history. Updated observers supply the collection on their next snapshot; an already
running Pi session needs to load the updated observer code first.

### Epics

Sentinel reads each workspace's epics through spec-location (`projects/<workspace>/epics/<slug>/epic.json`,
50 epics per workspace; records are read outside the byte budget) and derives each
member's status from the package facts it already collects, regardless of the
24-hour activity filter and the seven-day completion window. Members are package
slugs of the same workspace. The snapshot carries
`epics[]` with members, summary counts, `waiting_on`, `next` and per-epic coverage;
rows for member packages carry `epic`. An invalid record is a coverage reason and
never hides its member packages; a workspace without epics is normal. Sentinel never writes an epic record. Schema and
status rules: [docs/spec-epics.md](../../docs/spec-epics.md).
`cli.mjs epic lint --workspace W --epic S [--root PATH]` validates one record, rejects
`requires` cycles, and prints the dependency waves and missing members (exit 1 when invalid).
`cli.mjs epic wait --workspace W --epic S [--minutes N]` blocks until a member's status, attention
or launched session (`workspaces launch` assignment) changes, or N minutes pass, then prints every
member, the changed names and the ready members. Step progress alone does not end the wait.

Active observers check each target's entry in `pr-url.json`
(`{package_ref, targets: {<repo id>: {url, branch, base, mode, ...}}}`) against authoritative
GitHub PR metadata, in that target's primary checkout. A package has merged only when every
target's PR has; `merge.targets[]` lists each target's state and the package completes at the
latest `merged_at`. A package whose record omits a target stays unmerged (`missing-pr-record`). Missing stored branch/base fields are filled from that response;
when present they must match. The associated local branch tip must equal the merged
PR head, or the branch must be demonstrably absent. Loose and packed refs are read
without Git subprocesses. This also handles squash merges, rebased learnings and
branches deleted after publication.

Before an API lookup, Sentinel can confirm a conventional PR merge from fetched Git
history. The canonical GitHub origin repository must match the PR URL. Within the
newest 100 first-parent commits on `origin/<base>`, exactly one two-parent commit
must have the matching `Merge pull request #N from owner/branch` subject, and its
second parent must equal the current local associated branch head. Missing branch
metadata can come from that exact subject; missing base metadata requires the
unambiguous `origin/HEAD` default. An unpublished merge on local `main`, ancestry
alone, another PR/repository, an advanced branch or newer dispatch does not suffice.

This records `reason: local-pr-merge`, `evidence_source: local-git`, the merge commit,
fetched base tip and Git committer timestamp. It proves scoped integration in the
fetched repository history, not a fresh GitHub API response or acceptance. Squash,
fast-forward and unconventional merge messages still need API evidence, as do
first-time confirmations without a matching local branch. A later authoritative
unmerged response outweighs this local convention; it is refreshed when its poll
interval expires. Both active and cold cache reads reject a changed fetched base.

A confirmed merged PR records lifecycle completion, independently of acceptance.
Stale draft metadata, incomplete planned steps, missing/older-format learnings and
older running worker receipts cannot prevent that lifecycle check. Receipts and
checkpoints retain their recorded states. Dispatches newer than the merge,
noncomplete checkpoints newer than the merge and new branch commits keep reopened
work current. Unreadable/incomplete receipts or checkpoints cannot prove the absence
of reopened work; those remain unknown with a bounded `merge.reason`. Receipt
discovery examines up to 5,000 directory entries while retaining the separate
100-receipt cap, so verification logs and transcripts do not consume the receipt
allowance. Genuine entry or receipt truncation stays conservative. A package
without a scoped PR record is not associated with a PR by guesswork.

Each scan permits three local proof attempts and two seconds of local Git command
work, with each command capped at 750 ms. It permits three external PR checks and
six seconds of network work, with each call capped at 3.5 seconds. Both paths
respect their remaining budgets and an eight-second combined command-work cap.
Discovery/file-reading time does not spend that budget. Recorded local misses and API failures retry after
one minute, allowing later packages their turn; authoritative unmerged responses retry after ten minutes. Stable merged
evidence only needs a local ref check, including after the network budget is spent.
Historical receipt-state or premerge checkpoint reconciliation reuses that confirmed
PR/ref association; it does not force another API call. Newer work still invalidates
the confirmation. API failure reasons distinguish network, timeout, authentication,
rate limiting, missing client and malformed response failures; raw stderr is never
retained.
Observe mode caches results in reader memory. Shadow/recover may atomically persist
`sentinel-merge.json` (`{package_ref, targets: {<repo id>: record}}`) in the package folder, without changing receipts,
checkpoint acceptance or readiness artifacts. Cold status and the standalone
viewer never run merge commands. Package metadata changes only through the
explicit **Mark complete** action described above.

Package details list every file type in pages of up to 500 entries, within a
10,000-entry/12-level enumeration limit. **Load more files** reaches later pages;
truncation and read errors are visible. Reads accept regular files up to 8 MiB.
Links, traversal, unpublished packages and worktree copies are rejected. Images,
Markdown (including tables and fenced code), formatted JSON, YAML and text render
in the viewer; unsupported binaries download. Package-relative Markdown links
and images remain within the authorized package. Standalone HTML uses an opaque
sandboxed iframe with package-relative scripts/styles/images, no external resources, fetch requests,
forms or parent-page access. The selected viewer stays mounted across refreshes.
Missing tours are reported, and offline imports have no filesystem access.

Details show time since the first recorded dispatch and a duration for each step
attempt, including retries, waits and verification. Timing reuses the bounded
package receipts, including attempts omitted by the displayed-assignment cap.
It does not include work before the first recorded dispatch. Missing timestamps
stay unknown; terminal worker state does not establish spec completion. A complete
workflow checkpoint can stop the spec timer unless later work reopens it. Imported
or stale snapshots freeze unfinished durations at their observation time.

Attempt rows show an explicit dispatch reason when recorded and the handoff outcome
separately from process state. Older receipts show **Reason not recorded** rather than
guessing why they repeated. **Recorded unfinished workers** lists nonterminal workers
from the matching workflow checkpoint with that checkpoint's timestamp, so an earlier
step's fixer can be visible beside a completed implementation. These are recorded
states, not live process checks, and grant no intervention authority.

For an independent viewer:

```bash
node ~/.agents/scripts/spec-observe/dashboard.mjs
# Open http://127.0.0.1:4319/
```

Optional `--port` and `--agent-dir` override the port and Pi state directory.
Only localhost can access the page and state endpoint. Stop this manual
server with Ctrl+C; sentinel does not own or stop independently launched viewers.

`dashboard.html` contains its compiled Tailwind CSS and JavaScript, with no CDN or
build step. It can also open directly from disk: use **Import snapshot** to inspect
a saved observer JSON file offline. Live refresh requires the local service.

### Designs

The workspace detail lists the workspace's design packages
(`projects/<id>/designs/<slug>/design.json`, read through `/api/workspace-designs`:
up to 50 designs, 64 KiB per index) with posture and derived produced/captured
counts, and reports invalid indexes beside them. Selecting a design opens a screen
viewer in the file panel: previous/next by step, a width toggle from the declared
widths, the screen in the same sandboxed iframe as other workspace HTML, and the
index entry's person, job, kind, state, primary action, notes and deviations beside
it. Workspace HTML may load fonts from inside the workspace (`font-src 'self'`);
network access stays disabled. Read-only; nothing writes a design record. Contract:
[docs/design-packages.md](../../docs/design-packages.md).

### Thread briefs and assignment handoff

Selecting a workspace shows its discussion threads. The loopback dashboard and the
configured `--public-host` endpoint support thread reads, messages, brief editing
and assignment launch. Publish that endpoint through Tailscale Serve: the tailnet
ACL controls who can reach it. Forwarding or identity headers alone grant no access.
Writes require the endpoint's exact same-origin URL, the dashboard's thread action
token and JSON. Imported snapshots expose no message, brief or launch controls.
Package completion remains local-only.

**Create thread** starts a thread called "New thread" in the whole workspace or a
chosen repository. The thread's Pi runs in that directory and receives no kit or
project context. When the first message is sent, the host asks
`openrouter/inception/mercury-2.5` for a short title through a tool-less
`pi --print` call and saves it only if the thread still has the default title;
the open page updates without a reload. A failed or slow naming call leaves
"New thread" in place and never delays delivery. The first message's text is
sent to that model for naming.

Below the transcript and composer, the thread detail shows the brief editor and
the assignment handoff. **Save brief** publishes one canonical markdown brief for
the typed title and content through `/api/thread/save-brief`; the browser
generates the request UUID per save and reuses it when retrying an unchanged
draft after a failure. A conflict or any error keeps both fields, shows the
conflict text and returns focus to the save control. Saving publishes material
automatically; it never launches an assignment.
A visible status explains whether the brief is saved, awaiting launch, or started.
After saving, focus and the primary action move to **Preview assignment**; after
previewing they move to **Launch assignment**. Saving unchanged content again
keeps the existing request and preview instead of creating another brief.

**Preview assignment** calls `/api/thread/preview-assignment` with the saved
brief and shows the resolved target, execution directory, brief, model and the
64-character `contractDigest` before anything starts. **Launch assignment** sends
that exact `expectedDigest` to `/api/thread/launch-assignment`; the service
refuses when the fresh resolution no longer matches. A refused launch (409)
keeps the preview visible, marks it stale, disables Launch and requires a new
preview, so an operator can never dispatch a stale contract. Repeating the same
assignment ID is idempotent and does not spawn a second session.

After a launch the result card shows the assignment ID, recorded state,
attention and a read-only anchor; the page never fetches the assignment
automatically. **Discuss result** only fills the composer with a summary draft.
Nothing is sent or launched until the operator reviews the text and presses the
existing **Send** control, which uses the queued-message path.

## Observe-only host (operator)

One long-lived, authority-free host process observes every enrolled/discovered
repository and serves the same dashboard on loopback. It is separate from Pi:
it arms no policy, starts no observation workers and never opens a browser. The
composed local discussion service starts a Pi child only for an explicit
operator **Resume** or **Send**; it never sends provider prompts or deploys on
its own. Its localhost dashboard keeps the existing local **Mark complete**
write for the operator, while remote reads are local-only and cannot complete.
Generic workspace-file routes neither list nor serve the private `threads`
records; only the dedicated operator thread routes read them.

```bash
# Ordinary foreground use; replace /absolute/Projects with a real directory.
node ~/.agents/pi/extensions/spec-runtime/sentinel-host.mjs --root /absolute/Projects
```

Optional flags: `--agent-dir PATH` (default `PI_CODING_AGENT_DIR` or
`~/.pi/agent`), `--port N` (default 4319), and `--public-host NAME` (optional
normalized DNS name). The observation scope comes from `PI_INTERCOM_SCOPE_ID`
(default unset). `--port 0` binds an ephemeral loopback port and is the useful
choice for isolated tests, and the printed receipt reports the actual URL.
Invalid `--root`, `--public-host`, `--port`, unknown flags, duplicates and
missing values exit nonzero before any observation effect; importing the module
creates nothing.

Workspace browsing reads the storage root from `ADJACENT_STORAGE_ROOT`, defaulting
to `~/Documents/adjacent-storage`. A host installed through launchd must set
`ADJACENT_STORAGE_ROOT` in the plist's `EnvironmentVariables` dictionary when the
root is not the default, because launchd starts the host with a minimal environment.

Ownership is one keyed claim per canonical agent directory, independent of scope
or dashboard port: a second host for the same real agentDir, including through a
symlinked alias, is refused while the live owner holds
`<agentDir>/spec-sentinel/coordination.sqlite`. The store uses Node's
experimental `node:sqlite`; Node v24.9 is the current implementation target and
the experimental warning is retained. SIGTERM/SIGINT shutdown is bounded. The
host prints exactly one JSON line
`{type:"ready",state,snapshot_path,dashboard_url,dashboard_state,discussion_state}`
after initialization; `dashboard_state` and `discussion_state` are `ready` or
`unavailable`, and an unavailable dashboard is reported to stderr with a null
URL while observation continues.

Observation publishes one snapshot file per observer under
`<agentDir>/spec-sentinel/<workspace-key>/observers/<observer-id>.json`. The
receipt's `snapshot_path` names the current file; shutdown writes `state:
"closed"` with the same observer UUID. The reconcile heartbeat is referenced at
15 s; `published_at`, `sequence` and `snapshot.coverage.observed_at` advance
while the host lives. A stale `observing` file is never proof that its monitor
is alive; confirm the recorded PID/start identity before acting. Snapshots older than the 1 hour `OBSERVER_RETENTION_MS` window are pruned by the publisher and withheld by the dashboard, while live 15 s refreshes stay fresh.

The dashboard keeps the existing local/remote boundary: loopback requests get
the same-origin action token and normal completion, while requests classified
remote (public `Host`/`Origin`, or forwarded headers such as `x-forwarded-for`)
receive `completion:"local-only"`, no completion token, and a 403 on completion POST.
`--public-host` authorizes thread operations for that exact HTTPS endpoint and
exposes a `thread_action_token` in state responses; it does not grant package
completion or automatic recovery authority. It does not configure Tailscale Serve,
TLS or any forwarder.

An empty temporary root avoids inherited live-observe lookups. With a real
root, host observation also performs the existing read-only local Git PR
evidence and GitHub merge lookups described above; it grants no publication
authority.

### Operator-only launchd installation

The following commands are **not** executed by the host, its tests or this
repository. They require a separate explicit operator decision for the target
machine. Resolve the real paths first:

```bash
command -v node
node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' ~/.agents/pi/extensions/spec-runtime/sentinel-host.mjs
```

Write the plist (replace `<NODE>`, `<ENTRY>`, `<ROOT>`, `<HOME>` and optionally
`<AGENT_DIR>`/`<HOST>` with the resolved absolute values; launchd does not expand `~`). No credentials belong
in this file; keep the launchd environment minimal and resolve `PATH` for the
observation lookups (`gh` is only needed for GitHub merge evidence):

```bash
cat > ~/Library/LaunchAgents/local.spec-sentinel.host.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.spec-sentinel.host</string>
  <key>ProgramArguments</key>
  <array>
    <string><NODE></string>
    <string><ENTRY></string>
    <string>--root</string><string><ROOT></string>
    <string>--agent-dir</string><string><AGENT_DIR></string>
    <string>--port</string><string>4319</string>
    <string>--public-host</string><string><HOST></string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string><HOME>/Library/Logs/spec-sentinel-host.out.log</string>
  <key>StandardErrorPath</key><string><HOME>/Library/Logs/spec-sentinel-host.err.log</string>
</dict>
</plist>
PLIST
```

Placing the file is not loading it. Loading and removal require separate
operator authority:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.spec-sentinel.host.plist
launchctl bootout gui/$(id -u)/local.spec-sentinel.host
rm ~/Library/LaunchAgents/local.spec-sentinel.host.plist
```

### Operator-only systemd installation (Linux)

The Linux equivalent is a systemd user service. Like the launchd plist, it is an
operator decision for the target machine and is not installed by this repository.
First run `~/.agents/sync.sh`, which installs the extension's npm dependencies, and
start the host once in the foreground to confirm the `ready` line.

The host needs Node 22.19 or newer (`node:sqlite`). Pin that Node's path in the unit,
because systemd does not read the login shell's environment, and a distribution's
`node` is often older (Ubuntu 24.04 ships 18). Pi's installer keeps a suitable Node at
`~/.local/share/pi-node/current/bin/node`, a link that survives its updates. `PATH`
must reach `git`, and `gh` when GitHub merge evidence is wanted. Omit `--public-host`
when the dashboard is not served over Tailscale. The storage root comes from the
saved configuration (`cli.mjs setup --save`). The full host setup is in
`docs/linux-host-setup.md`.

```bash
TSNAME=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/spec-sentinel.service <<EOF
[Unit]
Description=Spec Sentinel host
After=network-online.target

[Service]
ExecStart=$HOME/.local/share/pi-node/current/bin/node $HOME/.agents/pi/extensions/spec-runtime/sentinel-host.mjs --root $HOME/Documents --port 4319 --public-host $TSNAME
Environment=PATH=$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure

[Install]
WantedBy=default.target
EOF
```

Load, inspect, and remove it with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now spec-sentinel
loginctl enable-linger "$USER"     # keep running without a login session
systemctl --user status spec-sentinel
journalctl --user -u spec-sentinel -f
systemctl --user disable --now spec-sentinel
rm ~/.config/systemd/user/spec-sentinel.service
```

Each machine runs its own host with its own agent directory, so a Mac and a Linux
host do not contend for the ownership claim. Each one observes only its own
checkouts.

### Operator-only Tailscale Serve

Serve publishes the loopback dashboard over the tailnet; the personal tailnet's
ACL decides who may connect, and the machine must stay awake for availability.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4319
tailscale serve status
tailscale serve reset
```

On Linux, `tailscale serve` needs root unless the user is the Tailscale operator.
Run `sudo tailscale set --operator=$USER` once, or prefix the commands with `sudo`.
The dashboard is then at `https://<machine>.<tailnet>.ts.net/`; pass that name as
`--public-host`.

Never enable Funnel for this dashboard. A `--public-host` argument only matches
the Serve hostname in Host/Origin checks; it performs no Serve or ACL change.
`tailscale funnel status` should show no enabled funnel and `AllowFunnel` false.

Later required operator checks, not part of this repository and not run here:
a second normal or tagged tailnet device (where permitted) must show an HTTPS
state response with no token and `completion:"local-only"` plus a refused
completion; the listener and Serve mapping must remain loopback-only with no
Funnel; and an authorized disposable host restart must show a new exact host
identity, a fresh observer UUID and unaffected independent processes. Each check
requires separate operator authority for its named target.

## Workspace sentinel status

```bash
node ~/.agents/scripts/spec-observe/cli.mjs sentinel status [--root PATH | --package REF|PATH] [--format text|json] [--agent-dir PATH]
```

Text output is the default. `--agent-dir` defaults to `PI_CODING_AGENT_DIR` or
`~/.pi/agent`. Packages come from the storage root (`ADJACENT_STORAGE_ROOT` or the saved
root): every `projects/<workspace>/specs/<slug>` is observed, with its targets read from
`locations.json` (a missing or unreadable file is the coverage reason `locations-unavailable`).
`--package` takes `ws/slug` or a package folder and limits the read to that package and its
workspace's epics. Repository discovery runs only to find legacy locations: repositories are
discovered recursively beneath `~/Documents` or the root saved with `/spec-sentinel root ~/Projects`
in Pi, and enrolled with `/spec-sentinel add <repository>` (primary checkouts only). A repository
with untracked `.specs/` entries yields one `legacy-location` attention row (snapshot `attention[]`)
with the remedy `spec-location migrate --workspace <ws>`, or "add the repository to a kit" when it
is in no kit. A `.specs/` folder is never read as a package. `--root PATH` overrides discovery for one CLI call.

Pi caches discovery for five minutes and uses the managed run index and receipts for
frequent updates. The index is read, not watched. Chokidar watches only each workspace's
`specs/` and `epics/` directories recursively without following symlinks outside them. Directory scans skip hidden, dependency/build/cache and symlink
children and are bounded by depth, entries, directory count and cooperative elapsed
budget. Incomplete coverage is reported. The reader locates packages through spec-location;
observation never grants recovery authority or makes a model call. Existing
`list|runs|report|metrics` commands are unchanged.

The dashboard keeps workflow state separate from worker execution. The latest
assignment remains under **Active** when its worker has completed but its workflow
still has a ready, waiting, blocked, held, or decision-required obligation. Historical
completed attempts stay historical. For example, a ready workflow is labelled
**Ready for next action**, while the detail preserves the worker's completed status.

## Workflow metrics

```bash
node ~/.agents/scripts/spec-observe/cli.mjs metrics --package <storage root>/projects/<workspace>/specs/<slug> --format text
node ~/.agents/scripts/spec-observe/cli.mjs metrics --package <storage root>/projects/<workspace>/specs/<slug> --all-sessions
```

In Pi, `/spec-metrics <storage root>/projects/<workspace>/specs/<slug>` displays the same summary without
a model turn. Restart or reload an idle observer session to load the new command;
the CLI works immediately while an existing implementation continues. Do not restart
the owning coordinator merely to observe: its shutdown cancels managed workers.

The default is the latest recorded coordinator session. `--session ID|PATH` selects
an earlier coordinator; `--all-sessions` covers recorded resumptions. JSON is the
default output and can be redirected to a snapshot file for later comparison.
These reports reuse native Pi transcripts and runtime events; no new model requests,
background polling or logging of hidden reasoning is introduced.

Reports distinguish:

- **Observed process span:** first coordinator user message through last observed
  activity across selected workers, including human pauses. Time through the snapshot
  is separate; completion is never inferred from a quiet or exited agent.
- **Step attempts:** actual runtime start/end, recorded state, first-editor delay and
  editor assignments. Retried steps remain separate; review/fix work outside managed
  dispatch is not invented as step time.
- **Role/model calls:** persisted assistant responses (including errors) and tool
  submissions counted separately. Retained sessions are filtered to selected run
  windows. Async reviewers/scouts are discovered under linked session paths.
- **Model response time:** native message start through persistence, including provider
  and network time. Timing coverage is explicit. This is not total agent runtime.
  Tool submission-to-result waits are upper bounds and include queueing; delegation
  waits are separate. Parallel times overlap, so do not sum them into elapsed time.
- **Tests:** shell-tool submissions containing recognized runners, plus the number of
  recognized commands inside them. This is a heuristic, not individual test-case counts
  or proof every conditional command started. Custom wrappers may be missed. Reading
  test files, mentioning commands in quoted prose, and polling an existing command
  are not counted as fresh tests.
- **Cost/tokens:** provider-reported values and coverage, not billing totals. Missing
  pricing stays unknown; a reported zero can mean the model was unpriced.
- **Mercury/clerk use:** actual model response counts, not configured availability.

Missing, partial and bounded transcripts remain explicit coverage gaps. No acceptance
verdict, causal performance claim or model assignment is changed by telemetry.

Focused checks: `node --test scripts/spec-observe/metrics.test.mjs scripts/spec-observe/core.test.mjs`

Find recent managed runs without knowing their package or reading transcripts:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs runs --limit 10
```

This reads the small pointer index in `~/.pi/agent/spec-runtime`, newest file update
first, and returns each run ID, package, manifest, and parent session path. Use
`--index-root PATH` for another installation. Index reads are capped at 64 KiB per
record and 1,000 candidates; the output reports truncation or malformed records.

For a managed run, use its canonical package from that list. The runtime records parent, owner, and
editor session paths, so future observation does not need manually pasted nested paths:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs report --package <storage root>/projects/<workspace>/specs/<slug>
```

For older runs, discover root sessions from `~/.pi/agent/sessions`, then select a session
ID or absolute path. An optional exact `--cwd` selects the working directory recorded
in the root session header (often the directory where Pi was opened, not the worktree):

```bash
node ~/.agents/scripts/spec-observe/cli.mjs list --limit 10
node ~/.agents/scripts/spec-observe/cli.mjs report --session SESSION_ID
```

`--sessions-root PATH` supports an alternate Pi session directory. `--max-mb N` bounds
each transcript read (default 64 MiB); truncation and malformed/partially written lines
are reported. Discovery reads at most 64 KiB of each candidate header and does not follow
directory symlinks. It still enumerates the session directory; use `--package` for a
small, stable scope. Missing files during a live rotation can require another snapshot.

Reports include parent/worker links, explicit write-tool and dispatch-attempt timings,
tool/status counts, observed model changes, reported token/cost totals and categorized
provider errors. First child creation is measured separately from dispatch attempts.
The origin is the first user/custom message, falling back to session creation. A
resumed session therefore measures its recorded history, not automatically its newest
goal. Managed records expose each run's start/finish timestamps and state separately.
Managed event files also supply per-run event counts, editor-start latency and each
editor assignment's start/finish/duration within that run, even when session files are
reused. A missing finish stays unknown. Runtime records remain reportable before any
session header exists, including failed launches. These per-run event metrics are the
comparison source; transcript totals describe the retained session history. Event
reads are bounded to their first 4 MiB and explicitly report truncation.

These are transcript observations, not proof of process liveness or successful edits.
Shell writes are not inferred; the first write tool might create a process note rather
than code. Reported zero cost may mean an unpriced model; missing cost stays `null`.
Cached tokens are repeated input across requests, and reasoning can overlap output.
Do not sum token categories or equate their total to unique context. Free-form errors,
results, shell commands and prompts stay in their original logs. Reports do contain
local paths, session IDs and model names; review before sharing outside the project.

## Compare interventions

Keep a baseline report and a report after one intervention in the existing local
experiment ledger. Record the package/step, revision, models, environment warmth,
intervention, first-dispatch/first-write latency, step duration, status-call count,
provider errors, reported cost coverage, and independent review/acceptance outcome.
Compare equivalent work; separate provider timeouts from orchestration overhead.
Lower latency without preserved acceptance and review quality is not an improvement.

Observation is passive and opt-in. Take a snapshot at dispatch, step completion, and
review completion, or at a finite agreed interval while actively observing a run.
This command does not install a background listener, and a chat session cannot promise
to monitor future runs after it ends. Do not repeatedly read full transcripts when
runtime events or compact snapshots answer the question. Propose the next intervention
after a completed comparison; do not rewrite instructions or steer live workers merely
because a metric worsened. Never use production work as an uncontrolled optimization
loop or relax required review/testing to improve measured speed.

Focused parser/discovery checks:

```bash
node --test scripts/spec-observe/core.test.mjs
```

Metrics recognize native `subagent-spec-clerk-<uuid>-<number>` session names as
clerk work. They report PR submission only from `pr-url.json` with schema version 1,
kind `pr_submission`, a `package_ref` matching the package, and a target entry with `url`, actual
`submitted_at` and the selected coordinator's exact `parent_session`. Legacy or differently bound receipts remain
unmeasured. Coordinator completion is reported separately from the existing fenced
`outcome: published` summary with matching `spec-folder`, an HTTPS PR URL and
`blocker: none` in a normal final text response. This records a claim, not independent
acceptance. Thinking, worker exits and informal completion prose never create a
milestone. Time after the first matching completion report is subsequent activity;
observed span and snapshot time remain available and include pauses.

Literal `bash`/`sh`/`zsh`/`dash -c` wrappers (including `bash -lc`) are inspected without
executing them, to a maximum nesting depth of four. Dynamic shell bodies remain unknown.
`test_command_calls` counts submissions containing recognized test runners;
`test_command_results` counts corresponding tool replies, `test_command_failures` counts
reported tool/command failures, and `test_commands_with_exit` counts structured exits.
These are command-level observations: conditionals, setup failures and wrappers can
prevent the actual suite from starting. Neither a returned reply nor a zero outer exit
code establishes that tests passed. Raw logs remain the evidence for that judgment.

### Assignment response status and terminal controls

An open Pi process is shown as **Session open**, not proof that work is still
running. A bounded read of its identity-validated session tail distinguishes
**Working**, **Idle · response finished**, and **Response interrupted**. Idle
requires a normal final assistant response with text and no pending tool call.
A later user message or tool operation clears it. Incomplete, changing, oversized
or unreadable output leaves response status unknown. Quiet time alone never
proves completion. A finished response is not workflow acceptance or proof that
implementation is complete. The last response is available in the agent detail.

The agent detail also shows a copyable SSH attach command, a local command for
operators already on the host, and **Ctrl+B, then D** detach instructions.
**End session…** opens a confirmation explaining that the terminal and its agent
will stop while saved files and the transcript remain. Cancellation sends no
request. The confirmed action revalidates the unique assignment, reviewed
process identity and exact tmux UUID/pane, then checks the identity again inside
tmux before killing only that session. An unknown or replaced identity refuses
the action; the default server and other assignment sessions are untouched.
Process exit must be confirmed before the record becomes ended.

`GET /api/assignment-session?assignment_id=…` resolves current terminal details.
`POST /api/assignment-session/end` requires the operator endpoint's exact Origin,
JSON, action token, assignment ID, reviewed identity and explicit confirmation.
Both routes use the configured storage root, never browser-supplied paths.
Loopback and the configured Tailscale Serve endpoint support these controls;
imported snapshots do not. Termination retries are idempotent after verified exit.

Focused verification: `node --test scripts/spec-observe/session-activity.test.mjs
scripts/spec-observe/session-routes.test.mjs`, the `session controls end only`
case in `scripts/workspaces/launch.integration.test.mjs`, and
`uv run --script scripts/spec-observe/frontend/browser-session-check.py`.
## Package dev servers

Configured workspaces expose Start dev server, Stop dev server, and a Tailscale link
in live package details. See [Package dev server previews](../../docs/dev-server-previews.md)
for host setup, the Compose contract, private runtime state, and cleanup behavior.
