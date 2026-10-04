# Executable Evidence Contract

This contract governs the standalone spec lifecycle. Read the shared
[Project Context And Authority](../../spec-end-to-end/references/project-context.md) contract
at every entry point. Agents consume specs; people review evidence artifacts and supply product
and authority decisions. Correctness must not depend on a person noticing a defect in a diff.

For written output, read the relevant sections of [Engineering Writing](../../../rules/engineering-writing.md).
Preserve the full evidence contracts in agent/machine artifacts. Human-facing PRs,
commits, and tour explanations select and explain the facts their readers need;
they do not need to reproduce the evidence ledger. This changes presentation, not
the required checks, authority, or readiness verdicts.

## Evidence And Authority

Every material, applicable obligation follows one traceable chain:

```text
sourced requirement/context -> claim -> credible failure -> gate -> observed result -> phase verdict
```

- A **requirement** comes from requested behavior, a justified architecture invariant, or an actual
  project/deployment commitment. An agent-written requirement does not establish its own necessity.
- A **claim** is a falsifiable statement with an honest scope and a decision phase.
- A **failure hypothesis** names a credible way that claim could be false while superficial checks pass.
- An **evidence gate** is an executable check or reproducible deterministic inspection that can reject it.
- A **result** records the code revision, environment, observed outcome, artifact, and proof limit.
- A **phase verdict** follows the applicable required gates, never confidence language or test counts.

Relevance, independence, reproducibility, and proof limits matter more than volume. A second agent
is useful but is not by itself an independent oracle: expected results must come from sourced
requirements, real contracts, or independently derived properties, not copied implementation logic.
A validator proves artifact structure; the independent audit judges evidence truth and sufficiency.

## Context And Proportionality At Intake

Resolve `context.md` before choosing architecture or evidence. Record:

- **Change types:** UI, client state, API, domain logic, data/query, schema/migration, auth/security,
  external integration, infrastructure/deploy, documentation/tooling.
- **Risk:** low, medium, high, or critical, with actual exposure, data value, and credible harm.
- **Boundaries:** the relevant browser/server, process/database, external API, permission/tenant,
  build/runtime, or retained-data transitions; an inapplicable boundary creates no obligation.
- **Impact, reversibility, uncertainty:** what can be harmed, how recovery works in this project,
  and the specific unknowns that affect the decision.
- **Evidence layers and independence:** the smallest set that can reject the material failures.
- **Environments:** actual isolated targets, representative fixtures, and required artifacts.
- **Decision phases:** `merge`, `deploy`, or `post-deploy` for each claim and gate.
- **QA mode:** automated, automated-with-exploration-output, or blocked-automation-gap.

Recalibrate in either direction when facts change. Removing a gate requires a recorded explanation
that its obligation is inapplicable, superseded, or covered by equivalent proof, with source and
claim mapping. The owning planner updates and re-prepares the package; the independent audit
checks that no applicable requirement disappeared. A real residual risk needs acceptance from
current user instructions or sourced project policy. An agent's assumption, missing harness,
failed check, schedule, or desire for green output is not acceptance.

### Risk-matched evidence

| Risk | Evidence emphasis |
|---|---|
| Low | Focused assertion or deterministic inspection at the changed boundary; relevant static checks; independent integrated audit. |
| Medium | Observable acceptance coverage, a real composition/seam check where crossed, credible negative paths, and independent audit. |
| High | Independent oracle or adversarial evidence for the high-consequence failure; representative isolated data/runtime; recovery proof when retained state or availability is actually at risk. |
| Critical | High-risk proof plus isolated rehearsal and recovery/fail-closed checks for consequential irreversible paths; unresolved material uncertainty blocks the affected phase. |

These are decision criteria, not infrastructure recipes. A one-line permission change may be
high-risk; a schema edit over disposable fixtures does not demand a historical-data migration
program. No risk tier mandates production access, canaries, flags, or a new release mechanism.
Reuse the established release process; any required live observation belongs to its later phase.
Security, privacy, relevant accessibility, and protection of valuable data still apply to prototypes.

### Select enough proof, then stop

1. Name the credible failure and the observation that would reject it.
2. Reuse an existing focused test, fixture, real-composition check, or deterministic inspection.
3. Let one gate cover multiple claims/failures when it actually observes them.
4. Use a disposable script or isolated harness when sufficient; retain its source, inputs, and
   results for reproducibility. Add maintained regression tests when recurrence warrants them.
5. Add tooling or another verification layer only for a named material gap the existing evidence
   cannot close. Account for setup, maintenance, cost, and external effects.
6. Stop when applicable claims are supported and independent audit finds no material gap. Do not
   rerun unchanged checks or invent hypothetical failures to make the package look complete.

A missing safe verifier for an applicable claim remains a gap; it does not justify unsafe testing
or a weaker assertion. Escalate only the unresolved decision, while completing independent work.

## Maintained Test Value

When planning or changing tests, apply the [Unit Testing Guide](../../../rules/unit-testing.md).
Before adding a maintained case, inspect existing evidence and name the distinct failure it
detects or the concrete improvement in diagnosis or execution cost. Reuse sufficient evidence.
For a removal, identify retained equivalent protection or a sourced reason the obligation no
longer applies. Compare inputs, boundaries, assertions, and oracle independence. A passing
remaining suite and reduced test counts do not establish equivalence. Preserve uncertain cases.

Use existing plan, learning, and review prose. No per-test ledger, score threshold, new schema,
or separate audit stage is required. One test can cover multiple obligations, and one obligation
can need tests at different boundaries. Reassess temporary discovery tests before retaining them.

Reuse domain rule sources and identifiers, including existing SpecOps analysis when relevant.
Distinguish observed behavior from approved intent. Keep durable rule/evidence links in existing
domain documentation when they serve later changes, rather than only in feature-local state.
Do not create a parallel catalog or one-test-per-rule requirement. Loss of required protection
or circular evidence is a material gap; optional unrelated consolidation remains follow-up work.

## Bounded Refinement Completion

`spec-branch-refine` counts review → fix rounds, including the last fix pass. The
end-to-end default is one round when background step reviews cover every step's
commits, otherwise two. A clean review may finish earlier. At the cap, resolved
findings and passing required merge gates allow `verified-at-cap`, without a further
independent review of the last fixes. This is distinct from an independent audit pass.

For `spec-work-tour` and `spec-pr`, a current `reviews/refinement-completion.md` with
`outcome: verified-at-cap`, `evidence_verdict: proven`, and no unresolved findings replaces
the final independent-audit pass requirement. Validate its links to actual review/fix
records, terminal decisions, and final-commit gate results. Map completion to the tour's
existing `audit` fields (`verdict: pass`, final `commit`, completion `artifact`) as the
selected review process's completion, not independent post-fix review. Record the limit
and absence of that final review in `context.decisions` and `residualRisks`; use the
human-facing label Review. Preserve the earlier audit's real verdict and SHA.

Do not add a third review through a coordinator, tour, publisher, or resume. Later
material changes invalidate the completion record; report stale evidence rather than
resetting an exhausted budget. A new review budget needs a new user directive. Resolve
known rebases before refinement when possible. Unresolved defects, missing decisions,
failed required checks, and stale results remain blockers regardless of the round cap.

## Verification Scheduling And Deadlines

Read [Verification and Review](../../../rules/verification-and-review.md) for CI ownership,
early authorized draft publication, and the two Jev checkpoints. Configured required CI
remains a readiness gate. Without CI, broad testing is operator-managed outside agent
evidence and does not create a local suite requirement or completion blocker. Preserve
acceptance/security/tenant/data obligations and resolve known relevant failures.

### Select tests by what they establish

Coverage value and execution frequency are separate decisions. Build integration coverage
where it detects failures isolated tests cannot, without putting the full integration suite
in every edit cycle. Use affected focused tests when they inform concrete decisions,
debugging, or unresolved acceptance questions. A focused integration test may be the
smallest credible check for a boundary change; do not replace
it with mocks merely to call the result a unit test.

| Check | Distinct value | Default execution point |
|---|---|---|
| Unit | Rules, calculations, parsing, transformations, and edge-case permutations | Affected cases during implementation and fixes |
| Focused integration | Actual wiring, persistence, constraints, transactions, authorization, serialization, or process boundaries | When the changed boundary is ready; repeat after relevant fixes |
| Browser journey | Behavior that depends on the browser or a complete user workflow | The affected journey when needed for changed behavior |
| Broad regression | Interactions across the integrated branch | Configured CI on authorized pushed checkpoints/final HEAD; otherwise operator-managed outside agent evidence |
| Scale or real external service | Capacity or actual dependency behavior | Explicitly relevant work or the project's scheduled checks |

Classify by actual setup and dependencies, not filenames or framework labels. Inspect
script expansion and filter semantics: a test-name or tag filter may still load every file,
start the application, migrate a database, or build browser assets. Prefer explicit files
or supported project selectors that limit that work. Use the project's test map and commands
when present; otherwise inspect the nearest tests and relevant callers. Dependency-based
selection is a useful supplement, not proof that dynamic wiring has been covered.

### Add integration coverage economically

Name the boundary failure each new integration case detects. Extend existing tests,
fixtures, and harnesses; keep setup minimal, isolated, deterministic, and independently
selectable. Cover meaningful success and refusal/failure paths through real application
composition, faking only the final external boundary for that proof. Exercise rule and
input permutations at unit level unless crossing the boundary can change their outcome.
Do not duplicate the same matrix through context, API, UI, and browser layers by default.
Keep tests that establish distinct contracts even when their scenarios resemble each other.
Do not add tests that merely mirror implementation details or inflate test counts.

When a relevant test is expensive, measure setup and execution separately where practical.
Look first for unnecessary fixtures, production-cost hashing or retries, real waits, repeated
startup/build work, global state forcing serialization, and overly broad modules. Optimize
the test setup without weakening the behavior being proved. Do not refactor unrelated suites
or introduce a universal test runner as a prerequisite to ordinary feature work.

### Schedule feedback and final checks

Choose test-first or implementation-first to suit the change and project. Implementation
steps write useful tests and run focused checks when they inform concrete decisions,
debugging, or unresolved acceptance questions. Reuse sufficient valid observations. Batch coherent edits before running expensive checks. Broad regression,
coverage collection, and repository-wide static checks belong to configured CI. Branch
review consumes its results instead of duplicating those suites locally. Without CI or
outside publication scope, broad operator testing remains outside agent evidence; it does
not require a local full-suite run, new CI, or a completion blocker. Broad local diagnostics
require explicit user direction and remain local evidence.
Do not run them after every step or create a final implementation step just to duplicate review.

For runtime-facing work, observe the changed path in isolation. A focused test through real
application composition can supply that observation; do not require a second manual smoke
run proving the same behavior. Use a bounded local app/entrypoint smoke check when it adds
missing runtime evidence, and inspect startup/runtime errors. Reuse an existing app only
when it serves current code in the intended isolated environment. Preserve required visual
inspection; a passing test or startup alone does not prove the rendered result. Stop only
owned processes.

Preparation retains exact commands, cases, files, and EV ownership. In existing Setup/evidence
prose, record the failure covered, test layer, execution stage, setup cost when known, and
deadline. Do not add mandatory schema fields or guess runtimes. Steps record actual focused
results and hand off remaining checks. Use `pending` gates and `skipped` commands with reason
`deferred to CI` or `deferred to branch review` only for intentionally deferred work, never to conceal a failure.
Deferring final checks alone does not require a checkpoint; missing implementation or failed
required step verification does. For older cards, record a scheduling adaptation in learning
without rewriting immutable preparation or dropping acceptance obligations.

Configured CI owns broad final checks within authorized publication scope; otherwise
broad testing is operator-managed outside agent evidence. Review validates and reuses applicable step
or CI results and runs outstanding focused gates; the coordinator, reviewer, tour, and publisher do
not each launch the same suite. Deduplicate overlapping final commands and retain required
focused obligations and configured CI gates. Do not silently weaken acceptance or known
relevant failures to reduce cost. Explicit user direction supersedes older broad local
completion requirements; record actual hook results when they ran, not an invented pass.

Before overlapping expensive runs, check resource ownership and existing work. Follow project
concurrency limits; isolate databases, ports, temporary directories, and mutable caches by run.
Parallelize only when isolation and CPU/memory/connection capacity support it. Queue or reuse
an applicable run instead of competing with it; do not stop another agent's processes.

### Bound execution and reuse results

Use a 120-second wall-clock deadline for each focused verification command by default.
A known slower build, integration check, or final suite may use a longer finite deadline
chosen before launch from repository configuration or observed runtime; record the reason
and limit in card setup or execution learning. Enforce the limit with a process-level
runner deadline or an available timeout wrapper that terminates the owned process tree.
A tool's output-yield/poll interval or a per-test timeout is not a command deadline.
Disable test-runner watch mode for finite checks; app development servers may retain their
normal reload behavior. Bound app readiness and smoke interaction separately from the
long-lived server, then clean up owned processes. On timeout, terminate owned children, retain partial output, and
record elapsed time and failure. Diagnose setup, contention, or the failing case before
retrying; narrow the reproduction where possible. Do not silently extend the limit or rerun
an unchanged command without new diagnostic evidence. If unresolved, record a step checkpoint or review evidence finding and carry the
gap forward; a timeout never counts as a pass.

Record exact commands, scope/filter, elapsed time, deadline, outcome, and reason for any
rerun in existing learning/evidence prose. No new schema fields are required. Run the required
regression suite in configured CI on the final authorized pushed commit; otherwise defer
broad testing to the operator outside agent evidence. Do not substitute a broad local suite
or sweep of every covered file. Missing CI alone is not a completion blocker.
Earlier focused implementation feedback serves a different purpose and remains appropriate.
After fixes, rerun affected checks. Reuse results only after assessing changes to relevant
code, dependencies, configuration, fixtures, and environment. Shared foundations can
invalidate earlier evidence; use affected focused feedback and configured CI, with broad
local diagnostics only when explicitly requested. Preserve the original observed revision and explain continued applicability
to current HEAD rather than relabeling an old run as a new one. The current readiness record
still binds current HEAD. Audit may reproduce a gate for a named uncertainty, but a new stage
or commit hash alone does not require every suite. Stop when required checks pass and no
material uncertainty remains; keep nonblocking follow-ups under the project's delivery policy.

## Applicable Evidence Layers

Select layers for actual obligations; do not turn this list into required feature construction:

- **Intent/structure:** sourced acceptance, imports, types, schemas, registration, and build contracts.
- **Policy/security:** relevant validation, permissions, tenant boundaries, prohibited effects,
  secret/privacy handling, and denied paths. Test flags only when justified flags exist.
- **Data:** actual queries, transactions, ordering, concurrency, and preservation commitments.
  Fresh setup can be sufficient for disposable fixtures; retained data may need migration evidence.
- **Server/client/live path:** exercise real application composition through concrete internal
  adapters. Fakes may replace the final external boundary. This is an isolated runtime check,
  not a call to a live production service.
- **Interface:** inspect representative changed states/viewports; run relevant interaction and
  accessibility assertions. Screenshots do not prove domain or persistence correctness.
- **Operations/recovery:** verify the existing configuration/release/recovery paths affected by
  this change. Do not invent zero-downtime, rollback, or monitoring requirements for an absent system.

### Bind proof to the requested deliverable

For a library/package change, the public exported entrypoint and its real implementation can be
its complete composition boundary. Do not require an unavailable consuming application, invent an
adapter, or add infrastructure to prove behavior outside the requested deliverable. If the request
promises an application-integrated outcome, that wiring must be evidenced; do not silently narrow
it to library tests. Record explicit scope and proof limits in either case. Missing essential
source is an input blocker, not permission to invent it; a proposal may identify a discovery step
when the source is locally obtainable, but preparation cannot mark an essential unknown ready.

## Decision Phases

- **Merge:** implementation and evidence are sufficient for integration under the resolved context.
  Required merge gates and claims must pass; the selected independent review process must
  complete at current HEAD under the bounded-completion policy. Required relevant CI must
  pass on the final pushed commit for remote readiness where configured. Local-only/no-CI
  work records actual focused evidence and operator-managed broad testing outside its
  evidence; absence of CI does not block completion or require an unauthorized push/local
  suite. Pending configured required CI still blocks remote readiness.
- **Deploy:** the candidate meets the established deployment process's preconditions. Separate
  readiness (`ready`, `blocked`, `not-assessed`, `not-applicable`) from authorization. A deploy gap
  can coexist with merge readiness unless it also invalidates a merge claim; explain that dependency.
- **Post-deploy:** observations after an authorized release. Before release, record `pending` gates
  and unproven claims, not passed checks or merge failures. A later failure that also disproves an
  implementation claim invalidates that merge evidence; phase labels cannot conceal a known defect.

An implementation package has at least one merge claim. Every gate has `phase` and `required`. A claim's proof gates belong to the same phase; split a
compound claim spanning phases. Optional exploration cannot be the sole proof of a required claim.
A deployment procedure inspected before merge proves the procedure's content, not that deployment
or recovery occurred. Separate those claims. No phase verdict authorizes execution.

Operator-managed broad testing is outside the agent-required EV graph and readiness verdict.
Record its ownership and unobserved status in existing context/evidence prose; never mark it
passed or list its absence as a blocking gap. If an older package required a local full suite,
record the current user directive and route that broad check outside the required graph rather
than running it or fabricating evidence. This does not retire an acceptance criterion or waive
a known relevant failure; retain the focused proof needed for those actual obligations.

Every gate records its environment, effects (including setup/teardown), and authority source or
`isolated local execution`. For later unauthorized operations, record `not granted; decision required`
and keep execution pending. Do not run commands merely because they appear in an evidence plan.

## Stage Responsibilities

- **Intake/architecture:** resolve sourced context and consequential questions, choose minimal design
  and proportional proof together, and state justified omissions.
- **Critique:** challenge necessity, risk calibration, invented commitments, circular evidence, and
  whether a cheaper/safer gate proves the same claim.
- **Spec/preparation:** write and code-ground stable CL/FH/EV mappings, phase ownership and context
  bindings; correct excess as well as gaps. Preserve unresolved authority as a decision.
- **Execution:** write owned tests, run focused unit/boundary checks, and produce required runtime/visual evidence;
  hand off final checks and later-phase procedures without executing outside authority. Record exact outcomes
  and limits; return consequential decisions upstream.
- **Audit/refine:** reuse valid focused and final-commit CI results, execute outstanding focused gates, independently falsify claims, enforce context constraints, and close material
  merge findings. Verify later-phase status honestly without forcing premature execution.
- **Tour:** expose context, choices, omissions, proof, burden, and separate readiness/authority states.
- **PR:** explain the resulting change and material limits, linking accessible evidence when useful.
  Publish an authorized draft at a meaningful checkpoint to start CI. Require the current
  merge-ready evidence case and passing final-commit CI before ready status; publication
  does not merge, deploy, or authorize either action.

## Required Artifacts

```text
.specs/project-context.md               # shared project context in the primary repository
.specs/<feature>/
├── context.md                          # relevant sourced snapshot and decisions
├── proposal.md
├── critique.md                         # only when warranted
├── spec.md / spec-steps.json
├── evidence-plan.json                  # version 2: context + phase-aware CL/FH/EV graph
├── spec-prepare.md / preparation.json   # version 3 manifest binds context too
├── criteria.md / invariants.md          # only when applicable
├── step-<NNN>-subspec.md
├── learnings/step-<NNN>-learning.md
├── evidence/                            # source/inputs/results, captures and checks
├── merge-evidence.md / merge-evidence.json
├── reviews/branch-<i>-review.md / branch-<i>-fix.md
└── work-tour.json / work-tour.html      # version 2: separate decision states
```

Keep agent inputs compact; avoid re-explaining the same decision in every file. Machine indexes
are projections, not competing sources. Old packages must resolve context, classify phases, and
re-prepare before resuming implementation or publishing readiness. Reuse still-valid observations
with recorded provenance; do not invent missing facts or merely relabel a legacy deploy verdict.
The shared validator/renderer still accept version 1 for existing Design/SpecOps callers, with
legacy notices. That compatibility does not satisfy standalone version 2 input contracts or
authorize publication: preparation, execution and PR stages must check their required versions.

## `evidence-plan.json` Version 2

`spec.md` owns behavior and requirements; this file owns traceability and execution routing:

```json
{
  "version": 2,
  "spec": ".specs/feature/spec.md",
  "context": {"path": ".specs/feature/context.md", "sha256": "<64 lowercase hex characters>"},
  "posture": {
    "risk": "medium",
    "rationale": "Changes saved state in an isolated test of the existing runtime.",
    "changeTypes": ["API", "data/query"],
    "boundaries": ["process/database"],
    "impacts": ["stored data"],
    "reversibility": "easy",
    "uncertainty": "low",
    "requiredLayers": ["data", "server contract"],
    "independence": ["independent integrated audit"],
    "environments": ["local test database with disposable fixtures"],
    "qaMode": "automated"
  },
  "claims": [{
    "id": "CL-1", "phase": "merge",
    "statement": "Saving persists and redisplays the normalized value.",
    "requirements": ["AC-1"], "failureHypotheses": ["FH-1"], "gates": ["EV-1"]
  }],
  "failureHypotheses": [{
    "id": "FH-1", "statement": "The real route never reaches persistence.",
    "claims": ["CL-1"], "gates": ["EV-1"]
  }],
  "gates": [{
    "id": "EV-1", "phase": "merge", "required": true,
    "kind": "integration-test", "description": "Reject an unwired save route.",
    "claims": ["CL-1"], "rejects": ["FH-1"], "ownerStep": 1,
    "command": "bun test app/test/integration/feature.test.js",
    "artifact": ".specs/feature/evidence/save-result.txt",
    "environment": "local test database with disposable fixtures",
    "effects": "Creates and removes isolated test records; no external calls.",
    "authorization": "isolated local execution",
    "independence": "real composition and expected value from AC-1"
  }]
}
```

Every applicable requirement maps to a claim; every claim maps to a credible failure and required
same-phase gate; every failure has a rejecting gate. Links are reciprocal. Every gate has one owner
step. For a later-phase gate, that step owns the procedure, handoff, and any safe isolated pre-deploy
proof in its existing scope. It gains no authority for live operations. A gate can cover several claims; no one-test-per-identifier rule applies. Gate artifacts
contain actual observations when run, not only the test source. Keep unexecuted later operations `pending`; phase names route verdicts, not permission.

## QA And Human Review

For user-visible work, provide a compact tour: entrypoint, deterministic setup, representative
scenarios, expected outcomes, automated coverage, and inspected captures when visual. Optional
exploration concerns product discovery or taste, not an unlabelled correctness gate. Surface
consequential context and decisions in the tour because nobody is expected to read the spec.

Do not claim absolute proof beyond the recorded environment and observations. Missing material
coverage is a gap for its phase. Human authorization is a legitimate separate decision; human
code review or required manual testing is not a substitute for evidence.
