---
name: specops-initial-plan
description: This skill should be used when the user asks to create an initial SpecOps plan or to extract a comprehensive implementation-language-agnostic specification from an existing codebase, module, subsystem, service, or workflow.
disable-model-invocation: true
argument-hint: "[target-scope (optional)]"
---

# SpecOps Initial Plan

Perform a SpecOps analysis to extract a comprehensive, implementation-language-agnostic specification from existing code and related artifacts. This output is intended to be authoritative for future reimplementation, migration, or system redesign.

If `$ARGUMENTS` is provided, treat it as `TARGET_SCOPE`.
If `$ARGUMENTS` is not provided, infer `TARGET_SCOPE` from user request and repository context.

Discover and analyze source artifacts relevant to `TARGET_SCOPE`, including code, tests, configs, schemas, and docs.

When details are ambiguous or missing, explicitly mark uncertainty. Do not silently infer business rules.

## Required Output Sections

Produce a markdown document with all sections below. If a section has no evidence, include it and write `None identified`.

### 1. Purpose & Responsibilities
- Problem addressed and system role.
- Core responsibilities.
- Explicit boundaries (what it does not do).
- Architectural pattern, if applicable (gateway, adapter, orchestrator, transformer, etc.).

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

### 3. Data Models & Structures
For each meaningful structure:
- Name and purpose.
- Fields: type, optionality, semantic meaning, allowed values/ranges.
- Lifecycle: creation, mutation, disposal.
- Ownership and boundary crossing.
- Serialization/persistence concerns.

### 4. Behavioral Contracts
- Preconditions and postconditions.
- Invariants.
- Ordering/idempotency/atomicity guarantees.
- Concurrency behavior and race-condition handling.
- Behavioral expectations visible in tests, and notable untested behaviors.

### 5. State Management
- In-memory state (caches, queues, counters, singletons).
- Persisted state (DB/files/remote stores), schema and access patterns.
- Shared state and consistency model.
- Crash/interruption implications and recoverability.

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

### 7. Side Effects & I/O
Catalog external interactions:
- File system.
- Network.
- Process management.
- Logging/metrics/tracing.
- Scheduling/timers/retries.

For each: sync/async behavior and error handling.

### 8. Error Handling & Failure Modes
- Error categories.
- Propagation strategy.
- Recovery and retry behavior.
- Partial-failure outcomes and rollback/cleanup.
- Operator and end-user visibility.

### 9. Integration Points & Data Flow
- Upstream triggers/callers.
- Downstream consumers/dependencies.
- Data transformations across boundaries.
- Control-flow paths and key decision points.
- Role in broader system patterns.

### 10. Edge Cases & Implicit Behavior
- Defaults that materially affect behavior.
- Timing/ordering assumptions.
- Feature flags and environment-specific branches.
- Workarounds, compatibility shims, TODO/FIXME/hack paths.
- Surprising or contradictory behavior.

### 11. Open Questions & Ambiguities
- Policy decisions encoded without rationale.
- Magic numbers/thresholds lacking context.
- Potential dead code or contradictory behavior.
- Any assumptions required due to missing evidence.

## Formatting Guidelines

- Use prose for narratives and tables for structured fields (interfaces, parameters, data models, enums).
- Name concrete entities exactly as found in source artifacts.
- Describe behavior as `WHAT` and `WHY`, not language-specific implementation details.
- Name design patterns when relevant and explain the local application.
- Add an `Evidence` subsection per major section with file references.

## Quality Bar

- Favor precision over brevity.
- Distinguish observed behavior from inferred intent.
- Call out confidence level where evidence is weak.
- Treat tests as behavioral evidence, not absolute truth.
