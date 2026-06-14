---
name: design-spec-review
description: This skill should be used when the user asks to "review the design spec", "check the design plan", "find gaps in the design spec", or "review design spec". Reviews .specs/<slug>/spec.md from a design lens for gaps, ambiguity, token/state/accessibility coverage, and implementation readiness, edits it when needed, and mirrors changes to GitHub only when a mirror exists.
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# Design Spec Review

Review a design-focused implementation spec for viability, ambiguity, traceability, and readiness — grounded in the actual repository and its design system. The local `spec.md` is canonical. This is the design counterpart to `spec-review`; it enforces the same 8-section contract so the spec stays consumable by `spec-run`, and adds design-specific ambiguity checks.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When something is unclear or underspecified, make a reasonable, well-grounded decision from the available context — the repository, the design system, existing conventions, and the spec's own intent — then proceed. When a design ambiguity is genuinely indeterminate, resolve it as an open question in the spec's Notes rather than asking the user. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when a required input is genuinely missing and cannot be inferred (for example, no spec to review). In that case, report what is missing and halt — do not ask for it interactively.

## Output Contract

Apply substantive review changes to the resolved local spec file first:

```txt
.specs/<feature-slug>/spec.md
```

GitHub issues are optional mirrors. Never update an issue instead of the local file.

## Resolve the Spec

1. `$ARGUMENTS` is a markdown path → review that file.
2. `$ARGUMENTS` names a `.specs/` folder → review `.specs/<feature-slug>/spec.md`.
3. `$ARGUMENTS` is a GitHub issue number on a GitHub repo → read the issue body, extract its `Spec folder:` footer, review the local `spec.md` (materialize it from the issue body first if the local file is missing but the footer is valid).
4. No argument → review the most recently modified `.specs/*/spec.md`.

If no local spec resolves, stop and report the missing input.

## Optional GitHub Mirror

When the spec has a GitHub issue mirror (issue number passed, or footer/conversation clearly identifies one for this repo), update that issue after editing `spec.md`. If the mirror update fails, keep the local edits and report the failure.

## Ground the Review in the Codebase and Design System

Do not review for internal consistency alone. Before trusting any claim, verify it against the repository:

- Every component, token, file, prop, and icon the spec references must actually exist, or for new ones sit plausibly alongside what exists. Read the referenced files.
- **Design-system grounding:** flag tokens, components, or patterns the spec invents when the system already provides an equivalent (reuse it), and flag off-system one-offs the spec adds without justification.
- Naming, structure, and conventions must match the project's real design system. When resolving an ambiguity, draw the answer from the tokens, existing components, or the spec's own intent. If genuinely indeterminate, record it in Notes as an open question.

## Verify Critique Reconciliation

If the footer names a spec folder and `critique.md` exists there, verify the critique landed: every **Must Address** item is reflected in Architecture/Implementation Steps or explicitly deferred in Notes with a rationale; a silently dropped Must Address is a gap — restore it. **Should Address** items need no enforcement; flag only cheap-to-include ones the spec ignores entirely. For phase specs, enforce only in-scope items. If there is no `critique.md`, skip this check.

## Editing the Spec

Edit `spec.md` directly when it should change. Edit with discipline: only for substantive gaps; preserve the author's intent and voice; report what changed and why; converge on re-run (a sound spec needs no edits). Splitting an oversized step is substantive, not churn.

## Output Steps

1. Write reviewed changes to the local `spec.md`.
2. If a GitHub mirror exists, update the issue with the final body.
3. Report: spec path; issue URL or "not mirrored"; whether the file changed; what changed and why, or that the spec already passed.

## Review Checklist

### Required Sections

All 8 sections present and substantive: **Qualifications** (only domains actually needed), **Problem Statement** (grounded, 2-4 sentences), **Goal** (one concrete sentence), **Architecture** (components/files with responsibilities, the component tree, tokens by real name, prop contracts in concrete syntax, governing posture/rule, dependency map), **Acceptance Criteria** (see below), **Notes** (trade-offs with rationale, posture rationale, prototype→production gaps), **Implementation Steps** (see below), **Applicable Rules** (each path resolves to a real file, each has a reason, the posture rule is present and correct, and the selection matches what the spec touches — the form rule for a form, `ux-states.md` for stateful views — with no padding).

### Architecture Review

Flag: designing for imagined future needs; one-use abstractions or wrapper components with no behavior; **reinventing tokens/components the system already has**; posture incoherence (expressive treatment on a functional surface or vice versa, against the proposal's verdict); responsive behavior or state coverage described vaguely instead of designed; trade-offs stated without rationale.

### Design Ambiguity Review

Scan every section for statements that let an implementer make an undocumented design judgment call. The test: if two engineers built from this prose, could they produce visibly different UI? If yes, it is ambiguous. Flag these categories:

- **Magic values vs tokens** — `padding: 16px` / `#3b82f6` where a token (`space-4`, `color-primary`) should be named.
- **Unspecified responsive behavior** — "responsive" without the breakpoints and what changes at each.
- **Missing states** — which of empty, loading, error, partial, permission, offline, stale, ideal are unspecified for a data-driven view (per `ux-states.md`).
- **Vague motion** — "smooth", "subtle", "animated" without duration, easing, or trigger; no `prefers-reduced-motion` handling.
- **Vague aesthetics** — "clean", "modern", "polished", "nice" as if they were specifications.
- **Accessibility gaps** — unspecified focus order, keyboard behavior, ARIA roles/labels, or contrast targets; color-only signaling.
- **Copy left to the implementer** — button labels, empty-state text, error messages described as "appropriate" rather than written.
- **Type & shape ambiguity** — component props without type/optionality/default; "a variant" without the enumerated values.
- **Internal contradictions** — one section says one layout/token/state, another says different.

Resolve each in place when the answer comes from the design system, conventions, or the spec's intent. Otherwise add a concrete open question in Notes naming the decision a designer must make.

### Acceptance Criteria Review

Criteria must be observable and automatable (or precisely described where no test harness exists), grouped by concern, and include non-ideal states. Flag subjective criteria ("looks good", "feels fast") and rewrite them to a measurable assertion (exact value, breakpoint, contrast ratio, or named state). Confirm accessibility and state criteria exist — their absence is a gap, not an omission to wave through.

### Implementation Steps Review

Each step has: what to do (exact files), why (tied to architecture or an AC), signatures/contracts (component props when changing interfaces), and tests (concrete assertions + target files). Verify the four constraints (deterministic, minimal, self-contained, forward-only) and the design step ordering (tokens/theme → primitives → composites/layout → states/interaction → accessibility/verification tests last).

### Traceability

Every step carries a `Covers: AC-n` tag or traces to a stated architectural need; every AC is covered by at least one step; verification tests in the steps map to observable assertions in the criteria. Add missing tags, correct mismatched ones, remove untraceable scope creep.

### Granularity & Step Splitting

Required on each step. Split when a step mixes a token change with the component that consumes it, mixes a primitive with a composite, bundles multiple components, maps to more than one AC, or could half-land while the rest is broken. Do not over-split a contract and its sole consumer that cannot be tested apart. Remove steps that should not exist (manual QA, doc-only, full-suite runs, lint-only, git/PR). State the granularity verdict explicitly: which steps were split and why, or that all were checked and none met a trigger.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
