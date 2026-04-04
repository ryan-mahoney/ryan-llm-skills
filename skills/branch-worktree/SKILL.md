---
name: branch-worktree
description: "Create a named branch and git worktree, then open it in a color-coded VSCode window. Use when: 'branch worktree', 'new worktree', 'worktree for', 'start a worktree', 'create worktree'."
argument-hint: "[description of work, optionally starting with issue number]"
---

# Branch Worktree

Create a git worktree with a structured branch name derived from a loose description, configure the environment, color-code the VSCode window, and open it.

## Arguments

- `$ARGUMENTS` — free-text description of the work. If it starts with a number, that number is used as the issue/ticket prefix in the branch name.
  - Example: `1087 redesign dashboard onboarding` → branch `1087-redesign-dashboard-onboarding`
  - Example: `fix candidate stage seed data` → branch `fix-candidate-stage-seed-data`
  - Example: `refactor/jobs list controller` → branch `refactor-jobs-list-controller`

## Before Starting

1. Confirm `$ARGUMENTS` is not empty. If empty, ask the user to describe the work.
2. Confirm the current directory is a git repository: `git rev-parse --git-dir`.
3. Confirm `code` CLI is available: `which code`.

## Steps

### 1. Derive branch name

Parse `$ARGUMENTS` into a valid branch name:

1. Lowercase the entire string.
2. If the string starts with a number, extract it as the issue prefix.
3. Replace `/`, spaces, underscores, and consecutive special characters with a single `-`.
4. Strip leading/trailing hyphens.
5. Truncate to 60 characters max (trim at last full word boundary).
6. The result is `<slug>`.

**Examples:**
| Input | Slug |
|---|---|
| `1087 redesign dashboard onboarding` | `1087-redesign-dashboard-onboarding` |
| `fix candidate stage seed data` | `fix-candidate-stage-seed-data` |
| `refactor/jobs list controller` | `refactor-jobs-list-controller` |

### 2. Extract repo name

```bash
repo_name=$(basename "$(git remote get-url origin)" .git)
```

### 3. Create worktree and branch

**Critical rule:** The worktree must be on branch `<slug>`, never on `main`. The branch must not track any remote branch.

```bash
git fetch origin
```

**Case A — Worktree path already exists (`~/.worktrees/<repo-name>/<slug>`):**

Verify the worktree is on the correct branch:
```bash
actual_branch=$(git -C ~/.worktrees/<repo-name>/<slug> rev-parse --abbrev-ref HEAD)
```
- If `actual_branch` equals `<slug>` → reuse it, skip to Step 3b.
- If `actual_branch` is anything else (e.g. `main`) → **remove and recreate:**
  ```bash
  git worktree remove --force ~/.worktrees/<repo-name>/<slug>
  ```
  Then fall through to Case C.

**Case B — Branch `<slug>` exists locally but no worktree:**

```bash
mkdir -p ~/.worktrees/<repo-name>
git worktree add ~/.worktrees/<repo-name>/<slug> <slug>
```

**Case C — Neither exists (most common):**

```bash
mkdir -p ~/.worktrees/<repo-name>
git worktree add --no-track -b <slug> ~/.worktrees/<repo-name>/<slug> origin/main
```

`--no-track` prevents the new branch from tracking `origin/main`.

### 3b. Verify branch and remove tracking

After the worktree is ready (all cases), run these checks inside the worktree:

```bash
cd ~/.worktrees/<repo-name>/<slug>

# Confirm we are on <slug>, not main or anything else
actual_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$actual_branch" != "<slug>" ]; then
  echo "ERROR: Worktree is on branch '$actual_branch', expected '<slug>'. Aborting."
  exit 1
fi

# Remove any upstream tracking — the branch must be independent for PRs
git branch --unset-upstream <slug> 2>/dev/null || true
```

Record the absolute worktree path for all subsequent steps.

### 4. Copy environment files

```bash
cp .env ~/.worktrees/<repo-name>/<slug>/.env 2>/dev/null || true
```

### 5. Color-code the VSCode window

Compute a deterministic color index from the slug. Use a simple hash:

```bash
hash_val=$(printf '%s' "<slug>" | cksum | awk '{print $1}')
color_index=$((hash_val % 8))
```

Select the hex value from this palette:

| Index | Color  | Hex       |
|-------|--------|-----------|
| 0     | Teal   | `#0d7377` |
| 1     | Purple | `#6a1b9a` |
| 2     | Orange | `#e65100` |
| 3     | Blue   | `#1565c0` |
| 4     | Green  | `#2e7d32` |
| 5     | Red    | `#b71c1c` |
| 6     | Indigo | `#283593` |
| 7     | Brown  | `#4e342e` |

Write `.vscode/settings.json` in the worktree:

- If the file does not exist, write:
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
- If the file exists, merge using `jq`:
  ```bash
  jq --arg bg "<hex>" \
    '.["workbench.colorCustomizations"] = {
      "titleBar.activeBackground": $bg,
      "titleBar.activeForeground": "#ffffff",
      "statusBar.background": $bg,
      "statusBar.foreground": "#ffffff"
    }' \
    .vscode/settings.json > /tmp/vscode-settings-tmp.json \
    && mv /tmp/vscode-settings-tmp.json .vscode/settings.json
  ```
- If `jq` is not available, overwrite with color settings only.

### 6. Install dependencies

Run dependency installation in the worktree so it's ready to work:

```bash
cd ~/.worktrees/<repo-name>/<slug> && bun install --frozen-lockfile
```

If `bun` is not on PATH, try:
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
```

### 7. Open in VSCode

```bash
code --new-window ~/.worktrees/<repo-name>/<slug>
```

### 8. Report

Print a summary to the user:

```
Worktree ready:
  Branch:   <slug>
  Tracks:   nothing (independent — push with `git push -u origin <slug>`)
  Path:     ~/.worktrees/<repo-name>/<slug>
  Color:    <color-name> (<hex>)
```

**STOP.** Do not proceed with any implementation work. The user will continue in the new VSCode window.

## Conventions

- Branch names follow the repo pattern: `NNNN-kebab-description` when an issue number is present, `kebab-description` otherwise.
- Worktrees live under `~/.worktrees/<repo-name>/` to keep them out of the source repo.
- `.vscode/settings.json` is gitignored in the repo, so color settings won't leak into commits.
- Always fetch origin before branching to ensure the worktree starts from the latest main.
- **Never leave a worktree on `main`.** Every worktree must be on its own named branch.
- **Branches must not track a remote.** Use `--no-track` on creation and `--unset-upstream` as a safety net. This ensures `git push -u origin <slug>` sets tracking correctly when the user is ready to open a PR.
