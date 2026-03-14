---
name: specops-orchestrate-analysis
description: This skill should be used when the user asks to orchestrate SpecOps work from an initial plan output across all targets using sequential subagents, including analysis generation and per-target spec creation.
disable-model-invocation: true
argument-hint: "[initial-plan-file-or-scope]"
---

# SpecOps Orchestrate Analysis

You are an orchestrator. Execute a SpecOps pipeline from an initial-plan artifact using sequential subagents.

Primary objective:
- Use the output of `specops-initial-plan` as the source of truth for target decomposition.
- For each target, run subagents in sequence.
- Ensure per-target outputs are produced consistently and verified before moving to the next target.

Do not implement product code directly unless subagents are unavailable.

## Inputs

- Initial plan artifact: `$ARGUMENTS` (or infer from user request/repo context).
- Related standards/conventions files if present (for example `AGENTS.md`, `docs/engineering-standards.md`).

## Before Starting

1. Read the initial-plan artifact fully.
2. Extract a deterministic, ordered target list. Each target should include:
- Target/module name.
- Scope description.
- Source evidence/files when present.
- Intended analysis output path.
- Intended spec output path.
3. If output paths are absent, default to:
- Analysis: `docs/specops/analysis/<target-slug>.md`
- Spec: `docs/specops/specs/<target-slug>.md`
4. Announce ordered execution plan before delegating.

## Execution Model: Sequential Subagents Per Target

Process one target at a time. Do not parallelize targets.

For each target, run subagents in this order:

1. Analysis subagent (use `specops-analysis` behavior)
2. Spec subagent (use `specops-make-spec` behavior)

### Subagent Invocation Template

```txt
Agent(
  subagent_type: "general-purpose",
  description: "SpecOps target <target-slug> - <phase>",
  prompt: "<PHASE_PROMPT>"
)
```

### PHASE_PROMPT (Analysis)

```txt
You are executing SpecOps analysis for one target.

Target: <target-name>
Scope: <target-scope>
Evidence/files: <file-list>
Output file: <analysis-output-file>

Follow the workflow and quality bar from skills/specops-analysis/SKILL.md.
Write the full analysis to <analysis-output-file>.
Do not implement code.
Return: summary, file written, assumptions, risks.
```

### PHASE_PROMPT (Spec)

```txt
You are creating an implementation spec from one completed analysis.

Analysis input: <analysis-output-file>
Spec output: <spec-output-file>
Target: <target-name>

Follow the workflow and quality bar from skills/specops-make-spec/SKILL.md.
Write the resulting spec to <spec-output-file>.
Do not implement code.
Return: summary, file written, assumptions, risks.
```

## Verification After Each Subagent

After each phase:
1. Confirm output file exists and is non-empty.
2. Confirm required sections from the corresponding skill are present.
3. Confirm claims are evidence-based and assumptions are labeled.
4. If invalid/incomplete, run one fix-up subagent for that same phase.

Allow up to 2 fix-up attempts per phase. If still failing, stop and report blockers.

## Fix-Up Subagent Template

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Fix SpecOps <target-slug> <phase>",
  prompt: "Previous output is incomplete or invalid.
Findings: <list>
Re-read relevant skill instructions and target artifacts.
Fix only what is required.
Overwrite the same output file.
Return: what changed and why."
)
```

## Completion

After all targets complete:
1. Provide per-target completion status.
2. List analysis files created.
3. List spec files created.
4. Report remaining risks, ambiguities, and any blocked targets.
