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

```bash
gh issue view <issue-number> --json body --jq '.body' | \
codex exec --full-auto \
  -m gpt-5.3-codex \
  -c model_reasoning_effort="high" \
  -o /tmp/review-<issue-number>.txt \
  "You are reviewing a GitHub issue spec (piped via stdin). Apply this checklist:

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

If the spec needs changes, run: gh issue edit <issue-number> --body '<updated body>'
Output whether the spec was modified and whether it is viable for implementation."
```

After codex returns:
1. Read `/tmp/review-<issue-number>.txt` for the review outcome.
2. If the spec was modified, proceed (the issue body is already updated).
3. If the review reports the spec is fundamentally unviable, stop and report.

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
