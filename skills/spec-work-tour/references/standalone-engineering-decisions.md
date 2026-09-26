# Engineering Decisions Through The Standalone Workflow

Apply this contract to standalone `spec-*` work, including direct stage invocations. It does not
change Design or SpecOps workflows. Use the existing artifacts and AC → CL → FH → EV graph;
do not introduce a second checklist, verdict, identifier system, or mandatory review stage.
Read the sections for the current stage and its handoff. A small change may need only a few
sentences and one existing gate. These are reasoning obligations, not document-size quotas.

## Architecture: Establish The Behavior Before The Mechanism

In `proposal.md`, state consequential domain rules in Constraints & Assumptions before choosing
components. Each rule needs its source, a concrete example or counterexample, and the boundary
that owns enforcement. Distinguish observed behavior from intended behavior; existing code can
demonstrate a bug rather than authorize it. Cite user/project decisions for consequential choices.

Ask these questions only where the changed behavior makes them relevant:

- **Identity and ownership:** In which scope is an identifier unique? Which layer owns the rule?
  Does a presentation-specific transformation have any consumer outside the presentation layer?
- **Absence and lifecycle:** Are missing, empty, deleted, stale, and failed distinguishable?
  What observation records removal when the system otherwise writes only changed values?
- **Boundaries and composition:** What happens exactly at the endpoint, on a duplicate, or when
  two valid operations are adjacent? Which ordering or units matter?
- **Visibility and failure:** What can an unauthorized caller infer from different responses?
  Is a fallback required by the contract, or would it hide a broken assumption?
- **Completion:** Which useful behavior is complete in this slice, and what can safely wait?

Resolve answers from the request, repository, and sourced context first. Ask the user only when
plausible answers materially change behavior, preservation, compatibility, or accepted risk and
the sources do not settle the choice. Do not turn the questions into a universal questionnaire.
Record unresolved consequential choices as `decision-required` before dependent work.

For example, adjacent report windows may need `[start, end)` so an event at 10:00 belongs to
exactly one window. That rule belongs in acceptance and query evidence even if the fix changes
one character. Do not generalize that convention to a product whose specified endpoints differ.

## Specification: Carry Decisions Into Acceptance And Scope

In `spec.md` Architecture, preserve the material rules with source, example/counterexample,
enforcement owner, and AC/CL references. Reuse an existing acceptance statement instead of
restating it or assigning a new kind of ID. Every changed material rule needs an observable AC,
a credible FH, and an EV capable of rejecting the counterexample. Use ordinary prose for
ownership constraints; preparation can derive `criteria.md` and live cross-step invariants.

Choose behavior-sized steps. Separate a prerequisite change when it has its own useful contract
and proof; do not split a feature into unconnected layers merely to produce small commits. A
consumer transition can be one step whose tests seed the dependency boundary and preserve the
public output contract. Substantial fixture work does not imply a large production change.

### Deferred Work

Use a compact **Deferred work** subsection in spec Notes only when work is actually deferred.
For each item state:

- what remains unsupported and its observable behavior now;
- why that limit is acceptable under sourced scope or an authorized risk decision;
- a concrete destination: a named later step/package, an existing issue, or a local follow-up
  brief in this subsection with an outcome and completion criteria;
- when to revisit it, and its responsible role if known. Do not invent a person or a commitment.

A deliberate permanent omission needs a rationale, not a fictitious follow-up. Temporary duplicate
code or transitional behavior needs a removal condition. An unmet current AC, security/data
obligation, or required merge claim remains a blocker; attaching an issue does not discharge it.
Narrowing accepted scope requires a sourced decision and re-preparation, not an implementer note.

Local follow-ups are sufficient when external issue creation is not authorized. Do not create
or comment on issues as a side effect of this contract. Because `.specs/` may be ignored, the
tour and authorized PR must reproduce actionable local follow-up briefs rather than expose only
an inaccessible file path. Never claim a local brief is already tracked in an external system.

## Preparation: Put Proof At The Owning Boundary

Check the rules and deferrals against current code and acceptance. Correct substantive omissions
through the normal preparation process before publishing the manifest. A required counterexample
belongs in an existing or new EV and in the owning card's strict `verification.cases`; no new
machine fields are required. Make expected results independent of the implementation under test.

- For database-generated values or query semantics, exercise actual persistence/query behavior
  in an isolated database. A hand-built struct or mocked repository cannot prove that calculation.
  Document non-obvious precedence/fallback behavior in the nearest test and point to its owner.
- For a boundary fix, observe the exact boundary as well as relevant neighboring cases. Prefer a
  focused regression that fails under the old behavior; a successful command alone is not proof.
- For changed consumers, provide representative dependency inputs and assert the externally
  visible output. Keep the promised production composition concrete.
- For runtime-facing work, compare test setup with normal startup/invocation. If tests inject a
  private assign, override, preloaded association, registration, or initializer absent in ordinary
  use, plan a case with that convenience absent. Fixtures may supply domain data and safe external
  substitutes; they must not manually supply missing internal wiring. Cover the default path for
  any new test hook or override. Record the entrypoint, ordinary setup, permitted substitutions,
  and observation in the existing Targets, Setup and Hazards, and verification blocks.

One existing focused test may satisfy both composition and ordinary-entry proof. This is not a
requirement to deploy, run a live service, invent a browser for a library, or add a second harness.
When no relevant setup discrepancy or override exists, name why the existing path suffices.

Select existing static checks for recurring mechanical rules. A new maintained check needs a
demonstrated recurring failure and a bounded maintenance cost; do not install a linter per spec.
Any safety-check suppression needs its exact scope and a reason grounded in the actual operation.

## Implementation: Inspect Generated Choices And Ordinary Execution

When generators or bulk transformations are used, record the command and inspect their choices:
required fields, defaults, query/tenant scope, identifiers, relationships, error behavior, and
unneeded public operations. Correct only relevant mismatches with the domain rules. Keep generated
and deliberate changes distinguishable; use separate commits when repository policy requires it.
Otherwise a short learning entry and a coherent diff suffice. Do not add a scaffold-only step.

Review defensive branches against actual reachable states. Remove protection against impossible
internal states when the invariant establishes impossibility; retain validation at real trust
boundaries and required fallbacks. Do not weaken behavior simply to shorten a diff.

Execute the owning-boundary and ordinary-entry cases. If a test helper supplies something normal
execution lacks, fix production setup or make the helper genuinely optional, and prove the path
without it. Record this observation, permitted fakes, and proof limits in the step learning under
the existing EV. Reuse adequate observed evidence; do not duplicate runs for ceremony.

Workers keep prepared artifacts immutable. Report newly discovered scope/deferral decisions in
learnings and return required intent changes for correction and re-preparation. Coordinators
carry accepted follow-ups into merge evidence; they never treat a learning as risk acceptance.

## Critique And Branch Audit: Challenge With Counterexamples

Use the domain questions above to challenge consequential assumptions with a specific input,
state transition, caller, or interleaving. Explain which promise it breaks and whether current
evidence rejects it. Question the specification too: an implementation and its tests can agree
on the same mistaken rule. Route consequential intent corrections to the owning planner.

Retain material challenges and their resolution in existing critique/review prose: assumption,
counterexample, code or requirement evidence, and disposition. No quota or invented objections.
Accept a sourced explanation when the counterexample is inapplicable. Cite that explanation so a
later pass does not reverse it without new evidence. Concrete defects use the existing finding
schema and verdict rules; unanswered questions must not become an unparsed parallel blocker.

Check ordinary-entry evidence for test-only prerequisites, database evidence for actual database
execution, and deferrals for real destinations and consistent current behavior. A missing test
that leaves a material merge claim unsupported is an evidence finding, not merely an advisory
test-style suggestion. A proposed cleanup that changes justified behavior is not a correction.

## Assembly, Tour, And Publication

In merge-evidence prose, carry the important rule/example → gate/result links, material review
decisions, ordinary-entry observation and limits, and accepted deferred-work briefs. Reuse
existing JSON fields: claims/gates for proof, QA scenarios for entrypoints, architecture decisions
for rationale, and context omissions for accepted scope limits. Do not add schema keys.

The tour exposes these through `architecture.decisions`, `qa`, gate `proof`/`boundary`, and
`context.omissions`. Put deferred outcome, current limitation, destination, revisit condition,
and acceptance source in the omission text. Keep unmet merge obligations in `gaps`.
The PR summarizes consequential rules and observed evidence and reproduces follow-up destinations
or briefs. Neither artifact may promote an internal-only slice or placeholder into a broader
completion claim. Publication remains subject to the existing authority and evidence gates.

## Resume And Upgrade

Equivalent existing prose and evidence satisfy this contract; headings and extra files are not
readiness requirements. On resume, check material coverage at the next owning stage. Return to
spec writing/preparation only for missing or contradicted behavior/proof, and rebind affected
artifacts normally. Preserve valid observations, commits, and settled decisions. No blanket
schema migration or replay of completed stages is needed.
