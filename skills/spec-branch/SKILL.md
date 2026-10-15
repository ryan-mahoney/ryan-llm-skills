---
name: spec-branch
description: Create or switch to a local branch from a spec package, work description, or ticket reference without requiring GitHub. Use for "create a spec branch", "make a spec branch", "start a branch", or "branch from spec". Reads standalone spec artifacts for naming context but never moves or writes them.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[description, spec package ref or folder, or issue/ticket reference]"
license: MIT
metadata:
  version: "8"
---

# Spec Branch

Create or switch to one local branch for standalone spec work. A spec package may supply naming context but this branch-only skill does not create a worktree or move artifacts.

## Resolve The Topic

Resolve in this order:

1. Explicit `$ARGUMENTS`.
2. An explicit spec package ref (`ws/slug`), package folder, or `spec.md`/`proposal.md` path.
3. The feature/work named in the conversation.

When a package is named, run the shared [spec-location step](../spec-end-to-end/references/spec-location.md) first: `node ~/.agents/scripts/spec-location/cli.mjs check <ref or folder>`. On refusal, print the `message` and `remedy` and stop. On success, read the package title context from `<package_dir>/spec.md` (or `proposal.md`) using the `package_dir` field in `locations.json`. If no explicit package is supplied, use a matching package named in the conversation; stop on ambiguous matches.

A number is a GitHub issue only when the current repository has a GitHub remote and `gh issue view <number> --json title --jq .title` succeeds. A non-GitHub ticket needs accompanying descriptive text.

If no descriptive topic resolves, make no changes and report:

```txt
outcome: blocked
reason: missing-branch-topic
```

## Derive The Branch

Normalize the topic:

1. Lowercase it.
2. Preserve a leading issue/ticket identifier.
3. Replace separators and repeated punctuation with one hyphen.
4. Trim hyphens.
5. Limit to 60 characters at a word boundary.

Require `git rev-parse --git-dir` to succeed. Then:

- Existing local branch: `git switch <branch>`.
- New branch: `git switch -c <branch>`.
- Remove upstream tracking: `git branch --unset-upstream <branch> 2>/dev/null || true`.

Never move, rename, copy, stage, or commit spec package artifacts in this branch-only skill. Use `spec-branch-worktree` when the user wants a new worktree and spec-folder handoff.

## Report

```txt
outcome: ready
branch: <branch>
source: spec-folder | description | ticket | github-issue
tracking: none
```

On failure, use `outcome: blocked` with a stable reason and the relevant git error. Do not implement the spec.
