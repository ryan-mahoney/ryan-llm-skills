---
name: specops-refactor-plan
description: This skill should be used when the user asks to create a refactor-focused SpecOps plan for a specific source folder and explicit refactor goal.
disable-model-invocation: true
argument-hint: "[target-folder] [refactor-goal]"
---

# SpecOps Refactor Plan

Perform a refactor-focused SpecOps analysis for existing source artifacts. The output should preserve current behavioral contracts while producing a decision-complete refactor plan for a defined scope and goal.

Input handling:
- If `$ARGUMENTS` is provided, parse the first token/group as `TARGET_FOLDER` and the remainder as `REFACTOR_GOAL`.
- If `$ARGUMENTS` is not provided, infer both from user request and repository context, and restate both explicitly in assumptions.

Evidence scope:
- Use `TARGET_FOLDER` as the primary evidence boundary.
- Include adjacent dependencies only when required for correctness.
- When using out-of-scope evidence, justify why it is necessary.

Analyze relevant artifacts for `TARGET_FOLDER`, including source code, tests, docs, configs, schemas, and operational signals when present.

When ambiguity exists, explicitly mark uncertainty. Do not silently infer business rules or policy intent.

Do not implement code while generating this plan.

## Required Output Sections

Produce a markdown document with all sections below. If a section has no evidence, include it and write `None identified`.

### 1. Purpose & Responsibilities
- Problem addressed and system role.
- Core responsibilities.
- Explicit boundaries (what it does not do).
- Architectural pattern, if applicable (gateway, adapter, orchestrator, transformer, etc.).

Evidence:
- Cite concrete files and symbols supporting this section.

### 2. Public Interfaces & Entry Points
Document all externally consumable interfaces:
- Exported functions/classes/constants.
- API routes, RPC methods, CLI commands, jobs, queues, events, stream messages, hooks.

For each interface:
- Name.
- Purpose.
- Inputs: parameter names, shape/type, optionality, semantic meaning.
- Outputs: shape/type, semantic meaning, async behavior.
- Failure modes and how they surface.

Evidence:
- Cite concrete files and symbols supporting this section.

### 3. Data Models & Structures
For each meaningful structure:
- Name and purpose.
- Fields: type, optionality, semantic meaning, allowed values/ranges.
- Lifecycle: creation, mutation, disposal.
- Ownership and boundary crossing.
- Serialization/persistence concerns.

Evidence:
- Cite concrete files and symbols supporting this section.

### 4. Behavioral Contracts
- Preconditions and postconditions.
- Invariants.
- Ordering/idempotency/atomicity guarantees.
- Concurrency behavior and race-condition handling.
- Behavioral expectations visible in tests, and notable untested behaviors.

Evidence:
- Cite concrete files and tests supporting this section.

### 5. State Management
- In-memory state (caches, queues, counters, singletons).
- Persisted state (DB/files/remote stores), schema and access patterns.
- Shared state and consistency model.
- Crash/interruption implications and recoverability.

Evidence:
- Cite concrete files and data stores supporting this section.

### 6. Dependencies
#### 6.1 Internal Dependencies
- Internal modules/services used.
- What is consumed from each.
- Dependency type (hard, runtime lookup, plugin, injected).
- Coupling and replaceability.

#### 6.2 External Dependencies
- Third-party libraries/services.
- Specific capabilities used.
- Replaceability assessment.

#### 6.3 Runtime & Environment Assumptions
- Filesystem layout/permissions.
- Config and environment variables.
- Network/services/ports/API assumptions.
- OS/runtime/process assumptions.

Evidence:
- Cite concrete dependency declarations and runtime usage points.

### 7. Side Effects & I/O
Catalog external interactions:
- File system.
- Network.
- Process management.
- Logging/metrics/tracing.
- Scheduling/timers/retries.

For each: sync/async behavior and error handling.

Evidence:
- Cite concrete call sites and wrappers.

### 8. Error Handling & Failure Modes
- Error categories.
- Propagation strategy.
- Recovery and retry behavior.
- Partial-failure outcomes and rollback/cleanup.
- Operator and end-user visibility.

Evidence:
- Cite concrete error paths and observable outputs.

### 9. Integration Points & Data Flow
- Upstream triggers/callers.
- Downstream consumers/dependencies.
- Data transformations across boundaries.
- Control-flow paths and key decision points.
- Role in broader system patterns.

Evidence:
- Cite concrete pathways, interfaces, and integration boundaries.

### 10. Edge Cases & Implicit Behavior
- Defaults that materially affect behavior.
- Timing/ordering assumptions.
- Feature flags and environment-specific branches.
- Workarounds, compatibility shims, TODO/FIXME/hack paths.
- Surprising or contradictory behavior.

Evidence:
- Cite concrete branches, defaults, and comments.

### 11. Open Questions & Ambiguities
- Policy decisions encoded without rationale.
- Magic numbers/thresholds lacking context.
- Potential dead code or contradictory behavior.
- Any assumptions required due to missing evidence.

Evidence:
- Cite unresolved areas and missing artifacts.

### 12. Refactor Objectives
- Desired outcomes tied to `REFACTOR_GOAL`.
- Explicit non-goals and protected behavior.
- Success criteria for maintainability/performance/reliability/readability as applicable.

Evidence:
- Cite current pain points and constraints from artifacts.

### 13. Proposed Refactor Strategy
- Structural approach (module boundaries, dependency direction, layering changes).
- Sequencing plan (safe order of changes).
- Minimal compatibility tactics required during transition.

Evidence:
- Cite why each strategy choice fits observed constraints.

### 14. Risk & Regression Surface
- Behavioral regression risks.
- Operational and performance risks.
- Concurrency/state integrity risks.
- Risk rating and mitigation per item.

Evidence:
- Cite contracts/tests/operational signals that indicate risk.

### 15. Compatibility & Migration
- Public API/contract stability expectations.
- Required migration steps for callers or operators.
- Rollout constraints and fallback strategy assumptions.

Evidence:
- Cite interface usage and dependency reach.

### 16. Validation Plan
- Automated tests/checks needed to prove no unintended behavior drift.
- Mapping from risks/contracts to concrete validation.
- Required comparison checks between pre-refactor and post-refactor behavior.

Evidence:
- Cite existing tests and specify gaps requiring new tests.

## Formatting Guidelines

- Use prose for narratives and tables for structured fields (interfaces, parameters, models, risk matrix, validation mapping).
- Name concrete entities exactly as found in source artifacts.
- Distinguish clearly between:
  - `Observed Current State`
  - `Proposed Refactor Decisions`
- Describe behavior as `WHAT` and `WHY`, not language-specific implementation details.
- Name design patterns when relevant and explain local application.
- Include an `Assumptions` section that explicitly restates `TARGET_FOLDER` and `REFACTOR_GOAL`.

## Quality Bar

- Favor precision over brevity.
- Distinguish observed behavior from inferred intent.
- Call out confidence level where evidence is weak.
- Treat tests as behavioral evidence, not absolute truth.
- Produce decision-complete guidance suitable for follow-on implementation spec generation.
