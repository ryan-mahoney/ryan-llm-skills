---
name: specops-analysis
description: This skill should be used when the user asks for a SpecOps analysis of existing systems, modules, services, or workflows to produce a comprehensive implementation-language-agnostic specification, including explicit and implicit business rules, decision logic, defaults, thresholds, workflow constraints, and user-visible policies enforced by the system.
disable-model-invocation: true
argument-hint: "[target-scope (optional)]"
---

# SpecOps Analysis

Perform a SpecOps analysis that extracts an implementation-language-agnostic specification from existing artifacts. The output should be detailed enough for reimplementation, migration, modernization, architecture review, policy review, or legacy-system understanding.

If `$ARGUMENTS` is provided, treat it as `TARGET_SCOPE`.
If `$ARGUMENTS` is not provided, infer `TARGET_SCOPE` from the request and repository context.

Analyze all relevant evidence for `TARGET_SCOPE`, including source code, tests, docs, configs, schemas, runbooks, migrations, fixtures, seeds, job definitions, telemetry hooks, user-facing text, and operational artifacts when present.

When ambiguity exists, explicitly call it out. Do not silently infer intent.

## Analysis Expectations

Prioritize understanding **what the system does**, **what rules it enforces**, and **what behaviors it makes possible, required, expensive, or impossible**.

Actively identify explicit and implicit rules that function as policy, including:

- business rules
- validation rules
- defaults with material behavioral impact
- quotas, thresholds, limits, and caps
- eligibility criteria
- access restrictions and authorization rules
- workflow gates and ordering constraints
- status-transition rules
- timing assumptions, retry windows, and expiration behavior
- fallback behavior that changes outcomes
- technical constraints that users experience as policy

Distinguish where possible between:

- documented policy
- code-enforced policy
- technical constraint mistaken for policy
- legacy behavior
- accidental or emergent behavior

Use concept-location techniques to find behavior relevant to domain concepts across code, tests, schemas, config, validation messages, feature flags, logging, analytics, docs, and user-facing copy.

Use tests, fixtures, runtime artifacts, and call sites as evidence of expected behavior, but do not treat tests as sole truth.

Separate **observed facts** from **inferred interpretation**. Mark confidence when evidence is weak, indirect, contradictory, or incomplete.

## Required Output Sections

Produce a markdown document with all sections below. If a section has no supporting evidence, include it and write `None identified`.

### 1. Purpose & Responsibilities

- Problem solved and system role.
- Core responsibilities and accountability.
- Explicit boundaries and non-goals.
- Applicable architectural pattern (gateway, adapter, orchestrator, transformer, policy engine, validator, workflow coordinator, etc.).
- Key domain concepts the module or subsystem appears to own.

### 2. Public Interfaces & Entry Points

Cover all externally consumable entry points:

- Exports (functions/classes/constants).
- API routes, RPC methods, CLI commands.
- Event handlers, queue consumers, jobs, hooks, stream interfaces.
- Scheduled triggers and background entry points.

For each interface include:

- Name.
- Purpose.
- Inputs: names, shape/type, optionality, semantic meaning.
- Outputs: shape/type, meaning, async/sync behavior.
- Error and failure surfaces.
- Policy or rule implications visible at the interface boundary.

### 3. Data Models & Structures

For each significant data structure:

- Name and purpose.
- Fields: type, optionality, semantic meaning, valid ranges/enums.
- Lifecycle: creation, mutation, disposal.
- Ownership and cross-boundary usage.
- Serialization/persistence format and concerns.
- Fields that act as flags, policy toggles, thresholds, counters, status markers, or workflow gates.

### 4. Behavioral Contracts

- Preconditions and postconditions.
- Invariants.
- Ordering, idempotency, atomicity guarantees.
- Concurrency model and race-condition handling.
- Test-backed expectations and noteworthy gaps.
- Conditions under which behavior changes materially.

### 4A. Decision Logic, Business Rules & Policy Surface

For each significant rule or policy-like behavior include:

- Rule statement in plain language.
- Classification: business rule, operational policy, security/access policy, workflow policy, validation rule, technical constraint, or de facto policy.
- Status: explicit/documented, implicit/inferred, legacy, accidental, or unclear.
- Trigger/conditions and boundary values.
- Outcome/enforcement behavior.
- Exceptions, overrides, bypass paths, or privileged flows.
- Affected actors, workflows, or downstream systems.
- User or operational impact.
- Evidence and confidence.

Examples of rules to look for:

- maximum or minimum counts
- required sequences of steps
- eligibility filters
- hidden defaults
- lockouts and cooldowns
- required timing gaps
- retry caps
- deduplication behavior
- allowed status transitions
- feature-flagged branches
- tenant, role, or account restrictions

### 4B. Policy Tests & Behavioral Scenarios

For significant rules, provide scenario-based checks that would confirm or falsify the rule:

- positive case
- negative case
- boundary case
- exception/override case
- ambiguous or conflicting case

For each scenario indicate whether it is:

- directly evidenced by artifacts
- strongly implied but untested
- missing and recommended for validation

### 5. State Management

- In-memory state (caches, queues, counters, singleton state).
- Persisted state (DB/files/remote stores), schema and read/write patterns.
- Shared/distributed state and consistency expectations.
- Crash/interruption outcomes and recovery behavior.
- State that materially influences policy enforcement or behavioral branching.

### 6. Dependencies

#### 6.1 Internal Dependencies

- Internal modules/services and exact usage.
- Dependency style (hard, injected, callback/plugin, runtime lookup).
- Coupling and replaceability.
- Dependencies that appear to supply rules, configuration, entitlements, or policy decisions.

#### 6.2 External Dependencies

- Third-party libraries/services.
- Capabilities used and where.
- Replaceability and encapsulation depth.
- Whether policy or rule behavior is delegated to the dependency.

#### 6.3 Runtime & Environment Assumptions

- Filesystem layout and permissions.
- Config/environment variables and required defaults.
- Network dependencies and external APIs.
- OS/runtime/process assumptions.
- Environment-specific branches that change functional behavior.

### 7. Side Effects & I/O

Catalog observable external interactions:

- Filesystem.
- Network.
- Process management.
- Logging, metrics, tracing.
- Scheduling and timer behavior.
- Notifications, emails, webhooks, and other outward signals.

For each interaction include:

- purpose
- sync/async characteristics
- triggering conditions
- failure handling
- whether it is part of rule enforcement, auditability, or recovery

### 8. Error Handling & Failure Modes

- Error categories.
- Propagation strategy.
- Recovery, retry, fallback, fail-fast behavior.
- Partial-failure state and rollback/cleanup strategy.
- Visibility to operators/end users.
- Whether errors block, defer, bypass, or silently alter policy enforcement.

### 9. Integration Points & Data Flow

- Upstream callers/triggers.
- Downstream consumers/dependencies.
- Data shape transformations.
- Primary control-flow paths and decision points.
- Participation in broader system patterns.
- Where rules are introduced, transformed, enforced, or observed across boundaries.

### 10. Edge Cases & Implicit Behavior

- Defaults that materially alter behavior.
- Implicit ordering/timing assumptions.
- Feature flags and environment-specific branches.
- Compatibility shims, hacks, TODO/FIXME paths.
- Surprising or contradictory behavior.
- Behavior that users or operators would likely experience as policy even if not documented as such.

### 11. Open Questions & Ambiguities

- Undocumented policy decisions.
- Magic numbers/thresholds without rationale.
- Potential dead code or contradictory logic.
- Unknowns that require stakeholder clarification.
- Behaviors that appear to be implementation artifacts but may be governing real workflows.
- Questions of legitimacy: intended rule, historical carryover, or accidental constraint?

## Formatting Guidelines

- Use prose for narrative analysis and tables for structured contracts.
- Name entities exactly as they appear in artifacts.
- Describe `WHAT` the system does and `WHY` it matters; avoid language-specific implementation guidance.
- Name known design patterns and describe the concrete local application.
- Add an `Evidence` subsection in each major section with file references.
- Where useful, include a `Observed` and `Inferred` split.
- Prefer declarative rule statements over code-shaped paraphrases.
- When identifying policy-like behavior, describe the human, workflow, or operational consequence.

## Quality Bar

- Prioritize precision over brevity.
- Separate observed facts from inferred interpretation.
- Mark confidence when evidence is weak or indirect.
- Use tests as evidence, not as sole truth.
- Surface implicit policy, accidental constraints, and de facto rules, not just documented behavior.
- Do not confuse storage limits, defaults, ordering constraints, or UI caps with neutral implementation detail when they materially regulate system use.
