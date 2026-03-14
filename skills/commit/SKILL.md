---
name: commit
description: This skill should be used when the user asks to "commit", "commit changes", "commit staged files", "conventional commit", or "commit this". Creates a conventional commit of staged files, using the GitHub issue for context.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# Commit

Determine the GitHub issue number: use $ARGUMENTS if provided, otherwise extract the issue number from the current branch name (the trailing number after the last hyphen, or a standalone numeric path segment).

1. If an issue number was identified, read the GitHub issue with `gh issue view` to understand the context of the changes
2. Review the staged changes with `git diff --cached`
3. Write a conventional commit message that reflects the nature of the changes (e.g., feat, fix, refactor, chore) and references the issue number if available (e.g., `feat(scope): description (#259)`)
4. Commit the staged files with that message

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
