# Spec epics

An epic is an ordered set of spec packages that deliver one plan. A spec package
already works as a filesystem record: its lifecycle can be read from the files the
workflow writes (`spec-steps.json`, dispatch receipts, `pr-url.json`,
`sentinel-merge.json`, `sentinel-completion.json`). An epic record adds only what
those files cannot say: which packages belong together, in what intended order,
with which dependencies, and for which plan. Every member's progress is derived
from the member package at read time and is never copied into the epic record.

Most packages stand alone and never belong to an epic. Nothing in this document
applies to them.

## Location

```
<storage root>/projects/<workspace>/epics/<slug>/epic.json   # the record (required)
<storage root>/projects/<workspace>/epics/<slug>/plan.md     # the plan the epic implements (optional)
<storage root>/projects/<workspace>/epics/<slug>/run.md      # epic-end-to-end coordination log (written by that skill)
<storage root>/projects/<workspace>/plans/<name>.md          # workspace-level plans
<storage root>/projects/<workspace>/specs/<slug>/            # member packages
```

An epic belongs to one workspace, and its record lives in that workspace's `epics/`
folder, never in a repository. Members are spec packages of the same workspace, so
an epic that spans several kit repositories needs no anchor repository: each member
package names its own target repositories in `scope.json`. Code finds member
folders with `node ~/.agents/scripts/spec-location/cli.mjs epics --workspace <workspace>`
and finds the epic's own location the same way
([spec location](../skills/spec-end-to-end/references/spec-location.md)); neither
a skill nor a reader builds these paths itself.

## Record schema (version 1)

```json
{
  "schema_version": 1,
  "epic": "adj",
  "title": "Adjacent functionality through Sentinel",
  "plan": "plan.md",
  "state": "active",
  "created_at": "2026-10-10",
  "note": "Optional free text about the epic as a whole.",
  "packages": [
    { "package": "adj1-foundational-contracts", "requires": [] },
    { "package": "adj2-remote-observation", "requires": ["adj1-foundational-contracts"] },
    { "package": "performance-query-layer",
      "requires": [],
      "note": "Targets the warbler repository; UX consumes it through the dependency pin." }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | `1`. |
| `epic` | yes | Slug matching `^[a-z][a-z0-9-]{0,31}$`. Must equal the directory name. For new epics it is also the member name prefix (see Naming); a migrated epic may use a readable slug such as `pages` for members named `p02-…`. |
| `title` | yes | Human title, one line. |
| `plan` | no | The plan document. Resolved as a path relative to the epic directory when that file exists, otherwise as a file name under the workspace's `plans/` folder. |
| `state` | yes | The epic's own lifecycle: `planned`, `active`, `complete`, `abandoned`. This is a coordinator or operator decision, like `sentinel-completion.json` for a package. It is the only lifecycle value stored in the record. |
| `created_at` | no | ISO date. |
| `note` | no | Free text about the epic. |
| `designs` | no | Design packages the epic implements, at most 20: `{ workspace, design, path? }` with the storage workspace id, the design slug and optionally the absolute design directory. See [Design packages](design-packages.md). |
| `packages` | yes | Ordered members. Array order is the intended tie-break order when several members are eligible. At most 100. |
| `packages[].package` | yes | Package slug in the same workspace (the directory name under `specs/`, no path separators). Unique within the epic. |
| `packages[].requires` | no | Member names whose merge (or manual completion) this member needs. Array order and numbering are never dependencies; only `requires` is. The edges must not form a cycle. |
| `packages[].note` | no | One sentence for what derived status cannot express: superseded, folded into another PR, accepted deferral. |

Records are small: readers refuse files over 64 KiB and more than 50 epics per
workspace. An invalid record is reported as a coverage reason and skipped; it never
hides or reinterprets the member packages.

Reserve a member name by listing it in `epic.json`. A listed member with no
directory shows as `missing`, which replaces stub folders.

## Derived member status

Readers compute one status per member from the member package. Status is
lifecycle, not acceptance: a merged package has landed, not necessarily passed
every gate.

| Status | Evidence |
| --- | --- |
| `missing` | The member directory does not exist. |
| `unobserved` | The member's workspace is not among the observed storage roots. |
| `proposed` | Directory exists and has no `spec-steps.json`. |
| `prepared` | `spec-steps.json` exists and no dispatch receipt exists. |
| `in-progress` | Dispatch receipts exist and the package is not complete. Carries the current step position and `attention` when the current run is blocked, needs a decision, or has unresolved attention conditions. |
| `published` | Completion basis `ready-pr` or `workflow-checkpoint` without a confirmed merge. |
| `merged` | Completion basis `merged-pr`. |
| `complete` | Completion basis `manual`. |
| `unknown` | The package exists but its receipts or checkpoints could not be fully read (read budget, stale or invalid records) and no completion is recorded. Never inferred from partial evidence. |

A member's wave is derived from `requires`: wave 1 requires nothing, and each later
wave requires only members of earlier waves. Members of one wave can run at the same
time. `node ~/.agents/scripts/spec-observe/cli.mjs epic lint --workspace W --epic S`
validates a record and prints its waves; the record never stores them.

A member's `waiting_on` lists the `requires` entries whose status is not `merged`
or `complete`; it is empty for a member that has itself landed. The epic's `next` is the first member in array order whose status is
`proposed` or `prepared` and whose `waiting_on` is empty.

## Sentinel

Sentinel reads `epics/*/epic.json` in every observed workspace and derives member
status from the same package facts it already collects, regardless of the 7-day
completion window and the 24-hour activity filter. The snapshot carries:

```
snapshot.epics[] = {
  epic, title, state, note,
  designs[] = { workspace, design, path },
  workspace,             // workspace id holding the record
  record,                // absolute path of epic.json
  plan,                  // absolute path or null
  members[] = { name, package, workspace, status, attention, step: { position, total } | null,
                waiting_on[], note, completed_at, pr_url, assignment_id },
  summary = { total, merged, complete, published, in_progress, prepared, proposed, missing, unobserved, unknown, attention },
  next,                  // member name or null
  coverage = { state, reasons[] }
}
run.epic = { epic, workspace, position, total }   // on every run row whose package is a member
```

The dashboard shows the epic badge on package rows, an epic section in the
package detail with every member's status, and an **Epics** view listing each
epic's members. `sentinel status --format text` prints one line per epic.
Sentinel never writes an epic record.

## Naming

Folder names encode identity and grouping, never status. Receipts, `pr-url.json`
and `sentinel-merge.json` record the package reference (`workspace/slug`), so a package is never
renamed after its first dispatch, and status suffixes such as `- DONE` are never
added.

- **Epic members:** `<epic>-<NN>-<slug>`, two-digit ordinal, for example
  `ai-01-service-explanations`, `bill-03-invoice-export`. The epic slug is 2 to 5
  letters. Existing members keep their current names (`data01-foundations`,
  `adj1-foundational-contracts`); the record lists them as they are.
- **Standalone packages:** `<NN>-<slug>` with a workspace-wide two-digit sequence
  (one sequence across all repositories in the workspace), or a bare slug where the
  workspace already uses one. Refuse a duplicate ordinal. Slugs are unique within a
  workspace.
- **Splits:** letter suffix on the ordinal, `07a-home-frame`, `bill-03a-invoice-export`. **Continuations:** a
  new ordinal, not `-part-2`.

The ordinal records creation order and grouping. It is not a dependency; use
`requires` for that.

## Who writes the record

- **epic-plan.** Splits a body of work into members, sequences them for parallel
  work, and writes the record with `state: planned`, the plan at
  `plans/<epic>-epic.md`, and one proposed member package per entry with a
  `context.md` for architecture. An edge added only so two members do not edit the
  same surface at once carries a member `note` saying so.
- **Planning.** When architecture decomposes one plan into two or more packages,
  the planning stage creates the workspace's `epics/<slug>/epic.json` with the members, their
  `requires`, and the plan path, and names the members by the convention above.
  When the plan implements design packages, it lists them under `designs` and cuts
  members on the screen inventory ([Design packages](design-packages.md)).
  A package that is already a member of a record leaves the record unchanged.
- **epic-end-to-end.** Reads membership, order and dependencies from the record,
  writes `run.md` beside it, and updates `state`. It runs a wave's ready members in
  parallel, each in its own launched session, when they change separate surfaces and
  verify against separate state; it alone merges them. Given a `PACKAGES` list and no
  record, it writes one first.
- **spec-end-to-end.** Resolves the package's epic at intake by listing
  the workspace's epics (`spec-location epics`) for the package slug, records the epic in its ledger and
  completion summary, and reports unmet `requires` as a fact. It never edits the
  record.
- **Operators.** Edit `state`, `note` and member notes by hand when a decision is
  not derivable.

## Migrating an existing plan

Existing plans that hand-maintain a status table become an `epic.json` plus the
plan file. Keep the plan's prose for intent, decisions and seams; delete the
status table once sentinel shows the same facts. Do not rename existing members.
A `requires` edge comes from the plan's own dependency table, not from numbering.
