---
name: specops-decompose
description: This skill should be used when the user asks to decompose a repository into a stable, machine-readable SpecOps target manifest (docs/specops/targets.json) — running the git-aware deterministic skeleton core, curating it with an LLM classification pass that authors durable overrides (exclude/collapse/merge/split/relabel), filling in per-target name and scope prose and the system summary, assigning deep analysis and compressed agent-doc paths, and reporting coverage, exclusions, renames, and low-confidence to the orchestrator.
disable-model-invocation: true
argument-hint: "[repo-root (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "4"
---

# SpecOps Decompose

Produce a stable `docs/specops/targets.json` manifest for a repository. This skill is a thin LLM
layer over the deterministic core `scripts/decompose-skeleton.mjs`, but the LLM does **two** jobs,
not one:

1. **Curate** — classify the candidate units the core surfaces and author durable `overrides`
   (`exclude`, `collapse`, `merge`, `split`, `relabel`) that fix what a structure-only script cannot
   judge: runtime output checked into the repo, over-split subtrees, loosely-grouped siblings.
2. **Prose** — per-target `name` and `scope`, and the `system` summary.

The script owns everything deterministic: it discovers files **git-aware** (honoring `.gitignore`,
including nested ones, so the system's own outputs and other ignored noise are never analyzed),
derives the partition, **applies your overrides**, and emits slugs, structural units, source globs,
deep-analysis paths, compressed agent-doc paths, content hashes, coverage (including an `excluded`
bucket), and renames.

The key idea: **the LLM decides once, the script replays forever.** Your curation is captured as
committed `overrides`, not re-rolled every run — so the partition stays idempotent (`--check`
passes, analysis artifacts don't churn) while still being informed by judgment a structural
heuristic can't make. Do not orchestrate; do not run other skills.

## Input

If `$ARGUMENTS` is provided, treat it as `REPO_ROOT`. Otherwise default `REPO_ROOT` to `.`
(the current repository).

If the skill bundle does not contain `scripts/decompose-skeleton.mjs`, use the shared suite
script at `~/.agents/scripts/decompose-skeleton.mjs`.

## Procedure

### 1. Run the deterministic core (skeleton)

Capture the structural manifest the script prints to stdout:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT>
```

If `docs/specops/targets.json` already exists, pass it so curated prose, **overrides**, and renames
are reconciled and preserved:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT> --manifest docs/specops/targets.json
```

On a reconcile run the script carries forward `name`, `scope`, `last_synthesized`, and the prior
`overrides` for slugs present in both manifests. **If the existing manifest already carries a sound
override set, do not re-curate** — skip to step 4. Re-curate only when the structure changed
materially (new top-level areas, `coverage.low_confidence: true`, or the caller asks).

### 2. Curate: classify candidates and author overrides

Get the compact, classified view of the candidate units:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT> --frontier
```

This prints one fingerprint per candidate unit: `file_count`, `total_bytes`, an extension
histogram, `sample_files`, a `looks_like` label, a `suggested_disposition`, and `signals`. The
script **proposes** (cheap heuristics); you **dispose**. Work from this list — you do not need to
read thousands of files. Spend light reconnaissance only where a suggestion is ambiguous; for a
large repo you may spawn **at most one level** of `Explore` subagents to gather evidence. Do not
nest subagents.

For each unit, settle a **role** and a **disposition** (see *Reference: curate taxonomy*), then
author `overrides` that make the partition match how a human would chapter the repo:

- **`exclude`** anything that is not behavior-bearing source you want documented: runtime/job output
  committed to the repo, generated artifacts, vendored third-party code, recordings/snapshots,
  large data fixtures. Git-awareness already removes ignored output for free; `exclude` is for
  noise that is *tracked*. Every exclude carries a one-line `reason`.
- **`collapse`** an over-split subtree into one target (the script emits one bucket per directory
  for loosely-organized trees — fold them: a demo/config/examples tree is usually one chapter).
- **`merge`** sibling or cross-folder units that are facets of one concept (e.g. `.claude` +
  `.clinerules*` → one "agent config" target). Collapse N parallel instances of the same shape into
  one representative target.
- **`split`** a derived unit the core under-divided (rare; the core already splits aggressively).
- **`relabel`** to set a curated name/scope on a unit inline.

Aim for a target count a reader would recognize as chapters — typically ~5–20 for a normal repo,
not one per directory. Prefer `summarize`-disposition units (config, manifests, editor/agent rules,
docs, demo source) staying as their own light targets over excluding them; reserve `exclude` for
genuine non-source. When in doubt, keep and report rather than silently drop.

Be conservative and evidence-grounded. An `exclude` removes files from analysis entirely, so it
must be defensible — the manifest records its reason and `--check` keeps it honest.

### 3. Re-project with the curated overrides

Write a manifest carrying your `overrides` array (start from the step-1 output; on a reconcile run
the existing manifest already holds them) and re-run the core so it applies them deterministically:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT> --manifest <curated-manifest.json>
```

The result is the authoritative structural manifest: derived + remainder + override targets, with
excluded files moved out of `coverage.unassigned` into `coverage.excluded`. This is your working
object for prose.

### 4. Treat the structural projection as authoritative and immutable

The script's derived fields are the contract. **Never hand-edit** any of:

- `slug`, `structural_unit`, `source_globs`, `tier2_path`, `agent_path`, `origin`, `source_hash`
- `coverage` (`unassigned`, `excluded`, `overlaps`, `low_confidence`)
- `renames`

These are derived deterministically from the units **and your overrides**, so re-runs do not churn.
You influence the partition only through the `overrides` array (step 2) — never by editing a
projected field. Editing them breaks `--check` and silently moves the partition.

### 5. Author name and scope

For each target with an empty `name` or empty `scope`:

- `name`: a short, human-readable noun phrase (not the slug).
- `scope`: ONE front-loaded line naming the unit's responsibility. Omit needless words; no marketing.

For a `remainder` target, ground the prose in the actual loose files it covers and make the label
read as a bucket (e.g. "Source root (loose modules)"). For an `override` target, describe the merged
or collapsed whole. For a `summarize`-disposition target, the scope may note it is configuration/
reference rather than core behavior.

### 6. Write or refresh the system summary

Set `system.summary` (one paragraph: what the repository is and does) and
`system.external_dependencies` (notable third-party services, runtimes, platforms). On a reconcile
run, refresh only if the system changed.

### 7. Write the manifest

Write the complete manifest to `docs/specops/targets.json`, pretty-printed (2-space indent).
Preserve every projected structural field byte-for-byte; your edits touch only `name`, `scope`,
`system`, and the `overrides` you authored in step 2.

### 8. Validate

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT> --check docs/specops/targets.json
```

Exit `0` means the manifest's structural fields agree with a fresh derivation **under the same
overrides** and the schema is valid. A nonzero exit prints each violation to stderr — report them;
do not silently edit structural fields to make the check pass. If an override is wrong, fix the
override and re-project, do not patch the projection.

### 9. Report to the caller

Return a short report that names, explicitly:

- `coverage.excluded` — files you removed from analysis, with the count and per-`reason` breakdown.
  This is the auditable record of "what we chose not to document and why"; surface it so a curator
  can pull anything back.
- `overrides` — the curation you authored, by op and target, each with its rationale. These are the
  judgment calls; make them visible in the report and the diff.
- `coverage.unassigned` — source files matched by no target. Gap closure normally drives this to
  `0`; a nonzero count signals files an override removed from coverage without excluding them.
- `remainder` targets — any `origin: "remainder"`. They flag directories that still lack module
  structure a curator may want to revisit.
- `renames` — `{old_slug, new_slug}` entries (a unit whose directory moved with unchanged content);
  the orchestrator should migrate the corresponding spec.
- `coverage.low_confidence` — `true` when no module system or source-root frontier was detectable;
  signals the partition needs human review.

Also state the manifest path written and any `--check` violations.

## Guardrail

This skill writes **only** `docs/specops/targets.json`. It must not write per-target specs,
compressed agent docs, an `AGENTS.md`, or any other file. If reconnaissance suggests a target's
spec is stale, report it — do not generate or edit it here.

## Reference: curate taxonomy

Classify each candidate unit by **role**, which implies a default **disposition**. The
`--frontier` `signals` are hints toward this, not the decision.

| Disposition | Meaning | Roles |
|---|---|---|
| `analyze` | behavior-bearing source; gets a full analysis target | entrypoint · domain/core logic · controller/handler/route · model/schema/entity · service/use-case · adapter/provider/gateway · middleware · view/UI component/page · shared utility |
| `summarize` | keep as a light target; note it, don't deep-analyze | dependency manifest · app/build config · CI config · editor/agent config (`.claude`, `.clinerules`, `.vscode`) · documentation · example/demo **source** |
| `exclude` | remove from analysis via an `exclude` override (+reason) | runtime/job output · generated artifacts · vendored third-party · build output · snapshots/cassettes · binary assets · lockfiles · secrets/`.env` |

The decisive distinction a structural script cannot make: example **source** (a demo task module —
reference-worthy, `summarize`) versus example **output** (a job's logs/artifacts — `exclude`), even
in the same tree. Use the fingerprint's `signals` (`runtime-output`, `no-code`, `dotfile-config`,
`example-or-demo`, `tiny`) plus light reconnaissance to decide.

## Reference: override vocabulary

The script applies overrides in two phases around remainder gap-closure, so each op sees the target
set it needs. Relative order within a phase follows the array.

- **Pre-remainder** (operate on derived units):
  - `{ "op": "exclude", "units": ["path", …], "reason": "…" }` — drop these units/subtrees from
    analysis. Accepts `units` (paths) and/or `globs`. Files land in `coverage.excluded`, never get a
    remainder, and no target owns them. Cannot target the whole repo.
  - `{ "op": "split", "unit": "path", "into": [ { "slug": "…", "subpath": "…" } ] }` — subdivide a
    unit the core under-split. Loose files in the parent are then caught by remainders.
- **Post-remainder** (operate on the full set, including loose remainder buckets):
  - `{ "op": "collapse", "unit": "path", "into": "slug" }` — fold a directory subtree (the unit and
    everything under it) into one target with a clean `path/**` glob. The primary cure for an
    over-split loosely-organized tree.
  - `{ "op": "merge", "units": ["path", …], "into": "slug" }` — combine arbitrary units (siblings,
    cross-folder) into one override target with the union of their globs.
  - `{ "op": "relabel", "unit": "path", "name": "…", "scope": "…" }` — set curated name/scope inline.

`collapse` is the inverse of `split`. Use `collapse` for "this subtree is one chapter," `merge` for
"these scattered units are one chapter."

## Reference: manifest schema

```jsonc
{
  "version": 1,
  "system": { "summary": "string (one paragraph)", "external_dependencies": ["string"] },
  "targets": [
    {
      "slug": "string",            // kebab-case, unique, derived from structural_unit
      "name": "string",            // LLM-authored
      "scope": "string",           // LLM-authored, one line
      "origin": "derived" | "override" | "remainder",
      "structural_unit": "string", // repo-relative path the slug derives from
      "source_globs": ["string"],  // >=1; generated projection, never hand-authored
      "tier2_path": "docs/specops/analysis/<slug>.md",
      "agent_path": "docs/specops/agents/<slug>.md",
      "source_hash": "sha256:…" | null,
      "last_synthesized": "ISO-8601" | null
    }
  ],
  "overrides": [                   // LLM-authored in the curate stage, then replayed deterministically
    { "op": "exclude", "units": ["path"], "reason": "string" },
    { "op": "collapse", "unit": "path", "into": "slug" },
    { "op": "merge", "units": ["path", "…"], "into": "slug" },
    { "op": "split", "unit": "path", "into": [ { "slug": "string", "subpath": "string" } ] },
    { "op": "relabel", "unit": "path", "name": "string", "scope": "string" }
  ],
  "renames": [ { "old_slug": "string", "new_slug": "string" } ],
  "coverage": {
    "unassigned": { "count": 0, "by_top_level": [ { "path": "string", "count": 0 } ], "sample": ["path"], "truncated": false },
    "excluded":   { "count": 0, "reasons": [ { "reason": "string", "count": 0 } ], "by_top_level": [], "sample": [], "truncated": false },
    "overlaps": [ { "path": "string", "slugs": ["string", "…"] } ],
    "low_confidence": false
  }
}
```

`name`, `scope`, `system`, and `overrides` are LLM-authored. Every other field is derived by the
script. `coverage.unassigned` and `coverage.excluded` are intentionally summaries, not full path
lists, because generated and excluded files can make the raw list large and unstable for a committed
manifest.

## Reference: slug rule

The script derives each `slug` from `structural_unit` so the same path yields the same slug on
every run:

1. Lowercase the path.
2. Replace each run of non-alphanumeric characters with a single `-`.
3. Trim leading and trailing `-`.
4. On collision, append the parent path segment (then the next ancestor) until unique.

Same `structural_unit` ⇒ same slug, every run. A single root unit slugs to `root`. An `override`
target's slug is the `into`/`slug` you chose.

## Reference: partition detection

1. **File discovery is git-aware.** When the repo root is a git work tree, the script lists files
   via `git ls-files` (tracked + untracked-not-ignored), so every `.gitignore` — including nested
   ones — decides what is noise. It falls back to a filesystem walk only when git is unavailable.
   Either way `IGNORED_DIRS` (tests, docs, build output, …) and `IGNORED_FILES` (`.DS_Store`,
   `.gitkeep`/`.keep` placeholders) are dropped, and the result is content-sorted for stable order.
2. **Frontier.** Workspace packages (`package.json` / `pnpm-workspace.yaml`) are preferred; else all
   recognized source roots (`src`, `lib`, `app`, `packages`, `services`, `cmd`); within a root the
   detector descends through semantic containers (`features`, `domains`, `modules`, `routes`,
   `workflows`, …). With no recognized frontier it falls back to top-level directories and marks
   `coverage.low_confidence: true`.
3. **Gap closure (remainder targets).** Every still-unowned, non-excluded file is grouped by its
   immediate parent and captured by a shallow `dir/*` (or `*`) remainder target, so loose files in
   an under-organized repo are analyzed rather than dropped into `coverage.unassigned`. Directory
   structure is derived from the discovered file set, so a git-ignored directory never forms a unit.

All directory and boundary detection reads the discovered file set, never the raw filesystem, so the
partition is consistent with git-awareness end to end.

## Reference: source_hash basis

`source_hash` is a content hash, not a file-list-plus-mtime stamp:

`"sha256:" + sha256( path-sorted, newline-joined list of `relpath \0 sha256(file-contents)` for every file matched by the target's effective source_globs )`

`relpath` is **unit-relative** — the matching glob's base is stripped. Consequences, by design:

- Unchanged across an mtime-only touch (it hashes contents).
- Unchanged across a content-preserving directory rename (glob base stripped ⇒ identical relative
  paths and contents) — this is what lets rename detection match old→new.
- Changes if and only if matched content changes.

A content-preserving rename produces a `renames` entry; a rename with content edits is reported as a
removal plus an addition for the orchestrator to resolve.
