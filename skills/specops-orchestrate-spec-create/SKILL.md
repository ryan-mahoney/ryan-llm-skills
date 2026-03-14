---
name: specops-orchestrate-spec-create
description: This skill should be used when the user asks to generate specs for multiple analysis files by orchestrating sequential subagents that apply the specops-make-spec workflow per file.
disable-model-invocation: true
argument-hint: "[analysis-file-list-or-directory (optional)]"
---

# SpecOps Orchestrate Spec Create

You are an orchestrator. Generate one implementation spec per analysis artifact using sequential subagents.

Use `specops-make-spec` behavior for each analysis file.
Do not implement product code directly unless subagents are unavailable.

## Inputs

- Analysis file list or directory from `$ARGUMENTS`.
- If no argument is provided, discover analysis files from repository conventions (for example `docs/specops/analysis/*.md`).
- Project standards and conventions files when present.

## Before Starting

1. Build an ordered list of analysis files to process.
2. Exclude clearly non-analysis files (notes, drafts, templates) unless explicitly requested.
3. Determine output path per analysis file:
- Default: `docs/specops/specs/<analysis-basename>.md`
4. Announce execution order and output mapping before delegation.

## Execution Model: One Sequential Subagent Per Analysis File

Process analysis files one at a time. Do not parallelize.

For each analysis file invoke:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Create spec for <analysis-file>",
  prompt: "<SPEC_PROMPT>"
)
```

### SPEC_PROMPT Template

```txt
You are creating an implementation specification from a completed SpecOps analysis.

Analysis file: <analysis-file>
Output spec file: <spec-output-file>

Follow skills/specops-make-spec/SKILL.md.
Read relevant project standards/conventions.
Write the full specification to <spec-output-file>.
Do not implement code.
Return: summary, file written, assumptions, risks.
```

## Verification After Each Subagent

1. Confirm output spec file exists and is non-empty.
2. Confirm required sections from `specops-make-spec` are present.
3. Confirm acceptance criteria are observable/automatable.
4. If incomplete, run one fix-up subagent for that file.

Allow up to 2 fix-up attempts per file. If still failing, stop and report blockers.

## Fix-Up Subagent Template

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Fix spec for <analysis-file>",
  prompt: "Previous spec output is incomplete or invalid.
Findings: <list>
Re-read skills/specops-make-spec/SKILL.md and the analysis file.
Fix only required gaps and overwrite the same output file.
Return: what changed and why."
)
```

## Completion

After all files complete:
1. Provide per-file completion status.
2. List spec files created.
3. Report risks, ambiguities, and blocked files.
