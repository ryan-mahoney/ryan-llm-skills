# Executable Evidence Contract

This contract governs the standalone spec lifecycle. Evidence, not human approval, is the merge authority. A person may supply product judgment, explore the QA tour, or challenge assumptions, but correctness and deployment safety cannot depend on a person noticing a defect in a diff.

## The Evidence Chain

Every material obligation follows one traceable chain:

```text
requirement -> claim -> failure hypothesis -> evidence gate -> result -> deploy verdict
```

- A **requirement** is an acceptance criterion, architecture invariant, or deployment obligation.
- A **claim** is a falsifiable statement asserted by the proposed or implemented system.
- A **failure hypothesis** names a credible way the claim could be false while superficial checks still pass.
- An **evidence gate** is an executable command or deterministic inspection capable of rejecting that failure.
- A **result** is a commit-bound outcome with an artifact and an honest proof boundary.
- The **deploy verdict** is derived from required gate closure, never confidence language.

Evidence is strong when it is relevant, falsifiable, reproducible, sufficiently independent, bound to the code under decision, and explicit about what it does not prove. Test volume, green badges, screenshots, and review prose are not inherently strong evidence.

## Evidence Posture At Intake

Set the posture before architecture or implementation planning. It may become stricter when discoveries increase risk. It may become weaker only through an explicit, recorded risk decision; convenience, schedule pressure, or missing tooling is not a justification.

Record:

- **Change types:** UI, client state, API, domain logic, data/query, schema/migration, auth/security, external integration, infrastructure/deploy, documentation/tooling.
- **Risk level:** low, medium, high, or critical, with rationale.
- **Boundaries crossed:** browser/server, controller/context, context/model, process/database, service/external API, build/runtime, migration/production data, permission/tenant.
- **Impact:** user-visible behavior, stored data, money, access, privacy, availability, irreversible side effects.
- **Reversibility:** easy, moderate, hard, or irreversible.
- **Uncertainty:** low, medium, or high; name novel or poorly understood parts.
- **Required evidence layers:** select from intent, structural, policy, data, server contract, client contract, interface, live path, security/privacy, operational, teardown.
- **Independence:** implementation assertion, separate oracle, adversarial audit, production-like environment, or another justified level.
- **Environments and artifacts:** exact runtime, fixtures, browsers/viewports, logs, screenshots, traces, migration copies, or deploy checks.
- **Merge and deploy gates:** which failures block merge, block deployment, or only reduce optional exploratory confidence.
- **QA mode:** automated, automated-with-exploration-output, or explicitly blocked by a missing automation boundary. Manual QA is never the hidden merge gate.

### Minimum posture by risk

| Risk | Minimum evidence |
|---|---|
| Low | Focused automated assertion at the changed boundary; static checks where relevant; clean integrated audit. |
| Medium | AC-level tests plus at least one real seam/live composition check; negative-path coverage; integrated audit; QA output for user-visible behavior. |
| High | Independent oracle or adversarial check; production-like data/runtime evidence; rollback and observability proof; clean integrated audit bound to HEAD. |
| Critical | High-risk requirements plus rehearsal or canary/gradual-deploy evidence, explicit fail-closed checks, recovery exercise, and no unresolved uncertainty in irreversible paths. |

The table is a floor, not an exhaustive recipe. A one-line permission change may be small in code and critical in impact.

## Full-Stack Evidence Layers

Use only applicable layers, but never omit a crossed boundary merely because another layer is green.

1. **Intent** — acceptance criteria and claim map prove the right problem is being solved.
2. **Structural** — imports, types, schemas, route registration, build graph, and static contracts are valid.
3. **Policy** — permissions, tenancy, validation, feature flags, and business invariants are enforced, including denied paths.
4. **Data** — queries, transactions, ordering, nulls, concurrency, migrations, rollback/forward-fix, and representative data shapes behave correctly.
5. **Server contract** — real route/handler/composition reaches the domain and persistence boundary and returns the promised contract.
6. **Client contract** — the production client calls the real contract and handles success, empty, loading, partial, error, stale, and permission states.
7. **Interface** — rendered UI is visually inspected at required viewports/states; accessibility and interaction assertions run where supported.
8. **Live path** — a normative journey crosses the actual production seams. Fakes may replace only the final external boundary.
9. **Security/privacy** — prohibited access, unsafe inputs, secret/PII leakage, and fail-closed behavior are exercised.
10. **Operational** — configuration, build, deploy, monitoring, performance, compatibility, and rollout behavior are demonstrated.
11. **Teardown** — cleanup, rollback, cancellation, retry/idempotency, and partial-failure recovery are demonstrated where relevant.

## Stage Responsibilities

- **Architecture:** sets the initial evidence posture, claims, failure hypotheses, and feasible proof strategy before selecting the design.
- **Architecture critique:** attacks both the solution and proof plan; adds failure hypotheses and rejects circular or irrelevant evidence.
- **Spec writing:** converts requirements into stable `CL-*`, `FH-*`, and `EV-*` identifiers and writes `evidence-plan.json`.
- **Preparation:** code-grounds the plan, checks ownership and feasibility, strengthens posture when reality demands it, and binds the evidence plan hash in `preparation.json`.
- **Step execution:** produces owned evidence, records exact commands/outcomes/artifacts/proof boundaries, and never claims more than observed.
- **Branch audit/refine:** independently evaluates every claim against the integrated diff, exercises cross-step and adversarial risks, and converges until no required gate or actionable finding is open.
- **Work tour:** assembles the claim ledger, evidence, QA walkthrough, architecture, and deployment case into commit-bound JSON and HTML.
- **PR publication:** verifies the pushed commit exactly matches a ready tour and passing final audit. The PR distributes evidence; it does not create safety through future review.

## Required Artifacts

```text
.specs/<feature>/
├── proposal.md
├── critique.md                         # when critique runs
├── spec.md
├── spec-steps.json
├── evidence-plan.json                  # posture + CL/FH/EV graph
├── spec-prepare.md
├── preparation.json                    # includes evidence-plan hash
├── criteria.md / invariants.md          # when applicable
├── step-<NNN>-subspec.md
├── step-<NNN>-learning.md               # command and evidence outcomes
├── evidence/                            # logs, captures, dry runs, reports
├── merge-evidence.md
├── merge-evidence.json                 # final claim/gate status bound to HEAD
├── reviews/branch-<i>-review.md         # independent integrated evidence audit
├── reviews/branch-<i>-fix.md
├── work-tour.json                      # final deploy verdict bound to HEAD
└── work-tour.html                      # architecture/evidence/QA tour
```

Specs created before this contract must be upgraded before they can produce a `ready` verdict. Do not invent evidence retrospectively from prose.

## `evidence-plan.json` Version 1

`spec.md` remains canonical for full prose. This sibling file is the strict traceability and routing index:

```json
{
  "version": 1,
  "spec": ".specs/feature/spec.md",
  "posture": {
    "risk": "medium",
    "rationale": "Crosses browser/server and changes stored state.",
    "changeTypes": ["UI", "API", "data/query"],
    "boundaries": ["browser/server", "context/model", "process/database"],
    "impacts": ["user-visible behavior", "stored data"],
    "reversibility": "moderate",
    "uncertainty": "low",
    "requiredLayers": ["intent", "data", "server contract", "client contract", "interface", "live path"],
    "independence": ["separate oracle", "integrated adversarial audit"],
    "environments": ["Bun test + test PostgreSQL", "browser at 1440px and 320px"],
    "qaMode": "automated-with-exploration-output"
  },
  "claims": [{
    "id": "CL-1",
    "statement": "Saving the form persists and redisplays the normalized value.",
    "requirements": ["AC-1", "AC-3"],
    "failureHypotheses": ["FH-1"],
    "gates": ["EV-1", "EV-2"]
  }],
  "failureHypotheses": [{
    "id": "FH-1",
    "statement": "The component test passes while the production route never reaches persistence.",
    "claims": ["CL-1"],
    "gates": ["EV-2"]
  }],
  "gates": [{
    "id": "EV-2",
    "kind": "live-path-test",
    "description": "Exercise the production route through the concrete model adapter.",
    "claims": ["CL-1"],
    "rejects": ["FH-1"],
    "ownerStep": 3,
    "command": "bun test app/test/integration/feature.test.js",
    "artifact": "app/test/integration/feature.test.js",
    "environment": "Bun test + test PostgreSQL",
    "independence": "real composition; final external boundary only may be faked",
    "mergeBlocking": true
  }]
}
```

Every requirement maps to a claim; every claim maps to a failure hypothesis and gate; every failure hypothesis is rejected by a gate; every gate has exactly one owner step. A gate description must say what unsafe implementation it can reject.

## QA Without A Manual Safety Gate

For user-visible work, produce QA output even when automation is complete:

- exact route or entrypoint and minimal setup
- deterministic fixtures or seeded state
- scenarios for ideal and non-ideal states
- expected observable results
- links to automated gates covering each scenario
- desktop/narrow captures and interaction/accessibility reports when visual
- known exploration-only questions that concern taste or product discovery, clearly separated from correctness

This lets a person tour the work without making their attention part of the safety system. When a behavior cannot yet be automated, the correct output is a blocking automation gap or a deliberately scoped QA artifact with an explicit risk decision—not an unlabeled “please test this” merge instruction.

## Anti-Patterns

- “Tests pass” with no requirement or failure mapping.
- Unit tests that manually construct an internal object which production never wires.
- Snapshots or screenshots used as the sole proof of domain/data correctness.
- An implementer grading its own ambiguous behavior with no separate oracle.
- A PR opened red because a human reviewer might catch the issue.
- Manual QA listed as required while the merge verdict says ready.
- Evidence generated before the final rebase or bound to a different SHA.
- Prose claiming rollback, security, accessibility, or deploy safety without an executable check or deterministic inspection.
- A work tour that hides failed commands, blockers, proof limits, or residual risk.
