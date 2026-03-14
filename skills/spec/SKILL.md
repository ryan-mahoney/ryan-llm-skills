---
name: spec
description: This skill should be used when the user asks to "write a spec", "create a spec", "spec this out", "plan this feature", or "write an implementation plan" for a feature or change. Creates a structured implementation spec and writes it to a GitHub issue.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# Spec

If an issue number is provided ($ARGUMENTS), write the spec into the body of that existing GitHub issue. If no argument is provided, create a new GitHub issue with the spec.

As a principal software architect, based on the current analysis, create a markdown spec including:

- The Qualifications (NodeJS, Data Processing, etc)
- Problem Statement
- Goal
- Architecture
- Acceptance Criteria
- Notes
- Implementation Steps

For the implementation steps, provide a flat numbered sequential list of engineering tasks. Each task should be deterministic and minimal. Describe only the needed change with no extra backwards compatibility. Include significant detail at each step so it can be implemented in isolation by separate people or LLM contexts. Do not describe manual testing. Do not describe documentation updates. Do not run the entire test suite.

The spec should reflect the project's ENGINEERING STANDARDS: `docs/engineering-standards.md`

Write the plan to a GitHub issue.

Do not implement the plan.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
