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

### 1. Resolve issue title (if issue number provided)

If `$ARGUMENTS` starts with or contains only an issue number (e.g. `1087`, `#1087`, `issue 1087`), **you must look up the issue title** before deriving the branch name:

```bash
issue_title=$(gh issue view 1087 --json title --jq .title)
```

Combine the issue number and title as your working description. For example, issue `1087` with title `Redesign dashboard onboarding flow` becomes `1087 redesign dashboard onboarding flow`.

**Never use a bare issue number as the branch name.** The branch must always include a descriptive slug derived from the issue title or the user's description. A branch named `1087` alone is invalid.

### 2. Derive branch name

Parse the resolved description into a valid branch name:

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
| `1087` (issue looked up → "Redesign dashboard onboarding flow") | `1087-redesign-dashboard-onboarding-flow` |

### 3. Extract repo name

```bash
repo_name=$(basename "$(git remote get-url origin)" .git)
```

### 4. Create worktree and branch

**Critical rule:** The worktree must be on branch `<slug>`, never on `main`. The branch must not track any remote branch.

```bash
git fetch origin
```

**Case A — Worktree path already exists (`~/.worktrees/<repo-name>/<slug>`):**

Verify the worktree is on the correct branch:
```bash
actual_branch=$(git -C ~/.worktrees/<repo-name>/<slug> rev-parse --abbrev-ref HEAD)
```
- If `actual_branch` equals `<slug>` → reuse it, skip to Step 4b.
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

### 4b. Verify branch and remove tracking

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

### 5. Copy environment files and spec folder

Copy the environment file:

```bash
cp .env ~/.worktrees/<repo-name>/<slug>/.env 2>/dev/null || true
```

**Copy the spec folder (if this worktree implements a spec).** The spec-driven skills (`architect-initial`, `architect-critics`, `spec`, `review-spec`, `architect-inspect`) read and write artifacts under `.specs/<feature-slug>/` at the repo root. Because the worktree branches from `origin/main`, any uncommitted spec work in the current checkout will be missing in the new worktree. Copy the relevant folder so the implementer can continue:

```bash
src_root="$(git rev-parse --show-toplevel)"
dest="$HOME/.worktrees/<repo-name>/<slug>"

if [ -d "$src_root/.specs" ]; then
  # The branch slug may carry an issue-number prefix (e.g. 1087-redesign-dashboard);
  # the feature-slug usually does not. Try the slug, then the slug with the leading
  # NNNN- stripped, before falling back to copying every spec folder.
  feature_slug="$(printf '%s' "<slug>" | sed -E 's/^[0-9]+-//')"
  if [ -d "$src_root/.specs/<slug>" ]; then
    mkdir -p "$dest/.specs"
    cp -R "$src_root/.specs/<slug>" "$dest/.specs/"
  elif [ -d "$src_root/.specs/$feature_slug" ]; then
    mkdir -p "$dest/.specs"
    cp -R "$src_root/.specs/$feature_slug" "$dest/.specs/"
  else
    # No confident match — copy the whole .specs tree so nothing is lost.
    cp -R "$src_root/.specs" "$dest/.specs"
  fi
fi
```

If no `.specs` folder exists, this worktree isn't spec-driven — skip silently. Note in the final report which spec folder (if any) was copied.

### 6. Color-code the VSCode window

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

### 7. Install dependencies

Get the worktree ready to work in. Resolve the install command in this order; stop at the first that applies:

1. **Bun project (default).** If `bun.lock`, `bun.lockb` is present, or AGENTS.md documents Bun:
   ```bash
   cd ~/.worktrees/<repo-name>/<slug> && bun install --frozen-lockfile
   ```
   If `bun` is not on PATH, prepend it and retry:
   ```bash
   export PATH="$HOME/.bun/bin:$PATH"
   bun install --frozen-lockfile
   ```

2. **AGENTS.md documents the install step.** If it's not a Bun project, read `AGENTS.md` (root, then nearest parent) for a documented setup/install command and run exactly that.

3. **Educated guess from the manifest/lockfile.** With no documented command, infer from what's present:
   | Signal | Command |
   |---|---|
   | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
   | `yarn.lock` | `yarn install --frozen-lockfile` |
   | `package-lock.json` | `npm ci` |
   | `package.json` only | `npm install` |
   | `poetry.lock` | `poetry install` |
   | `uv.lock` | `uv sync` |
   | `requirements.txt` | `pip install -r requirements.txt` |
   | `Gemfile` | `bundle install` |
   | `go.mod` | `go mod download` |
   | `Cargo.toml` | `cargo fetch` |

4. **Skip on failure or no match.** If the resolved command fails, or none of the above apply, skip dependency installation and note it in the final report. Do not block opening the worktree on a failed install — the user can install manually.

### 8. Open in VSCode

```bash
code --new-window ~/.worktrees/<repo-name>/<slug>
```

### 9. Report

Print a summary to the user:

```
Worktree ready:
  Branch:   <slug>
  Tracks:   nothing (independent — push with `git push -u origin <slug>`)
  Path:     ~/.worktrees/<repo-name>/<slug>
  Color:    <color-name> (<hex>)
  Spec:     <copied folder under .specs/, or "none">
  Deps:     <command run, or "skipped — install manually">
```

**STOP.** Do not proceed with any implementation work. The user will continue in the new VSCode window.

## Conventions

- Branch names follow the repo pattern: `NNNN-kebab-description` when an issue number is present, `kebab-description` otherwise.
- **Always include a descriptive slug.** If the user provides only an issue number, look up the issue title via `gh issue view` and derive the description from it. A bare number (e.g. `1087`) is never a valid branch name.
- Worktrees live under `~/.worktrees/<repo-name>/` to keep them out of the source repo.
- The spec-driven skills key off `.specs/<feature-slug>/` at the repo root. Copy that folder into spec-implementation worktrees so the spec travels with the branch; uncommitted spec work is otherwise lost when branching from `origin/main`.
- Dependency installation defaults to Bun, then defers to AGENTS.md, then guesses from the lockfile, then skips. A failed install never blocks opening the worktree.
- `.vscode/settings.json` is gitignored in the repo, so color settings won't leak into commits.
- Always fetch origin before branching to ensure the worktree starts from the latest main.
- **Never leave a worktree on `main`.** Every worktree must be on its own named branch.
- **Branches must not track a remote.** Use `--no-track` on creation and `--unset-upstream` as a safety net. This ensures `git push -u origin <slug>` sets tracking correctly when the user is ready to open a PR.
