---
name: run
description: This skill should be used when the user asks to "run a step", "implement the step", "execute the spec", "run the plan", or "implement step N". Implements specific steps from a GitHub issue spec.
disable-model-invocation: true
argument-hint: "[issue-number] [step(s)]"
---

# Run

As a senior software engineer, implement the following spec using surgical changes that are low-risk, do not add complexity, create unnecessary conditions, or introduce unnecessary backward compatibility. Do not run the entire test suite.

Act in accordance with the project's ENGINEERING STANDARDS: `docs/engineering-standards.md`

SPEC: `gh issue view $1`
ONLY STEP(S): $2

Before each step, consider if it is the correct approach; adapt as needed; then implement the step.
