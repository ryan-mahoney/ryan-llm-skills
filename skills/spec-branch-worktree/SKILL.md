---
name: spec-branch-worktree
description: Create or reuse a named git branch and worktree for standalone spec-driven work, copy the matching .specs/<feature>/ package into it, prepare the local environment, and open it in VS Code. Use for "spec branch worktree", "new spec worktree", "worktree for", "start a worktree", or "create worktree".
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[description, .specs feature path, or issue/ticket reference]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "9"
---

# Spec Branch Worktree

Create or reuse one branch worktree under `~/.worktrees/<repo-name>/<slug>`. When the work is driven by `.specs/<feature>/`, copy that complete package into the worktree and treat the destination copy as canonical for all subsequent stages on the branch.

## Resolve Input

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

Require a git repository and the `code` CLI before mutating anything.

## Create Or Reuse

- If `dest` is an existing worktree on branch `<slug>`, reuse it.
- If `dest` exists but is not that worktree/branch, stop with `reason: worktree-path-conflict`; never force-remove it.
- If branch `<slug>` exists elsewhere, stop with `reason: branch-already-checked-out`.
- If the branch exists and is free, run `git worktree add "$dest" <slug>`.
- Otherwise run `git worktree add --no-track -b <slug> "$dest" "$base_ref"`.

Verify `git -C "$dest" rev-parse --abbrev-ref HEAD` equals `<slug>`, then remove upstream tracking with `git -C "$dest" branch --unset-upstream <slug> 2>/dev/null || true`.

## Prepare The Worktree

Copy local environment configuration when present:

```bash
cp "$repo_root/.env" "$dest/.env" 2>/dev/null || true
```

When a source spec slug was resolved, copy the entire source folder into `$dest/.specs/<source-slug>/`, preserving every file and subdirectory. Do not copy only `spec.md`, do not copy unrelated feature folders, and do not rewrite paths inside artifacts. Relative artifact references remain valid because the `.specs/<feature>/` shape is unchanged.

If the destination feature folder already exists:

- Reuse it when its files are byte-identical to the source.
- If either copy has diverged, stop with `reason: spec-folder-conflict`; never merge or overwrite silently.

After a successful copy, the destination is the active spec folder for this branch. The source remains an inert handoff copy; subsequent spec skills must run from the worktree and must not write back to the source checkout.

Choose a deterministic title/status-bar color from the slug using `cksum % 8`: teal `#0d7377`, purple `#6a1b9a`, orange `#e65100`, blue `#1565c0`, green `#2e7d32`, red `#b71c1c`, indigo `#283593`, or brown `#4e342e`. Merge these keys into `$dest/.vscode/settings.json` when possible:

```json
{
  "workbench.colorCustomizations": {
    "titleBar.activeBackground": "<hex>",
    "titleBar.activeForeground": "#ffffff",
    "statusBar.background": "<hex>",
    "statusBar.foreground": "#ffffff"
  }
}
```

Install dependencies using the first matching repository signal: Bun lock/AGENTS guidance → `bun install --frozen-lockfile`; documented non-Bun setup → exact documented command; then pnpm, yarn, npm, Poetry, uv, pip, Bundler, Go, or Cargo lock/project files. A failed or unavailable install is non-fatal but must be reported explicitly.

Open with `code --new-window "$dest"`.

## Report

Return one compact, definitive summary:

```txt
outcome: ready
branch: <slug>
worktree: <absolute path>
base: <base ref>
tracking: none
spec: copied:<slug> | reused:<slug> | none
environment: copied | absent
dependencies: <command and outcome | skipped>
vscode: opened
```

On failure, return `outcome: blocked`, a stable `reason`, and the conflicting path/branch or missing prerequisite. Stop after reporting; do not implement the spec.
