---
name: spec-branch-worktree
description: Create or reuse a named git branch and worktree for spec-driven work, prepare its local environment, and open it in a color-coded VSCode window. Use for "spec branch worktree", "new spec worktree", "worktree for", "start a worktree", or "create worktree". Feature-document artifacts remain outside the checkout and are never copied.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[description, feature-document path, or issue/ticket reference]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "8"
---

# Spec Branch Worktree

Create or reuse one branch worktree under `~/.worktrees/<repo-name>/<slug>`. Spec artifacts live in the external feature document folder; use them only to derive intent and never copy them into the worktree.

## Resolve Input

Resolve the work description in this order:

1. Explicit `$ARGUMENTS`.
2. An explicit feature-document/spec/proposal path; use its title and folder name.
3. The feature document or work named in the conversation.

If only a GitHub issue number is supplied, use `gh issue view <number> --json title --jq .title` only when the current repository has a GitHub remote. For other ticket identifiers, require descriptive context. If no description resolves, stop with:

```txt
outcome: blocked
reason: missing-work-description
```

When a **# Canonical spec artifact paths** stanza is present, `artifactsRoot` may inform the description, but no artifact path is a worktree destination.

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

Copy only local environment configuration when present:

```bash
cp "$repo_root/.env" "$dest/.env" 2>/dev/null || true
```

Never create or copy a spec-artifact directory in `dest`.

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
artifacts: external | none
environment: copied | absent
dependencies: <command and outcome | skipped>
vscode: opened
```

On failure, return `outcome: blocked`, a stable `reason`, and the conflicting path/branch or missing prerequisite. Stop after reporting; do not implement the spec.
