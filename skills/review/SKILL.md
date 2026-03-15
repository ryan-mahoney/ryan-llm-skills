---
name: review
description: This skill should be used when the user asks to "review a spec", "review an issue", "check the plan", "review the implementation plan", or "find gaps in the spec". Reviews a GitHub issue spec for gaps and viability, then directly edits the issue if improvements are needed.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Review

Review GitHub issue $ARGUMENTS.

Read the issue spec via `gh issue view $ARGUMENTS`. Assess whether the spec is viable for this project, whether there are gaps or errors, and whether there are important improvements.

If the spec should be changed, directly edit the content of issue $ARGUMENTS with an updated body that reflects an improved implementation spec.

## Review Checklist

### Required Sections
All 7 sections must be present and substantive (not just headings):
1. **Qualifications** — lists only skills actually needed, not a generic wish list.
2. **Problem Statement** — grounded in 2-4 sentences: what's missing/broken, current behavior, what the spec addresses.
3. **Goal** — one concrete sentence describing the outcome when complete.
4. **Architecture** — files with responsibilities, types/interfaces in concrete syntax, design decisions with rationale, dependency map. No vague descriptions.
5. **Acceptance Criteria** — numbered, observable, automatable assertions grouped by concern. Includes non-happy-path behaviors. No subjective criteria.
6. **Notes** — trade-offs with rationale (why this approach, what we give up, what we gain, alternatives considered). Risks and ambiguities called out.
7. **Implementation Steps** — see below.

### Architecture Review
Flag these problems:
- Designing for imagined future requirements instead of current needs.
- Abstractions with only one use or abstract layers "for future flexibility."
- Complex patterns without matching problem complexity.
- Optimizations without measured need.
- Missing failure modes or error propagation strategy.
- Data flow that can't be explained in under 5 minutes.
- Trade-offs stated without rationale.

### Implementation Steps Review
Each step must include:
1. What to do: exact files and changes required.
2. Why: tied to architecture or acceptance criteria.
3. Signatures/contracts: public API shape when adding or changing interfaces.
4. Tests: concrete automated test assertions and target test files.

Verify the four step constraints:
- **Deterministic:** No subjective instructions ("improve", "clean up", "refactor as needed").
- **Minimal:** Smallest verifiable unit of progress.
- **Self-contained:** Executable in isolation by a separate engineer or LLM context.
- **Forward-only:** Target architecture only. No unnecessary compatibility layers.

Verify step ordering:
- Types and contracts first.
- Pure/domain logic next.
- Stateful and I/O modules after.
- Integration wiring and verification tests last.

Flag and remove steps that should not exist:
- Manual testing or QA checklists.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting or lint-only chores.
- Git workflow or PR process steps.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
