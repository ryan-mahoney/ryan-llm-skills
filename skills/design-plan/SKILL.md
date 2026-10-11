---
name: design-plan
description: "Plan a design package from context files: read the research, choose subject-matter and designer lenses, enumerate every screen-state with the person and decision or action it serves, declare the viewport posture, and write brief.md and design.json under a workspace's designs/ folder. Use when the user says 'plan the design', 'design this from these notes', 'what screens do we need', or starts a prototype from research. Stops before producing screens; design-run builds them."
argument-hint: "<workspace-id> <design-slug> <context-path>... [--posture desktop-only|responsive] [--design-system PATH]"
disable-model-invocation: true
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Design Plan — Context In, Brief and Screen Index Out

Turn research and context files into a design package plan: who the people are, what each
decides or does, which screens in which states are needed, through which expert and
designer lenses the screens will be judged, and against which design system. Write the
plan to disk as `brief.md` and `design.json`, then stop so the screen list can be vetted
before any screen is produced.

Contract: [Design packages](../../docs/design-packages.md). Content rule for every screen:
[prototype-design.md](../../rules/prototype-design.md). This skill writes no HTML.

## Arguments

- `workspace-id` — an existing workspace (`node ~/.agents/scripts/workspaces/cli.mjs show <id>`).
- `design-slug` — `^[a-z][a-z0-9-]{0,47}$`; becomes `designs/<slug>/`. Refuse a slug whose folder already holds a `design.json`; use `design-run` to continue an existing design.
- `context-path...` — one or more files or folders: research, notes, briefs, feature lists, journey pages, screenshots, existing UI. Workspace-relative paths resolve against the workspace directory; absolute paths are read as given.
- `--posture` — `desktop-only` or `responsive`. When absent, decide from the context and declare the decision as an assumption.
- `--design-system PATH` — overrides the kit's `design_system` entry; it must lie inside a kit repository and is recorded as that repository id plus the relative path. Without either, report `outcome: blocked`, `reason: missing-design-system`.

## Non-interactive operation

Run to completion. Ask at most one round of questions, and only when different answers
would produce a different screen list (see Step 2). In a non-interactive run, ask nothing
and convert every gap into a declared assumption in `brief.md`.

## Step 1 — Resolve the workspace and design system

1. Resolve the storage root as the workspace CLI does (`--root`, `ADJACENT_STORAGE_ROOT`,
   then `~/Documents/adjacent-storage`). Run `show <id> --json`; stop with
   `outcome: blocked`, `reason: workspace-unavailable` when the id is not a valid workspace.
2. From the `show <id> --json` result, note the kit's repositories and their roles and read
   its `design_system` (`repository` plus `paths`, relative to that repository's checkout).
   Resolve each path against the repository's absolute `path` in the same result. Read every
   listed design-system document and the token source (Tailwind config or CSS variables).
   Record `repository` and the repository-relative `paths` for `design.json`; never an
   absolute path.
3. The design directory is `<workspace-dir>/designs/<slug>/`. Create it; write nothing
   outside it.

## Step 2 — Read the context and qualify the request

Read every context path completely. Then restate, in your own words, who the people are,
what work they do, and what each is trying to decide or do on the surfaces in scope.

Apply the underspecification rubric. For each item decide: answered by the context,
answerable from the repositories, or missing.

- **People and top task** — who uses these screens and what they most often come to do.
- **Surface type** — operator tool, data tool, form, content page, marketing, or a mix.
  This fixes the posture rule: [functionalist-design.md](../../rules/functionalist-design.md)
  for functional surfaces, [expressive-design.md](../../rules/expressive-design.md) for
  expressive ones. Name the zones when a surface is hybrid.
- **Devices** — `desktop-only` is a complete, legitimate answer for operator tools. Decide
  it here, not screen by screen.
- **Accessibility target** — AA is the floor.
- **Content readiness** — real domain content available, or to be invented realistically
  from the context.
- **Existing versus new** — redesign of shipped UI (read it) or a new surface.

A missing answer earns a question only when different answers would change the screen
list or the posture. Everything else becomes a one-line declared assumption.

## Step 3 — Choose the lenses

Name the people whose knowledge the screens will be judged against. Two kinds:

- **Subject-matter experts** — two or three people who know how this work is actually
  done in this field or process (the planner, the dispatcher, the underwriter), drawn from
  published practice: handbooks, standards bodies, named practitioners with attributable
  positions. Write what each would insist a screen for this job gets right.
- **Designers** — two or three practitioners whose published work bears on this surface:
  information design for dense tools, usability for forms and flows, systems thinking for
  component reuse, brand and typography for expressive surfaces. Pair productive tension.

Rules for both: only people with publicly documented positions; confirm one relevant
source each before naming them; write the concrete demand they place on these screens, not
a biography. When no well-matched person can be verified, name a lens instead
(`data-density`, `usability-first`, `systems-consistency`, `accessibility-first`,
`conversion-first`, `brand`) and say why it fits. Do not reuse the same roster for every
design.

## Step 4 — Inventory the screens

Enumerate screen × state. For each screen write `person`, `job`, `kind`
(`decision`, `action`, `flow-step`), `state` (`ideal`, `empty`, `loading`, `error`,
`partial`, `denied`, `offline`, `stale`), `title`, and `primary_action` when the screen has
one.

- A screen without a job is rejected: every screen serves someone deciding or acting.
  "Shows the list of X" is not a job. "Decides which X to work on first" is.
- Include every state [ux-states.md](../../rules/ux-states.md) requires for the view, each
  as its own screen. Twelve states are twelve files.
- Order so the shell screen (the ideal state of the primary surface) is step 1, and set
  `shell_from` on every later screen that shares its chrome. Screens with a new shell come
  before the screens that copy from them.
- Keep the count honest in both directions: do not pad with states the product never
  shows, and do not merge two decisions into one screen to save a file.
- Record anticipated design-system deviations with their reasons; `design-run` confirms
  or drops them.

## Step 5 — Write the plan

Write both files atomically (temporary file in the design directory, then rename).

### `brief.md`

```markdown
# <Title>

## People and jobs
## Surface and posture
<functional | expressive | hybrid zones>; viewport posture and why
## Design system
<entry path, token source, components to mirror, anticipated deviations with reasons>
## Lenses
### Subject-matter experts
### Designers
## Screens
<the inventory as a table: step, id, person, job, kind, state, shell_from, primary action>
## Assumptions
<one line each, vetoable>
## Context read
<paths>
```

### `design.json`

Per the index schema in [design-packages.md](../../docs/design-packages.md): `schema_version`
1, `design` equal to the slug, `title`, `brief: "brief.md"`, `created_at`, `design_system`
as `{repository, paths}` (repository-relative, copied from the kit), `viewport`, `context` (workspace-relative where possible), `screens` in
step order with `step` running 1..N, and any `deviations`. Omit `file`; the schema derives
it.

Validate: `node ~/.agents/scripts/design/cli.mjs lint <design-dir>`. An invalid index is
reported by the lint; fix it before reporting. Zero produced screens is the expected state.

## Output

Report this compact summary before any commentary:

- `outcome`: `planned` or `blocked` (with `reason`).
- Design directory, `brief.md` and `design.json` paths.
- Posture, screen count, and the step-1 shell screen.
- Lenses chosen, one line each.
- Declared assumptions that a reviewer may want to veto.
- Next: review the screen list, then `design-run <workspace-id> <design-slug>`.

Do not produce any screen. Do not write into a repository or anywhere outside the design
directory. Do not add Co-Authored-By trailers, "Generated with" footers, or model
attribution to any artifact.
