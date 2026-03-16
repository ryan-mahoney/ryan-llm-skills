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
1. Follow `skills/spec/SKILL.md` to write a spec.
2. Write the spec to the existing issue: `gh issue edit <issue-number> --body '<spec body>'`.
3. Capture the issue number for all subsequent phases.

If no issue number is provided:
1. Follow `skills/spec/SKILL.md` to write a spec and create a new GitHub issue.
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

## Phase 3: Branch

Follow `skills/branch/SKILL.md` with the issue number.

1. Read the GitHub issue to understand the topic.
2. Create a descriptive branch name that includes the issue number.
3. Check out the new branch.

## Phase 4: Implement

Delegate implementation to a subagent that follows `skills/run-agents/SKILL.md`:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Implement issue #<issue-number> all steps",
  prompt: "Follow skills/run-agents/SKILL.md to implement all steps from GitHub issue #<issue-number>.
Read the issue spec via gh issue view <issue-number> --json body --jq '.body'.
Implement each step with a dedicated subagent. Commit after each verified step.
Report per-step completion with commit hashes when done."
)
```

After the subagent returns, verify that all steps completed successfully. If the subagent reports blockers, stop and report them.

## Phase 5: PR

Follow `skills/pr/SKILL.md` with the issue number.

1. Read the GitHub issue to understand the context.
2. Commit any remaining staged files with a conventional commit.
3. Push the branch to origin.
4. Open a pull request:
   - Title: short, imperative, under 70 characters.
   - Body: summary of what changed and why, link to the issue.
   - Reference and close the issue.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
