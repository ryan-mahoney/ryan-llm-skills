---
name: spec-architect-critics
description: "Independently review an architecture proposal after spec-architect-initial. Catch evidence-backed omissions, correct mistaken assumptions, and simplify design and verification while preserving the requested outcome."
mode: coding
scope: document
disable-model-invocation: true
license: MIT
metadata:
  version: "10"
---

# Spec Architect Critics — Independent Architecture Review

Improve the proposal's chance of delivering the requested outcome with a small, predictable design and sufficient, affordable verification. Catch consequential omissions and mistaken assumptions before implementation. Removing unnecessary machinery and confirming a sound proposal are useful outcomes; there is no finding quota.

Check material claims against project sources rather than accepting the proposal's assertions as evidence.

## 1. Establish the outcome and context

- Resolve an explicit package ref or folder first, otherwise the package named in the conversation. Run the shared [spec-location step](../spec-end-to-end/references/spec-location.md): `node ~/.agents/scripts/spec-location/cli.mjs check --authoring <ref or folder>`. On refusal, report its `message` and `remedy` and stop. Read `proposal.md` from `package_dir` in the returned `locations`. Stop on ambiguity; do not guess by modification time.
- For a directly supplied architecture document or conversation plan, review that material without inventing a spec package.
- Read the proposal fully, applicable `AGENTS.md`, sourced `context.md`, and relevant project context. Identify the requested outcome, acceptance obligations, explicit exclusions, existing owners, actual exposure, and consequential unknowns. Distinguish user/project requirements from assumptions introduced by the proposal.
- Apply [Minimal Implementation](../../rules/minimal-implementation.md), the Critique And Branch Audit section of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md), and the [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). For evidence recommendations, apply the value rubric in [Unit Testing](../../rules/unit-testing.md) and scheduling policy in [Verification and Review](../../rules/verification-and-review.md). Follow [Engineering Writing](../../rules/engineering-writing.md) for the critique.

Preserve the promised behavior, security, accessibility, and protection of valuable data. A smaller diff that misses the root cause or transfers complexity to callers is not a better design. De-risking can require adding missing behavior; do not silently narrow the outcome to save code.

## 2. Investigate before recommending

Trace the affected flow and check the few project facts that could change the design: callers, enforcement boundaries, existing helpers, platform guarantees, and relevant tests. Reuse sourced discoveries from the proposal, independently checking consequential or doubtful claims. Keep searches bounded to the changed behavior and its real dependencies.

For a suspected defect, establish:

1. The supported input, state transition, caller, or interleaving that triggers it.
2. The requirement or contract it violates and the concrete consequence.
3. Why that condition is reachable in this project, including any mechanism that already prevents it.

An external input rejected at its trust boundary does not justify checks at every internal layer. A future deployment topology or unsupported operating mode does not establish present exposure. Conversely, no previous incident is needed to identify a conflict with an explicit requirement or a demonstrated defect in a reachable code path.

Resolve factual unknowns with a targeted read or small isolated probe when authorized and useful. Inspect before building a harness. If a consequential fact remains unavailable, record `decision-required` with the missing fact, why it changes the design, and the smallest next investigation or user decision. Keep it separate from implementation recommendations; uncertainty does not authorize a fallback subsystem. Nonconsequential unknowns do not block planning.

## 3. Apply two complementary lenses

Use **simplicity and change economy** plus the **most relevant domain-correctness lens** (for example, ownership and data integrity, API contracts, or UI state and accessibility). Apply both to the same project evidence, then produce one deduplicated set of findings.

Named practitioners are optional when their documented work adds a useful insight or the user requests expert perspectives. Verify a relevant primary source before attributing a position, distinguish your application from their published claim, and cite it briefly. Otherwise use the lenses directly. Do not spend the review researching biographies, simulating personas, inventing quotations, or manufacturing disagreement.

Look for material improvements:

- **Outcome and correctness:** Does the ordinary entrypoint deliver the promised behavior? Are domain rules and changed boundaries coherent? Does a proposed deferral leave a usable slice? Challenge consequential assumptions with applicable counterexamples.
- **Necessity and ownership:** Can an existing owner, helper, standard library, platform guarantee, or installed dependency satisfy the requirement? Prefer the smallest coherent correction at the owning boundary. Remove duplicate enforcement, speculative extension points, unnecessary configuration, and abstractions without a present responsibility.
- **Predictability and cost:** Does the proposal add modes, state transitions, dependencies, coordination, or recovery behavior whose cost exceeds the risk it addresses? Compare build, verification, operation, and maintenance burden. Suggest one simpler sufficient alternative, not a catalog of redesigns.
- **Proof value:** Which plausible wrong implementation would each proposed check reject? Does existing evidence already cover it? Prefer focused checks at real boundaries, independent expected results, and reuse of fixtures. One check can cover several claims. Recommend another test or layer only for a named material gap; preserve unique protection when simplifying evidence.

Do not impose a checklist of scale, compatibility, rollout, recovery, or deployment concerns where the project has no such commitment. Check applicable evidence now; leave detailed CL/FH/EV construction to spec writing. Preserve merge/deploy/post-deploy distinctions and authorization limits. Broad suites remain with CI or the operator under the shared policy.

## 4. Ground and triage findings

Retain the risk tags consumed by `spec-write`. Tag each material risk or proposed guard once in its finding, with its basis:

- `observed` — cite an incident, failing run, repository defect with a concrete reachable counterexample, or sourced requirement/contract. State whether this is an observed failure or a preventive correction required by that contract; do not imply an incident occurred. A proposal or earlier critique cannot serve as its own authority.
- `design-enforced` — cite the existing or proposed mechanism and its owning file/symbol or proposal section. Do not add a second guard for the same condition. If the mechanism is new or changing, retain focused proof of its promised behavior; the label is not proof that unfinished code works.
- `hypothetical` — applicability or harm is unsupported by project facts. It does not become an invariant, acceptance criterion, test, gate, lock, or recovery path. Omit irrelevant hypotheticals. If a previously raised concern needs disposition, record briefly why it warrants no implementation and what concrete change would make it relevant.

Missing or uncited grounding cannot justify added defensive machinery. Rare but reachable high-consequence failures can matter; frequency alone neither proves nor dismisses risk. Do not classify an unresolved security, retained-data, or acceptance obligation as an accepted hypothetical. Real residual risk needs user or sourced-policy acceptance; unresolved consequential intent returns as `decision-required`.

For each actionable finding, record the trigger and consequence, project evidence, smallest sufficient correction, and focused verification impact. For additions, explain why existing mechanisms are insufficient and why the protection is worth its implementation and maintenance cost. For removals, show that the obligation is inapplicable or remains covered. Requirements justify outcomes, not every proposed mechanism.

Rank only findings that survive this check:

- **Must Address:** a demonstrated conflict with an applicable requirement, concrete correctness/safety defect, or material proof gap that must be resolved before the affected implementation proceeds. Confidence of tone and expert agreement cannot establish this priority.
- **Should Address:** a grounded improvement within scope with a clear net benefit. Nonblocking; state the tradeoff so spec writing can decide.
- **Consider:** a relevant optional refinement worth retaining. Do not fill this category with generic advice or turn it into a required backlog.

Zero findings is valid in every category. Record genuine decisions separately; do not promote unanswered questions to Must Address fixes. Stop when material claims have been checked, actionable findings are grounded, and consequential unknowns have a bounded next action. Do not expand the search merely to fill sections.

## 5. Write the handoff once

Write a concise, standalone `critique.md` in the resolved `package_dir`. For a supplied document outside the pipeline, write `CRITIQUE-[name].md` beside that source; for conversation-only material without a supplied output location, return the critique in the response. Do not modify the proposal, create another approval stage, or generate extra review artifacts.

Use these sections, omitting empty optional sections:

```markdown
# Architecture Critique: [Feature]

> Reviewing: [source and revision when available]
> Date: YYYY-MM-DD

## Assessment
[Requested outcome, whether the proposal supports it, and the material corrections
needed. State when no changes are needed. Briefly name the two lenses.]

## Recommendations
### Must Address
[Findings, or None.]
### Should Address
[Findings, or None.]
### Consider
[Include only when useful.]

[Each finding appears once: trigger and consequence; grounding tag and project
source; smallest sufficient correction; verification impact and material cost.
Reference existing requirement/claim IDs where available.]

## Decisions Required
[Only consequential unresolved facts or intent: what is unknown, affected decision,
and the smallest investigation or decision needed. Do not prescribe speculative code.]

## Retained Design and Dismissed Concerns
[Only choices worth preserving or previously raised concerns whose sourced resolution
will prevent rework. Include real accepted risks with their acceptance source;
unfounded hypotheticals create no implementation or acceptance obligation.]
```

Use sibling filenames or package-relative references for package artifacts. Write files atomically with a level-1 heading on line 1. Report `outcome: critiqued`, output path (or inline), Must/Should/Consider counts, any consequential `decision-required` items, and `next: spec-write`. Completion of the critique does not resolve outstanding decisions; spec writing must reconcile them before committing to affected work.
