# Design packages

A design package is a folder of one self-contained HTML file and matching Markdown
interaction guide per screen-state, plus a machine-readable index. One model produces it
step by step from the user's conversation and a design system. It lives in workspace
storage, not in a repository, and Sentinel shows it
through the workspace file viewer. Epics and specs reference its screens where they live;
nothing is copied into `.specs/`.

The skills are `design-plan` (context in, brief and index out), `design-run` (produce
screens and guides, capture, review), and `design-prototype-explode` (extract separate
screens and granular context from an existing compound prototype). The rule that governs
the content of every screen is
[prototype-design.md](../rules/prototype-design.md).

## Location

```
<ADJACENT_STORAGE_ROOT>/projects/<workspace>/designs/<slug>/
  design.json                 the index (required)
  brief.md                    who, job, lenses, assumptions (written by design-plan)
  screens/NN-<id>.html        one screen, one state, self-contained
  screens/NN-<id>.md          matching user interaction and journey guide
  captures/NN-<id>@<width>.png  inspected render per declared width
  review.md                   lens review findings and what changed (written by design-run)
  vendor/tailwind.js          pinned Tailwind play runtime, referenced relatively
```

The storage root resolves as the workspace CLI resolves it: `--root`, then
`ADJACENT_STORAGE_ROOT`, then `~/Documents/adjacent-storage`. The workspace must exist
(`node scripts/workspaces/cli.mjs show <id>`); its `kit.yaml` names the repositories the
design is for and, under its `design_system` key, the design system to mirror.
Design skills write only inside `designs/<slug>/`.

## Planning input

`design-plan` takes its context from the design request and relevant conversation. It has no
context-file argument. The prompt can mention files, folders, screenshots, or existing UI,
including multiple sources. The skill reads those references when provided. No file is required.

The skill preserves the supplied goals, requirements, constraints, and decisions in `brief.md`.
This lets `design-run` continue without the original chat. User requirements remain distinct from assumptions.
The optional `design.json.context` field lists paths of referenced material only. It is omitted
when no referenced material was read.

The `agent-tooling` workspace uses the [design system](../design-system/README.md)
imported into this repository. Its offline HTML/Tailwind catalog, original CSS token source,
component examples, and JavaScript helpers are under `design-system/`. The workspace kit
resolves those paths through repository ID `agents`.

Why workspace storage and not `.specs/`: workspaces already hold the `context/` and
`sources/` inputs, a kit spans repositories, some repositories track `.specs/` and would
put prototypes in source history, and Sentinel serves workspace files without a run
snapshot authorizing them.

## Why one file per screen-state

A single file holding every state behind a switcher grows until an implementing model
cannot use it, and the switcher plus its labels leak into the prototype. Each file holds
one screen in one state. Shared chrome is copied forward from the step named in
`shell_from`, then edited. Rationale lives in the index, never in the markup.

## Screen interaction guides

Every produced `screens/NN-<id>.html` has a sibling `screens/NN-<id>.md`. The guide explains
the user's experience and the screen's place in the process. It is not an implementation
description or a copy of the index's `notes`.

Use a screen title and a relative link to its HTML. Organize the explanation around:

- **Person and goal:** who arrives, what they need to decide or accomplish, and what
  successful progress means here.
- **Entry and context:** how they arrive, prerequisites, the selected object or scope,
  and information carried from related screens.
- **Decisions and interactions:** the information that informs the decision; meaningful
  controls with exact visible labels, their outcomes, and confirmation when applicable.
- **Feedback and continuity:** this screen's state, pending or unavailable actions,
  recovery, retained input/selection, and relevant focus or keyboard behavior.
- **Connections:** relative links to actual related HTML screens and their guides;
  distinguish journey transitions from alternative states of the same surface.

Use only the sections that add useful information. Match detail to the screen's job.
Explain why information or an interaction helps the person, rather than listing every
label. Omit markup, CSS, component structure, rendering mechanics and build instructions.
Describe intended behavior from the brief and final design. Identify interactions the
prototype only illustrates, proposed capabilities and unresolved outcomes; a clickable
mockup does not establish that a real operation succeeded. Never invent a destination
or outcome to complete the narrative.

Write the guide after the screen is finalized and refresh it whenever screen behavior,
labels or related transitions change, including changes made during lens review. A
documentation-only pass can fill missing guides without rebuilding or recapturing HTML.
Review guides against the final screens and brief, and check that relative links resolve.

## Importing a compound prototype

`design-prototype-explode` accepts existing HTML prototypes whose switchers, navigation
or scripted interactions represent multiple screens and states. It enumerates reachable
experiences and writes each as `screens/NN-<id>.html` with a matching `.md` interaction
guide, plus `brief.md` and `design.json` under this contract. The source files remain intact.
Extraction preserves the source design; missing states and source defects are reported
rather than filled in through redesign.

Supplied context is split by relevance to each screen/state. Shared requirements remain
in the brief, and the guide repeats constraints needed to understand that screen. When
no context exists, the guide derives the user's interactions from the source and records
inferred goals or unresolved outcomes. An `extraction.md` record maps source activation
paths and context sections to outputs, with aliases, conflicts, omissions and conversion
changes. It is separate from the guides because it serves extraction traceability.

Imported CSS prototypes can retain their own styles without conversion to Tailwind.
Their resources still stay inside the design directory, and their output goes through
the same lint, independent capture and guide checks. A missing named design system is
recorded for later redesign work; it does not require inventing one during extraction.

## Self-contained means offline

Sentinel renders a screen in a sandboxed iframe with
`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'none'`. A screen may load scripts,
styles, images and fonts from inside the design folder by relative path and nothing from
the network. `design-run` copies the pinned Tailwind play runtime to `vendor/tailwind.js`
(`node scripts/design/cli.mjs vendor <dir>`, version and digest pinned in
`scripts/design/cli.mjs`); screens reference it as `../vendor/tailwind.js` and put the
design system's tokens in an inline `tailwind.config`.

## Index schema (version 1)

```json
{
  "schema_version": 1,
  "design": "ladder-overview",
  "title": "Route ladder overview for planners",
  "brief": "brief.md",
  "created_at": "2026-10-11",
  "design_system": { "repository": "transitops-cms",
                     "paths": ["public/design-system/index.html", "app/design-system.css"] },
  "viewport": { "posture": "desktop-only", "widths": [1280] },
  "context": ["context/project.txt", "sources/gtfs-planner/README.md"],
  "screens": [
    { "step": 1, "id": "overview", "title": "Ladder overview",
      "person": "Service planner", "job": "Decide which route's headway problem to work on first",
      "kind": "decision", "state": "ideal", "shell_from": null, "primary_action": "Open route",
      "notes": "Sort defaults to worst adherence; the number that drives the decision leads each row." },
    { "step": 2, "id": "overview-empty", "title": "Ladder overview, no feed imported",
      "person": "Service planner", "job": "Get the first feed imported",
      "kind": "action", "state": "empty", "shell_from": 1, "primary_action": "Import feed" }
  ],
  "deviations": [
    { "screen": 1, "token": "table row height", "from": "44px", "to": "36px",
      "reason": "Planners compare 40+ routes at once; the system's row height was set for forms." }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | `1`. |
| `design` | yes | Slug `^[a-z][a-z0-9-]{0,47}$` or a two-digit numbered slug such as `01-home-split` (up to 48 characters), equal to the directory name. |
| `title` | yes | One line. |
| `brief`, `created_at`, `note` | no | Brief path relative to the design directory; ISO date; free text. |
| `design_system` | no | `repository` (a kit repository id) and `paths` (repository-relative; entry document first, then tokens as config or CSS). Same shape as the kit's `design_system`, so the file moves between machines. `node scripts/design/cli.mjs system <dir>` resolves the absolute paths through the kit. The legacy form `{path, tokens}` with absolute paths is still read. |
| `viewport.posture` | yes | `desktop-only` or `responsive`. Declared before any screen is built. |
| `viewport.widths` | yes | One to four distinct integers, 320 to 3840. `responsive` needs at least two. Every width is captured. |
| `context` | no | Paths of referenced material read, workspace-relative where possible. Chat context is preserved in `brief.md`. |
| `screens` | yes | Ordered, 1 to 100. `step` runs 1..N in array order. |
| `screens[].id` | yes | Slug, unique within the design. |
| `screens[].title` | yes | What the screen is called. |
| `screens[].person` | yes | Who uses it. |
| `screens[].job` | yes | The decision or action it serves. A screen that only shows data has no job and is rejected. |
| `screens[].kind` | yes | `decision`, `action` or `flow-step`. |
| `screens[].state` | yes | `ideal`, `empty`, `loading`, `error`, `partial`, `denied`, `offline` or `stale` (per `ux-states.md`). |
| `screens[].file` | derived | Always `screens/NN-<id>.html`; a different value is rejected. |
| `screens[].shell_from` | no | Earlier step whose file this one was copied from before editing. |
| `screens[].primary_action` | no | Verb + object of the main control. |
| `screens[].notes` | no | Rationale and what the state shows. Shown beside the frame, never in it. |
| `deviations[]` | no | `screen`, `token`, `from`, `to`, `reason`: a recorded departure from the design system. |

Readers refuse an index over 64 KiB. Nothing about progress is stored in the index.

## Derived status

| Fact | Evidence |
| --- | --- |
| `produced` | `screens/NN-<id>.html` exists. |
| `captured` | `captures/NN-<id>@<width>.png` exists for a width; a screen is captured when every declared width is. |
| lint | `node scripts/design/cli.mjs lint <dir>`: `pass`, `warn` or `fail`. |

CLI status accounts for HTML and captures; it does not track guide completeness.
`design-run` separately checks same-basename Markdown files. Rerunning it produces missing
screens and fills missing guides for existing screens. `--step N` rebuilds one screen and
refreshes its guide. A completed production run requires both files for every screen in scope.

## Lint

`scripts/design/cli.mjs lint <dir>` validates the index and checks every produced screen.
Failing: external resources in `src`, `href`, `@import` or `url()`; the Tailwind CDN; a
form with an action; `fetch`, `XMLHttpRequest`, beacons or sockets; a file over 200 KiB.
Warnings the model must weigh: self-referential phrases ("empty state", "prototype",
"this page shows"), marketing adjectives ("seamless", "intuitive", "at a glance"),
state or variant switch attributes, and a file with neither a `<style>` block nor a
Tailwind reference. The script decides nothing about the design itself.

## Referencing a screen from an epic or a spec

A screen reference names the design by identity and resolves to one file:

```
Design reference: transitops/ladder-overview step 2 → /abs/.../designs/ladder-overview/screens/02-overview-empty.html sha256:<hash>
```

`node scripts/design/cli.mjs ref <dir> <step>` prints the line. The identity survives a
storage-root move; the absolute path lets a reader without the resolver open the file,
matching how receipts and `epic.json` store paths. The digest binds the reference to the
file as prepared: a design edited after a spec was prepared is a changed input. A step
owner that finds a different digest reports a departure needing re-preparation; it never
builds to the newer file silently.

- **Epic record.** `epic.json` may carry `designs[]` with `{ workspace, design, path }`
  naming the designs the epic implements (schema in [spec-epics.md](spec-epics.md)). The
  design never names epics; the back-reference is derived.
- **Planning.** When a plan is decomposed into packages, the screens are the unit to cut
  on. Each member's `proposal.md` lists the screens it implements. A screen claimed by no
  package is a plan gap; a screen claimed by two needs an owner.
- **Specs.** `spec-write` records the spec-level `Design reference:` line with the step
  range, repeats the exact screen line in every `Visual: yes` step, and emits
  `design: { workspace, design, step, path, sha256 }` on those entries in
  `spec-steps.json`. It does not copy the screen into the package.
- **Implementation.** Implementers read the screen where it lives (serve the design
  folder on loopback or open the file) and never write into a design folder. Feedback that
  changes a design goes through `design-run --step N`; the new digest surfaces in the
  affected specs.

## Sentinel

The workspace detail lists the workspace's designs (`/api/workspace-designs`, up to 50,
index under 64 KiB each) with posture and produced/total. The Designs route grammar is
`#/designs?ws=<workspace>&id=<slug>&path=<screen file>&tab=<declared width>` with an
optional `q` row search; a missing design selects the first listed package, missing or
invalid path/width parameters normalize with a history replace, an explicit unknown `id`
stays unavailable rather than selecting a neighbour, and design, step and width choices
push their own entries. A selected design renders a
master-detail viewer: previous/next by step, a labelled width select from the declared
widths, the screen read from the workspace folder through `/workspace-view/` in the
sandboxed `allow-scripts` iframe, and the index entry's person, job, primary action,
capture coverage, notes and same-step deviations in a compact disclosure. A
ResizeObserver scales the frame down to the pane and never upscales. A coalesced
five-second index poll refreshes derived metadata, and a per-screen HEAD probes only a
produced ws/slug/file identity or an explicit retry, without reloading an unchanged
frame; only a workspace, design, screen or retry identity change replaces it. The optional `brief` field links to the workspace Files route from the planned-screen
and read-error fallbacks; the ideal toolbar carries Open screen.
Read-only; Sentinel never writes a design record.

## Host-restart deployment handoff

The generated dashboard is served by the existing host process. After this change is merged, an
authorized operator restarts that existing host process using the normal deployment procedure;
this step does not restart, deploy or reconfigure the service and it invents no command or
service authority. After the restart, validate the actual Designs surface, the
`/api/workspace-designs` API and the workspace-view reader, hard-reload the client, and record
the results separately. No deployment or broad regression claim is made by this step.
