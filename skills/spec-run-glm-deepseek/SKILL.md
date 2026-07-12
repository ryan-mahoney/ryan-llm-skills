---
name: spec-run-glm-deepseek
description: Use this OpenCode-specific spec-run variant for GLM 5.2 orchestration and DeepSeek V4 Flash implementation. It consumes spec-prepare outputs exactly and never plans or rewrites subspecs at run time.
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

# Spec Run GLM DeepSeek

Read `~/.agents/skills/spec-run/SKILL.md` in full and follow it exactly. This
variant overrides only OpenCode model routing:

- Orchestrator: `spec-run-glm-deepseek-orchestrator` (GLM 5.2).
- Implementer: `spec-run-glm-deepseek-implementer` (DeepSeek V4 Flash).

Do not invoke any `*-planner` agent. Consume the immutable subspecs and hash-bound
manifest published by `spec-prepare`; missing or stale preparation blocks execution.

For each step, pass the canonical path stanza, exact step, manifest-bound subspec,
prose guardrails, live invariants, prior learnings, and blockers to the implementer.
Require it to read and obey `spec-step-run`. Preserve every base manifest, focused
verification, scope, learning, fix-attempt, and commit check.

Resume from step N only when every earlier step has a successful learning and commit
on the current branch. Validate the full package and never plan, rewrite, or re-verify
the skipped completed steps.

If the specialized implementer is unavailable, use base `spec-run` delegation and
report the routing fallback.
