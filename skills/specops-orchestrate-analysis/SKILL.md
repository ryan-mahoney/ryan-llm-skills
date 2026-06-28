---
name: specops-orchestrate-analysis
description: This skill should be used when the user asks to orchestrate SpecOps analysis across all targets, run analysis for every target in docs/specops/targets.json, execute the decomposition-first SpecOps analysis pipeline in-harness, use sequential subagents to produce per-target analysis specs, or bootstrap the initial compressed agent docs and AGENTS.md index. It also supports the legacy initial-plan artifact flow as a fallback.
disable-model-invocation: true
argument-hint: "[manifest-path-or-repo-root]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "5"
---

# SpecOps Orchestrate Analysis

You are an in-harness orchestrator. Execute the decomposition-first SpecOps analysis pipeline from
`docs/specops/targets.json` using one sequential analysis subagent per manifest target.

Primary objective:
- Use the `specops-decompose` manifest as the source of truth for target decomposition.
- For each manifest target, run a `specops-analysis` subagent in manifest-driven mode.
- Ensure every target's analysis output is produced, verified, and reported before moving on.
- After analysis, build compressed agent docs and refresh the generated `AGENTS.md` index.

Do not generate specs. Do not implement product code directly unless subagents are unavailable.
Do not edit source code. Do not re-partition targets.

## Status

Primary path: orchestrate the decomposition-first AGENTS documentation pipeline in-harness by
reading `docs/specops/targets.json` and delegating one `specops-analysis` pass per target.

Legacy fallback: if the user explicitly provides an old `specops-initial-plan` artifact, or no
manifest exists and the user asks to proceed without `specops-decompose`, use the initial-plan flow
at the end of this file.

## Inputs

- Manifest path or repo root: `$ARGUMENTS` (or infer from user request/repo context).
- Default manifest path: `docs/specops/targets.json` under the current repository.
- Related standards/conventions files if present (for example `AGENTS.md`, `docs/engineering-standards.md`).

## Before Starting

1. Resolve the manifest:
   - If `$ARGUMENTS` is a JSON file, use it as the manifest.
   - If `$ARGUMENTS` is a directory, use `<directory>/docs/specops/targets.json`.
   - If `$ARGUMENTS` is absent, use `docs/specops/targets.json` in the current repository.
2. Read the manifest fully and validate that it has `version`, `system`, and a `targets` array.
3. For each target, require these fields:
   - `slug`
   - `name`
   - `scope`
   - `source_globs`
   - `tier2_path`
   - `agent_path` (or use `docs/specops/agents/<slug>.md` as the fallback)
   - `source_hash` (may be `null` if the manifest cannot hash the target)
4. Preserve target order exactly as it appears in the manifest.
5. Announce the ordered execution plan before delegating: target slug, scope, source globs, and output path.

A target's `origin` may be `derived`, `override`, or `remainder`. Analyze all three identically — a
`remainder` target is a bucket of loose files from an under-organized directory (its `source_globs`
use a shallow `dir/*` or `*` shape that matches only direct-child files) and gets the same analysis
pass as any other target. Do not skip it.

If the manifest is missing, empty, malformed, or has no targets, stop and tell the caller to run
`specops-decompose` first unless they explicitly asked for the legacy initial-plan fallback.

## Manifest Ownership Guardrails

Treat the manifest's structural fields as authoritative. Never edit:

- `slug`
- `structural_unit`
- `source_globs`
- `origin`
- `source_hash`
- `coverage`
- `overrides`
- `renames`

The orchestrator may report returned hashes and freshness information, but it must not silently
change structural manifest fields. If a subagent returns a `source_hash` that differs from the
manifest entry's `source_hash`, report the mismatch as a stale-manifest warning and recommend
rerunning `specops-decompose`.

## Execution Model: Sequential Subagents Per Target

Process one target at a time. Do not parallelize targets.

For each manifest target, run an analysis subagent using `specops-analysis` manifest-driven
behavior. Pass the complete target entry, not a prose-only scope, so the subagent reads `name`,
`scope`, `source_globs`, and `tier2_path` directly from the entry.

### Subagent Invocation Template

```txt
Agent(
  subagent_type: "general-purpose",
  description: "SpecOps target <target-slug> - analysis",
  prompt: "<PHASE_PROMPT>"
)
```

### PHASE_PROMPT (Analysis)

```txt
You are executing SpecOps analysis for one target.

Manifest target entry:
<target-json>

Follow the workflow and quality bar from the sibling `specops-analysis` skill
(`../specops-analysis/SKILL.md` from this skill directory).
Use manifest-driven invocation:
- Read `name`, `scope`, `source_globs`, and `tier2_path` directly from the target entry.
- Analyze only files covered by the effective `source_globs`, plus directly relevant tests, docs,
  configs, schemas, fixtures, and operational artifacts needed to explain the target behavior.
- Write the full analysis to `tier2_path`.
- Return the analyzed `source_hash` for the target's `source_globs`.

Do not generate a spec. Do not implement code.
Do not edit docs/specops/targets.json.
Return: summary, file written, analyzed source_hash, assumptions, risks.
```

## Verification After Each Subagent

After each analysis:
1. Confirm the target's `tier2_path` exists and is non-empty.
2. Confirm all required `specops-analysis` sections are present:
   - `1. Purpose & Responsibilities`
   - `2. Public Interfaces & Entry Points`
   - `3. Data Models & Structures`
   - `4. Behavioral Contracts`
   - `4A. Decision Logic, Business Rules & Policy Surface`
   - `4B. Policy Tests & Behavioral Scenarios`
   - `5. State Management`
   - `6. Dependencies`
   - `7. Side Effects & I/O`
   - `8. Error Handling & Failure Modes`
   - `9. Integration Points & Data Flow`
   - `10. Edge Cases & Implicit Behavior`
   - `11. Open Questions & Ambiguities`
3. Confirm each major section includes an `Evidence` subsection or explicitly says evidence was not identified.
4. Confirm observed facts and inferred interpretations are labeled where evidence is weak, indirect, contradictory, or incomplete.
5. Compare the returned analyzed `source_hash` with the manifest entry's `source_hash`.
   - If they match, mark the target fresh in the run report.
   - If they differ or the subagent does not return a hash, keep the analysis but flag the target for manifest refresh.
6. If invalid or incomplete, run one fix-up subagent for that same target.

Allow up to 2 fix-up attempts per target. If still failing, stop and report blockers.

## Fix-Up Subagent Template

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Fix SpecOps <target-slug> analysis",
  prompt: "Previous analysis is incomplete or invalid.
Findings: <list>
Re-read relevant skill instructions and target artifacts.
Fix only what is required.
Overwrite the same output file.
Do not edit docs/specops/targets.json.
Return: what changed and why, plus the analyzed source_hash."
)
```

## Completion

After all targets complete:
1. Provide per-target completion status.
2. List analysis files created.
3. Report source hash status for every target:
   - matched manifest hash
   - missing returned hash
   - mismatch requiring `specops-decompose`
4. Report remaining risks, ambiguities, and any blocked targets.
5. Invoke `specops-agent-docs` for all completed targets to create compressed docs under each
   target's `agent_path`.
6. Invoke `specops-index-agents` to update the generated block in root `AGENTS.md`.
7. Report compressed agent docs and AGENTS index status.
8. If every target was completed and hashes matched, say the analysis set is current with the manifest.

## Legacy Initial-Plan Fallback

Use this only when the user explicitly provides an initial-plan artifact or asks to proceed without
`docs/specops/targets.json`.

1. Read the initial-plan artifact fully.
2. Extract a deterministic, ordered target list. Each target should include:
   - Target/module name.
   - Scope description.
   - Source evidence/files when present.
   - Intended analysis output path.
3. If output paths are absent, default to `docs/specops/analysis/<target-slug>.md`.
4. Announce that the run is using the legacy fallback instead of the manifest-driven pipeline.
5. Run the same sequential subagent and verification loop, passing the target scope and evidence
   instead of a manifest target entry.
