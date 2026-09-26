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

## Keep Specs In The Primary Repository

Every `.specs/` read and write uses the primary repository checkout, including direct skill
invocations and resumed work. Never copy, move, or symlink the spec folder into a worktree.
A tracked or previously copied worktree `.specs/` folder is not authoritative: leave it alone
and use the primary repository's version. Do not merge its differences back automatically.

Resolve both roots before locating or creating a package. Run this helper from the code checkout:

```bash
node ~/.agents/skills/spec-end-to-end/scripts/resolve-spec-path.mjs .specs/<feature>/spec.md
```

It uses Git's worktree registry to return `executionRoot`, `repositoryRoot`, `specRoot`, and
`specPath`. It maps an explicit path inside a registered worktree's `.specs/` back to the primary
repository, even when the canonical file does not exist yet. With no argument it returns the
roots for discovery. Do not use `git rev-parse --show-toplevel` alone to identify the primary
repository: in a linked worktree it identifies the code checkout. If the primary checkout is
unavailable, report the missing location; never fall back to the worktree copy.

Carry the absolute execution root and canonical feature-folder path in every stage/worker
handoff. These are runtime locations, not new spec schema fields. Keep serialized paths portable:

- `.specs/<feature>/...` resolves from `repositoryRoot` for all reads, writes, hashes, logs,
  captures, prototypes, reviews, preparation, evidence, tours, and publication records.
- Shared project context is `repositoryRoot/.specs/project-context.md`; feature snapshots
  remain in `.specs/<feature>/context.md`.
- A filename relative to the feature package resolves from its canonical folder.
- Source files, tests, repository instructions, Git commands, and build/test commands resolve
  from `executionRoot`. Their commit bindings refer to the implementation branch.

Pass resolved absolute paths to tools while keeping commands in the code checkout. For a command
that writes evidence, resolve its output destination explicitly; a relative shell redirect or
screenshot output under `.specs/` would otherwise write to the worktree. Do not change to the
primary checkout to run implementation tests just because that is where the records live.

Visual references inside `.specs/` stay at their canonical paths. Worktree creation does not
rewrite them, invalidate preparation, or regenerate designs. Resolve legacy references outside
the package at their source; if packaging is needed, the owning preparation stage updates the
canonical package and refreshes affected hashes. Report a missing reference rather than
creating a substitute. If the canonical package is missing but a worktree copy exists, report
that recovery is needed; do not silently adopt or overwrite either location.

Concurrent work on one canonical feature package needs one coordinator. Do not run competing
writers for the same artifacts; use separate feature folders for independent work.

Apply the [project context operational boundary](project-context.md#operational-boundary).
Identify actual targets/effects before copying or activating environment files, installing dependencies
with hooks, or starting applications. A worktree does not isolate external systems. Copy only
configuration appropriate for isolated local execution under repository instructions; never blindly
copy `.env` or add speculative flags to compensate for unknown targets. Report non-fatal setup failures. Do not open an editor, write editor
settings, create a continuation hook, or start a replacement agent session.
