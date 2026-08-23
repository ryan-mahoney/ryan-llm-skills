---
name: specops-make-spec
description: This skill should be used when the user asks to convert a SpecOps analysis into a deterministic implementation specification for a specific project, stack, and engineering standards.
disable-model-invocation: true
argument-hint: "[analysis-scope-or-file (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# SpecOps Make Spec

Convert a verified SpecOps analysis into an implementation and executable-evidence specification. Read [the shared executable-evidence contract](../spec-work-tour/references/executable-evidence.md) first.

If `$ARGUMENTS` is provided, treat it as `ANALYSIS_SCOPE` (or specific analysis file if clearly file-shaped).
If `$ARGUMENTS` is not provided, infer the analysis target from user request and repository context.

Read these sources before authoring the spec:
- The target analysis artifact(s).
- Project engineering standards (for example `docs/engineering-standards.md` when present).
- Project agent conventions (for example `AGENTS.md` when present).
- Adjacent analysis artifacts in the same area when needed for dependencies/context.

Write the implementation spec to the requested destination, else `docs/specops/specs/<target-slug>.md`. Write its machine evidence plan beside it as `<target-slug>.evidence.json` and validate it with `spec-work-tour/scripts/validate-evidence-plan.mjs`.

Do not implement code while generating this spec.

## Generalization Rules

- Derive technology choices from project standards and repository evidence.
- If the stack is explicit (language/runtime/framework), tailor signatures, file layout, and tests to that stack.
- If stack details are ambiguous, state assumptions explicitly and provide the minimum viable default grounded in repo conventions.
- Prefer native/platform-standard APIs when they reduce complexity and align with standards.

## Required Output Sections

Every section is required. If not applicable, include the section with `N/A`.

### 1. Qualifications
List concrete technical domains required for this implementation (only skills actually needed for this target).

### 2. Problem Statement
In 2-4 sentences, frame the implementation gap from the analysis: required capability, current behavior/source approach, and what this implementation spec provides.

### 3. Goal
One sentence describing the concrete artifact produced when implementation is complete.

### 4. Architecture
Describe the proposed implementation structure:
- Files to create/modify with responsibilities.
- Key types/interfaces/contracts (use concrete syntax for the target language where appropriate).
- Platform/runtime-specific design decisions and rationale.
- Dependency map (internal modules and external packages/services).

### 5. Acceptance Criteria
Provide a numbered list of observable, automatable assertions:
- Trace each criterion to analysis contracts/invariants/failure modes.
- Group by concern (core behavior, error handling, concurrency, integration, etc.).
- Include edge cases and non-happy-path behaviors.

### 6. Executable Evidence Plan

Set the risk posture and define stable AC/CL/FH/EV traceability using the shared contract. Every analysis contract, invariant, and failure mode maps to a claim; every claim has a credible failure hypothesis and a gate capable of rejecting it. Name commands, artifacts, environments, independence, proof boundaries, merge/deploy blocking, and a single owner step. Include contract, real-seam integration, drift/conformance, operational, rollback, and QA-tour evidence as applicable. Human review and required manual QA are not gates.

### 7. Notes
Capture trade-offs, risks, ambiguities, migration concerns, and sequencing dependencies.

### 8. Implementation Steps
Provide a flat, numbered, sequential plan of deterministic engineering tasks.

For each step include:
1. What to do: exact files and required changes.
2. Why: tie to architecture or acceptance criteria.
3. Signatures/contracts: include public API shape when added/changed.
4. Tests: concrete automated test assertions and target test files.
5. Coverage: `Covers: AC-*` and exactly owned `Evidence: EV-*` tags.

## Implementation-Step Constraints

- Deterministic: avoid subjective instructions.
- Minimal: smallest verifiable unit of progress.
- Self-contained: executable in isolation by another engineer/context.
- Forward-only: target architecture only; avoid unnecessary compatibility layers unless explicitly required.

Do not include steps for:
- Manual testing as a correctness gate. Deterministic QA-tour output tied to automated gates is allowed.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting/lint-only chores.
- Git/PR process steps.

Ordering principle:
- Contracts and types first.
- Pure/domain logic next.
- Stateful and I/O modules after.
- Integration wiring and final verification tests last.

## Conventions

- Follow project standards strictly (`strict` typing, import conventions, error handling patterns, layering, etc.).
- Keep nullability and boundary validation explicit.
- Prefer discriminated unions or equivalent tagged variants for protocol/state transitions where relevant.
- Ensure operational correctness: shutdown behavior, resource cleanup, error propagation, observability hooks.
- Make every claim traceable to analysis evidence or clearly labeled as an assumption.

## Quality Bar

- Precision over brevity.
- Observable outcomes over implementation trivia.
- No hidden assumptions.
- Every major decision includes rationale and evidence.
- The adjacent evidence JSON passes the shared validator and contains exactly one owner step per EV item.
