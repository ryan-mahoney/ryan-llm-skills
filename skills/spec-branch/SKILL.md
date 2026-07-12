---
name: spec-branch
description: Create or switch to a local branch from a feature-document spec, work description, or ticket reference without requiring GitHub. Use for "create a spec branch", "make a spec branch", "start a branch", or "branch from spec". Reads external feature-document artifacts for context but never moves or writes them.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[description, feature-document path, or issue/ticket reference]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "6"
---

# Spec Branch

Create or switch to one local branch. Feature-document artifacts remain outside the checkout and are read only for naming context.

## Resolve The Topic

Resolve in this order:

1. Explicit `$ARGUMENTS`.
2. An explicit feature-document, `spec.md`, or `proposal.md` path.
3. The feature/work named in the conversation.

When a **# Canonical spec artifact paths** stanza exists, use its `spec` or `proposal` title as context. Do not search for a most-recent spec.

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

Never move, rename, copy, stage, or commit feature-document artifacts.

## Report

```txt
outcome: ready
branch: <branch>
source: feature-document | description | ticket | github-issue
tracking: none
```

On failure, use `outcome: blocked` with a stable reason and the relevant git error. Do not implement the spec.
