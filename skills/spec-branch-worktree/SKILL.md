---
name: spec-branch-worktree
description: "Create or reuse a named git branch and worktree for standalone spec-driven work, keep the matching .specs/<feature>/ package in the primary repository, prepare the local environment, and return the worktree to the invoking agent. Use for \"spec branch worktree\", \"new spec worktree\", \"worktree for\", \"start a worktree\", or \"create worktree\"."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[description, .specs feature path, or issue/ticket reference]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "13"
---

# Spec Branch Worktree

Create or reuse one branch worktree under `~/.worktrees/<repo-name>/<slug>`. The primary repository retains the canonical `.specs/<feature>/` package for every stage; the worktree holds the code checkout.

## Resolve Input

Read [Workspace Handoff](../spec-end-to-end/references/workspace-handoff.md). Resolve the primary
repository and code checkout separately before locating `.specs/`. Map explicit worktree spec
paths to their primary-repository counterparts using the shared path resolver.

Resolve the work description in this order:

1. Explicit `$ARGUMENTS`.
2. An explicit `.specs/<feature>/` folder or a file inside it; use its title and folder name and record the source feature slug.
3. The spec folder or work named in the conversation.

If only a GitHub issue number is supplied, use `gh issue view <number> --json title --jq .title` only when the current repository has a GitHub remote. For other ticket identifiers, require descriptive context. If no description resolves, stop with:

```txt
outcome: blocked
reason: missing-work-description
```

If no explicit path is supplied and exactly one `.specs/*/spec.md` or `.specs/*/proposal.md` matches the conversation, use it. Stop on ambiguity rather than choosing by modification time.

## Derive Names

Normalize the description to a branch slug:

1. Lowercase.
2. Preserve a leading issue/ticket identifier.
3. Replace separators and repeated punctuation with one hyphen.
4. Trim hyphens.
5. Limit to 60 characters at a word boundary.

Resolve:

```bash
repo_root=$(git rev-parse --show-toplevel)
repo_name=$(basename "$(git remote get-url origin 2>/dev/null || printf '%s' "$repo_root")" .git)
dest="$HOME/.worktrees/$repo_name/<slug>"
git fetch origin 2>/dev/null || true
default_branch=$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')
base_ref="origin/${default_branch:-main}"
git rev-parse --verify "$base_ref" >/dev/null 2>&1 || base_ref="HEAD"
```

Require a git repository before mutating anything.

## Create Or Reuse

- If `dest` is an existing worktree on branch `<slug>`, reuse it.
- If `dest` exists but is not that worktree/branch, stop with `reason: worktree-path-conflict`; never force-remove it.
- If branch `<slug>` exists elsewhere, stop with `reason: branch-already-checked-out`.
- If the branch exists and is free, run `git worktree add "$dest" <slug>`.
- Otherwise run `git worktree add --no-track -b <slug> "$dest" "$base_ref"`.

Verify `git -C "$dest" rev-parse --abbrev-ref HEAD` equals `<slug>`, then remove upstream tracking with `git -C "$dest" branch --unset-upstream <slug> 2>/dev/null || true`.

## Prepare The Worktree

Read the [Project Context And Authority](../spec-end-to-end/references/project-context.md)
operational boundary before environment setup. A worktree isolates files, not database or service
connections. Inspect configuration target names without exposing secrets. Copy only configuration
appropriate for an isolated local target under repository instructions; never activate a production
connection merely because `.env` exists. Use an existing safe local example when available. Record
unknown targets and defer commands with external effects until resolved. Do not invent flags or
new configuration mechanisms as a substitute for identifying the target.

Keep the spec package in the primary repository. Do not copy, move, or symlink `.specs/` into
`dest`. If Git checks out a tracked copy, or an older run left one there, leave it untouched and
ignore it for all spec reads and writes. Return the canonical absolute spec-folder path along
with the worktree path. All subsequent plans, updates, learnings, logs, reviews, and tours go to
that canonical folder.

Read visual references from their canonical source locations. Confirm required files exist;
worktree creation does not rebase reference paths, rewrite specs, or invalidate preparation.
For a missing visual reference, stop with `reason: missing-visual-reference`. Any needed legacy
reference packaging belongs to preparation in the primary repository under the shared handoff
rules. Never regenerate a design during worktree setup.

Check install/startup hooks for external effects and respect resolved authority. Install dependencies
using the first matching repository signal: Bun lock/AGENTS guidance → `bun install --frozen-lockfile`; documented non-Bun setup → exact documented command; then pnpm, yarn, npm, Poetry, uv, pip, Bundler, Go, or Cargo lock/project files. A failed or unavailable install is non-fatal but must be reported explicitly.

## Return Control

Return the prepared worktree path and canonical spec-folder path to the invoking top-level agent. The invoking agent decides how
to continue work there: for example, by setting tool working directories, continuing in the same
session, or delegating later stages when authorized.

Do not open an editor, create editor-specific settings, start a replacement agent session, install
a continuation hook, or implement the spec. Worktree creation is a repository handoff, not a UI or
session handoff.

## Report

Return one compact, definitive summary:

```txt
outcome: ready
branch: <slug>
worktree: <absolute path>
base: <base ref>
tracking: none
spec-folder: <absolute primary-repository feature path | none>
visual-references: verified:<count> | none
preparation: preserved | none
environment: copied | absent
dependencies: <command and outcome | skipped>
handoff: top-level-agent
editor: unchanged
```

On failure, return `outcome: blocked`, a stable `reason`, and the conflicting path/branch or missing prerequisite. Stop after reporting; do not implement the spec.
