---
name: pr
description: This skill should be used when the user asks to "open a PR", "create a PR", "submit a PR", "push and open PR", or "send a pull request". Commits staged files, pushes the branch, and opens a PR referencing a GitHub issue.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# PR

Determine the GitHub issue number: use $ARGUMENTS if provided, otherwise extract the issue number from the current branch name (the trailing number after the last hyphen, or a standalone numeric path segment).

1. If an issue number was identified, read the GitHub issue with `gh issue view` to understand the context
2. Git conventional commit the staged files
3. Push the branch to origin
4. Open a pull request:
   - Title: short, imperative, under 70 characters
   - Body: summary of what changed and why, link to the issue
   - If an issue number was identified, ensure the PR references and closes that GitHub issue

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
