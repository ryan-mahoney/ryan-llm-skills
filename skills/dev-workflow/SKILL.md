---
name: dev-workflow
description: This skill should be used when the user asks to "run the full workflow", "spec and implement", "dev workflow", "build this end to end", or "spec, branch, implement, and PR". Chains spec → branch → run-agents → PR into a single orchestrated flow.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# Dev Workflow

Based on the current analysis, execute the full development workflow: write a spec to a GitHub issue, create a branch, implement all steps, and open a PR.

If any phase fails, stop and report which phase failed and why. Do not proceed to subsequent phases.

## Phase 1: Spec

If an issue number is provided ($ARGUMENTS):
1. Read the existing issue via `gh issue view <issue-number>`.
2. Use its spec as-is. Do not overwrite or regenerate the spec.
3. Capture the issue number for all subsequent phases.

If no issue number is provided:
1. Follow `skills/spec/SKILL.md` to write a spec and create a new GitHub issue.
2. Capture the new issue number for all subsequent phases.

## Phase 2: Branch

Follow `skills/branch/SKILL.md` with the issue number.

1. Read the GitHub issue to understand the topic.
2. Create a descriptive branch name that includes the issue number.
3. Check out the new branch.

## Phase 3: Implement

Delegate implementation to a subagent that follows `skills/run-agents/SKILL.md`:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Implement issue #<issue-number> all steps",
  prompt: "Follow skills/run-agents/SKILL.md to implement all steps from GitHub issue #<issue-number>.
Read the issue spec via gh issue view <issue-number>.
Implement each step with a dedicated subagent. Commit after each verified step.
Report per-step completion with commit hashes when done."
)
```

After the subagent returns, verify that all steps completed successfully. If the subagent reports blockers, stop and report them.

## Phase 4: PR

Follow `skills/pr/SKILL.md` with the issue number.

1. Read the GitHub issue to understand the context.
2. Commit any remaining staged files with a conventional commit.
3. Push the branch to origin.
4. Open a pull request:
   - Title: short, imperative, under 70 characters.
   - Body: summary of what changed and why, link to the issue.
   - Reference and close the issue.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
