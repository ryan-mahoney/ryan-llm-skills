---
name: spec-dev-workflow
description: This skill should be used when the user asks to "run the full workflow", "spec and implement", "dev workflow", "build this end to end", or "spec, branch, implement, and PR". Chains spec-write -> spec-review -> spec-branch-worktree -> spec-run, with GitHub issue/PR mirroring only when available.
disable-model-invocation: true
argument-hint: "[feature-slug, description, or GitHub issue number (optional)]"
---

# Spec Dev Workflow

Execute the full spec-driven development workflow using repository-local spec artifacts as the source of truth. GitHub issues and PRs are optional mirrors when the current repo is hosted on GitHub and `gh` is authenticated.

If any phase fails, stop and report which phase failed and why. Do not proceed to later phases after a failed phase.

## Phase 1: Write Spec

Follow `~/.agents/skills/spec-write/SKILL.md`.

Expected output:

- `.specs/<feature-slug>/spec.md` exists and contains the implementation spec.
- If the repo is GitHub-hosted and `gh` is authenticated, the same body is mirrored to a GitHub issue.
- The spec ends with `Spec folder: .specs/<feature-slug>/`.

If no proposal or current analysis exists, stop and ask the user for the missing feature context.

## Phase 2: Review Spec

Follow `~/.agents/skills/spec-review/SKILL.md` against the local `.specs/<feature-slug>/spec.md`.

The review must be grounded in the codebase. It may update `spec.md`; if a GitHub mirror exists, it should mirror the final body back to the issue.

Continue only when the spec is viable and no blocking gaps remain.

## Phase 3: Branch + Worktree

Follow `~/.agents/skills/spec-branch-worktree/SKILL.md` using the feature slug or issue/ticket description from the reviewed spec.

The worktree skill is responsible for:

- Creating a branch with a descriptive slug.
- Creating or reusing `~/.worktrees/<repo-name>/<slug>`.
- Copying the relevant `.specs/<feature-slug>/` folder into the worktree.
- Installing dependencies when a safe install command is discoverable.
- Opening the worktree in a new VSCode window.

After the worktree is ready, stop in the original checkout and report the continuation instructions below. Implementation should happen in the worktree.

## Phase 4: Implement

In the new worktree, follow `~/.agents/skills/spec-run/SKILL.md` against the copied local spec:

```txt
Run spec from .specs/<feature-slug>/spec.md
```

`spec-run` should implement each step with a dedicated subagent when the harness supports subagents. If the harness does not support subagents, it may implement directly and must report that fallback.

Each verified spec step gets its own conventional commit. If a GitHub issue mirror exists, commit messages should append `(#<issue-number>)`; otherwise they should omit issue references.

## Phase 5: Publish

If the repo is GitHub-hosted and `gh` is authenticated, follow `~/.agents/skills/pr/SKILL.md` to push the branch and open a PR.

If the repo is not GitHub-hosted:

1. Push the branch with `git push -u origin <slug>`.
2. Report the local spec path and branch name.
3. Do not attempt to create a GitHub PR.

If the repo uses Bitbucket, GitLab, or another forge and a matching local/CLI integration is available in the harness, use that integration only when the user explicitly asks for it. Otherwise stop after pushing or report the push command.

## Completion Report

Report:

- Spec path.
- GitHub issue mirror, if any.
- Worktree path.
- Branch name.
- Step commits from `spec-run`.
- Acceptance criteria results.
- PR URL if one was opened, or publish status for non-GitHub repos.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
