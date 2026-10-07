# Engineering Decisions Through The Standalone Workflow

Apply this contract to standalone `spec-*` work, including direct stage invocations. It does not
change Design or SpecOps workflows. Use the existing artifacts and AC → CL → FH → EV graph;
do not introduce a second checklist, verdict, identifier system, or mandatory review stage.
Read the sections for the current stage and its handoff. A small change may need only a few
sentences and one existing gate. These are reasoning obligations, not document-size quotas.

## Reuse: One Owner Per Behavior

Every stage reads this section. Helpers written separately by isolated workers drift apart:
one copy gets a fix and the others keep the old behavior. Give each behavior one owner.

**Search by behavior, then confirm.** Before planning or writing a reusable function, type,
shared constant, UI component, parser, formatter, path builder, or similar helper, locate its existing owner. When the
turn exposes a semantic `code_search` tool, query the responsibility ("format a duration for
display", "build the feature worktree path"), not only a likely symbol name. Otherwise use exact
search (`rg`) for several plausible names, distinctive literals, and the API calls the helper
would make. Read each plausible hit before deciding. This is a bounded lookup, not a survey.

**Optional semantic search.** When the repository is opted in and the owner
`spec_search` tool is available, use one bounded semantic query for a genuine
behavioral discovery gap — query the responsibility, not a guessed symbol. Read
the returned candidate files before deciding. Fall back to exact `rg`/direct
reads for literals, symbols, and known files, and whenever search is disabled,
unenrolled, unavailable, busy or timed out. Empty or partial candidate results
are never absence. This uses no extra model conversation, and `spec_scout`
remains independent.

**A duplicate is the same responsibility under the same contract.** Textual similarity alone is
not duplication; two helpers that serve deliberately different contracts may coexist. Copying or
re-deriving another module's private helper is duplication, even when it matches a sibling
module's style. When an equivalent exists, reuse it, or extend it when the new need is a small
compatible generalization. Do not fork a second copy to avoid touching the original.

**Put shared helpers where the next search finds them.** A general-purpose helper — one with no
dependence on this feature's domain — belongs in the repository's existing shared location
(for example `src/lib/` or the package's `utils` module), exported under a name that states its
behavior. Keep a helper private to a feature module only when it is genuinely feature-specific.
Do not create a new shared location when one exists.

**Give shared values a domain owner.** Domain values, limits, configuration, and design
tokens used across surfaces belong in the existing owning module or token/config source.
Import or derive them there instead of copying them into pages, sections, or components.
Keep values local when their meaning is local; equal literals alone do not imply shared
ownership. Avoid a global constants file that couples unrelated domains.

**Contribute to shared UI.** Locate the existing component or primitive with the same
behavior before building a page-specific version. Compose it or add a compatible variant
in its owning component module, preserving existing callers and accessibility behavior.
When current consumers need a new shared component, place it in the established component
library; keep feature-specific composition local. Visual similarity alone does not justify
merging different behavior contracts or creating speculative component APIs.

**Preserve shared callers and safety contracts.** When changing a common helper,
test fixture, or process owner, inspect its nearest real callers and the relevant
ordinary/alternate modes at the affected revision. Identify what existing callers
must retain, including lifecycle and cleanup protection. Before adding a parallel
helper or lower-level path, locate the existing owner and its safety contract. For
example, process termination that validates both PID and start identity must not be
replaced by signalling a numeric PID after closing a handle; the PID may be reused.
Carry the owning symbol/path and these constraints into the editor's existing
`Edits`/`Preserve` packet, not a separate inventory.

A passing new-path test may exit before changed shared behavior is reached. Reuse
existing focused coverage of a representative unaffected caller/mode; if that path
has a concrete coverage gap, exercise the smallest existing test or add a focused
case that reaches it. For example, a discovery-only fake may pass while its ordinary
message emitter still calls a deleted helper. Schedule checks after coherent edits
under the shared verification policy, not per edit or through a broad suite.

Stage obligations:

- **Architecture and specification:** identify the relevant helper, shared-value, and component
  owners. State each reuse decision in Architecture prose ("format amounts with
  `formatMoney` in `src/lib/currency.ts`") so preparation can derive it as a guardrail.
- **Preparation:** for new helpers, shared values, or components, reuse grounded search
  results or make the bounded lookup above, whatever the step's difficulty. Name the symbol,
  path, and reuse/extend action in `Targets`; for a new owner, name its destination and why
  the nearest existing owner does not fit. No separate inventory or report is required.
- **Implementation:** carry these ownership decisions into the editor's existing `Edits`
  and `Preserve` fields. Search only for additions or uncertainties the card did not settle,
  using relevant prior `introduced` entries. Record new reusable symbols, including shared
  components, in the step's existing learning so later steps find them.
- **Step review:** check new or changed responsibilities against their named owners and a
  bounded precedent search at the reviewed revision. Confirm the same contract and concrete
  drift or maintenance harm before flagging a duplicate. Do not survey the whole repository
  or defer this check to a final branch audit. For shared helpers/fixtures, trace a
  representative existing caller and mode the new evidence does not reach. Check for
  deleted-but-still-called behavior and lower-level bypasses of lifecycle/identity
  protection. Report a concrete defect or material evidence gap through the existing
  finding schema; a passing new-path test does not discharge an unaffected contract.
- **Explicit branch audit and fix:** check both directions. A new helper may duplicate an existing one,
  and a changed helper may have copies that still carry the old behavior. When a fix corrects a
  helper's logic, search for copies with the same defect and correct or consolidate them, or
  record why they serve a different contract.

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

Choose granular steps with one coherent implementation objective and resolved consequential
decisions. Split independent behaviors and substantial integration boundaries; give each worker
explicit prior-step contracts and observable completion conditions. A useful prerequisite may
have its own bounded contract and a named later integration owner. Keep tightly coupled edits
together when splitting would require temporary scaffolding. Do not compress several objectives
into one step merely to produce a complete feature slice. Card-writing must revise boundaries
when it reveals hidden coordination work; ordinary local coding choices remain with the worker.

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
or comment on issues as a side effect of this contract. Preserve full briefs in internal records.
In the tour, explain the consequential limitation and next action directly. Include them in the
PR only when needed to assess the change; do not copy the entire brief or cite `.specs/` paths.
Never claim a local brief is already tracked in an external system.

## Preparation: Put Proof At The Owning Boundary

Check the rules and deferrals against current code and acceptance. Correct substantive omissions
through the normal preparation process before declaring the package prepared. A required counterexample
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
The PR explains the problem and resulting behavior, including a consequential rule, observation,
or follow-up only when it affects review. Use accessible shared references and explain needed
facts inline; do not narrate the workflow or cite uncommitted/local files. Neither artifact may
promote an internal-only slice or placeholder into a broader
completion claim. Publication remains subject to the existing authority and evidence gates.

## Resume And Upgrade

Equivalent existing prose and evidence satisfy this contract; headings and extra files are not
readiness requirements. On resume, check material coverage at the next owning stage. Return to
spec writing/preparation only for missing or contradicted behavior/proof, and rebind affected
artifacts normally. Preserve valid observations, commits, and settled decisions. No blanket
schema migration or replay of completed stages is needed.
