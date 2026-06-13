---
name: spec-branch-worktree
description: "Create a named branch and git worktree for spec-driven work, then open it in a color-coded VSCode window. Use when: 'spec branch worktree', 'new spec worktree', 'worktree for', 'start a worktree', 'create worktree'."
argument-hint: "[description, feature-slug, or issue/ticket reference]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "4"
---

# Spec Branch Worktree

Create a git worktree with a structured branch name derived from a spec folder, ticket reference, or loose description. Configure the environment, color-code the VSCode window, copy the relevant `.specs/<feature-slug>/` folder, and open it.

## Arguments

`$ARGUMENTS` is a free-text description of the work. It may start with a ticket or issue prefix.

Examples:

| Input | Branch |
|---|---|
| `1087 redesign dashboard onboarding` | `1087-redesign-dashboard-onboarding` |
| `PROJ-123 add invoice retry` | `proj-123-add-invoice-retry` |
| `fix candidate stage seed data` | `fix-candidate-stage-seed-data` |
| `.specs/new-billing-export/` | `new-billing-export` |

## Before Starting

1. Confirm `$ARGUMENTS` is not empty. If empty, ask the user to describe the work.
2. Confirm the current directory is a git repository: `git rev-parse --git-dir`.
3. Confirm `code` CLI is available: `which code`.

## Steps

### 1. Resolve the Work Description

If `$ARGUMENTS` names an existing `.specs/<feature-slug>/` folder, use `<feature-slug>` as the initial description and record `<feature-slug>` as the source spec slug for Step 5. If `spec.md` or `proposal.md` contains a clear title, include it when deriving the final slug, but keep the source spec slug anchored to the folder named by `$ARGUMENTS`.

If `$ARGUMENTS` is only a number, treat it as a GitHub issue number only when the current repo has a GitHub remote and `gh issue view <number> --json title --jq .title` succeeds. Combine the number and title as the working description.

If the current repo is not hosted on GitHub, or the GitHub lookup fails, ask for a descriptive title. A bare number is not a valid worktree branch name.

For non-GitHub tickets, use the ticket reference when the user provided enough description, such as `PROJ-123 add invoice retry`.

### 2. Derive Branch Name

Parse the resolved description into a valid branch name:

1. Lowercase the entire string.
2. Preserve a leading issue or ticket prefix when present (`123`, `PROJ-123`, etc.).
3. Replace `/`, spaces, underscores, and consecutive special characters with a single `-`.
4. Strip leading/trailing hyphens.
5. Truncate to 60 characters max, trimming at the last full word boundary when possible.

The result is `<slug>`.

### 3. Extract Repo Name and Base Ref

```bash
repo_name=$(basename "$(git remote get-url origin 2>/dev/null || basename "$(git rev-parse --show-toplevel)")" .git)
git fetch origin 2>/dev/null || true
default_branch=$(git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')
base_ref="origin/${default_branch:-main}"
git rev-parse --verify "$base_ref" >/dev/null 2>&1 || base_ref="HEAD"
```

### 4. Create Worktree and Branch

Critical rules:

- The worktree must be on branch `<slug>`, never on `main`.
- The branch must not track a remote branch.
- Worktrees live under `~/.worktrees/<repo-name>/`.

**Case A - Worktree path already exists (`~/.worktrees/<repo-name>/<slug>`):**

Verify the worktree is on the correct branch:

```bash
actual_branch=$(git -C ~/.worktrees/<repo-name>/<slug> rev-parse --abbrev-ref HEAD)
```

- If `actual_branch` equals `<slug>`, reuse it and skip to Step 4b.
- If `actual_branch` is anything else, remove and recreate it:
  ```bash
  git worktree remove --force ~/.worktrees/<repo-name>/<slug>
  ```
  Then fall through to Case C.

**Case B - Branch `<slug>` exists locally but no worktree:**

```bash
mkdir -p ~/.worktrees/<repo-name>
git worktree add ~/.worktrees/<repo-name>/<slug> <slug>
```

**Case C - Neither exists:**

```bash
mkdir -p ~/.worktrees/<repo-name>
git worktree add --no-track -b <slug> ~/.worktrees/<repo-name>/<slug> "$base_ref"
```

### 4b. Verify Branch and Remove Tracking

Run these checks inside the worktree:

```bash
cd ~/.worktrees/<repo-name>/<slug>

actual_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$actual_branch" != "<slug>" ]; then
  echo "ERROR: Worktree is on branch '$actual_branch', expected '<slug>'. Aborting."
  exit 1
fi

git branch --unset-upstream <slug> 2>/dev/null || true
```

Record the absolute worktree path for all subsequent steps.

### 5. Copy Environment Files and Spec Folder

Copy the environment file:

```bash
cp .env ~/.worktrees/<repo-name>/<slug>/.env 2>/dev/null || true
```

Copy the entire spec slug folder if this worktree implements a spec. The spec-driven skills (`spec-architect-initial`, `spec-architect-critics`, `spec-write`, `spec-review`, `spec-criteria`, `spec-run`, `spec-audit`, `spec-remediate`, `architect-inspect`) read and write artifacts under `.specs/<feature-slug>/` at the repo root, including sidecar analysis/proposal files, the `criteria.md` and `audit.md` checklists, and the cross-phase `invariants.md` ledger that `spec-audit` and `spec-remediate` need in the worktree.

Because the worktree may branch from a clean remote ref, uncommitted spec work in the current checkout can be missing. Create `.specs/` in the worktree and copy only the relevant slug folder as a directory, preserving every file and subdirectory in it. Do not copy only `spec.md` or `proposal.md`, and do not copy unrelated `.specs/*` folders.

```bash
src_root="$(git rev-parse --show-toplevel)"
dest="$HOME/.worktrees/<repo-name>/<slug>"
source_spec_slug="<source-spec-slug-if-known>"
copied_spec="none"

if [ -d "$src_root/.specs" ]; then
  feature_slug="$(printf '%s' "<slug>" | sed -E 's/^[0-9]+-//; s/^[a-z]+-[0-9]+-//')"
  if [ -n "$source_spec_slug" ] && [ "$source_spec_slug" != "<source-spec-slug-if-known>" ] && [ -d "$src_root/.specs/$source_spec_slug" ]; then
    src_spec_dir="$src_root/.specs/$source_spec_slug"
    copied_spec="$source_spec_slug"
  elif [ -d "$src_root/.specs/<slug>" ]; then
    src_spec_dir="$src_root/.specs/<slug>"
    copied_spec="<slug>"
  elif [ -d "$src_root/.specs/$feature_slug" ]; then
    src_spec_dir="$src_root/.specs/$feature_slug"
    copied_spec="$feature_slug"
  fi

  if [ "$copied_spec" != "none" ]; then
    mkdir -p "$dest/.specs/$copied_spec"
    cp -R "$src_spec_dir/." "$dest/.specs/$copied_spec/"
  fi
fi
```

If no `.specs` folder exists, or no matching spec folder exists for the source spec slug, `<slug>`, or the derived `feature_slug`, skip silently. Note in the final report which spec folder, if any, was copied, using the `copied_spec` value.

### 6. Color-Code the VSCode Window

Compute a deterministic color index from the slug:

```bash
hash_val=$(printf '%s' "<slug>" | cksum | awk '{print $1}')
color_index=$((hash_val % 8))
```

Select the hex value from this palette:

| Index | Color | Hex |
|---|---|---|
| 0 | Teal | `#0d7377` |
| 1 | Purple | `#6a1b9a` |
| 2 | Orange | `#e65100` |
| 3 | Blue | `#1565c0` |
| 4 | Green | `#2e7d32` |
| 5 | Red | `#b71c1c` |
| 6 | Indigo | `#283593` |
| 7 | Brown | `#4e342e` |

Write `.vscode/settings.json` in the worktree:

- If the file does not exist, write the color settings.
- If the file exists and `jq` is available, merge the color settings.
- If `jq` is not available, overwrite with color settings only.

Use this JSON shape:

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

### 7. Install Dependencies

Get the worktree ready to work in. Resolve the install command in this order and stop at the first that applies:

| Signal | Command |
|---|---|
| `bun.lock`, `bun.lockb`, or AGENTS.md documents Bun | `bun install --frozen-lockfile` |
| AGENTS.md documents a non-Bun setup command | Run exactly that command |
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

If the resolved command fails, or none applies, skip dependency installation and note it in the final report. Do not block opening the worktree on a failed install.

### 8. Open in VSCode

```bash
code --new-window ~/.worktrees/<repo-name>/<slug>
```

### 9. Report

Print a summary:

```txt
Worktree ready:
  Branch:   <slug>
  Tracks:   nothing (push with `git push -u origin <slug>`)
  Path:     ~/.worktrees/<repo-name>/<slug>
  Color:    <color-name> (<hex>)
  Spec:     <copied folder under .specs/, or "none">
  Deps:     <command run, or "skipped - install manually">
```

Stop after reporting. Do not proceed with implementation work in the original window.
