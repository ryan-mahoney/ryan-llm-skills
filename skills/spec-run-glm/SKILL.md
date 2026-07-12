---
name: spec-run-glm
description: Use this OpenCode-specific spec-run variant for GLM 5.2 orchestration and GLM 5.2 Fast implementation. It consumes spec-prepare outputs exactly and never plans or rewrites subspecs at run time.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[absolute spec path or feature-document folder, optional resume step]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# Spec Run GLM

Read `~/.agents/skills/spec-run/SKILL.md` in full and follow it exactly. This
variant overrides only OpenCode model routing:

- Orchestrator: `spec-run-glm-orchestrator` (`z-ai/glm-5.2`).
- Implementer: `spec-run-glm-implementer` (GLM 5.2 Fast).

Do not invoke any `*-planner` agent. `spec-prepare` already grounded the spec,
planned every step, designed verification, and bound the immutable subspecs in
`preparation.json`. A missing or stale prepared artifact blocks execution.

For each step, pass the canonical path stanza, exact step, manifest-bound subspec,
prose guardrails, live invariants, prior learnings, and blockers to the implementer.
Require it to read and obey `spec-step-run`. The base skill's manifest validation,
focused-command authority, fix-attempt limits, scope checks, learning, and one-commit
boundary remain unchanged.

Resume from step N only when every earlier step has a successful learning and commit
on the current branch. Validate the complete preparation package, report the skipped
completed range, and start at N. Never plan, rewrite, or re-verify skipped steps.

If the specialized implementer is unavailable, use the base `spec-run` delegation
behavior and report the routing fallback.
