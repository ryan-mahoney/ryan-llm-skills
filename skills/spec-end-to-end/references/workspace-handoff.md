# Workspace Handoff

The top-level agent owns repository layout. Use ordinary Git operations and adapt to the repository
instead of forcing every run through a branch-management skill.

## Choose The Workspace

1. Honor an explicit request to use a worktree, stay in the current checkout, or target a branch.
2. Reuse a clearly matching existing implementation checkout when it is safe and unambiguous.
3. Prefer a worktree when the source checkout is dirty, concurrent work is active, or isolation
   materially reduces risk. Otherwise, a normal feature branch in the current checkout is enough.
4. Resolve the base branch from repository and remote conventions. Avoid upstream tracking that
   could accidentally push the feature branch to the base branch.
5. Stop on branch/path ownership conflicts. Never force-remove an unrelated worktree or overwrite
   foreign changes.

## Hand Off A Spec Package

`.specs/` is often gitignored, so creating a worktree may not carry the prepared package with it.
When the package is absent from the destination:

1. Copy the complete `.specs/<feature>/` folder, preserving all files, subdirectories, evidence,
   packaged references, and checkout-relative paths. Never copy only `spec.md`.
2. Treat the destination copy as canonical. The source copy becomes an inert handoff artifact.
3. If the destination package already exists, reuse it only when it is byte-identical. Stop on
   divergence instead of merging or overwriting silently.
4. Confirm every direct `Visual reference:` inside the feature folder still resolves byte-for-byte.
5. For a legacy visual reference outside the package, copy the smallest self-contained artifact
   into `visual-references/`, update only the destination reference values, remove destination
   `preparation.json`, and rerun `spec-prepare` because its hashes are stale.
6. Stop when a named visual reference is missing or a destination collision has different bytes.

Copy local environment configuration and install dependencies only when repository instructions
make that appropriate. Report non-fatal setup failures. Do not open an editor, write editor
settings, create a continuation hook, or start a replacement agent session.
