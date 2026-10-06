# Ground Execution Cards And Publish The Package

Perform these transformations in exactly this order. They are deliberately sequential because later outputs bind earlier decisions.

### 1. Continue the same planning invocation

The `spec-write` entrypoint has resolved the canonical paths and resolved required preparation inputs
before editing. Continue with that context and the repository evidence already read;
do not restart discovery or delegate the whole preparation phase. Resolve remaining
unknowns at their owning boundary. Keep the current draft spec and indexes consistent.

### 2. Review and correct the spec

Ground the review in repository code. Read every existing file, type, function, API, pattern reference, and test named by the spec; new paths must be plausible beside verified precedent. Verify that critique Must Address recommendations landed or have explicit rationale.

For every `Visual: yes` step, resolve its visual source before judging the step ready:

1. Prefer an exact step-level `Visual reference: <file path>`, then a spec-wide
   reference, then the approved or selected reference named by `proposal.md` or
   `critique.md`.
2. When none is named and exactly one plausible entry file exists under the resolved
   feature's `prototype/` or `visual-references/` folder, use it and correct `spec.md`
   to name its repository-relative path. Never choose among multiple variants without
   repository or proposal evidence selecting one.
3. Confirm the entry file and its local assets exist. Inspect the source and, for HTML
   or application prototypes, render it with Playwright to identify the relevant page,
   component, visible heading or stable selector, states, interactions, and viewports.
   Playwright is the only browser automation and screenshot tool for this workflow.
4. When no prototype or reference design exists, identify an exact existing production
   component, route, Storybook story, or page as the visual precedent when possible.
   State honestly that no prototype exists; do not invent or silently substitute one.

Keep a resolved prototype or reference as the visual source of truth. Use it for visual
intent—composition, hierarchy, spacing, copy, states, and interactions—while using the
repository as authority for production components, tokens, architecture, semantics, and
accessibility, and the spec as authority for behavior and acceptance coverage. Identify
prototype-only fixtures, dependencies, shell UI, and fake interactions that production
must not copy.

Correct only substantive defects:

- Missing or non-substantive required sections.
- Ambiguous behavior, shapes, defaults, ordering, error handling, or side effects.
- Architecture that conflicts with real repository patterns or sourced project constraints.
- Unjustified flags, environment variables, compatibility layers, release mechanisms, or proof
  tooling. Remove obligations unsupported by actual users, retained data, scale, or release policy.
  Record the source and affected claim/gate mapping for each correction; do not accept real risks
  without a user or project-policy decision.
- Missing acceptance coverage or non-automatable criteria.
- Executable Evidence Plan defects: missing or invalid posture; incomplete AC → CL → FH → EV traceability; an EV item owned by no step or by more than one step; a gate that cannot reject its failure hypothesis; human review/manual QA used as a safety gate; or evidence forms, independence, environments, and deployment proof that do not fit actual risk.
- Pre-mortem defects: a missing pre-mortem, or a credible concern with no disposition (AC, step, EV item, or explicitly accepted risk).
- Steps that are not deterministic, minimal, self-contained, forward-only, or dependency ordered.
- Non-flat step numbering, mismatched `Covers:` tags, or incorrect complexity/visual flags.
- Steps large enough that independent concerns can be implemented and verified separately without a compatibility shim.

A `Visual: yes` step description is substantive only when its single front-loaded
sentence names the user-visible surface and outcome, the exact reference entry path and
relevant region or states when a reference exists, and the production seam or existing
primitives that will realize it. When no reference exists, name the exact production
precedent and relevant design posture instead. Correct vague descriptions such as
"implement the prototype" or "polish the page" before reconciling the step index.
Prefer a sentence like: `Implement the journal drawer's empty and save-pending states
shown in .specs/journal/prototype/index.html under "Journal drawer", reusing the existing
Drawer and form primitives and wiring the real journal query and mutation.`

Preserve intent and voice. Apply the entrypoint's step-granularity rules before writing cards. Split compound objectives rather than
hiding them in a longer card. Do not restyle a sound spec. Re-running preparation against unchanged inputs must converge without churn.

Apply the Reuse and Preparation sections of [Engineering Decisions](../../spec-work-tour/references/standalone-engineering-decisions.md).
Carry helper, shared-value, and component ownership into each affected card's `Targets`:
symbol, path, and reuse/extend action, or the new destination and reason. Reuse grounded
planning results; search only unresolved ownership. Do not add another report or inventory.
Verify material domain rules have sourced examples/counterexamples and AC/CL/FH/EV coverage;
verify deferrals preserve current acceptance and have concrete destinations. Existing equivalent
prose suffices. Correct missing behavior or proof, not headings. Ground database-derived behavior
at the database and boundary fixes at the exact boundary. Compare fixture setup with ordinary
invocation and include a default-path case for new test hooks/overrides or relevant discrepancies.
Put cases in the existing strict verification block and setup/proof limits in the owning card.
Reuse the production-composition gate when it already covers ordinary entry.

### 3. Reconcile the step index

`spec.md` is canonical. Rewrite `spec-steps.json` to contain exactly one entry per final implementation step, in ascending order, using the current strict step-index schema. Each entry's number, name, description, difficulty, visual-design flag, and evidence array must match the Markdown step. The top-level `spec` path must equal the repository-relative path in the `Spec folder:` footer.

Reconcile `evidence-plan.json` against the corrected spec. Preserve stable identifiers where their meaning survives. Correct posture, context path, claim/hypothesis/gate mappings, phase, required flag, command,
artifact, environment, effects, authority, independence and owner-step fields. Recalibrate in either
direction from sourced facts. Replace costly gates with equivalent safe proof or remove demonstrably
inapplicable obligations, recording why coverage remains sufficient. A genuine missing verifier
requires the smallest sufficient local solution or an explicit phase-specific gap, never invented
production operations. A prepared later-phase procedure may remain pending without blocking merge.

Run `node ~/.agents/skills/spec-work-tour/scripts/validate-evidence-plan.mjs <path>` once after final reconciliation. Any structural or traceability failure blocks publication.

### 4. Derive prose guardrails and invariants

Walk Architecture, Notes, and Implementation Steps for normative statements that constrain ownership, placement, layering, negative boundaries, or licensed deviations from precedent. A reuse decision that names an existing symbol as the owner of a behavior is an ownership constraint. Do not restate acceptance criteria that tests already own and do not invent constraints.

When at least one implementation guardrail exists, atomically write `criteria.md` with:

- The canonical spec source path.
- One stable heading per property.
- A `Statement:` field containing the implementation property in prose.
- A `Source:` field quoting or precisely locating the normative spec sentence.
- An `Applies to:` field classifying the property as `establish: step <N>`, `preserve: <steps>`, or `final completion`; combine classifications when needed.

`criteria.md` is implementer guidance, not an audit program. A final-completion property is not a demand that every intermediate step establish it; a named later step is a handoff, not a reason for the current worker to ask permission. It must contain no shell commands, grep recipes, expected search-hit sets, executable verdict instructions, audit modes, or audit result schema.

When cross-step or cross-phase ownership constraints exist, atomically update `invariants.md`. Keep established live entries, append new entries with their source and establishing step/phase, and retain a superseded entry only when a later spec explicitly licenses its replacement. Preparation and final review consume only live, non-superseded entries.

If no criteria or invariants apply, ensure the corresponding artifact is absent. Removal happens before subspec planning so the final file set is unambiguous.

### 5. Write difficulty-routed execution cards

Use each `spec-steps.json` entry's existing `difficulty` as the default preparation budget. Process the steps in ascending order in the same preparation invocation and write one canonical `step-<NNN>-subspec.md` execution card per step:

| Difficulty | Grounding budget | Card depth |
|---|---|---|
| `easy` | Verify named paths, modified public shapes, and an exact focused command. Do not survey callers. Use the bounded Reuse lookup for a missing target or unresolved ownership of a new helper, shared value, or component. | Minimal |
| `medium` | Read named symbols, their immediate integration seam, and the existing target test or nearest test file. | Grounded |
| `hard` | Inspect the relevant cross-module contracts, consequential callers/callees, and test architecture. | Detailed |

Difficulty bounds effort; it does not require delegation. A hard but explicit propagation can still be planned directly. Deepen any card only when repository evidence exposes a missing target, new public or ownership boundary, ambiguous acceptance behavior, unavailable focused verifier, architecture conflict, concurrency or migration risk, destructive data change, security boundary, or uncertain external runtime contract.

Visual grounding is required independently of difficulty. For every `Visual: yes` card,
inspect the resolved reference or production precedent, the actual production surface,
applicable design rules, the design-system primitives/tokens it should reuse, and the
existing Playwright configuration or nearest Playwright test. This is a bounded visual
handoff, not permission for a broad UI survey.

#### Bind runtime work to the requested composition boundary

For a library-only deliverable, its public exported entrypoint is the runtime composition; do not
require an unrelated consuming application. Apply the shared deliverable-boundary rule.

When a step's own objective or acceptance coverage promises runtime- or user-observable behavior through a controller, provider, command, service, or adapter, use the named targets and immediate integration seam already required by the difficulty budget to identify:

```txt
Production wiring: <runtime entrypoint or composition owner path/symbol>
Concrete adapter: <production implementation path/symbol for internal injected interfaces | none — direct production call>
```

Place these lines in `Targets`. Do not add a repository survey merely to populate them. Dependency injection may replace true external boundaries such as an editor/runtime API, process spawning, filesystem, clock, or network. It does not make a test-only internal interface a production implementation. Every required internal injected interface must have an existing concrete adapter or a named adapter target in the same step.

Include at least one focused verification case that traverses the real production composition through the concrete adapter to an observable result, while faking only the final external boundary. If the entrypoint, adapter, or downstream command/API contract required by this step is absent and the prepared step does not own its addition, correct the spec/step targets or return a non-ready verdict. A deliberately library-only precursor may defer wiring only when its own acceptance coverage is non-runtime and a named later step explicitly owns the integration; never use that exception for a step that itself promises reachable behavior.

#### Prepare focused risk cases

For every medium or hard card, add these two lines to `Setup and Hazards` using only the spec, guardrails, invariants, targets, and repository context already read for that card:

```txt
Risk lenses: <comma-separated labels | none>
Live invariants: <comma-separated invariant IDs | none>
```

Use only applicable labels from this fixed vocabulary:

- `persistence-integrity`
- `atomic-publication`
- `concurrency`
- `lease-or-refcount`
- `idempotency`
- `cancellation`
- `resource-budget`
- `progress-observer`
- `filesystem-snapshot`
- `cross-step-contract`
- `external-runtime`
- `security-boundary`

List only live invariants that the step establishes, consumes, or can violate through its named targets. Do not perform extra repository surveying, add commands, or expand a full adversarial boundary matrix merely to populate these lines. Turn credible risks into concrete cases and sufficient focused commands in the card's verification block, using the already-grounded behavior and invariants. Reuse cases that cover multiple obligations; do not add one test per label. Labels identify prepared risks and do not trigger routine execution-time expansion. Use `none` when no label or invariant applies.

Apply the shared Verification Scheduling And Deadlines policy when assigning commands.
Choose the strategy to fit the change. Cards retain exact focused commands and cases,
with execution stages in Setup: useful unit feedback for concrete implementation decisions/debugging,
focused integration
checks when a concrete acceptance/debugging decision needs them, and broad suites in
configured CI on authorized pushed checkpoints and final HEAD. Without CI, broad testing
is operator-managed outside agent evidence; do not make it a local-suite or completion gate.
Name each integration case's distinct boundary failure; keep rule permutations in unit tests
unless the boundary affects them. Include smoke procedures only for missing runtime evidence
and preserve visual observations. EV owners produce test sources, focused results, and remaining
handoffs; branch review consolidates valid focused/CI results and executes outstanding
focused checks. Preserve exact CI command ownership and final-revision binding.
Do not create an implementation step solely to repeat those checks.

Read the strict card schema and strategy/command guidance in
[spec-subspec-write](../../spec-subspec-write/SKILL.md) before writing cards; reading its
contract does not require delegation. Every card must contain strict `planning` and
`verification` blocks matching that contract. The parent validates step numbers, filenames, concrete targets, focused commands, and observable cases mechanically. It does not create a second prose copy of the verification contract or semantically re-judge an equivalent planner's work.

When a step carries an `Evidence:` tag in `spec.md`, add one line per owned EV item to `Targets`:

```txt
Evidence: EV-<n> — <artifact form> → <committed path | .specs/<feature>/evidence/<file>>
```

Committed evidence such as integration tests also appears as ordinary targets; non-committed artifacts (QA walkthrough, screenshots, dry-run logs, benchmark output) name their destination under `.specs/<feature>/evidence/`. Each card repeats the gate's phase, required flag, command, actual target/environment, effects,
authority source, rejected failure and proof boundary. Later-phase gates require a procedure and
handoff. Identify safe isolated pre-deploy checks separately from operations awaiting release or
authority; keep only unexecuted gates pending. Verify merge commands cannot accidentally target live
resources through environment files, setup/teardown or app startup. Do not invent evidence obligations the spec does not own.

Write targets and the edit sequence as the best expected route, never as an exhaustive file or permission whitelist. State in `Setup and Hazards` which criteria the step should establish now, preserve for later work, or may satisfy early even when another step was expected to own them. Treat applicable, authorized prepared verification as the execution plan. The implementation worker adds investigation or checks when actual code, a failure, or a material departure exposes a specific acceptance gap; it names that gap briefly. Do not routinely repeat architecture analysis or expand checks because a label is present.

For every `Visual: yes` card, include one of these exact lines in `Targets`:

```txt
Visual reference: .specs/<feature>/<prototype-or-visual-references>/<entry-file>
Visual reference: none
```

Use `none` only when preparation found no prototype or reference design. The edit
sequence must begin by inspecting the reference or named production precedent, not by
creating a new design direction.

After `Targets` and before `Edit Sequence`, add this compact conditional section:

```markdown
### Visual Implementation Brief

Relevant reference: <page/route plus visible heading, stable selector, states, and interactions | none>
Reference authority: <what must match; what prototype-only shell, fixtures, or dependencies to ignore>
Production surface: <route and component path/symbol>
Reuse: <existing components, tokens, and closest production precedent>
Behavior mapping: <prototype fixtures/interactions to real data, state, actions, and focus behavior>
UX obligations: <relevant loading/empty/error/partial states, feedback, keyboard/a11y, and responsive behavior>
Viewports: <named viewport sizes that expose the intended layout>
Playwright plan: <existing config/test, server or Storybook target, route/fixture, selectors, and screenshot paths>
```

Make every value concrete and step-specific; use `none` only when the item genuinely does
not apply. Storybook may provide the rendered target, but Playwright must drive it and
capture screenshots. The Playwright plan must use the smallest representative states and
viewports and must support rendering both the reference and production UI when the
reference is executable. Include an exact focused Playwright command and test file in the
strict verification block when the repository already has Playwright or the step owns the
smallest required Playwright setup. Non-visual cards omit the section.

When writing a card exposes independent objectives or unresolved consequential design
choices, revise the step decomposition first. Update the spec, index and EV ownership,
then regenerate cards affected by changed step boundaries or requirements. Preserve
stable AC/CL/FH/EV identifiers where meaning survives. For an unimplemented re-plan,
remove obsolete canonical `step-<NNN>-subspec.md` files only after preserving the prior
planning snapshot; never remove execution learnings or evidence. Retain unchanged cards when their targets and requirements still apply.

Correct locally resolvable problems directly. Accumulate spec corrections discovered while producing cards, update the spec/index/guardrails once, then regenerate only cards whose inputs or required behavior changed. A missing field or stale private symbol is a repair, not a blocker.

Use `spec-subspec-write` only when an escalation trigger remains unresolved after the bounded grounding above. The fallback leaf must return a compact card or identify the exact genuine blocker; the parent still owns all shared artifacts. Stop without publishing only for a required product decision, unavailable dependency, or irreconcilable spec/repository contract that cannot be resolved from local evidence.

#### Refine complexity once from prepared facts

After normal grounding, assess the remaining implementation judgment using the entrypoint's complexity rubric. In the same preparation invocation, request `step-difficulty` advice through the shared [Jev CLI/MCP contract](../../../scripts/jev/README.md). Submit compact facts already known from each card: objective, direct precedent (or its absence), settled contracts/ownership, remaining judgment (explicitly `none` when settled), failure consequences, and the credible mistakes focused evidence can expose or miss. Use the current planner tier. Batch up to eight relevant newly prepared or materially changed steps per request. Attempt the first eligible batch normally without a service-readiness probe. An unavailable response stops further advisory calls for this preparation invocation; use planner judgment for the rest. Do not repeatedly request unchanged steps, gather diffs or explore repository files merely to classify, add a classifier agent/stage, or call again at dispatch.

The result is advisory, not a model-quality guarantee. Consider each assessment separately; an uncertain sibling does not invalidate a usable assessment. Missing facts, unclear tiers, unavailable service or exhausted budget fall back immediately to planner judgment with no retries or implementation block. The tool preserves the supplied planner tier as a floor; do not lower a tier while concrete consequential judgment remains. A planner may independently correct an overestimate when normal grounding demonstrates a settled route, recording the short reason in existing preparation prose. Genuine medium/hard uncertainty favors hard. Intent or authority ambiguity still follows the existing planning-blocker route.

Update only the authoritative `Complexity:` tag and its `spec-steps.json` `difficulty` mirror when justified, before package validation. Retain completed grounding and valid cards; no repeat grounding, format migration, competing difficulty field or extra report is required. Put a useful advisory/fallback reason in the existing preparation row when it changes the routing decision. Preserve explicit owner overrides and stronger-owner capability.

### 6. Validate the complete package

After the last step, reread every final artifact. Confirm:

- Step numbers are exactly the ascending `spec-steps.json` numbers.
- There is exactly one canonical subspec per indexed step and no unexpected canonical step number.
- Every planning verdict is `ready`. Ignore obsolete `planning.spec_sha256` fields on retained cards; they do not require re-preparation.
- Every verification contract has concrete focused commands and observable cases, including
  applicable domain counterexamples, owning-boundary proof, and ordinary-entry behavior from
  the Engineering Decisions contract; accepted deferrals have a concrete handoff.
- Every ready card that promises runtime- or user-observable behavior names `Production wiring` and `Concrete adapter` targets and verifies one reachable production path.
- Every `Visual: yes` description names its user-visible surface and exact reference plus
  relevant region/states, or explicitly names the production precedent when no reference
  exists; `spec-steps.json` contains that same description.
- Every `Visual: yes` card records `Visual reference: <path | none>`, contains a complete
  `Visual Implementation Brief`, and names Playwright as its only screenshot mechanism.
- Every medium and hard card records canonical `Risk lenses` and `Live invariants` lines in `Setup and Hazards`.
- Every requirement maps to a claim, every claim to at least one failure hypothesis and gate, and every failure hypothesis to a gate capable of rejecting it.
- Every Executable Evidence Plan item is owned by exactly one step whose card and `spec-steps.json` entry carry matching evidence ownership and a concrete command, environment, artifact, independence level, rejected failure, and proof boundary.
- `evidence-plan.json.context.path` resolves to this package's required `context.md`.
- Context sources remain current; `evidence-plan.json` names the canonical `context.md`, and
  posture fits actual exposure with every increase or reduction justified; user-visible work has QA-tour output; no required gate depends on human review or manual QA; every pre-mortem item carries a disposition.
- Criteria contain prose `Statement` properties only.
- The context, report, spec, index, optional criteria/invariants, and all subspecs are complete before declaring readiness.

### 7. Write the report and publish last

Atomically write `spec-prepare.md` on every run. Include:

- Spec path and whether it changed.
- Review changes and rationale, or an unchanged verdict.
- Step-index reconciliation.
- Guardrails and invariant counts.
- Evidence posture and traceability counts; EV items with owning steps, rejected failure hypotheses, commands, artifacts, and the pre-mortem disposition summary.
- One row per step with difficulty, visual-reference summary, card depth, subspec path,
  verification strategy, and focused commands.
- Corrections/reruns and open blockers.
- Overall outcome: `prepared`, `decision-required`, or `blocked`.

If blocked or awaiting a merge-relevant decision, stop after the report. Do not declare a partial package prepared.

Declare the package prepared only when its required artifacts exist, indexed steps have exactly one canonical card each, and all cards have a `ready` verdict. Do not emit `preparation.json` or another fingerprint/manifest replacement. Discard a legacy `preparation.json` during re-preparation.

## Exceptional Deep-Planning Fallback

When an escalation trigger requires a `spec-subspec-write` leaf, its prompt must say, in substance:

- Plan only the assigned step and write only the assigned subspec.
- Read `spec-subspec-write` fully and obey it.
- Do not spawn or delegate to another agent.
- Receive and honor the sourced context snapshot and operational boundaries.
- Read only the named targets, immediate callers/callees, existing test precedent, AGENTS test guidance, and bounded new-code precedent allowed by the leaf skill.
- For a visual step, receive the parent's resolved `Visual reference` path or `none`,
  relevant reference region/states, production precedent, applicable design-rule paths,
  and Playwright context needed to produce the complete visual brief.
- Return one of `ready`, `needs-spec-correction`, or `blocked`; never silently improvise around a spec/code mismatch.
- Do not implement code or modify shared preparation artifacts.

Do not use fallback delegation for routine grounding, formatting, or validation work the preparation agent can complete directly.

## Output

Return `outcome: prepared` only after validating the required artifacts and ready cards, with `next: spec-run`.
For unresolved work return `decision-required` or `blocked` and do not claim readiness.
Report the canonical paths for `context.md`, `spec.md`, `spec-prepare.md`, `spec-steps.json`, `evidence-plan.json`, optional `criteria.md`/`invariants.md`, and each step subspec. State evidence posture and traceability counts, corrections, selected verification strategies, automation gaps, and whether the package is prepared.

Do not add attribution footers or co-author trailers.
