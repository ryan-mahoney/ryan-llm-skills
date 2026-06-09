---
name: pr-feedback
description: This skill should be used when the user asks to "address PR feedback", "handle PR comments", "review PR feedback", "fix PR comments", or "respond to PR reviews". Retrieves PR review comments, addresses them one at a time, and leaves responses.
disable-model-invocation: true
argument-hint: "[pr-number (optional)]"
---

# PR Feedback

If a PR number is provided ($ARGUMENTS), use that PR. Otherwise, use the PR associated with the current branch.

## Retrieving Comments

Use GitHub's GraphQL API via `gh api graphql` to retrieve detailed PR review comments. The REST API (`gh pr view`) does not expose all comment metadata needed for proper handling.

Example GraphQL query to fetch review comments with full details:

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviews(first: 100) {
          nodes {
            author { login }
            body
            state
            comments(first: 100) {
              nodes {
                id
                body
                path
                line
                startLine
                diffHunk
                originalCommit { oid }
              }
            }
          }
        }
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { name }
            }
          }
        }
      }
    }
  }
' -f owner="$(gh repo view --json owner -q .owner.login)" \
   -f repo="$(gh repo view --json name -q .name)" \
   -f pr=$PR_NUMBER
```

Key fields to extract:
- `id` — needed for replying to specific review comments
- `body` — the comment text/feedback
- `path` — the file the comment is on
- `line` / `startLine` — line numbers for context
- `diffHunk` — the diff context
- `author.login` — who left the feedback
- `state` — review state (APPROVED, CHANGES_REQUESTED, COMMENTED)

## Workflow

1. Retrieve all PR review comments using the GraphQL API as shown above
2. Consider each comment one at a time
3. Make any necessary fixes for each comment
4. Stage, commit, and push the changes for each comment (always, even for small fixes)
5. Leave a reply comment on each addressed review comment using `gh api graphql` with the `addPullRequestReviewThread` mutation or `gh pr review --comment --body` for thread replies
