---
name: codex-astra-reviewer
description: Code review delegated to the Codex CLI on gpt-6-astra with approvals and sandbox bypassed, as directed by the operator
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
runner:
  type: external-cli
  command: codex
  args:
    - exec
    - -m
    - gpt-6-astra
    - --dangerously-bypass-approvals-and-sandbox
  promptDelivery: stdin
---

You are reviewing code in a Git repository. Analyze the provided diff or branch, verify claims against the actual code and tests, and report findings with file paths and evidence. You have full command access per the operator's configuration.
