---
name: repo-status
description: "Collect live Git facts for repository status updates: branches, tracking, divergence, dirty files and registered worktrees, with optional open pull requests. Use for 'repo status', 'status across repositories', 'which worktrees are dirty', or a branch/PR progress update that needs current facts."
argument-hint: "[root path] [--depth N] [--prs]"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Repository Status

Run the collector before answering a repository, branch or worktree status question.
Use its Markdown report as the source of observed Git and optional GitHub facts.
Node and Git are required; GitHub CLI is optional.

## Invoke the installed collector

Resolve `repo_status_skill_dir` to the absolute directory containing the loaded
`SKILL.md`. Use that loaded location for copied or symlinked installations. Set
`repo_status_root` to the requested repository or parent directory. Quote both
paths; do not assume the current working directory contains the skill.

```bash
node "$repo_status_skill_dir/scripts/repo-status.mjs" "$repo_status_root" --depth 2 --prs
```

Choose the options for the requested scope:

- Omit the root to use the current working directory and its enclosing checkout.
- Use `--depth N` to discover additional repositories through N directory levels
  below the supplied root. The default is 0. Descent continues inside repositories.
- Every discovered repository includes all its registered worktrees, including
  paths outside the scan root or depth. Linked worktrees form one repository group;
  independent clones and submodules remain separate.
- Child `.git`, `node_modules`, `dist`, `build`, `target`, `out`, `coverage` and
  `tmp` directories, and child symlinks, are skipped. An explicit symlink or `tmp`
  root is still inspected.
- Add `--prs` for PR questions. This opts into GitHub reads through gh's
  configured/default checkout selection; the report labels the selected
  HOST/OWNER/REPO. The local-only default needs no gh installation or network.
- Use `--help` for scope, freshness and cap details without collecting facts.

For the local status of the current checkout, run:

```bash
node "$repo_status_skill_dir/scripts/repo-status.mjs"
```

Collection allows 30 seconds for local reads and up to 30 more for optional PR
reads, with a 60-second total ceiling and at most 10 seconds per child. Stalled
synchronous filesystem calls are outside that deadline guarantee. PR output shows
at most 100 open PRs; additional records make the PR collection incomplete.

## Consume facts and preserve uncertainty

Report the scan root, depth and collection scope alongside the relevant facts.
State incomplete coverage and affected paths. A failed local read returns partial
facts and a nonzero exit; retain useful rows rather than discarding the report.
No-upstream, detached, unborn and missing local upstream states can still have
known dirty counts. Unknown or absent fields must remain unknown or absent.

Ahead/behind compares local refs; remote freshness is unknown because the collector
does not fetch. Git and GitHub observations are sequential, not an atomic snapshot.
Optional PR failures remain unavailable and do not change a successful local exit.
Only a successful empty PR query establishes no open PRs. UNKNOWN/null
mergeability, draft and merge-state fields do not establish readiness. Do not
infer PR ownership from a branch name or an unverified repository URL.

Prefer successful current observations over historical artifacts for the same
repository or PR, including `.specs/` records such as `pr-url.json`. Failed remote
reads validate nothing historical; label any retained historical value as stale
and unverified. Read spec ledgers separately when the answer needs step counts,
stages or next actions; the collector does not parse them.

## Authority

Collection is read-only: do not fetch, commit, push, merge, prune worktrees, change
Git/gh defaults, or write target plans or status files. Editing a target plan or
status file requires a separate user request. Use the report to answer the status
question within that boundary. This is trusted local tooling, not a sandbox for
arbitrary repository filters.
