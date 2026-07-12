---
name: design-spec-writer
description: This skill should be used when the user asks to "write the design spec", "spec this design", "turn this design into a spec", "make the design implementable", or "write the implementation plan for this design". Creates a deterministic design-focused spec in the feature document folder plus a machine step index for spec-prepare and spec-run, using the proposal, critique, and approved prototype without interacting with GitHub.
disable-model-invocation: true
argument-hint: "[feature-slug (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "8"
---

# Design Spec Writer

Turn an approved design direction into the same deterministic eight-section contract produced by `spec-write`, specialized for design tokens, components, states, interaction, and accessibility. Write human artifacts in the feature document folder outside the checkout and machine state under its `.restory/spec/` directory.

The local `spec.md` is canonical. This skill writes the local spec only and never creates, edits, or renames around GitHub issues.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When something is unclear or underspecified, make a reasonable, well-grounded decision from the available context — the proposal, critique, any approved prototype, the repo's design system, and the spec's own intent — then proceed. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when a required input is genuinely missing and cannot be inferred (for example, no proposal, prototype, or design direction to spec from). In that case, report what is missing and halt — do not ask for it interactively.

## Output Contract

Use the exact absolute `spec`, `artifactsRoot`, `prototypeRoot`, and `machineStateRoot` paths from the **# Canonical spec artifact paths** stanza. Write the completed spec to:

```txt
<feature-document-folder>/spec.md
```

Write every artifact atomically. Begin Markdown artifacts with a level-1 heading and write machine JSON with a trailing newline. Never write spec artifacts inside the git checkout or worktree.

This skill writes the local spec only. It does **not** create, edit, comment on, or label GitHub issues, and it does **not** rename the spec folder to add an issue-number prefix — the folder keeps its plain kebab-case slug.

## Pre-Step — Load Pipeline Inputs

Resolve the feature document folder in this order: the canonical stanza's `artifactsRoot`; an explicit proposal/spec path or containing folder; a feature document folder named in the conversation; the directory containing the active working document. Never search for a most-recent spec or create a spec folder inside a checkout. Stop with a definitive missing-input report if no folder resolves.

Read the fixed-name artifacts:

- **`proposal.md`** — the design proposal. Primary input for Architecture and Approach. It carries the **Context Verdict** (posture + governing rules), **Design Direction**, **Design System Usage**, and **States**. If there is no proposal, no prototype, and no design in the conversation, stop and say there is nothing to spec from.
- **`critique.md`** — optional. If present, reconcile per the triage table below. Absence is not an error.
- **`prototypeRoot`** — optional but authoritative when present. Use the exact stanza path. **An approved prototype is the visual source of truth.** Translate its concrete decisions — layout, type scale, spacing, color, component composition, states, interactions — rather than re-deriving them. Map prototype-only tokens and libraries to real project equivalents.
- **`spec.md`** — this skill's output. Overwrite only after producing the complete updated body.

Also read the repo's design system (tokens, component library, existing components) and `AGENTS.md`, so the spec references real, existing artifacts.

### Phase specs

A large design may split into phases. All phase specs share the feature document folder. State the phase in the Problem Statement, reconcile only in-scope critique items, and keep the phase marker in the absolute-path footer.

## Reconcile Critique Feedback

| Priority | Action |
|---|---|
| **Must Address** | Incorporate into the design in Architecture. If it changes a core decision (posture, direction, a component contract), update the design and record the rationale. |
| **Should Address** | Address if natural to the scope; else record in Notes as a known follow-up with a brief reason for deferring. |
| **Consider** | Note only if relevant. Skip if out of scope. |

Be pragmatic: a critique explores; the spec commits. Make the final spec read as one coherent plan, not a list of compromises.

## Select Applicable Rules

The proposal's **posture** decides the governing design rule. Select from repo-local rules (`rules/`, `.agents/rules/`) first, then `~/.agents/rules/`:

- **Posture rule (exactly one of):** `functionalist-design.md` for functional surfaces, `expressive-design.md` for expressive ones. For hybrid, select both and note which governs which zone.
- `ux-states.md` — whenever the work renders any data-driven view with multiple states (almost always).
- `form-design.md` — the work builds or changes a form.
- `table-row-design.md` — the work builds or changes a table.
- `cta-design.md` — the work adds or changes buttons or user-facing action copy.
- `unit-testing.md` — steps add automated tests.

Select by relevance, not completeness. Record the selection in the Applicable Rules section — `spec-run` injects these paths into every step prompt, so an unselected rule is invisible at implementation time; but do not pad, irrelevant rules dilute the ones that matter. Repo-local rules win on conflict.

## Required Sections

Every section is required. If not applicable, include the heading with "N/A".

### 1. Qualifications

Concrete frontend/design domains required: the framework (React/Vue/Svelte), the styling system (Tailwind/CSS modules/styled), the component library, accessibility practice (ARIA, WCAG), and the project's component-testing tools (Storybook, Playwright, Testing Library, axe/jest-axe). List only what this work needs.

### 2. Problem Statement

2-4 sentences: what UI is missing or wrong, the current behavior, and what this spec addresses.

### 3. Goal

One sentence describing the concrete, observable outcome when implementation is complete.

### 4. Architecture

Include:

- **Components/files to create or modify**, each with its responsibility and path.
- **The component tree** — how pieces compose, which existing components are reused.
- **Design tokens** — the spacing/color/type/radius tokens used, referenced by their real names. New tokens are listed explicitly with values and justification. No magic literals where a token exists.
- **Key contracts in concrete syntax** — component prop interfaces / types for the project's language.
- **Governing posture and rule**, and for hybrid, the zone mapping.
- **Dependency map** — component library, icon set, motion library, fonts.

Design for current requirements. Reuse existing components and tokens before adding. Avoid one-use abstractions and wrapper components with no behavior.

### 5. Acceptance Criteria

A numbered list (`AC-1`, `AC-2`, …) of observable, automatable design assertions, grouped by concern:

- **Structure/layout** — regions present, composition, responsive behavior at named breakpoints (e.g. "single column below 768px").
- **Token conformance** — uses system tokens, not hardcoded values (e.g. "all spacing uses the `space-*` scale; no literal px margins").
- **States** — every required state renders per `ux-states.md` (empty, loading, error, partial, ideal, and any permission/offline/stale states).
- **Interaction & feedback** — action acknowledgment, focus movement, disabled/active states, timing where it matters.
- **Accessibility** — concrete contrast ratios (≥ 4.5:1 body text for AA), roles/labels, keyboard operability, focus visibility, axe-clean where a tool exists.
- **Copy/CTA** — verb-led labels, one primary action per view, per `cta-design.md`.

Make each criterion verifiable without subjective judgment. Prefer assertions checkable by the project's existing test tooling — a Storybook story, a Playwright/visual snapshot, a jest-axe assertion. When the repo has no such harness, state the criterion as a precise, observable visual check (exact value, exact breakpoint, exact state) for final branch review or a human to verify — do not invent a test framework the repo lacks. Include non-ideal states; "renders the empty state with the documented copy and CTA" is a criterion.

### 6. Notes

Trade-offs with rationale, posture rationale, risks, what was deferred from critique and why, and any prototype→production gaps (what the prototype faked that production must do for real).

### 7. Implementation Steps

A flat, numbered, sequential list of deterministic engineering tasks. For each: **What to do** (exact files/changes), **Why** (tie to architecture or an AC), **Signatures/contracts** (component prop shapes when adding/changing interfaces), **Tests** (concrete assertions and target files — Storybook stories, Playwright/visual snapshots, jest-axe, Testing Library; behavior and states, not implementation), **Coverage** (`Covers: AC-3, AC-7`), **Complexity** (`Complexity: easy`), and **Visual design** (`Visual: yes` or `Visual: no`). Every AC must be covered by at least one step; a step covering no AC must trace to a stated architectural need.

Number the steps with sequential integers starting at 1 (1, 2, 3, …) as one continuous list. Do not group steps under "Phase" headings and do not use tiered or decimal numbers (`1.1`, `2.3`, `3.2.1`). Even when the design is organized in phases, the Implementation Steps stay one flat integer sequence — the external task-runner addresses steps by this number. A phase *spec* (one of several `spec.md` files for a multi-phase design, per Phase specs above) still keeps its own flat 1..N list.

Each step's `Covers:`, `Complexity:`, and `Visual:` tag lines sit together at the end of the step. Score complexity by *this step's own* work, applying the rubric the same way every time so the label is reproducible across runs. The system uses per-step tags to route each step to an appropriately strong implementation model, so score every step. Anchor the choice on scope (files/components this step touches), novelty (new patterns vs. reusing existing components/tokens), domain difficulty (the design and a11y depth this step exercises), and integration risk (state wiring, motion, cross-component blast radius):

| Tier | When |
|---|---|
| `easy` | One component or a few closely-related files; uses existing tokens/primitives directly; no new patterns; local styling or markup; low blast radius. |
| `medium` | Several components, or some new components/variants following established patterns; limited state/interaction wiring; standard design knowledge. |
| `hard` | New design-system primitives or tokens, cross-component composition, complex interaction/motion/focus management, non-trivial responsive or a11y work, or a wide high-risk change where subtle visual or accessibility correctness dominates. |

When torn between two tiers, choose the higher one — an under-powered model is the costlier error.

Flag each step's `Visual:` by whether *that step* produces or changes visual UI — component markup, layout, styling/theming, design-system implementation (tokens included), or prototypes — `Visual: yes`. Steps with no visual output — pure config wiring, data shaping, or text-only test scaffolding — are `Visual: no`. Most steps in a design spec are `Visual: yes`; flag every step regardless. The system routes `Visual: yes` steps to design-capable handling and visual verification.

Each step's name, one-line description, `Complexity:` value, and `Visual:` flag are also emitted to `spec-steps.json` (see Machine-Readable Step Index); the JSON `difficulty` must equal the step's `Complexity:` tag and `visualDesign` must equal its `Visual:` flag (`Visual: yes` → `true`).

Step constraints: **Deterministic** (no "polish", "make it nicer", "clean up"), **Minimal** (smallest verifiable unit), **Self-contained** (executable in isolation), **Forward-only** (target design only, no compatibility shims).

Step ordering for design work:

- **Tokens/theme first** — new design tokens, Tailwind config, CSS variables.
- **Primitives next** — leaf components (Button, Input, Badge).
- **Composites & layout** — components that compose primitives, page layout.
- **States & interaction** — empty/loading/error wiring, focus, motion.
- **Accessibility & verification tests last** — a11y assertions, visual/interaction snapshots.

Exclude: manual QA checklists, documentation-only tasks, running the entire test suite, formatting/lint-only chores, and git/PR process steps.

### 8. Applicable Rules

List the selected rule files as resolvable paths, each with a one-line reason:

```markdown
- `~/.agents/rules/expressive-design.md` — expressive landing surface
- `~/.agents/rules/ux-states.md` — renders empty/loading/error states
- `~/.agents/rules/cta-design.md` — primary CTA and form buttons
```

If none apply, "N/A".

## Spec Footer

End `spec.md` with the absolute feature document folder plus the spec-wide Visual design roll-up. The roll-up is `yes-visual-design` when any step is `Visual: yes`, else `no-visual-design`:

```txt
Spec folder: <absolute path of the feature document folder>/
Visual design: yes-visual-design
```

For phase specs: `Spec folder: <absolute path of the feature document folder>/ (phase 2)`.

## Machine-Readable Step Index

After `spec.md` is final, write the machine-readable step index to the stanza's exact `<machineStateRoot>/spec-steps.json` path. This is the same derived contract `spec-write` produces.

The file is a derived index, not a second source of truth — `spec.md` stays canonical for full step text, `Covers:` tags, `Complexity:` tags, and `Visual:` flags. It is a JSON object with a `steps` array, one entry per Implementation Step in spec order:

```json
{
  "spec": "/absolute/path/to/feature-document-folder/spec.md",
  "steps": [
    {
      "step": 1,
      "name": "Add color and spacing tokens",
      "description": "Define the new design tokens and Tailwind config entries in tailwind.config.ts.",
      "difficulty": "easy",
      "visualDesign": true
    }
  ]
}
```

Field contract:

- `spec` — the canonical absolute stanza path to `spec.md`, matching the footer.
- `step` — the step's number in `spec.md` (integer, 1-based). Downstream skills and the external task-runner address steps by this number.
- `name` — a terse imperative title (verb + object), roughly eight words or fewer. Not the full "What to do" prose.
- `description` — one front-loaded, plain-language sentence summarizing what the step does.
- `difficulty` — exactly one of `easy`, `medium`, `hard`, identical to the step's `Complexity:` tag.
- `visualDesign` — boolean; `true` when the step implements user-facing visual design, identical to the step's `Visual:` flag (`Visual: yes` → `true`, `Visual: no` → `false`).

Write `spec-steps.json` only after the spec body is final, so the index matches the committed step list, numbering, and complexity tags. Exactly one entry per step, in order.

## Output Steps

1. Atomically write the final Markdown body to the stanza's absolute `spec` path, including the absolute footer and per-step tags.
2. Atomically write the derived index to `<machineStateRoot>/spec-steps.json`, with one minimal entry per step and exact tag parity.
3. Report one compact routing summary: `outcome: written`; absolute spec and step-index paths; total/easy/medium/hard/visual step counts; proposal/critique/prototype inputs used; and `next: spec-prepare`.

Do not implement the plan. Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
