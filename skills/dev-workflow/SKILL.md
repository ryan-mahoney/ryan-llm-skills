---
name: dev-workflow
description: This skill should be used when the user asks to "run the full workflow", "spec and implement", "dev workflow", "build this end to end", or "spec, branch, implement, and PR". Chains spec → branch → run-agents → PR into a single orchestrated flow.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# Dev Workflow

Based on the current analysis, execute the full development workflow: write a spec to a GitHub issue, review it via Codex CLI, create a branch, implement all steps, and open a PR.

If any phase fails, stop and report which phase failed and why. Do not proceed to subsequent phases.

## Phase 1: Spec

If an issue number is provided ($ARGUMENTS):
1. Follow `~/.agents/skills/spec/SKILL.md` to write a spec.
2. Write the spec to the existing issue: `gh issue edit <issue-number> --body '<spec body>'`.
3. Capture the issue number for all subsequent phases.

If no issue number is provided:
1. Follow `~/.agents/skills/spec/SKILL.md` to write a spec and create a new GitHub issue.
2. Capture the new issue number for all subsequent phases.

## Phase 2: Review

Run Codex CLI to review the spec with high reasoning effort. Codex will edit the issue body directly if changes are needed.

Preflight requirement:
- `gh auth status` must be valid before running this phase.
- The review must be based on GitHub issue content only (never repository-local files).

```bash
REVIEW_FILE=/tmp/review-<issue-number>.txt

codex exec --dangerously-bypass-approvals-and-sandbox \
  -c model_reasoning_effort="high" \
  -o "$REVIEW_FILE" \
  "You are reviewing GitHub issue #<issue-number> as an implementation spec.

First, fetch the issue body directly from GitHub by running:
gh issue view <issue-number> --json body --jq '.body'

If that command fails for any reason (auth, permissions, network, gh CLI), stop immediately and output ONLY this compact JSON:
{\"review_status\":\"failed\",\"spec_modified\":false,\"viable\":false,\"failure_reason\":\"<exact failure cause>\",\"summary\":\"Unable to fetch issue body from GitHub.\"}

Do not read or review repository-local files as a substitute for issue content.

If fetch succeeds, review the fetched issue body using this checklist:

### Required Sections
All 7 sections must be present and substantive:
1. Qualifications — lists only skills actually needed.
2. Problem Statement — 2-4 sentences: what is missing/broken, current behavior, what the spec addresses.
3. Goal — one concrete sentence describing the outcome.
4. Architecture — files with responsibilities, types/interfaces, design decisions with rationale, dependency map.
5. Acceptance Criteria — numbered, observable, automatable assertions. Includes non-happy-path behaviors.
6. Notes — trade-offs with rationale, risks and ambiguities.
7. Implementation Steps — see below.

### Architecture Review
Flag: over-engineering, single-use abstractions, missing failure modes, unclear data flow, unjustified trade-offs.

### Implementation Steps Review
Each step needs: what (exact files/changes), why (tied to architecture/criteria), signatures/contracts, tests.
Verify: deterministic, minimal, self-contained, forward-only.
Order: types first, pure logic next, I/O after, integration last.
Remove: manual QA, docs-only, full test suite runs, formatting, git workflow steps.

If the spec needs changes, run: gh issue edit <issue-number> --body '<updated body>'.

At the end, output ONLY compact JSON with these exact keys:
- review_status: \"success\" or \"failed\"
- spec_modified: boolean
- viable: boolean
- failure_reason: empty string on success, otherwise a concise reason
- summary: concise review outcome"
```

After codex returns:
1. Validate `/tmp/review-<issue-number>.txt` exists and is valid JSON.
2. Parse fields from JSON: `review_status`, `spec_modified`, `viable`, `failure_reason`.
3. If `review_status` is `failed`, stop and report remediation:
   - Authenticate GitHub CLI (`gh auth login` or refresh credentials).
   - Re-run the workflow from Phase 2.
4. If `review_status` is `success` but `viable` is `false`, stop and report the spec as unviable.
5. If `spec_modified` is `true`, proceed (the issue body is already updated).
6. Continue to Phase 3 only when `review_status=success` and `viable=true`.

## Phase 3: Branch + Worktree

Create an isolated worktree so multiple dev-workflows can run concurrently against the same repository, each in its own VSCode window.

1. Read the GitHub issue to understand the topic.
2. Derive a descriptive slug from the issue title (e.g., `42-add-auth-middleware`).
   The slug must include the issue number and be a valid branch name.
3. Extract the repository name from `git remote get-url origin` (last path segment, strip `.git` suffix).
4. Check for existing worktree/branch (enables re-entry after a crashed run):
   - If `~/.worktrees/<repo-name>/<slug>` already exists, reuse it and skip to step 6.
   - If branch `<slug>` exists but no worktree, run:
     `git worktree add ~/.worktrees/<repo-name>/<slug> <slug>`
   - If neither exists, create both from the latest remote main:
     ```bash
     git fetch origin
     mkdir -p ~/.worktrees/<repo-name>
     git worktree add ~/.worktrees/<repo-name>/<slug> -b <slug> origin/main
     ```
5. Record the absolute worktree path. All subsequent phases operate from this path.
6. Copy environment files from the original repository root into the worktree:
   ```bash
   cp .env ~/.worktrees/<repo-name>/<slug>/.env
   ```
   If `.env` does not exist in the source repo, skip this step without failing.
7. Color-code the VSCode window. Compute the color index as `<issue-number> % 8` and select the hex value from this palette:

   | Index | Color  | Hex       |
   |-------|--------|-----------|
   | 0     | Teal   | `#0d7377` |
   | 1     | Purple | `#6a1b9a` |
   | 2     | Orange | `#e65100` |
   | 3     | Blue   | `#1565c0` |
   | 4     | Green  | `#2e7d32` |
   | 5     | Red    | `#b71c1c` |
   | 6     | Indigo | `#283593` |
   | 7     | Brown  | `#4e342e` |

   Write `.vscode/settings.json` in the worktree with the color settings:
   - If no `.vscode/settings.json` exists, write:
     ```json
     {
       "workbench.colorCustomizations": {
         "titleBar.activeBackground": "<hex>",
         "titleBar.activeForeground": "#ffffff",
         "statusBar.background": "<hex>",
         "statusBar.foreground": "#ffffff"
       }
     }
     ```
   - If `.vscode/settings.json` already exists, merge via `jq`:
     ```bash
     jq --arg bg "<hex>" \
       '.["workbench.colorCustomizations"] = {"titleBar.activeBackground": $bg, "titleBar.activeForeground": "#ffffff", "statusBar.background": $bg, "statusBar.foreground": "#ffffff"}' \
       .vscode/settings.json > /tmp/vscode-settings-tmp.json && mv /tmp/vscode-settings-tmp.json .vscode/settings.json
     ```
   - If `jq` is not available, write the file from scratch (color settings only).
8. Write a continuation hook so the new VSCode window's Claude Code session automatically receives the next-phase instructions on startup.

   Create `<worktree-path>/.claude/hooks/continue.sh`:

   ```bash
   #!/bin/bash
   cat <<'PROMPT'
   # Continue Dev Workflow — Issue #<issue-number>

   This worktree was created by the dev-workflow skill. Pick up from Phase 4.

   ## Phase 4: Implement

   Follow `~/.agents/skills/run-agents/SKILL.md` to implement all steps from GitHub issue #<issue-number>.
   Read the issue spec via `gh issue view <issue-number> --json body --jq '.body'`.
   Implement each step with a dedicated subagent. Commit after each verified step.

   ## Phase 5: PR

   Follow `~/.agents/skills/pr/SKILL.md` with issue number <issue-number>.

   1. Read the GitHub issue to understand the context.
   2. Commit any remaining staged files with a conventional commit.
   3. Push the branch to origin: `git push -u origin <slug>`.
   4. Open a pull request:
      - Title: short, imperative, under 70 characters.
      - Body: summary of what changed and why, link to the issue.
      - Reference and close the issue.
   Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
   PROMPT
   ```

   Make it executable: `chmod +x <worktree-path>/.claude/hooks/continue.sh`

   Write `<worktree-path>/.claude/settings.json` (merge with existing if present):

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "startup",
           "hooks": [
             {
               "type": "command",
               "command": ".claude/hooks/continue.sh",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

9. Open the worktree in a new VSCode window: `code --new-window ~/.worktrees/<repo-name>/<slug>`

10. **STOP.** Do not proceed to implementation. Report the worktree path, issue number, and branch name to the user. The new VSCode window's Claude Code session will receive the continuation prompt via the SessionStart hook — the user just needs to type "go".
