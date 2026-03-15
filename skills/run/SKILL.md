---
name: run
description: This skill should be used when the user asks to "run a step", "implement the step", "execute the spec", "run the plan", or "implement step N". Implements specific steps from a GitHub issue spec.
disable-model-invocation: true
argument-hint: "[issue-number] [step(s)]"
---

# Run

Implement the requested steps from a GitHub issue spec. Use surgical, low-risk changes. Do not add complexity, unnecessary conditions, or unnecessary backward compatibility. Do not run the entire test suite.

SPEC: `gh issue view $1`
STEP(S): $2

## Before Starting

1. Read the issue spec via `gh issue view $1`.
2. Identify the requested step(s) from $2.
3. Announce which steps will be implemented, in order.

## Per-Step Workflow

For each requested step:

1. Read the step and evaluate whether it is the correct approach given the current state of the codebase. Adapt if needed.
2. Implement the step.
3. Run targeted tests for changed behavior.
4. Stage the changed files.
5. Write a conventional commit message: `type(scope): description (#$1)` where type reflects the nature of the change (feat, fix, refactor, chore, test).
6. Commit.

If multiple steps are requested, repeat this workflow for each step sequentially. Each step gets its own commit.

## Implementation Principles

- Fail fast on invalid inputs. No defensive fallbacks or "just in case" logic unless explicitly required.
- Prefer raising errors over silent failures, default values, or swallowing exceptions.
- Simple over clever. Boring, maintainable code beats clever optimizations.
- Build for today. Design for current requirements, not imagined future ones.
- Concise and idiomatic. Write code like a senior engineer, not a tutorial.
- Small functions under 10-15 lines. Extract helpers liberally.
- Single responsibility. Each function does one thing well.
- Clear but concise naming.
- Rule of three: do not abstract until you have 3 uses.
- Contextual error messages: what failed, what was expected, how to fix.
- Propagate errors, do not suppress. Let errors bubble up unless you can meaningfully handle them.
- Follow existing project patterns. Match the conventions already in use.

Do not:
- Add try/catch unless explicitly needed.
- Create interfaces with only one implementation.
- Add comments explaining what code obviously does.
- Write defensive "safety" logic for scenarios that indicate bugs.

## Quality Bar

- Maintainable by someone else in 6 months.
- Obvious what it does.
- Obvious when it breaks.
- Test behavior, not implementation. Focus on edge cases and failure modes.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
