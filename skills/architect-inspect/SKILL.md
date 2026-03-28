---
name: architect-inspect
description: "Inspect a top-level file for a component or feature, then analyze and describe the current architecture around it (boundaries, dependencies, data flow, and risks). Use this when the user says 'inspect this architecture', 'analyze this component architecture', 'explain how this feature is structured', or 'how does this module fit into the system'."
argument-hint: "[top-level file path] [optional output markdown path]"
---

# Architect-Inspect

Analyze the existing architecture for a feature starting from one top-level file. This skill maps how the file is used, what it depends on, where responsibilities live, and what architectural seams or risks are present today.

## Arguments

- `$1` - Required. Path to the top-level file for the component/feature (example: `src/features/billing/routes.ts`).
- `$2` - Optional. Output markdown path. If omitted, return analysis in the response only.

## Before Starting

1. Confirm `$1` exists and is a file.
2. Set variables:

```bash
entry_file="$1"
output_path="${2:-}"
feature_root="$(dirname "$entry_file")"
entry_stem="$(basename "${entry_file%.*}")"
```

3. Read `AGENTS.md` if present for project architecture and conventions.
4. Identify likely stack/routing context from manifests and entry wiring files.

## Steps

### 1. Classify the entry file's architectural role

Determine what the file is in the system:

- Route/transport boundary
- Feature entry module
- Domain service/orchestrator
- UI container/page
- Integration adapter

Collect quick evidence (exports, imports, framework signatures, route declarations).

### 2. Map inbound dependencies (who uses this file)

Find where this entry file is imported, referenced, or wired.

```bash
rg -n "$entry_stem" .
```

Record key callers and classify each as upstream trigger, router/wiring, or peer module.

### 3. Map outbound dependencies (what this file uses)

Inspect imports/dependencies from the entry file and immediate feature neighbors.

```bash
rg -n "from |require\\(" "$entry_file"
rg -n "from |require\\(" "$feature_root"
```

Classify dependencies:

- Internal domain modules
- Shared/internal platform modules
- Third-party/external services

### 4. Trace control and data flow

Build a high-level path:

- Trigger or entry point
- Orchestration and business logic layers
- State/persistence touchpoints
- Side effects (network, files, queues, logging)
- Response/output boundary

Keep this architectural (layer and flow), not a line-by-line code walkthrough.

**Pattern reference:** Architecture-fit framing aligns with `skills/architect-initial/SKILL.md`.

### 5. Assess boundaries and architectural health

Identify:

- Clear boundaries that are working well
- Responsibility leaks (for example transport layer doing domain work)
- Tight coupling hotspots
- Testability and change-risk concerns

Use concrete file evidence for each claim.

**Pattern reference:** Responsibility-boundary checks align with `skills/controller-refactor-plan/SKILL.md`.

### 6. Produce the architecture inspection output

Return markdown with these sections:

```markdown
# Architecture Inspection: <entry file>

## Summary
- What this feature/component does and its architectural role.

## Entry Points and Callers
- Ranked list of upstream files/modules and why they matter.

## Dependency Map
- Internal dependencies
- External dependencies
- Coupling notes

## Data and Control Flow
- End-to-end flow from trigger to outcome.

## Boundaries and Responsibilities
- What is well-separated
- Where responsibilities are mixed

## Risks and Hotspots
- Concrete risks with evidence and impact.

## Key Files to Read Next
- 3-8 files ranked for fastest architecture understanding.
```

If `$2` is provided, write the same output to that path (create parent directory as needed) and also summarize in the response.

## Conventions

- Evidence over opinion: every major claim should cite concrete files/symbols.
- Clearly label inference when direct evidence is incomplete.
- Keep analysis focused on current-state architecture, not implementation planning.
- Prefer existing project terminology for layers and modules.
- If architecture context is ambiguous, state assumptions explicitly.

**Pattern reference:** Sectioned evidence-driven reporting should mirror `skills/specops-analysis/SKILL.md`.
