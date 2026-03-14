---
name: branch
description: This skill should be used when the user asks to "create a branch", "make a branch", "start a branch", or "branch from issue". Creates a new local branch based on a GitHub issue topic.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Branch

Create a new local branch related to GitHub issue $ARGUMENTS.

1. Read the GitHub issue to understand the topic
2. Create a descriptive branch name that includes the GitHub issue number
3. Check out the new branch
