# Observe spec runs

This read-only CLI finds Pi sessions and measures orchestration without sending model
requests, executing logged commands, changing workers, or printing prompts and source
contents. Node.js is the only dependency.

## Sentinel dashboard

The dashboard is a Solid application with TypeScript components under
`frontend/src/`. It uses the existing Node HTTP routes and SSE thread stream.
Polling updates observed data; message and launch editors keep their own drafts
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

Focused model tests run with `npm test --prefix scripts/spec-observe/frontend`,
including the pure `src/conversations-state.test.ts` owner cases for
selection/view/availability decisions (EV-1) and retained drafts and prepared
seeds (EV-6). The shared isolated browser journey runs with
`uv run --script scripts/spec-observe/frontend/browser-check.py` after starting
Chromium through the `uishot` skill. It uses temporary storage and simulated
workers to exercise polling, SSE, cursor selection, files, designs, dispatch
and read-only imports. It replaces the old tests that executed the handwritten
renderer against a fake DOM; HTTP and file-boundary tests remain in
`dashboard.test.mjs`. The browser journey waits through real five-second polls
to detect editor replacement and reuses one isolated fixture for its sequential
interactions. The **Conversations** destination keeps its own isolated check,
`conversations-browser-check.py`: its `route-drafts` and `journey` cases cover
the production route/draft/send/transcript path (EV-3), `view-states` covers
connection and view states (EV-4), `response-states` covers responses, queues
and action gating (EV-8), and `new-thread` covers addressable creation (EV-7);
`browser-handoff-check.py --section thread` retains the launch-thread handoff
and one-use prepared text (EV-5). Three independent desktop sibling checks cover
the remaining journeys: `autocomplete-check.py` (launch-brief autocomplete at
1440x1100), `browser-handoff-check.py` (brief, review, result, thread-bound and
the direct Agents -> workspace -> brief -> review -> launch journey) and
`browser-session-check.py`. When `SENTINEL_EVIDENCE_DIR` names the package evidence
directory, each writes its receipt (`conversations-browser-<case>.json`,
`ev-12-thread.json`, `ev-3-autocomplete.json`, `ev-4-handoff.json` or
`ev-5-session.json`) and routes captures to `evidence/browser/`; otherwise
each falls back to `/tmp`.

In the launch brief (`#/launch?ws=<workspace>&tab=brief`), `/` suggests skills
from the execution host's installed Pi catalog, including configured user and
project sources. `@` suggests text files from the draft's retained target: a
whole-workspace draft searches the shared workspace material and every checked
out repository in the kit, while a repository target searches that checkout.
Suggestions show skill descriptions or file headings and source names. Arrow
keys select an item, Enter or Tab inserts it, and Escape closes the list. Enter
accepts an open suggestion before it saves the brief. Paths and email addresses
remain ordinary text.

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
searches protect against stale replies after edits or launch-context changes.

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

The Files destination addresses four sources with `ws`, `source`, `id` and `path`:
workspace `#/files?ws=<workspace>` (optionally with a selected `path=`),
registered context `#/files?ws=<workspace>&source=context&path=<workspace-relative>`,
repository `#/files?ws=<workspace>&source=repository&id=<repository-id>&path=<checkout-relative>`,
and package `#/files?source=package&id=<package>&path=<package-relative>` (the
portfolio exception that needs no `ws`). Workspaces routes available registered
context and repository artifacts here, while briefs and notes stay workspace-source
paths. Listings page up to 500 entries within a 10,000-entry/12-level enumeration
limit and report truncation and read errors; each read serves one regular file up
to 8 MiB. Package-relative Markdown links and images resolve through the
package-view address (`packageViewUrl`) so they serve the authorized file bytes and
stay inside the package.

`frontend/src/route.ts` is the single hash-route owner for `dest`, `ws`, `id`, `tab`,
`source`, `path`, `filter` and `q`, encoded with `URLSearchParams`; an empty or
unknown destination canonicalizes to the Specs landing route. Examples: `#/specs`,
`#/workspaces`, `#/conversations?ws=fixture&id=<thread>` (`id` selects that
thread; `tab=new` opens the addressable Start conversation dialog), and the grammar example
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

The **Specs** destination pairs the spec list with a detail split into **Overview**,
**Activity** and **Files** tabs. The Overview action bar owns **Mark complete** and
its confirmation dialog, the Open spec, agent, epic and package Files actions, and
dev-server controls for configured workspaces. **Mark complete** saves
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
next action (attach command, `node ~/.agents/scripts/workspaces/cli.mjs locate <id>`, wait, do not relaunch,
history, or inspect recorded workers). Quiet session activity is informational
(no growth for 120 seconds); attached clients are presence only and never grant
control. Selecting an agent opens the dedicated AgentDetail composition: a
non-scrolling object head with identity status and a `tabindex="-1"` heading
focused only when the selected identity changes, a scrolling body that renders
one qualification notice at most (recovery for error/offline/stale, then
identity/record disagreement, unconfirmed workers and partial assignment
coverage), the agent guidance headline and caution, separated recorded/observed
facts, a semantic Execution table (execution directory and repository id wrap
inside the table), the Terminal session panel (same-key mounted across polls and
retained reads), an explicit operator locate command with a native copy control
and a readonly textarea fallback when the clipboard is denied, declared evidence
from the compatible linked workflow record or an explicitly labelled package-level
fallback (not this assignment acceptance), and attention/coverage disclosure. A
persistent ActionBar keeps Copy locate command, Open spec (planned/completed
filter and workspace preserved through the shared spec route) and Open work tour
(`source=package`/`id=<canonical package>`/`path=work-tour.html`, rendered by the
real sandboxed Files reader) visible on long detail, elevating exactly one
recovery primary (Retry state, Retry connection or Refresh state) for
error/offline/stale reads. The record view is read-only: it never invokes attach,
takeover or resume and
never writes records. The local live session controls only copy the attach command
and end the session after the identity confirmation; the agent detail shows the
bounded last response, not the transcript, and remote or imported snapshots expose
no session controls. The header's **Launch agent** action starts the direct
assignment flow described under launch flow and assignment handoff, leaving
this list read-only. Older snapshots without `assignments`
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
coverage reports incomplete reads. Completed step receipts, step learning files,
ready work tours, older PR publication records and direct integrations exclude a package from Planned,
without weakening the completion evidence required for Done. The list defaults to
newest specification edit first (`planned_at` from `spec.md`, falling back to
`scope.json` or the package folder). Search and workspace scope apply to this view,
and planned folders can open their package files.

On a planned spec's live detail page, **Start implementation** provides an editable
brief prefilled with the standard `/spec-end-to-end Implement … from its prepared specs`
prompt from the top-level README, including its model assignment lines, and the package's
reference. The orchestrator uses `deepseek:deepseek-flash:high`; the initial
step-owner and other worker model roles remain in the editable brief. **Preview settings**
prepares the package’s separate worktree, saves the brief and shows the package,
actual working directory and branch, model, publication
authority, and assignment instructions. **Start agent** starts an independent
Pi agent in tmux using that reviewed contract. The launch receives the package
context and the `spec-end-to-end` skill, with authority to publish a ready PR.
Editing the brief or target requires a new preview.
Unavailable package paths return a recovery message to materialize the package
on its execution host, then refresh and preview again.

The form uses the existing thread brief/assignment APIs to retain the saved brief;
it does not send a discussion message or start a discussion agent. A single
package target is selected automatically; multiple targets require a choice.
The server resolves that checkout to a unique usable workspace repository and
validates its package binding before previewing. Imported snapshots cannot
launch agents.

Spec preparation uses the same canonical worktree helper as runtime step dispatch:
it creates the recorded branch in the recorded worktree, or the usual sibling
`<repository>-<spec-slug>` when no worktree is recorded. Existing worktrees must
match the repository and branch; preparation never resets or cleans them. Different
packages can run concurrently in distinct worktrees. The launch lease still rejects
another writer in the same directory **or** another live/unconfirmed assignment
for the same package, including older coordinators launched from the primary checkout.
Existing conversation threads keep their primary repository binding; only their
spec assignment uses the prepared worktree. Relaunch of a confirmed stopped legacy
assignment can use its package worktree, with the same repository and agent settings.

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
`epics[]` with members (declared `requires` plus derived `waiting_on`), summary counts, `next` and per-epic coverage;
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

The Specs **Files** tab hands the selected package off to the shared Files
destination by address; the Specs detail itself has no inline viewer. Files list
every file type in pages of up to 500 entries, within a
10,000-entry/12-level enumeration limit. **Load more files** reaches later pages;
truncation and read errors are visible. Reads accept regular files up to 8 MiB.
Links, traversal, unpublished packages and worktree copies are rejected. Images,
Markdown (including tables and fenced code), formatted JSON, YAML and text render
in the viewer; unsupported binaries download. Package-relative Markdown links
and images resolve through the package-view address (`packageViewUrl`) so they serve
the authorized package bytes and remain within the package. Standalone HTML uses an opaque
sandboxed iframe with package-relative scripts/styles/images, no external resources, fetch requests,
forms or parent-page access. The selected viewer stays mounted across refreshes.
Missing tours are reported, and offline imports have no filesystem access.

The Specs **Activity** tab shows time since the first recorded dispatch and a
duration for each step attempt, including retries, waits and verification, beside
the observed evidence, coverage reasons, omissions and source paths. Timing reuses the bounded
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
a saved observer JSON file offline. Live refresh requires the local service. Because
the committed HTML is a generated asset, it reflects only the checkout it was built
from; the host reads the updated file on its next request. Deploying the repository
file route to an installed host is a separate, operator-authorized step: after
installing the merged checkout and module set, the operator restarts the host (for
example `systemctl --user restart spec-sentinel`) and reads
`/api/repository-files?id=<workspace>&repository=<repository>` on loopback. The
pending execution-host restart/read procedure is not run by merge verification and
never restarts a live host without explicit operator authority.

### Next steps

`GET|HEAD /api/next-steps` runs the bounded cross-workspace written-file scan in
`next-steps.mjs` and returns one JSON document (`schema_version: 1`, server
`scanned_at`, `window_ms: 604800000`, `coverage`, `rows`). HEAD executes the scan
and returns headers only. The route answers `503` with the same JSON when the
storage root is unavailable (no rows are invented); a truncated catalog, failed
read or skipped candidate keeps the useful rows in a `200` response whose
`coverage.state` is `partial`.

Each row is one package subject (or an eligible planned epic) with its newest
watched file: `proposal.md`, `critique.md`, `spec.md` and `work-tour.html`, in
lifecycle order `work-tour > spec > critique > proposal` for equal mtimes. A file
exactly seven days old (`now - 604800000 ms`, inclusive) is included; one
millisecond older is omitted. Candidates are sorted newest-first by
`written_at` and `key`, then the newest 200 are retained before any package
signal is read; truncation is a partial reason. Planned-epic `epic.json`
eligibility reads necessarily run during candidate collection, before that
selection, and share the same signal budget. Traversal is capped at 500 package
directories and 50 epics per catalog workspace and never follows symlinked
directories or files. Signal reads share a 16 MiB aggregate budget: Markdown,
`epic.json` and `pr-url.json` are bounded at 64 KiB; `work-tour.json` is bounded
at 512 KiB; `work-tour.html` is never read. Excerpts are 400 characters and
lists carry at most six titles. Proposal verdicts accept only `COMPATIBLE`,
`COMPATIBLE_WITH_CAVEATS` and `INCOMPATIBLE`; a critique without the required
`Recommendations`, `Must Address` or `Should Address` structure is `unparsed`;
a missing or malformed required `work-tour.json` is `unreadable`. Planned epics
appear only when every member directory was checked and holds no regular
watched file; absent member directories are empty, while an unreadable member
check omits eligibility and reports a scoped partial reason.
The scan traverses at most 100 valid catalog workspaces (the shared catalog row
ceiling) and reports an explicit partial reason when the catalog publishes more;
`listWorkspaces` keeps its independent default 400-entry/4 MiB catalog budget.
`coverage.workspaces.total` is `null` when the shared catalog budget or that row
ceiling prevents a complete workspace count.

### Designs

The workspace detail lists the workspace's design packages
(`projects/<id>/designs/<slug>/design.json`, read through `/api/workspace-designs`:
up to 50 designs, 64 KiB per index) with posture and derived produced/captured
counts, and reports invalid indexes beside them. Designs has its own route grammar:
`#/designs?ws=<workspace>&id=<slug>&path=<screen file>&tab=<declared width>` with an
optional `q` row search. A missing design selects the first listed package; missing
or invalid path/width parameters normalize through `history.replaceState`, while an
explicit unknown `id` remains unavailable rather than selecting a neighbour.
Choosing a design, step or width pushes an entry, and the selection is resolved
against the unfiltered index so a search never clears the open detail. Selecting a design opens a master-detail viewer: previous/next by step, a
labelled width select built from the declared widths, and the screen served
read-only from the workspace folder through `/workspace-view/` in the same sandboxed
`allow-scripts` iframe as other workspace HTML. A ResizeObserver scales the frame
down to the pane and never upscales it, and step and width controls keep focus while
the index refreshes. A coalesced five-second poll re-reads the index and refreshes derived
metadata, and a per-screen HEAD probes only a produced ws/slug/file identity or an
explicit retry, so width changes and polls never re-probe; neither reloads an
unchanged frame: only a workspace, design, screen or retry identity change replaces
it. The index entry's
person, job, primary action, capture coverage, notes and same-step deviations sit in
a compact disclosure beside the frame, and an optional `brief` opens through the
workspace Files route from the planned-screen and read-error fallbacks (the ideal
toolbar carries Open screen only). Workspace HTML may load fonts and relative
scripts/styles
from inside the workspace (`font-src 'self'`); network access stays disabled.
Read-only; nothing writes a design record. Contract:
[docs/design-packages.md](../../docs/design-packages.md).

### Ready planning and hand-offs

Specs' **Ready** filter (URL `filter=ready`; the older `planned` key normalizes to it)
lists prepared, not-started packages with a derived status — **Ready to implement**,
**Prepared · waiting**, **Preparation incomplete**, **Not planned** or **Implementation
starting** — and the observed basis for it. **Implement spec** on a ready package opens the
bound `#/launch` implementation review: canonical target alias, `spec-end-to-end`, draft-PR
stop and merge stays with the operator. Nothing starts before the explicit launch control. A
waiting package keeps **Open prerequisite** as its single primary and disables Implement with
the named prerequisite; **Resume planning** appears only when the intact proposal facts allow
it; unreadable preparation facts or assignment coverage render unknown and refuse entry even
on a synthetic click.

On an epic whose members are not all planned, each eligible **Plan** row and the **Plan
member** primary open the bound planning review (`spec-architect-initial`, or the derived
`spec-write` stage, authority None, stop at Prepared). A member that stopped at
`decision-required` shows **Decision needed** with the recorded question and recommendation;
**Discuss decision** seeds the one-use `seedNewThreadDraft` prepared text and target and opens
the route-addressable `#/conversations?ws=<workspace>&tab=new` Start conversation dialog with
nothing sent. Closing retains the draft; only explicit create transfers it and only Send
sends it.

The isolated package-bound journeys run after the frontend build:

```sh
npm run build --prefix scripts/spec-observe/frontend
SENTINEL_EVIDENCE_DIR=<package>/evidence/browser uv run --script \
  scripts/spec-observe/frontend/handoff-browser-check.py --case all
```

`--case all` runs the seven `review`, `result`, `specs`, `epic`, `decision`, `final-review`
and `integration` cases as independent subprocesses (180 seconds each, 300 seconds total) and
writes one `report.json` under `SENTINEL_EVIDENCE_DIR` atomically, even on failure; a failed,
timed-out or unstarted case is never reported passed. It requires all thirteen
`app-ui-plan-screens` references to have matching production captures at 1280 and 1600. The
earlier unbound journey stays separate:

```sh
SENTINEL_EVIDENCE_DIR=<package>/evidence/browser uv run --script \
  scripts/spec-observe/frontend/browser-handoff-check.py
```

`--case integration` additionally runs the opt-in `SENTINEL_HANDOFF_INTEGRATION=1` fixture:
the five direct dispatch methods delegate to the real `createDiscussionService`, snapshots
come from `collectWorkspace` over the fixture's real package files and canonical assignment
records, and only the final tmux process boundary is fake. The other presentation cases keep
their bounded refusal and observation controls; they prove the browser contract and the
observed states, not model compliance. The retired planned-launch checker's protections now
live in the integration case's canonical worktree, skill, reviewed digest and saved brief and
in the unbound journey's stale-source, dirty-save and double-submit proof. Each check keeps
its own temporary workspace/Git fixture and drives the real launch client, resolver,
readiness and conversation consumers; only the final worker process is fake. Proof limit:
these runs show isolated route/contract composition and the captured states, not real
planning-model compliance or live publication.

### Launch flow and assignment handoff

The **Agents** view's **Launch agent** action (`#launch-agent-action`) starts the
direct assignment flow. At portfolio scope it opens the workspace picker first;
choosing a workspace mounts the brief at `#/launch?ws=<workspace>&tab=brief`. The
route carries `ws` plus optional `thread`, `target`, `package` and `skill`; `tab`
is `brief`, `review` or `result`, and a result route adds `id` (the submitted
assignment UUID). A cold review URL without local saved state falls back to the
brief, and a result URL whose id has no local record shows inspection guidance
instead of claiming local confirmation. Thread **Prepare assignment** opens this
same surface with the thread id and the thread's recorded repository target.

The direct dispatch surface posts JSON to `/api/dispatch/save-brief`,
`/api/dispatch/preview` and `/api/dispatch/launch`, and reads
`/api/dispatch/suggestions`; thread-bound assignment work uses
`/api/thread/save-brief`, `/api/thread/preview-assignment` and
`/api/thread/launch-assignment`. All writes require the endpoint's exact
same-origin URL, the dashboard action token and JSON. A brief save accepts the
64 KiB large-body cap; preview and launch accept the 8 KiB administrative cap.
Direct defaults are the whole workspace when no repository is selected, the
`general` skill, the `pi` harness, no publication authority, and the fixed
assignment instruction; references cross the wire as identity only (`kind`,
`id`). Thread-bound preview and launch reuse the target recorded with the saved
brief, so the server remains the binding authority. For a spec assignment, the
client first posts to `/api/dispatch/prepare-spec-target` with
`{workspace_id, spec_package, repository_id}` or
`{workspace_id, spec_package, thread_id}`. This authenticated mutation accepts no
checkout path, branch or base override, returns `execution_dir` and
`execution_branch`, and never starts an agent. Preview and launch remain read-only
with respect to worktree preparation; both resolve the recorded worktree and the
approved digest includes its directory and branch. Missing or mismatched worktrees
refuse launch rather than falling back to the primary checkout. CLI operators first run
`node scripts/workspaces/cli.mjs prepare-spec-target WORKSPACE --target REPOSITORY --spec-package PACKAGE_REF --root STORAGE_ROOT`;
then use the ordinary `launch` preview and digest confirmation. CLI launch previews
remain read-only. For a stopped legacy retry, preparation also accepts
`--supersedes ASSIGNMENT_ID` and verifies that the predecessor is gone.

**Save brief** publishes one canonical markdown brief for the typed title and
content, and never starts an agent. The submitted title, content, target and
selected references stay visible and disabled while the save is pending; a
failure keeps the typed work and retries the same request identity, and saving
unchanged content again keeps the existing request instead of creating another
brief. **Review** resolves the saved brief and shows the requested facts beside
the resolved target, execution directory, skill, model and the 64-character
`contractDigest`, with the captured **What Pi will receive** contents and
hashes. **Launch agent** submits that exact `expectedDigest`; a changed source
or target makes the fresh resolution differ and the service refuses with a 409
`stale-preview`, retaining the previous facts and withholding dispatch until
another review. `target-busy`, `run-active` and `request-conflict` also withhold
dispatch, and an unavailable service is distinct; a busy denial names and links
the conflicting assignment for inspection. Nothing starts until the explicit
launch control is used, and a second launch is unavailable while dispatch is
pending.

After launch the result route shows the submitted assignment ID, execution
directory, brief and recorded observation. `live` is a launch acknowledgement
that never claims completion; `launch_failed` is a confirmed startup failure
with **Correct assignment** minting fresh request and assignment identities
while retaining the typed text; any other acknowledgement is unconfirmed and
inspection-only — locate the submitted identity in Agents and do not relaunch
it. **Open agent** selects the exact observed assignment when available,
otherwise a workspace-scoped UUID filter. **Discuss result** appears only for a
thread-bound result and fills that thread's composer with an unsent summary
draft; nothing is sent until the operator reviews the text and presses the
existing **Send** control on the queued-message path. The thread message
composer and queue stay message-scoped and never launch an assignment.
`launch-state.ts` (`seedThreadDraft`/`consumeThreadDraft`, re-exported through
`Conversations.tsx`) is the public producer for that one-use seed, and the
consumer clears it after the exact requested thread applies it. Composer,
retry and reading-position drafts live in `conversations-state.ts` for the
browser session: they survive destination navigation, polls and ordinary
remounts but not a reload or a second tab, and nothing is written to browser
storage.

Selecting a workspace shows its discussion threads. The loopback dashboard and the
configured `--public-host` endpoint support thread reads and messages. Publish
that endpoint through Tailscale Serve: the tailnet ACL controls who can reach it.
Forwarding or identity headers alone grant no access. Imported snapshots expose
no message, brief or launch controls. Package completion remains local-only.

**Create thread** starts a thread called "New thread" in the whole workspace or a
chosen repository. The **Start conversation** dialog is route-addressable:
`tab=new` opens it on mount and direct entry, removing the tab closes it, and a
workspace/thread/availability change reconciles it without stealing the route.
Its prepared text and repository target come from the public
`seedNewThreadDraft`/`consumeNewThreadDraft` producer in
`conversations-state.ts`, consumed once into the created thread. The thread's Pi runs in that directory and receives no kit or
project context. When the first message is sent, the host asks
`deepseek/deepseek-flash` for a short title through a tool-less
`pi --print` call and saves it only if the thread still has the default title;
the open page updates without a reload. A failed or slow naming call leaves
"New thread" in place and never delays delivery. The first message's text is
sent to that model for naming.

## Request work (speech and interpretation)

`createDashboardServer` registers three protected request routes alongside the
thread routes, composed from the concrete adapters in `request-speech.mjs` and
`request-interpret.mjs`:

- `GET /api/request/speech` → `{state, host, limit_seconds: 30, sample_rate: 16000}`.
  Locality is required (no token). `state` is `ready` or `unavailable`.
- `POST /api/request/transcribe?request_id=<uuid>` with an
  `application/octet-stream` body: little-endian 16 kHz mono Float32 PCM,
  nonempty, ≤ 30 s (1,920,000 bytes), 4-byte aligned, finite samples →
  `{request_id, text, seconds}`.
- `POST /api/request/interpret` with an `application/json` body ≤ 16 KiB:
  `{request_id, workspace_id, transcript, context?, resolved_refs?}` →
  `{request_id, resolution, candidates, unresolved_references, clarification,
  catalog: {read_at, omitted, errors}}`.

Every POST requires the exact operator origin, the dashboard action token
(`x-sentinel-token`) and its exact MIME type. Refusals are static
`{error, reason}` bodies: `locality`/`token`/`origin`/`mime` 403,
`invalid-request`/`input-too-long` 400, `oversize` 413,
`workspace-unavailable` 404, `superseded`/`request-conflict` 409,
`interpretation-failed`/`transcription-failed` 502, `no-speech` 422 and
`unavailable` 503; exception text, child output and paths never cross the
boundary.

**Speech setup.** Install Bun, then run this command from the tooling checkout:

```bash
node scripts/spec-observe/setup-speech.mjs --checkout "$HOME/Documents/rearrange-writer"
systemctl --user restart spec-sentinel
curl -fsS http://127.0.0.1:4319/api/request/speech
```

The Linux installer installs locked writer dependencies, provisions checksum-verified ASR
assets, and checks that the real daemon loads its engine. It saves a systemd user-service
drop-in with `SENTINEL_SPEECH_CHECKOUT` and a PATH that includes Bun and Pi Node.
It writes configuration only after the load check passes. It does not restart Sentinel.
It saves the chosen paths in `$XDG_CONFIG_HOME/adjacent/speech-setup.json`
(default: `$HOME/.config/adjacent/speech-setup.json`) for later sync runs.
Restart Sentinel after setup, then reload the dashboard to refresh its speech availability.

`sync.sh` runs this installer automatically when `SENTINEL_SPEECH_CHECKOUT` or the default
`$HOME/Documents/rearrange-writer` checkout exists. Model downloads skip files with matching
checksums. Without a checkout, automatic setup prints the command needed to enable speech.
To clone and provision the writer on a fresh host, supply `--repository <writer-clone-url>`.
Alternatively, set `SENTINEL_SPEECH_REPOSITORY_URL` before `sync.sh` to enable automatic cloning.
Git access to that repository and Bun are prerequisites. Set `SENTINEL_SPEECH_BUN` to an
absolute executable path when Bun is outside PATH and `$HOME/.bun/bin`.

For manual service configuration, `SENTINEL_SPEECH_CHECKOUT` must name an absolute, existing
Rearrange Writer checkout with provisioned ASR assets and `bun` on the service PATH.
Unset or unusable means speech only is unavailable (`state: "unavailable"`,
503 on transcribe) while typing still works. Each recording is uploaded once
as ≤ 30 s of 16 kHz Float32LE and transcribed by one daemon child per clip;
the PCM stays in memory and is never written to disk. Interpretation runs one
tool-free `pi` print per request against the operator's configured provider —
the transcript and bounded catalog excerpt leave the host only through that
existing model configuration; no additional routing or storage.

**Operator endpoints.** Loopback and the configured `--public-host` (HTTPS
behind Tailscale Serve) are the authorized endpoints. Every POST needs the
exact `Origin` (`https://<public-host>` on the public endpoint,
`http://<host>` on loopback — no case folding), the action token and the exact
MIME type.

**Identity slots.** Each operation keeps one active slot keyed by the request
id plus a SHA-256 fingerprint of the validated payload (audio bytes for
transcribe; normalized workspace/transcript/context/refs for interpret). An
identical in-flight identity joins the running response; the same id with
different input answers `request-conflict`; a new id answers the old caller
`superseded`, aborts its child, and starts only after the old child drains (a
rapid A→B→C keeps C behind A even when B never starts). A settled call
releases its slot, so a retry with the same id starts a fresh call. Nothing is
persisted or cached.

**Fixture seam.** `createDashboardServer({..., requestServices})` accepts
optional `{speech, interpret, spawn}` overrides; `spawn` reaches only the real
speech/printReply child boundaries. Real provider, real ASR-engine and mobile
checks remain unassessed outside the isolated fixtures.

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

Metrics report PR submission only from `pr-url.json` with schema version 1,
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

### Live terminal preview

The live terminal preview is optional and requires `asciinema` 3.x on the
dashboard host's `PATH`. Nothing validates the version: when the binary is
missing, the panel's state is **Not installed**, and an older binary may fail
instead. The viewer panel ships with the dashboard frontend; the route and
lifecycle contract below is what the host provides once it is present.

`POST /api/assignment-terminal/open` requires a strictly local dashboard
request, the dashboard action token and the exact same-origin `Origin`.
`GET|HEAD /api/assignment-terminal/<assignment-uuid>/<asset>` (the player
assets) requires the same strict local classification but no token. The raw
`/ws` upgrade requires a loopback `Host` and its explicit matching local
`Origin`. The configured public host, any forwarding header and imported
snapshots are refused by these routes. Remote operators reach the host-local
page through an SSH tunnel (`ssh -L 4319:127.0.0.1:4319 <host>`) rather than
the public host. Only the dashboard page's content-security policy carries the
player's WebAssembly allowance and the exact local `ws://` origins; package
and workspace document policies keep their sandbox and `connect-src 'none'`.

The view attaches tmux read-only: no keystroke reaches the agent and no
recording is written. One stream is shared by every local dashboard viewer; it
stops after the last viewer's grace window, after an unviewed open, when the
asciinema process exits, or on dashboard shutdown. The dashboard owns only its
asciinema child and never signals the tmux server or the agent pane.

While a stream is active, the upstream loopback port asciinema opens accepts
reads from any browser origin. That residual exposure is accepted outside the
dashboard-only promise: direct readers of the upstream port cannot start a
stream, and they never count as viewers, so they cannot retain one past the
proxy's last-viewer grace window or its unused-open timer. The dashboard never
restarts a stream or itself; restarting it (or retrying a view) is an operator
action.

Focused verification: `node --test scripts/spec-observe/terminal-routes.test.mjs`.

## Package dev servers

Configured workspaces expose Start dev server, Stop dev server, and a Tailscale link
in the live Specs Overview action bar. See [Package dev server previews](../../docs/dev-server-previews.md)
for host setup, the Compose contract, private runtime state, and cleanup behavior.
