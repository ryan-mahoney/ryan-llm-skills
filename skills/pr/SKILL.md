---
name: pr
description: This skill should be used when the user asks to "open a PR", "create a PR", "submit a PR", "push and open PR", or "send a pull request". Commits staged files, pushes the branch, and opens a PR referencing a GitHub issue.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# PR

Determine the GitHub issue number: use $ARGUMENTS if provided, otherwise extract the issue number from the current branch name (the trailing number after the last hyphen, or a standalone numeric path segment).

1. Git conventional commit the staged files
2. Push the branch to origin
3. Open a pull request according to best practices
4. If an issue number was identified, ensure the PR references and closes that GitHub issue

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
