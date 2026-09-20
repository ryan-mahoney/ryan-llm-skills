# Product Documentation Skills

Three skills document access and individual screens. Three companion skills register, document,
and visualize journeys across repositories. Each skill writes one kind of artifact, and later
skills read the relevant earlier artifacts.

## What each skill writes

| Skill | Writes | Answers |
|---|---|---|
| `build-permission-model` | `docs/permissions/permission-model.md` | Who can open which page? |
| `build-screen-inventory` | `docs/screen-inventory.md` and `docs/inventories/*.md` | Which pages exist, and for whom? |
| `document-screen-behavior` | `docs/screens/SCRN-###-*.md` | What does one page do? |
| `build-journey-map` | `docs/journey-registry.md` | Which user goals cross these repositories? |
| `document-journey` | `docs/journeys/JRNY-###-<slug>.md` | What happens at each stage and repository boundary? |
| `visualize-journey` | `docs/journeys/visuals/JRNY-###/`, a portfolio index, and a journey canvas | What does the path look like, how do journeys connect, and where should we investigate? |
| `view-journeys` | Nothing; serves `docs/journeys/visuals/` over `http://127.0.0.1` | Where can I open the maps with working links? |

## Screen Documentation Order

Run the skills in this order:

1. `build-permission-model`
2. `build-screen-inventory`
3. `document-screen-behavior`

The permission model is first because the other two skills need it. It records the roles, the capabilities of each role, and the guard on each page route.

The screen inventory is second. It divides the pages into groups. One group holds the pages that one audience can reach. The permission model supplies the audience rules.

The screen documents are last. Each document describes one screen in full. The inventory shows which screens have no document yet.

## The files

```text
docs/
├── permissions/
│   └── permission-model.md         <- skill 1 writes
├── screen-inventory.md             <- skill 2 writes
├── inventories/
│   └── <name>-screens.md           <- skill 2 writes
├── screens/
│   └── SCRN-001-<name>.md          <- skill 3 writes
└── screenshots/
    └── SCRN-001/*.png              <- skill 3 writes
```

## What passes between them

| From | To | What passes |
|---|---|---|
| Permission model | Screen inventory | The audience rules (`AUD-##`) |
| Permission model | Screen document | The role IDs (`ROLE-##`) and capability IDs (`CAP-##`) |
| Screen inventory | Screen document | The screen ID, and the list of pages with no document |

Each file records the version of the file that it read. The key is `derived_from`. If an earlier file changes, you can see which later files are old.

## How to run them

To document a product for the first time, do these steps:

1. Run `build-permission-model`. Read the findings before you continue.
2. Run `build-screen-inventory`. Make sure that each route is in one inventory.
3. Run `document-screen-behavior` one time for each screen.

Step 3 is long. One run writes one screen document. Start with the screens that users open most.

## When you need only one skill

You do not always need all three.

| You want | Run |
|---|---|
| To know who can open a page | `build-permission-model` |
| A list of every page | `build-screen-inventory` |
| A full description of one page | `document-screen-behavior` |

Each of these three screen-documentation skills can run alone. Journey documentation has the
explicit prerequisites described below.

## When a file is absent

The screen-documentation skills look for the files that come before them. If a file is absent,
they derive the needed access or screen context from source, record the missing input, and
recommend the skill that writes it. This does not create a replacement upstream document.

This behavior keeps each skill usable alone. The result is less exact than a full run.

## When the code and the documents disagree

The code is correct. A document can be old.

If a skill finds a difference, it reports the difference. It does not correct the earlier document quietly. A quiet correction makes two documents that disagree forever.

## How to keep them current

Each file records the version of the code that a person read it against. The key is `verified_against`.

Each file also records the commands that rebuild its raw input. Use these commands to see what changed. Then update only the parts that changed.

Refresh the permission model when roles, capabilities, route guards, or audience rules change.
Then refresh the affected inventories, screen pages, and journeys against that version.

## Journey Documentation Order

1. Run `build-journey-map` with every repository the user's goal crosses. It reads available access
   and screen docs plus existing end-to-end tests, then registers journeys with permanent `JRNY-###`
   IDs and repository seams in `docs/journey-registry.md`.
2. Run `document-journey <JRNY-###>` for a registered journey. It traces the stages, screens,
   promises, carried context, and losses across repositories, and writes the journey page.
3. Run `visualize-journey <JRNY-###>` after the page exists. It produces a manifest and HTML map
   under `docs/journeys/visuals/JRNY-###/`, with screenshots, CTAs, evidence links, and prioritized
   investigations. It also refreshes the portfolio index at `docs/journeys/visuals/index.html` and
   the journey canvas at `docs/journeys/visuals/canvas.html`.
4. Run `view-journeys` to open the results. It serves the collection locally and returns the canvas
   URL.

`document-journey` requires a registry row and does not invent journey IDs. `visualize-journey`
requires both the registry row and journey page. The registry and page remain canonical; refresh
the derived visual map when they change. A journey that crosses marketing, an application, email,
and checkout is one user goal even when its implementation spans several repositories.

The canvas is a pan-and-zoom map of every journey in the collection. It shows what the list cannot:
entry surfaces that several journeys share, journeys that continue in another journey, branches
that hand the user to another journey, and seams that more than one journey depends on. Shared
surfaces and shared seams are derived from the manifests. A branch or exit into another journey is
recorded as `toJourney`, and a follow-on journey as `terminal.continuesIn`, only when the journey
page or registry names that journey. Select a journey to open its map; select a branch or
continuation label to open the step where the user leaves.

The generated pages are self-contained HTML, but their evidence links reach into sibling
repositories, so opening them with `file://` leaves most links broken. `view-journeys` serves the
collection from the nearest directory that contains every linked file, shows source files as text,
and refuses dotfiles, `node_modules`, and paths outside that directory. It never creates or renders
a journey.
