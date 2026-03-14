---
name: review
description: This skill should be used when the user asks to "review a spec", "review an issue", "check the plan", "review the implementation plan", or "find gaps in the spec". Reviews a GitHub issue spec for gaps and viability, then directly edits the issue if improvements are needed.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Review

Review GitHub issue $ARGUMENTS.

Assess whether the spec has gaps, whether the plan is viable for this project, whether there are errors, and whether there are important improvements.

If the spec should be changed, directly edit the content of issue $ARGUMENTS with an updated body that reflects an improved implementation spec.

Follow `docs/engineering-standards.md` and honor this rule:

For the implementation steps, provide a flat numbered sequential list of engineering tasks. Each task should be deterministic and minimal. Describe only the needed change with no extra backwards compatibility. Include significant detail at each step so it can be implemented in isolation by separate people or LLM contexts. Do not describe manual testing. Do not describe documentation updates. Do not run the entire test suite.
