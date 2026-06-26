---
name: specops-agent-docs
description: This skill should be used when the user asks to build, generate, compress, refresh, or update agent-facing docs from SpecOps analysis; create per-target docs under docs/specops/agents; summarize docs/specops/analysis files for coding agents; or produce compact target guides that AGENTS.md can index.
disable-model-invocation: true
argument-hint: "[manifest-path-or-repo-root] [target-slug optional]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Agent Docs

Build compressed, agent-facing target docs from the deeper SpecOps analysis layer. These docs are
the Tier-1 working memory an agent should read first; the deep analysis remains the evidence-rich
source of truth.

## Inputs

- Manifest path or repo root: `$ARGUMENTS` (or infer from current repository).
- Optional target slug: refresh only that target when provided.
- Default manifest path: `docs/specops/targets.json`.
- Default agent-doc path for a target: target `agent_path`, falling back to
  `docs/specops/agents/<slug>.md`.

## Procedure

1. Resolve and read the manifest.
2. Select targets:
   - If a slug is provided, select only that target.
   - Otherwise process all targets in manifest order.
3. For each selected target, read its deep analysis at `tier2_path`.
   - If the analysis file is missing, do not invent an agent doc. Report the target as blocked and
     ask the orchestrator to run `specops-analysis` for that target.
   - If the target has no `agent_path`, use `docs/specops/agents/<slug>.md`.
4. Write or overwrite the compressed agent doc at `agent_path`.
5. Return the written paths, blocked targets, and any stale or missing evidence concerns.

For many targets, use one sequential subagent per target. Do not parallelize unless the caller
explicitly asks for speed over reviewability.

## Compression Contract

Each agent doc must be short enough to read during ordinary coding. Prefer dense bullets over
prose. Target 80-140 lines; exceed that only when a target has unusually broad responsibility.

Use this structure exactly:

```markdown
# <Target Name> Agent Doc

Source target: `<slug>`
Scope: <one-line target scope>
Deep analysis: [`<tier2_path>`](../analysis/<slug>.md)
Freshness: `source_hash=<hash-or-null>`, `last_synthesized=<timestamp-or-null>`

## Use When
- ...

## Read First
- `<source-file-or-entry-point>` — why it matters.

## Interfaces
- ...

## Rules & Invariants
- ...

## State, I/O & Side Effects
- ...

## Failure Modes
- ...

## Change Checklist
- ...

## Escalate To Deep Analysis
- ...
```

## Content Rules

- Extract from the target's deep analysis; do not re-analyze the codebase from scratch unless the
  deep analysis is missing a critical fact and the relevant file is directly cited.
- Keep only what helps an agent make changes safely: entry points, boundaries, rules, invariants,
  data/state ownership, side effects, failure modes, and test/check commands when target-specific.
- Preserve important policy-like rules from sections `4A` and `4B` of the deep analysis.
- Include file paths for entry points and evidence, but avoid copying long evidence prose.
- Mark weak or inferred claims as `Inferred`.
- Do not include generic project setup or framework guidance already covered by root `AGENTS.md`.
- Do not mention Codex, OpenAI, GPT, or AI authorship in generated repository artifacts.

## Freshness

The target manifest owns `source_hash` and `last_synthesized`. This skill writes agent docs but
does not update manifest freshness fields. The branch orchestrator updates the manifest after
analysis refreshes.

If the deep analysis appears inconsistent with the manifest target, report the mismatch rather than
silently correcting unrelated files.

## Guardrails

- Write only selected target files under `docs/specops/agents/`.
- Do not edit `docs/specops/targets.json`.
- Do not edit root `AGENTS.md`; use `specops-index-agents` for that.
- Do not edit source code.
