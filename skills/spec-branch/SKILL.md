---
name: spec-branch
description: This skill should be used when the user asks to "create a spec branch", "make a spec branch", "start a branch", or "branch from spec". Creates a local branch from a spec, description, or issue/ticket reference without requiring GitHub.
mode: coding
scope: document
capability: git-mutating
disable-model-invocation: true
argument-hint: "[description, feature-slug, or issue/ticket reference]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Spec Branch

Create a new local branch related to a spec-driven task.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When the branch topic is unclear or underspecified, infer it from the available context — the spec folder under discussion, the most recently modified `.specs/*/` folder, or the work described in the conversation — then proceed. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when no branch topic can be inferred from any source. In that case, report that there is nothing to branch from and halt — do not ask for a description interactively.

## Inputs

Use `$ARGUMENTS` as the branch topic. It may be:

- A `.specs/<feature-slug>/` folder name.
- A free-text work description.
- A ticket reference plus description, such as `PROJ-123 add invoice retry`.
- A GitHub issue number, only when the current repo is hosted on GitHub.

If `$ARGUMENTS` is empty, infer the topic from context — the spec folder under discussion, the most recently modified `.specs/*/` folder, or the work described in the conversation. Only if no topic can be inferred from any source, report that there is nothing to branch from and stop. Do not create a branch from an empty or bare identifier.

## Resolve the Topic

1. Confirm the current directory is a git repository: `git rev-parse --git-dir`.
2. If `$ARGUMENTS` names `.specs/<feature-slug>/`, read `spec.md` or `proposal.md` and derive the branch topic from the feature slug and title.
3. If `$ARGUMENTS` is only a number and the current repo has a GitHub remote, try `gh issue view <number> --json title --jq .title`.
4. If the GitHub lookup fails, or the repo is not GitHub-hosted, derive a descriptive title from the conversation or the referenced spec/ticket. A bare number is not a valid branch name; if no descriptive context exists, report that and stop.

## Derive the Branch Name

Parse the resolved topic into a valid branch name:

1. Lowercase the entire string.
2. Preserve a leading issue or ticket prefix when present (`123`, `PROJ-123`, etc.).
3. Replace `/`, spaces, underscores, and consecutive special characters with a single `-`.
4. Strip leading/trailing hyphens.
5. Truncate to 60 characters max, trimming at the last full word boundary when possible.

Examples:

| Input | Branch |
|---|---|
| `1087 redesign dashboard onboarding` | `1087-redesign-dashboard-onboarding` |
| `PROJ-123 add invoice retry` | `proj-123-add-invoice-retry` |
| `fix candidate stage seed data` | `fix-candidate-stage-seed-data` |
| `.specs/new-billing-export/` | `new-billing-export` |

## Create the Branch

1. Check whether the branch already exists: `git rev-parse --verify <branch-name>`.
2. If it exists, switch to it with `git switch <branch-name>`.
3. If it does not exist, create it from the current HEAD with `git switch -c <branch-name>`.
4. Remove upstream tracking if present: `git branch --unset-upstream <branch-name> 2>/dev/null || true`.

## Report

Report:

- Branch name.
- Source topic: spec folder, GitHub issue, ticket reference, or free-text description.
- Tracking status: none.

Do not implement the spec after creating the branch.
