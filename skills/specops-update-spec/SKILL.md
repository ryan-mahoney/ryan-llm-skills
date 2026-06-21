---
name: specops-update-spec
description: This skill should be used when the user asks to update one SpecOps target's deep spec in place from a branch or diff — re-reading the target's tier2_path spec and the changed files, editing only the sections traceable to the diff, re-validating Evidence file references, and returning the target's refreshed source_hash and last_synthesized to the orchestrator.
disable-model-invocation: true
argument-hint: "[target manifest entry + branch/diff context]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Update Spec

Update ONE target's deep spec in place from a branch or diff. This is a Phase 2 leaf skill: the
orchestrator passes a single target's manifest entry plus the branch/diff context, and you edit
that one spec to match the change, then return a refreshed freshness stamp. The read-and-edit-in-
place model is the point — you do not regenerate the spec, you patch the parts the diff touched.
Do not orchestrate; do not run other skills.

## Input

The orchestrator passes you, for ONE target:

- The target's **manifest entry** — `slug`, `name`, `scope`, `source_globs`, `tier2_path`,
  `source_hash`, `last_synthesized`.
- **Branch/diff context** — the branch under review and the file diff (or enough to reconstruct
  the changed paths and hunks).

You do **not** read `docs/specops/targets.json` yourself. The orchestrator owns the manifest and
hands you the one entry you need.

## Procedure

### 1. Read the existing spec and the changed files

Read the existing spec at the target's `tier2_path`. Read the changed files from the diff, scoped
to the target's `source_globs` — only changes that fall inside this target's globs are yours to
reflect. Note the changed paths and the specific hunks; those map to the spec sections you may edit.

For a large change you may spawn **at most one level** of `Explore` subagents to locate the spec
sections affected by the diff (the suite's one-subagent-deep bound). Do not nest subagents.

### 2. Edit the spec in place

Change **only** the sections traceable to the diff. Preserve the document's structure and leave
untouched sections **byte-for-byte unchanged**. Do not rewrite the whole spec, do not reorder
sections, do not reflow prose that the diff did not affect. Use targeted edits, not a full rewrite.

For each changed hunk, find the section that describes that behavior (interface, data model,
behavioral contract, rule, side effect, etc.) and update it to match the new code. If the diff
adds behavior with no corresponding section, add it in the matching place; if it removes behavior,
remove or correct the stale section. Keep the edit minimal and traceable to the diff.

### 3. Re-validate Evidence file references

A SpecOps deep spec cites source files under `Evidence` subsections (see `specops-analysis`). Walk
those references and re-validate them:

- **Existence check (mechanical):** for each path cited in an `Evidence` subsection, confirm the
  file still exists at that path. Flag every reference whose file no longer exists (moved, renamed,
  or deleted) so the orchestrator knows the citation is broken.
- **Stale-surrounding-code check:** for each Evidence reference whose file **did change in the
  diff**, flag it — the cited code moved or changed, so the spec text around that reference may
  need updating even if the path still resolves.

Report both lists. Fix the Evidence references you can fix from the diff with confidence; flag the
rest for the orchestrator rather than guessing.

### 4. Recompute and return the refreshed source_hash and last_synthesized

Recompute the target's `source_hash` over its effective `source_globs`, using the same hashing the
decomposition core uses, and capture a fresh `last_synthesized` timestamp. You **return** these to
the orchestrator — you do **not** write them into the manifest yourself (the orchestrator owns the
manifest write).

Use one of the two mechanisms the committed script actually supports:

- **Single target (simpler).** Import the exported `sourceHash` and call it over this target's
  globs:

  ```bash
  node --input-type=module -e \
    'import { sourceHash } from "./scripts/decompose-skeleton.mjs"; console.log(sourceHash("<REPO_ROOT>", ["<unit>/**"]))'
  ```

  Pass the target's actual `source_globs` array. This prints `sha256:<hex>` — the exact value the
  script would store for that target.

- **Whole-manifest reconcile.** If the orchestrator wants every target reconciled at once, it can
  run `node scripts/decompose-skeleton.mjs <REPO_ROOT> --manifest docs/specops/targets.json`; the
  printed JSON carries the freshly recomputed `source_hash` for this target's slug. Read it from
  there.

Both yield the same hash for a given target's globs. For `last_synthesized`, use the current
UTC time in ISO-8601 (e.g. `2026-06-21T00:00:00Z`).

There is no per-target hash CLI flag — these are the only supported paths. Do not invent one.

## Guardrail

Edit **only** this target's own `tier2_path` spec. Do not touch any sibling target's spec, the
manifest, or any other file. Sibling specs stay untouched.

If the diff implicates a path owned by **no** target — a changed file that falls outside this
target's `source_globs` and is not covered by another known target — do **not** invent a target and
do **not** stretch this spec to cover it. Report the unowned path to the orchestrator so it can run
a `specops-decompose` re-run to re-derive the partition. Inventing a target here would silently move
the partition the decomposition core owns.

## Return to the orchestrator

Return a short report containing:

- The refreshed `source_hash` (`sha256:…`) and the fresh `last_synthesized` timestamp, for the
  orchestrator to write back into the manifest.
- The spec sections you changed, each tied to the diff hunk that prompted it.
- Evidence re-validation findings: references whose files no longer exist, and references whose
  surrounding code changed in the diff.
- Any unowned paths in the diff that need an orchestrator-driven `specops-decompose` re-run.
