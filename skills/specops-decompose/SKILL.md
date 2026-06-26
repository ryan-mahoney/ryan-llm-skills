---
name: specops-decompose
description: This skill should be used when the user asks to decompose a repository into a stable, machine-readable SpecOps target manifest (docs/specops/targets.json) — running the deterministic skeleton-derivation core, filling in per-target name and scope prose and the system summary, assigning deep analysis and compressed agent-doc paths, and reporting coverage, renames, and low-confidence to the orchestrator.
disable-model-invocation: true
argument-hint: "[repo-root (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# SpecOps Decompose

Produce a stable `docs/specops/targets.json` manifest for a repository. This is a leaf skill: a
thin LLM layer over the deterministic core `scripts/decompose-skeleton.mjs`. The script owns the
partition — slugs, structural units, source globs, deep analysis paths, compressed agent-doc paths,
compact coverage summary, content hashes, overrides, and renames. Its detector considers workspaces, multiple source roots, and bounded
recursive frontiers through common semantic containers such as `features`, `domains`, `modules`,
`routes`, and `workflows`; it may split a large package or source root below the first directory
layer when the structure is clear. You own only prose: per-target `name` and `scope`, and the
`system` summary. The only stochastic output is that prose. Do not orchestrate; do not run other
skills.

## Input

If `$ARGUMENTS` is provided, treat it as `REPO_ROOT`. Otherwise default `REPO_ROOT` to `.`
(the current repository).

## Procedure

### 1. Run the deterministic core

Run the script and capture the JSON it prints to stdout:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT>
```

If the skill bundle does not contain `scripts/decompose-skeleton.mjs`, use the shared suite
script at `~/.agents/scripts/decompose-skeleton.mjs`.

If `docs/specops/targets.json` already exists in the target repo, pass it so curated prose,
overrides, and renames are reconciled and preserved:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT> --manifest docs/specops/targets.json
```

The script prints the full structural manifest (pretty-printed JSON). Parse it; this is your
working object. On a reconcile run it has already carried forward `name`, `scope`, and
`last_synthesized` for slugs present in both manifests.

### 2. Treat the structural output as authoritative and immutable

The script's structural fields are the contract. **Never edit** any of:

- `slug`
- `structural_unit`
- `source_globs`
- `tier2_path`
- `agent_path`
- `origin`
- `source_hash`
- `coverage` (`unassigned.count`, `unassigned.by_top_level`, `unassigned.sample`,
  `unassigned.truncated`, `overlaps`, `low_confidence`)
- `overrides`
- `renames`

These are derived deterministically so re-runs do not churn. Editing them breaks `--check` and
silently moves the partition. This is the load-bearing guardrail of the whole pipeline: the LLM
can never move the partition, the slugs, the globs, or the coverage. Do not re-derive the
partition yourself.

### 3. Author name and scope for new targets

For each target with an empty `name` or empty `scope`, author concise prose:

- `name`: a short, human-readable label for the unit (a noun phrase, not the slug).
- `scope`: ONE line describing what the unit is responsible for.

Use light reconnaissance to ground the prose — read the unit's entry points and a few key files.
For a large repo you may spawn **at most one level** of `Explore` subagents (the suite's
one-subagent-deep bound). Do not nest subagents. Do not re-partition. Front-load the scope: lead
with the responsibility, omit needless words, no marketing language.

### 4. Write or refresh the system summary

Set the top-level `system` object:

- `system.summary`: one paragraph describing what the whole repository is and does.
- `system.external_dependencies`: the notable third-party services, runtimes, or platforms the
  system depends on (array of strings).

On a reconcile run, refresh these if the system has changed; otherwise leave a sound prior
summary in place.

### 5. Write the manifest

Write the final, complete manifest object to `docs/specops/targets.json` in the target repo,
pretty-printed (2-space indent). Preserve every structural field from the script byte-for-byte;
your edits touch only `name`, `scope`, and `system`.

### 6. Validate (optional but recommended)

Re-derive and validate structural integrity:

```bash
node scripts/decompose-skeleton.mjs <REPO_ROOT> --check docs/specops/targets.json
```

Exit `0` means the manifest's structural fields agree with a fresh derivation and the schema is
valid. A nonzero exit prints each violation to stderr — report them; do not silently edit
structural fields to make the check pass.

### 7. Report to the caller

Return a short report to the orchestrator that names, explicitly:

- `coverage.unassigned` — source files matched by no target (gaps the orchestrator may resolve
  with an override), reported as a compact summary with `count`, grouped `by_top_level`, capped
  `sample`, and `truncated` flag. Do not expand or store the full raw file list in the manifest.
- `renames` — `{old_slug, new_slug}` entries the script detected (a target whose directory moved
  with unchanged content); the orchestrator should migrate the corresponding spec.
- `coverage.low_confidence` — `true` when no module system or recognized source-root frontier was
  detectable, including top-level-directory fallback or collapse to a single root unit; signals the
  partition needs human review.

Also state the manifest path written and any `--check` violations.

## Guardrail

This skill writes **only** `docs/specops/targets.json`. It must not write per-target specs,
compressed agent docs, an
`AGENTS.md`, or any other file. If reconnaissance suggests a target's spec is stale, report it —
do not generate or edit it here.

## Reference: manifest schema

The manifest an implementer must produce (and the script emits) has this shape. Transcribed so
you can reproduce it without reading the script:

```jsonc
{
  "version": 1,
  "system": { "summary": "string (one paragraph)", "external_dependencies": ["string"] },
  "targets": [
    {
      "slug": "string",            // kebab-case, unique, derived deterministically from structural_unit
      "name": "string",            // LLM-authored
      "scope": "string",           // LLM-authored, one line
      "origin": "derived" | "override",
      "structural_unit": "string", // repo-relative path the slug derives from, e.g. "packages/submissions"
      "source_globs": ["string"],  // >=1; generated projection of the unit (and overrides), never hand-authored
      "tier2_path": "docs/specops/analysis/<slug>.md",
      "agent_path": "docs/specops/agents/<slug>.md",
      "source_hash": "sha256:…" | null,
      "last_synthesized": "ISO-8601" | null
    }
  ],
  "overrides": [
    { "op": "merge", "units": ["path", "…"], "into": "slug" },
    { "op": "split", "unit": "path", "into": [ { "slug": "string", "subpath": "string" } ] },
    { "op": "relabel", "unit": "path", "name": "string", "scope": "string" }
  ],
  "renames": [ { "old_slug": "string", "new_slug": "string" } ],
  "coverage": {
    "unassigned": {
      "count": 0,
      "by_top_level": [ { "path": "string", "count": 0 } ],
      "sample": ["path"],
      "truncated": false
    },
    "overlaps": [ { "path": "string", "slugs": ["string", "…"] } ],
    "low_confidence": false
  }
}
```

`name` and `scope` are LLM-authored; `system.summary` and `system.external_dependencies` are
LLM-authored. Every other field is derived by the script. `overrides` are author-supplied curation
the script applies; you never invent them in this skill. `coverage.unassigned` is intentionally a
summary rather than a complete path list because generated, vendored, and local artifact files can
make the raw list too large and unstable for a committed manifest.

## Reference: slug rule

The script derives each `slug` from the `structural_unit` path so the same path yields the same
slug on every run:

1. Lowercase the path.
2. Replace each run of non-alphanumeric characters with a single `-`.
3. Trim leading and trailing `-`.
4. On collision with an already-taken slug, append the parent path segment (then the next
   ancestor, and so on) until the slug is unique.

Same `structural_unit` path ⇒ same slug, every run. A single root unit slugs to `root`.

## Reference: partition detection

The script derives a stable target frontier in this order:

1. Workspace packages from `package.json` or `pnpm-workspace.yaml` are preferred. A workspace unit
   remains a target unless it contains a clear internal semantic frontier, or unless it is large and
   has several child units under an internal source root.
2. Without workspaces, all recognizable source roots are considered, not just the first one found:
   `src`, `lib`, `app`, `packages`, `services`, and `cmd`.
3. Within a source root, the detector recursively descends through semantic container directories
   such as `features`, `domains`, `modules`, `routes`, and `workflows`, so `src/features/billing`
   becomes a target rather than the shallower `src/features`.
4. If no recognized module or source-root frontier exists, the script falls back to top-level
   directories and marks `coverage.low_confidence: true`.

This keeps the partition deterministic while avoiding the earlier one-level-only target list.

## Reference: source_hash basis

`source_hash` is a content hash, not a file-list-plus-mtime stamp. The script computes it as:

`"sha256:" + sha256( the path-sorted, newline-joined list of `relpath \0 sha256(file-contents)` for every file matched by the target's effective source_globs )`

`relpath` is **unit-relative** — the matching glob's base path is stripped, so the path is
relative to the unit, not the repo. Consequences, by design:

- Unchanged across an mtime-only touch (it hashes contents, not timestamps).
- Unchanged across a directory rename that preserves content (the glob base is stripped, so the
  relative paths and contents are identical) — this is what lets rename detection match old→new.
- Changes if and only if the matched content changes.

This is why a content-preserving rename produces a `renames` entry while a rename with content
edits is reported as a removal plus an addition for the orchestrator to resolve.
