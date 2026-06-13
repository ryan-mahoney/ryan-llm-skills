---
name: design-spec-writer
description: This skill should be used when the user asks to "write the design spec", "spec this design", "turn this design into a spec", "make the design implementable", or "write the implementation plan for this design". Creates a deterministic, design-focused implementation spec in .specs/<slug>/spec.md — the same contract spec-run consumes — from the proposal, critique, and any approved prototype.
disable-model-invocation: true
argument-hint: "[feature-slug or GitHub issue number (optional)]"
---

# Design Spec Writer

Turn an approved design direction into a deterministic implementation spec that `spec-run` can execute without modification. The output is `.specs/<feature-slug>/spec.md` in the **exact same 8-section contract** the engineering `spec-write` produces — so `spec-criteria`, `spec-branch`, `spec-run`, `spec-audit`, and `spec-remediate` all work unchanged. The difference is the content: design tokens, components, states, interaction, and accessibility instead of services and data layers.

The local `spec.md` is canonical; issue trackers are optional mirrors.

## Output Contract

Always write the completed spec to:

```txt
.specs/<feature-slug>/spec.md
```

If the current repository is a GitHub repository and `gh` is authenticated, also mirror the same spec body to a GitHub issue (edit the issue named by `$ARGUMENTS`, else create one). If GitHub is unavailable, unauthenticated, or hosted elsewhere, skip the mirror and report the local path. Bitbucket, GitLab, self-hosted, and local-only repos use `spec.md` only. (Same GitHub-mirror detection and issue-ID folder prefix rules as `spec-write`.)

## Pre-Step — Load Pipeline Inputs

Locate the spec folder `.specs/<feature-slug>/`, resolving in this order: an explicit `$ARGUMENTS` folder; a folder named in the conversation; the `proposal.md` matching the feature (most recent on ties); else create one from a kebab-case slug.

Read the fixed-name artifacts:

- **`proposal.md`** — the design proposal. Primary input for Architecture and Approach. It carries the **Context Verdict** (posture + governing rules), **Design Direction**, **Design System Usage**, and **States**. If there is no proposal, no prototype, and no design in the conversation, stop and say there is nothing to spec from.
- **`critique.md`** — optional. If present, reconcile per the triage table below. Absence is not an error.
- **`prototype/`** — optional but authoritative when present. **An approved prototype is the visual source of truth.** Translate its concrete decisions — layout, type scale, spacing, color, component composition, states, interactions — into the spec rather than re-deriving them. Where the prototype used CDN Tailwind or inline tokens, the spec maps those to the repo's real tokens/components.
- **`spec.md`** — this skill's output. Overwrite only after producing the complete updated body.

Also read the repo's design system (tokens, component library, existing components) and `AGENTS.md`, so the spec references real, existing artifacts.

### Phase specs

A large design may split into phases (e.g. design tokens, then components, then page composition). All phase specs share the folder. State the phase in the Problem Statement, reconcile only in-scope critique items, and end with `Spec folder: .specs/<feature-slug>/ (phase N)`.

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

Make each criterion verifiable without subjective judgment. Prefer assertions checkable by the project's existing test tooling — a Storybook story, a Playwright/visual snapshot, a jest-axe assertion. When the repo has no such harness, state the criterion as a precise, observable visual check (exact value, exact breakpoint, exact state) so `spec-audit` or a human can verify it — do not invent a test framework the repo lacks. Include non-ideal states; "renders the empty state with the documented copy and CTA" is a criterion.

### 6. Notes

Trade-offs with rationale, posture rationale, risks, what was deferred from critique and why, and any prototype→production gaps (what the prototype faked that production must do for real).

### 7. Implementation Steps

A flat, numbered, sequential list of deterministic engineering tasks. For each: **What to do** (exact files/changes), **Why** (tie to architecture or an AC), **Signatures/contracts** (component prop shapes when adding/changing interfaces), **Tests** (concrete assertions and target files — Storybook stories, Playwright/visual snapshots, jest-axe, Testing Library; behavior and states, not implementation), and **Coverage** (`Covers: AC-3, AC-7`). Every AC must be covered by at least one step; a step covering no AC must trace to a stated architectural need.

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

End `spec.md` with the locator line (use the issue-prefixed slug when an issue exists):

```txt
Spec folder: .specs/<feature-slug>/
```

For phase specs: `Spec folder: .specs/<feature-slug>/ (phase 2)`. The GitHub mirror, when used, contains the same footer.

## Output Steps

1. Resolve the GitHub mirror and issue number (create the issue first to reserve its number when creating new).
2. Apply the issue-ID folder prefix when an issue number exists, so the canonical folder is `.specs/<issue-number>-<feature-slug>/`; without one it stays `.specs/<feature-slug>/`.
3. Write the final markdown body — footer included — to `<canonical folder>/spec.md`.
4. If GitHub mirroring is available, set the issue body to the same content.
5. Report: spec path; GitHub issue URL or "not mirrored"; and the inputs used (proposal, critique, prototype).

Do not implement the plan. Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
