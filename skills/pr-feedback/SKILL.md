---
name: pr-feedback
description: This skill should be used when the user asks to "address PR feedback", "handle PR comments", "review PR feedback", "fix PR comments", or "respond to PR reviews". Retrieves PR review comments, addresses them one at a time, and leaves responses.
disable-model-invocation: true
argument-hint: "[pr-number (optional)]"
---

# PR Feedback

If a PR number is provided ($ARGUMENTS), use that PR. Otherwise, use the PR associated with the current branch.

1. Use the `gh` CLI to retrieve all PR feedback/review comments on the pull request
2. Consider each comment one at a time
3. Make any necessary fixes for each comment
4. Leave a reply comment on each addressed review comment
