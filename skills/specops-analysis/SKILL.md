---
name: specops-analysis
description: This skill should be used when the user asks for a SpecOps analysis of existing systems, modules, services, or workflows to produce a comprehensive implementation-language-agnostic specification.
disable-model-invocation: true
argument-hint: "[target-scope (optional)]"
---

# SpecOps Analysis

Perform a SpecOps analysis that extracts an implementation-language-agnostic specification from existing artifacts. The output should be detailed enough for reimplementation, migration, modernization, or architecture review.

If `$ARGUMENTS` is provided, treat it as `TARGET_SCOPE`.
If `$ARGUMENTS` is not provided, infer `TARGET_SCOPE` from the request and repository context.

Analyze all relevant evidence for `TARGET_SCOPE`, including source code, tests, docs, configs, schemas, runbooks, and operational artifacts when present.

When ambiguity exists, explicitly call it out. Do not silently infer intent.

## Required Output Sections

Produce a markdown document with all sections below. If a section has no supporting evidence, include it and write `None identified`.

### 1. Purpose & Responsibilities
- Problem solved and system role.
- Core responsibilities and accountability.
- Explicit boundaries and non-goals.
- Applicable architectural pattern (gateway, adapter, orchestrator, transformer, etc.).

### 2. Public Interfaces & Entry Points
Cover all externally consumable entry points:
- Exports (functions/classes/constants).
- API routes, RPC methods, CLI commands.
- Event handlers, queue consumers, jobs, hooks, stream interfaces.

For each interface include:
- Name.
- Purpose.
- Inputs: names, shape/type, optionality, semantic meaning.
- Outputs: shape/type, meaning, async/sync behavior.
- Error and failure surfaces.

### 3. Data Models & Structures
For each significant data structure:
- Name and purpose.
- Fields: type, optionality, semantic meaning, valid ranges/enums.
- Lifecycle: creation, mutation, disposal.
- Ownership and cross-boundary usage.
- Serialization/persistence format and concerns.

### 4. Behavioral Contracts
- Preconditions and postconditions.
- Invariants.
- Ordering, idempotency, atomicity guarantees.
- Concurrency model and race-condition handling.
- Test-backed expectations and noteworthy gaps.

### 5. State Management
- In-memory state (caches, queues, counters, singleton state).
- Persisted state (DB/files/remote stores), schema and read/write patterns.
- Shared/distributed state and consistency expectations.
- Crash/interruption outcomes and recovery behavior.

### 6. Dependencies
#### 6.1 Internal Dependencies
- Internal modules/services and exact usage.
- Dependency style (hard, injected, callback/plugin, runtime lookup).
- Coupling and replaceability.

#### 6.2 External Dependencies
- Third-party libraries/services.
- Capabilities used and where.
- Replaceability and encapsulation depth.

#### 6.3 Runtime & Environment Assumptions
- Filesystem layout and permissions.
- Config/environment variables and required defaults.
- Network dependencies and external APIs.
- OS/runtime/process assumptions.

### 7. Side Effects & I/O
Catalog observable external interactions:
- Filesystem.
- Network.
- Process management.
- Logging, metrics, tracing.
- Scheduling and timer behavior.

For each interaction: sync/async characteristics and failure handling.

### 8. Error Handling & Failure Modes
- Error categories.
- Propagation strategy.
- Recovery, retry, fallback, fail-fast behavior.
- Partial-failure state and rollback/cleanup strategy.
- Visibility to operators/end users.

### 9. Integration Points & Data Flow
- Upstream callers/triggers.
- Downstream consumers/dependencies.
- Data shape transformations.
- Primary control-flow paths and decision points.
- Participation in broader system patterns.

### 10. Edge Cases & Implicit Behavior
- Defaults that materially alter behavior.
- Implicit ordering/timing assumptions.
- Feature flags and environment-specific branches.
- Compatibility shims, hacks, TODO/FIXME paths.
- Surprising or contradictory behavior.

### 11. Open Questions & Ambiguities
- Undocumented policy decisions.
- Magic numbers/thresholds without rationale.
- Potential dead code or contradictory logic.
- Unknowns that require stakeholder clarification.

## Formatting Guidelines

- Use prose for narrative analysis and tables for structured contracts.
- Name entities exactly as they appear in artifacts.
- Describe `WHAT` the system does and `WHY` it matters; avoid language-specific implementation guidance.
- Name known design patterns and describe the concrete local application.
- Add an `Evidence` subsection in each major section with file references.

## Quality Bar

- Prioritize precision over brevity.
- Separate observed facts from inferred interpretation.
- Mark confidence when evidence is weak or indirect.
- Use tests as evidence, not as sole truth.
