---
name: pr-review
description: This skill should be used when the user asks to "review this PR", "review PR", "review the pull request", "code review PR", "give PR feedback", or "check this PR". Reviews a PR's code changes, submits review comments, and commits any fixes.
disable-model-invocation: true
argument-hint: "[pr-number (optional)]"
---

# PR Review

If a PR number is provided ($ARGUMENTS), use that PR. Otherwise, use the PR associated with the current branch.

1. Use `gh pr view` and `gh pr diff` to read the pull request description and code changes
2. Review the changes for correctness, clarity, and adherence to `docs/engineering-standards.md`
3. Submit review comments using `gh api` or `gh pr review` for specific lines or general feedback
4. If any changes are needed and can be made directly, make the fixes, then conventional commit and push to the branch

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
