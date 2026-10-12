# Workspace Handoff

The top-level agent owns the code checkout layout. Use ordinary Git operations and adapt to the repository
instead of forcing every run through a branch-management skill.

## Spec Locations

[Spec Location](spec-location.md) is the single description of how skills find spec files: run `spec-location check`,
then read paths from `locations.json`. Code runs in a worktree per target repository; spec files are never in a
checkout. Carry `package_ref`, `package_dir`, and each target's worktree path in every stage and worker handoff. These
are runtime locations, not new spec schema fields.

Never rename a package folder after its first dispatch, and never encode status in a folder name. Name new packages by
the [convention](../../../docs/spec-epics.md#naming).

Concurrent work on one package needs one coordinator. Do not run competing writers for the same artifacts; use
separate packages for independent work.

## Choose The Workspace

Choose one per target in `locations.json`.

1. Honor an explicit request to use a worktree, stay in the current checkout, or target a branch.
2. Reuse a clearly matching existing implementation checkout when it is safe and unambiguous. In managed Pi,
   `spec_dispatch` creates or reuses each target's worktree and records it in `locations.json`.
3. Prefer a worktree when the source checkout is dirty, concurrent work is active, or isolation
   materially reduces risk. Otherwise, a normal feature branch in the current checkout is enough.
4. Resolve the base branch from repository and remote conventions. Avoid upstream tracking that
   could accidentally push the feature branch to the base branch.
5. Stop on branch/path ownership conflicts. Never force-remove an unrelated worktree or overwrite
   foreign changes.

Source files, tests, repository instructions, Git commands, and build/test commands resolve from the target's
checkout. Pass resolved absolute paths to tools while keeping commands in that checkout. Do not change into
another directory to run implementation tests because that is where the records live.

Visual references stay at their recorded locations in the package or `captures_dir`. Worktree creation does not
rewrite them, invalidate preparation, or regenerate designs. Resolve references outside the package at their source;
if packaging is needed, the owning preparation stage updates the package and refreshes affected hashes. Report a
missing reference rather than creating a substitute.

Apply the [project context operational boundary](project-context.md#operational-boundary).
Identify actual targets/effects before copying or activating environment files, installing dependencies
with hooks, or starting applications. A worktree does not isolate external systems. Copy only
configuration appropriate for isolated local execution under repository instructions; never blindly
copy `.env` or add speculative flags to compensate for unknown targets. Report non-fatal setup failures. Do not open an editor, write editor
settings, create a continuation hook, or start a replacement agent session.
