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
<primary checkout>/.specs/_epics/<slug>/epic.json   # the record (required)
<primary checkout>/.specs/_epics/<slug>/plan.md     # the plan the epic implements (recommended)
<primary checkout>/.specs/_epics/<slug>/run.md      # epic-end-to-end coordination log (written by that skill)
```

The record lives in the primary repository checkout, never in a linked worktree,
under the same `.specs/` rules as feature packages
([workspace handoff](../skills/spec-end-to-end/references/workspace-handoff.md)).
`.specs/` children whose names start with `_` are not packages: `_epics`, `_plans`,
`_images` and similar folders are skipped by package discovery.

An epic with members in several repositories keeps its record in one anchor
repository, ordinarily the one holding the plan. Members elsewhere name their
repository explicitly (below).

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
      "repository": "/Users/me/Documents/warbler",
      "requires": [],
      "note": "Lands in Warbler demo; UX consumes it through the dependency pin." }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | `1`. |
| `epic` | yes | Slug matching `^[a-z][a-z0-9-]{0,31}$`. Must equal the directory name. For new epics it is also the member name prefix (see Naming); a migrated epic may use a readable slug such as `pages` for members named `p02-…`. |
| `title` | yes | Human title, one line. |
| `plan` | no | Path to the plan document, relative to the epic directory. It may point outside the directory but must stay inside `.specs/`. |
| `state` | yes | The epic's own lifecycle: `planned`, `active`, `complete`, `abandoned`. This is a coordinator or operator decision, like `sentinel-completion.json` for a package. It is the only lifecycle value stored in the record. |
| `created_at` | no | ISO date. |
| `note` | no | Free text about the epic. |
| `packages` | yes | Ordered members. Array order is the intended tie-break order when several members are eligible. At most 100. |
| `packages[].package` | yes | Directory name under `.specs/` (no path separators). Unique within the epic. |
| `packages[].repository` | no | Absolute path of the member's primary checkout when it differs from the record's repository. |
| `packages[].requires` | no | Member names whose merge (or manual completion) this member needs. Array order and numbering are never dependencies; only `requires` is. |
| `packages[].note` | no | One sentence for what derived status cannot express: superseded, folded into another PR, accepted deferral. |

Records are small: readers refuse files over 64 KiB and more than 50 epics per
`.specs/`. An invalid record is reported as a coverage reason and skipped; it never
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
| `unobserved` | The member's repository is not among the observed roots. |
| `proposed` | Directory exists and has no `spec-steps.json`. |
| `prepared` | `spec-steps.json` exists and no dispatch receipt exists. |
| `in-progress` | Dispatch receipts exist and the package is not complete. Carries the current step position and `attention` when the current run is blocked, needs a decision, or has unresolved attention conditions. |
| `published` | Completion basis `ready-pr` or `workflow-checkpoint` without a confirmed merge. |
| `merged` | Completion basis `merged-pr`. |
| `complete` | Completion basis `manual`. |
| `unknown` | The package exists but its receipts or checkpoints could not be fully read (read budget, stale or invalid records) and no completion is recorded. Never inferred from partial evidence. |

A member's `waiting_on` lists the `requires` entries whose status is not `merged`
or `complete`; it is empty for a member that has itself landed. The epic's `next` is the first member in array order whose status is
`proposed` or `prepared` and whose `waiting_on` is empty.

## Sentinel

Sentinel reads `_epics/*/epic.json` in every observed `.specs/` and derives member
status from the same package facts it already collects, regardless of the 7-day
completion window and the 24-hour activity filter. The snapshot carries:

```
snapshot.epics[] = {
  epic, title, state, note,
  repository,            // primary checkout holding the record
  record,                // absolute path of epic.json
  plan,                  // absolute path or null
  members[] = { name, package, repository, status, attention, step: { position, total } | null,
                waiting_on[], note, completed_at, pr_url, assignment_id },
  summary = { total, merged, complete, published, in_progress, prepared, proposed, missing, unobserved, unknown, attention },
  next,                  // member name or null
  coverage = { state, reasons[] }
}
run.epic = { epic, repository, position, total }   // on every run row whose package is a member
```

The dashboard shows the epic badge on package rows, an epic section in the
package detail with every member's status, and an **Epics** view listing each
epic's members. `sentinel status --format text` prints one line per epic.
Sentinel never writes an epic record.

## Naming

Folder names encode identity and grouping, never status. Receipts, `pr-url.json`
and `sentinel-merge.json` store absolute package paths, so a package is never
renamed after its first dispatch, and status suffixes such as `- DONE` are never
added.

- **Epic members:** `<epic><NN>-<slug>`, two-digit ordinal, for example
  `data01-foundations`, `adj07-adjacent-import-pilot`. The epic slug is 2 to 5
  letters. Existing members keep their current names; the record lists them as
  they are.
- **Standalone packages:** `<NN>-<slug>` with a repository-wide two-digit sequence,
  or a bare slug where the repository already uses one. Refuse a duplicate ordinal.
- **Splits:** letter suffix on the ordinal, `07a-home-frame`. **Continuations:** a
  new ordinal, not `-part-2`.

The ordinal records creation order and grouping. It is not a dependency; use
`requires` for that.

## Who writes the record

- **Planning.** When architecture decomposes one plan into two or more packages,
  the planning stage creates `_epics/<slug>/epic.json` with the members, their
  `requires`, and the plan path, and names the members by the convention above.
- **epic-end-to-end.** Reads membership, order and dependencies from the record,
  writes `run.md` beside it, and updates `state`. Given a `PACKAGES` list and no
  record, it writes one first.
- **spec-end-to-end.** Resolves the package's epic at intake by scanning
  `_epics/*/epic.json` for the package name, records the epic in its ledger and
  completion summary, and reports unmet `requires` as a fact. It never edits the
  record.
- **Operators.** Edit `state`, `note` and member notes by hand when a decision is
  not derivable.

## Migrating an existing plan

Existing plans that hand-maintain a status table become an `epic.json` plus the
plan file. Keep the plan's prose for intent, decisions and seams; delete the
status table once sentinel shows the same facts. Do not rename existing members.
A `requires` edge comes from the plan's own dependency table, not from numbering.
