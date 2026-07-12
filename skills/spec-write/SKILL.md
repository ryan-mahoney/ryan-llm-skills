---
name: spec-write
description: This skill should be used when the user asks to "write a spec", "create a spec", "spec this out", "plan this feature", or "write an implementation plan" for a feature or change. Creates a structured implementation spec at spec.md in the feature document folder without interacting with GitHub issues.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[feature-slug (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "13"
---

# Spec Write

Create a deterministic implementation spec from the current proposal and persist it to the feature document folder — a folder outside the git checkout owned by the app. The local file is canonical. This skill never creates, edits, or renames around GitHub issues.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When something is unclear or underspecified, make a reasonable, well-grounded decision from the available context — the conversation, the repository, existing conventions, and the spec's own intent — then proceed. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when a required input is genuinely missing and cannot be inferred (for example, no proposal or analysis to spec from). In that case, report what is missing and halt — do not ask for it interactively.

## Output Contract

Always write the completed spec to `spec.md` in the feature document folder:

```txt
<feature-document-folder>/spec.md
```

When the prompt includes a **# Canonical spec artifact paths** stanza, it is the primary path source — use its exact absolute `spec` path (and its `machineStateRoot` for the step index below).

Write every artifact atomically: write the full content to a temporary file in the destination directory, then rename it over the final path. Every markdown artifact begins with a level-1 `#` heading on line 1. Never write spec artifacts inside the git checkout or worktree.

This skill writes the local spec only. It does **not** create, edit, comment on, label, or close GitHub issues, and it does **not** rename the feature document folder to add an issue-number prefix.

## Pre-Step - Load Pipeline Inputs

Before writing the spec, locate the feature document folder for this feature — the folder outside the git checkout that holds the spec artifacts.

Resolve the folder in this order:

1. If the prompt includes a **# Canonical spec artifact paths** stanza, use its paths exactly — the `artifactsRoot` is the feature document folder.
2. If `$ARGUMENTS` is a path to a spec/proposal/requirements file or its containing folder, use that folder.
3. If the conversation names a feature document folder announced by `spec-architect-initial`, use it.
4. Otherwise use the directory containing the active working document file.

Never fall back to a spec folder inside a git checkout, and never create one there. If no feature document folder can be resolved, stop and report the missing input.

The folder contains fixed-name artifacts:

- **`requirements.md`** - optional. What was asked for; read it when present.
- **`proposal.md`** - the architecture proposal. This is the primary input for the Architecture and Implementation Steps sections. If there is no feature document folder, no proposal, and no analysis in the current conversation, stop and tell the user there is nothing to spec from.
- **`critique.md`** - optional. If present, reconcile it using the rules below. If absent, skip reconciliation; the critique stage is optional and its absence is not an error.
- **`spec.md`** - the output of this skill. Overwrite it only after producing the complete updated spec body.

### Phase specs

A large proposal may be split into multiple specs, one per phase. All phase specs share the same feature document folder unless the proposal explicitly creates separate folders.

When writing a phase spec:

- State which phase of the proposal this spec covers in the Problem Statement.
- Reconcile only the critique recommendations that fall within this phase's scope. Recommendations belonging to other phases are not deferrals; note them as "covered by phase N" only if helpful.
- End the spec with the footer block, keeping the phase marker on the folder line: `Spec folder: <absolute path of the feature document folder>/ (phase N)` followed by the `Visual design:` line (see Spec Footer).

## Reconcile Critique Feedback

Triage each recommendation by scope and relevance:

| Priority | Action |
|---|---|
| **Must Address** - flaws that will cause real problems if shipped | Incorporate into the spec's architecture. If a recommendation changes a core decision, update the design and document the rationale. |
| **Should Address** - meaningful improvements, not showstoppers | Address in the spec if the scope of the feature makes it natural to include. Otherwise, record in the Notes section as a known follow-up with a brief rationale for deferring. |
| **Consider** - polish/refinement | Note in the Notes section only if relevant. Skip if out of scope. No need to address every consideration. |

Reconciliation principles:

- Be pragmatic, not exhaustive. A critique explores possibilities; the spec commits to decisions.
- State your reasoning when deferring a critique recommendation.
- Do not over-engineer to satisfy hypotheticals.
- Resolve tensions using actual project context: team size, maturity, timeline, and current architecture.
- Make the final spec read as one coherent plan, not an accumulated list of compromises.

Apply reconciled decisions when writing the Architecture, Notes, and Implementation Steps sections below.

## Select Applicable Rules

Rule files are short, reusable convention guides (UX, forms, tables, copy, testing) that step implementers must follow when their subject matter is in play. Enumerate candidates from:

1. A repo-local rules folder (`rules/` or `.agents/rules/`) when one exists.
2. The user-global rules folder `~/.agents/rules/`.

Select by relevance, not completeness: form rules only when the spec builds or changes a form, table rules for tabular UI, CTA/copy rules for user-facing text, testing rules when steps add tests, broad design rules only for user-facing UI work. A backend-only spec typically selects nothing, or only the testing rule. Repo-local rules win over global rules on conflict.

Record the selection in the Applicable Rules section below. `spec-run` injects these paths into every step prompt, so an unselected rule is invisible at implementation time — but do not pad the list; irrelevant rules dilute the ones that matter.

## Required Sections

Every section is required. If not applicable, include the heading with "N/A".

### 1. Qualifications

List concrete technical domains required for this implementation. Include only skills actually needed.

### 2. Problem Statement

In 2-4 sentences: what capability is missing or broken, what the current behavior is, and what this spec addresses.

### 3. Goal

One sentence describing the concrete outcome when implementation is complete.

### 4. Architecture

Include:

- Files to create or modify, with responsibilities.
- Key types, interfaces, or contracts in concrete syntax for the project's language.
- Design decisions and rationale.
- Dependency map covering internal modules and external packages/services.

Design for current requirements, not imagined future ones. Start simple: boring technology, explicit boundaries, and data flow that can be explained in under 5 minutes. Fail fast on invalid inputs; do not add defensive fallbacks unless explicitly required.

Avoid abstractions with only one use, abstract layers "for future flexibility," complex patterns without matching problem complexity, and optimizations without measured need.

Ground the architecture in existing code: before adding a new module or helper, search for existing implementations and precedents using the available repository-search tools named in the runtime capability section — exact search for symbols or literals, and semantic search when available for behavior and precedent — and prefer reusing or extending what already exists.

### 5. Acceptance Criteria

Create a numbered list (`AC-1`, `AC-2`, etc.) of observable, automatable assertions:

- Group by concern: core behavior, error handling, edge cases, integration.
- Include non-happy-path behaviors.
- Make every criterion testable without subjective judgment.

### 6. Notes

Cover trade-offs, risks, ambiguities, migration concerns, and sequencing dependencies.

For each significant trade-off, state why this approach was chosen, what it gives up, what it gains, and which alternatives were considered.

### 7. Implementation Steps

Create a flat, numbered, sequential list of deterministic engineering tasks.

Number the steps with sequential integers starting at 1 (1, 2, 3, …) as one continuous list. Do not group steps under "Phase" headings and do not use tiered or decimal numbers (`1.1`, `2.3`, `3.2.1`). Even when the proposal is organized in phases, the Implementation Steps stay one flat integer sequence — preparation, `spec-run`, `spec-step-run`, and the external task-runner address steps by this number. A phase *spec* (one of several `spec.md` files for a multi-phase proposal, per Phase specs above) still keeps its own flat 1..N list.

For each step include:

1. What to do: exact files and changes required.
2. Why: tie to architecture or acceptance criteria.
3. Signatures/contracts: public API shape when adding or changing interfaces.
4. Tests: concrete automated test assertions and target test files. Test behavior, not implementation. Focus on edge cases and failure modes.
5. Coverage: which acceptance criteria this step satisfies, as a tag line (`Covers: AC-3, AC-7`). Every criterion must be covered by at least one step; a step covering no criterion must trace to a stated architectural need instead.
6. Complexity: how hard *this step* is, as a tag line (`Complexity: easy`). One of `easy`, `medium`, `hard` — see the rubric below. The system uses per-step tags to route each step to an appropriately strong implementation model, so score every step, not just the spec.
7. Visual design: whether *this step* implements user-facing visual design, as a tag line (`Visual: yes` or `Visual: no`). See the Visual design rubric in Implementation Profile. The system routes `Visual: yes` steps to design-capable handling and visual verification, so flag every step, not just the spec.

Each step's `Covers:`, `Complexity:`, and `Visual:` tag lines sit together at the end of the step. Judge complexity by *this step's own* work, applying the rubric the same way every time so the label is reproducible across runs. Anchor the choice on four signals — scope (files/modules this step touches), novelty (new abstractions vs. reusing existing patterns), domain difficulty (the Qualifications this step exercises), and integration risk (state, I/O, migrations, blast radius this step incurs):

| Tier | When |
|---|---|
| `easy` | One file or a few closely-related files; uses existing patterns directly; no new abstractions; local or pure logic; low blast radius. |
| `medium` | Several files, or some new types/functions following established patterns; limited state/IO; standard domain knowledge. |
| `hard` | New architecture/abstractions, cross-module integration, concurrency, migrations, non-trivial algorithms, specialized domain depth, or a wide high-risk change where subtle correctness dominates. |

When torn between two tiers, choose the higher one — an under-powered model is the costlier error.

Each step's terse name, one-line description, `Complexity:` value, and `Visual:` flag are also emitted to a machine-readable `spec-steps.json` index (see Machine-Readable Step Index). The JSON `difficulty` field must equal the step's `Complexity:` tag and `visualDesign` must equal its `Visual:` flag (`Visual: yes` → `true`) — the tags in `spec.md` are canonical; the JSON mirrors them.

Step constraints:

- **Deterministic:** No subjective instructions such as "improve", "clean up", or "refactor as needed".
- **Minimal:** Smallest verifiable unit of progress.
- **Self-contained:** Executable in isolation by a separate engineer or LLM context.
- **Forward-only:** Target architecture only. No unnecessary compatibility layers.

Step ordering:

- Types and contracts first.
- Pure/domain logic next.
- Stateful and I/O modules after.
- Integration wiring and verification tests last.

Exclude:

- Manual testing or QA checklists.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting or lint-only chores.
- Git workflow or PR process steps.

### 8. Applicable Rules

List the rule files selected above as resolvable paths, each with a one-line reason:

```markdown
- `~/.agents/rules/form-design.md` — spec adds a settings form
- `~/.agents/rules/unit-testing.md` — steps add unit tests
```

If none apply, "N/A".

## Implementation Profile

Both routing axes — Complexity and Visual design — are scored **per step**, not for the spec as a whole. Each step in Implementation Steps carries its own `Complexity:` and `Visual:` tag (see §7) so the system can route each step to an appropriately strong, appropriately-skilled implementation model. Do not emit a spec-level complexity.

The footer carries one spec-wide roll-up, derived after writing the spec body: a Visual design flag that summarizes the per-step `Visual:` tags. The per-step tags are canonical; the footer is a convenience summary. Apply the rubric the same way every time so the labels are reproducible across runs.

### Visual design

Flag each step by whether *that step* implements user-facing visual design:

- `Visual: yes` — the step produces or changes visual UI: component markup, layout, styling/theming, design-system implementation, or prototypes — anywhere visual fidelity and aesthetic judgment matter. Such a step usually relies on a design rule (`functionalist-design`, `expressive-design`, `form-design`, `table-row-design`, `cta-design`) from Applicable Rules.
- `Visual: no` — backend, infrastructure, tooling, data, API, pure logic, tests, or copy-only work with no visual layout or styling output. UI *logic* with no styling, and CLI or other text-only output, are `Visual: no`.

The per-step flag is binary — emit exactly one per step. The footer's spec-wide `Visual design:` line is the roll-up: `yes-visual-design` when any step is `Visual: yes`, else `no-visual-design`.

## Spec Footer

End `spec.md` with a metadata footer block so downstream skills can locate the folder and route the work. The first line is the canonical folder — the absolute path of the feature document folder; the second is the spec-wide Visual design roll-up (`yes-visual-design` if any step is `Visual: yes`, else `no-visual-design`). Per-step complexity and per-step visual flags are not in the footer — they live on each step (see §7). Never prefix the folder with an issue number:

```txt
Spec folder: <absolute path of the feature document folder>/
Visual design: no-visual-design
```

`Visual design` is exactly one of `yes-visual-design`, `no-visual-design`.

For phase specs, keep the phase marker on the folder line:

```txt
Spec folder: <absolute path of the feature document folder>/ (phase 2)
Visual design: yes-visual-design
```

## Machine-Readable Step Index

Alongside `spec.md`, write a machine-readable index of the implementation steps to:

```txt
<machineStateRoot>/spec-steps.json
```

`machineStateRoot` is the machine-state folder from the **# Canonical spec artifact paths** stanza — `<documentRoot>/.restory/spec/`, where `<documentRoot>` is the feature document folder named in the `Spec folder:` footer.

This file is a derived index, not a second source of truth. `spec.md` stays canonical — the full step text, `Covers:` tags, `Complexity:` tag, and `Visual:` flag all live there. `spec-steps.json` exists so an external task-runner can enumerate the steps and route each one — by difficulty and by visual-design skill — without parsing markdown. It is the same routing signal §7 describes, in a parsable shape.

The index is a JSON object with a `steps` array — one entry per Implementation Step, in spec order:

```json
{
  "spec": "/absolute/path/to/feature-document-folder/spec.md",
  "steps": [
    {
      "step": 1,
      "name": "Define the FooConfig type",
      "description": "Add the FooConfig interface and its defaults to src/config.ts.",
      "difficulty": "easy",
      "visualDesign": false
    }
  ]
}
```

Field contract:

- `spec` — the canonical absolute path of `spec.md` in the feature document folder (the `spec` path from the stanza), matching the `Spec folder:` footer.
- `step` — the step's number in `spec.md` (integer, 1-based, matching the Implementation Steps list). Downstream skills and the external task-runner address steps by this number.
- `name` — a terse imperative title for the step (verb + object), roughly eight words or fewer. Not the full "What to do" prose.
- `description` — one front-loaded, plain-language sentence summarizing what the step does.
- `difficulty` — exactly one of `easy`, `medium`, `hard`, identical to the step's `Complexity:` tag.
- `visualDesign` — boolean; `true` when the step implements user-facing visual design, identical to the step's `Visual:` flag (`Visual: yes` → `true`, `Visual: no` → `false`).

Write `spec-steps.json` only after the spec body is final, so the index matches the committed step list, numbering, complexity tags, and visual flags exactly. There must be exactly one entry per step, in the same order.

## Output Steps

1. Write the final markdown body — including each step's `Complexity:` tag (§7) and the footer block (`Spec folder:`, `Visual design:`) referencing the absolute feature document folder — to `spec.md` in the feature document folder (the canonical `spec` path).
2. Write the machine-readable step index to `<machineStateRoot>/spec-steps.json` (see Machine-Readable Step Index), one entry per step, each `difficulty` matching that step's `Complexity:` tag and each `visualDesign` matching its `Visual:` flag.
3. Report one compact routing summary: `outcome: written`; absolute spec and step-index paths; total/easy/medium/hard/visual step counts; proposal/critique inputs used; and `next: spec-prepare`.

Do not implement the plan.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
