---
name: spec
description: This skill should be used when the user asks to "write a spec", "create a spec", "spec this out", "plan this feature", or "write an implementation plan" for a feature or change. Creates a structured implementation spec and writes it to a GitHub issue.
disable-model-invocation: true
argument-hint: "[issue-number (optional)]"
---

# Spec

If an issue number is provided ($ARGUMENTS), write the spec into the body of that existing GitHub issue. If no argument is provided, create a new GitHub issue with the spec.

## Pre-Step — Reconcile Prior Critique Feedback

Before writing the spec, check the conversation history for output from the `architect-critics` skill (a critique document with "Expert Perspectives," "Synthesis," and "Recommendations" sections, or a `CRITIQUE-*.md` file).

### Match the correct critique to this spec

Multiple unrelated critique files may exist. Do not blindly apply every critique you find. Match by:

1. **Feature/proposal name** — the critique title (e.g., `CRITIQUE-user-onboarding.md`) should clearly correspond to the feature this spec covers.
2. **Conversation proximity** — if the critique appeared in the current conversation thread, it is the intended input.
3. **Referenced source** — the critique document includes a "Reviewing:" line pointing to the proposal file or conversation topic. Cross-reference that against the current analysis.

If no matching critique is found, skip this pre-step and proceed directly to writing the spec. If multiple critiques seem relevant, reconcile each independently.

### Triage each recommendation by scope and relevance

Once the correct critique(s) are identified, reconcile pragmatically:

| Priority | Action |
|---|---|
| **Must Address** — flaws that will cause real problems if shipped | Incorporate into the spec's architecture. If a recommendation changes a core decision, update the design and document the rationale. |
| **Should Address** — meaningful improvements, not showstoppers | Address in the spec if the scope of the feature makes it natural to include. Otherwise, record in the Notes section as a known follow-up with a brief rationale for deferring. |
| **Consider** — polish/refinement | Note in the Notes section only if relevant. Skip if out of scope. No need to address every consideration. |

### Reconciliation principles

- **Be pragmatic, not exhaustive.** Not every critique point needs to be addressed. A critique explores possibilities; the spec commits to decisions. It is acceptable to acknowledge a valid concern and consciously defer it.
- **State your reasoning.** When deferring a critique recommendation, write one sentence in Notes explaining why (e.g., "deferred — adds complexity disproportionate to current load," "out of scope for this feature, tracked as follow-up").
- **Don't over-engineer to satisfy hypotheticals.** If an expert raised a scalability concern that only matters at 100x current traffic, it is valid to acknowledge it and not design for it yet.
- **Resolve tensions with project context.** Where experts disagreed, pick the side that fits the actual team size, timeline, and system maturity — and state why.
- **Converge, don't accumulate.** The spec should read as a coherent plan, not a list of compromises. Integrate accepted changes naturally into the architecture.

Apply the reconciled decisions when writing the Architecture, Notes, and Implementation Steps sections below.

---

Based on the current analysis (and any reconciled critique feedback), create a markdown spec with the following sections.

## Required Sections

Every section is required. If not applicable, include the heading with "N/A".

### 1. Qualifications
List concrete technical domains required for this implementation (only skills actually needed).

### 2. Problem Statement
In 2-4 sentences: what capability is missing or broken, what the current behavior is, and what this spec addresses.

### 3. Goal
One sentence describing the concrete outcome when implementation is complete.

### 4. Architecture
- Files to create or modify, with responsibilities.
- Key types, interfaces, or contracts (use concrete syntax for the project's language).
- Design decisions and rationale.
- Dependency map (internal modules, external packages/services).

Design for current requirements, not imagined future ones. Start simple — boring technology, explicit boundaries. Understand how data moves before deciding on components. Fail fast on invalid inputs; no defensive fallbacks unless explicitly required.

Avoid: abstractions with only one use, abstract layers "for future flexibility," complex patterns without matching problem complexity, optimizations without measured need.

Aim for: data flow explainable in under 5 minutes, each component with a clear single responsibility, explicit failure modes, trade-offs stated with rationale.

### 5. Acceptance Criteria
Numbered list of observable, automatable assertions:
- Group by concern (core behavior, error handling, edge cases, integration).
- Include non-happy-path behaviors.
- Each criterion should be testable without subjective judgment.

### 6. Notes
Trade-offs, risks, ambiguities, migration concerns, and sequencing dependencies.

For each significant trade-off, state: why this approach, what we're giving up, what we're gaining, and alternatives considered.

### 7. Implementation Steps
Flat, numbered, sequential list of deterministic engineering tasks.

For each step include:
1. What to do: exact files and the changes required.
2. Why: tie to architecture or acceptance criteria.
3. Signatures/contracts: public API shape when adding or changing interfaces.
4. Tests: concrete automated test assertions and target test files. Test behavior, not implementation. Focus on edge cases and failure modes.

#### Step Constraints

- **Deterministic:** No subjective instructions ("improve", "clean up", "refactor as needed").
- **Minimal:** Smallest verifiable unit of progress.
- **Self-contained:** Executable in isolation by a separate engineer or LLM context.
- **Forward-only:** Target architecture only. No unnecessary compatibility layers.

#### Step Ordering

- Types and contracts first.
- Pure/domain logic next.
- Stateful and I/O modules after.
- Integration wiring and verification tests last.

#### Exclude from Steps

- Manual testing or QA checklists.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting or lint-only chores.
- Git workflow or PR process steps.

## Conventions

- Fail fast on invalid inputs; no defensive fallbacks unless explicitly required.
- Contextual error messages: what failed, what was expected, how to fix.
- Propagate errors, don't suppress — let them surface.
- Keep nullability and boundary validation explicit.
- Prefer discriminated unions or tagged variants for state/protocol transitions where relevant.
- No abstractions until three uses; no cargo cult patterns.

## Quality Bar

- Simple over clever: boring, maintainable code beats clever optimizations.
- Build for today: current requirements only, not imagined futures.
- Precision over brevity.
- Observable outcomes over implementation trivia.
- No hidden assumptions — state them explicitly.
- Every major design decision includes rationale.

Do not implement the plan.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
