# Integrated Evidence Audit And Work Tour

The standalone spec workflow does not depend on human code review. Its final authority is a commit-bound chain from requirement to falsifiable claim, credible failure hypothesis, executable gate, observed result, the selected review mode, and phase-specific verdict. Operational authority remains a separate sourced decision.

`spec-branch-refine` alternates `spec-branch-review` and `spec-branch-fix` until the implementation and its evidence are proven or the loop is honestly blocked. A proven pass hands off to the explicit `spec-work-tour` stage, which emits the required machine verdict and HTML tour. A PR distributes that case; it is not where safety is expected to emerge.

`spec-end-to-end` coordinates these stages after `spec-run`, checks each handoff, and invokes
`spec-pr` after the tour is ready. See the [workflow guide](spec-workflow.md) for starting, resuming,
and delegating a run. Compact worker reports do not replace the evidence package or this audit.

## Test Execution

Steps run their prepared focused acceptance checks after coherent implementation and
record actual revisions, results, and proof limits. They hand off outstanding final
focused checks to branch review. The reviewer reuses applicable step/CI evidence and
executes remaining focused gates for concrete gaps. Configured CI owns broad suites;
without CI, broad testing remains operator-managed outside agent evidence and does not
block completion. After a fix, rerun affected checks; coordinators consume results.

## Artifact Package

```text
.specs/<feature>/
├── context.md                          # sourced project facts, decisions and authority
├── proposal.md
├── critique.md                         # optional challenge stage
├── spec.md
├── spec-steps.json
├── evidence-plan.json                  # version 2: context + phased AC/CL/FH/EV graph
├── spec-prepare.md
├── criteria.md                         # optional prose guardrails
├── invariants.md                       # optional live invariants
├── step-<NNN>-subspec.md               # immutable execution card
├── learnings/
│   └── step-<NNN>-learning.md          # command/evidence outcomes and later-step handoffs
├── evidence/                            # captures, logs, dry runs, QA inputs
├── merge-evidence.md
├── merge-evidence.json                 # pre-audit results bound to HEAD
├── blockers.md                          # when applicable
├── reviews/
│   ├── branch-<i>-review.md             # independent evidence audit
│   └── branch-<i>-fix.md
├── work-tour.json                      # version 2: separate merge/release states
└── work-tour.html                      # architecture/evidence/QA tour
```

`.specs/` is usually gitignored. All reads and writes stay in the primary repository;
pass its canonical path to workers and never copy the package into a worktree.
New step learnings go in `learnings/`. Readers accept historical root-level learning
files when no folder copy exists; existing evidence paths remain unchanged.

## Evidence Audit Stages

`spec-branch-review` leaves production code unchanged and is independent of the fixer.
It closes outstanding focused acceptance gaps and writes their evidence. It runs:

1. **Orientation and provenance:** resolve the prepared package, exact base/HEAD, commit mapping, evidence posture, dirty-tree exclusions, and prior decisions.
2. **Per-commit checks:** inspect each small diff against its step intent for correctness, security, reference integrity, simplification, and local evidence defects.
3. **Integrated branch checks:** inspect final producer/consumer contracts, real application composition in isolation, cross-step behavior, data/policy boundaries, deployment concerns, and defects hidden by isolated commits.
4. **Executable-evidence audit:** walk every AC → CL → FH → EV chain, inspect gate relevance and independence, execute outstanding focused required gates and rerun affected gates for named remaining gaps, and try credible adversarial cases. Reuse
   sufficient checks; no quota of tests, harnesses or operational exercises applies.
5. **Context and guardrails:** compare the result with sourced context, deliberate omissions,
   criteria and invariants. New configuration, flags, compatibility or release mechanisms need a
   present requirement. Violations are actionable guardrail defects; ordinary simplification is advisory.

The audit emits ordinary structured findings. `category: evidence` is used when a gate is missing, stale, irrelevant, circular, unreproducible, under-independent, or overclaims its proof boundary. A pass requires all merge-blocking claims proven, no actionable finding, a clean candidate scope, and an audit SHA equal to HEAD.

The audit challenges domain assumptions even when the implementation and tests agree with the spec.
Each material challenge identifies a concrete input, state transition, caller, or interleaving that breaks a promise.
Findings retain concrete impact and supporting evidence. Exceptional sourced dismissals
record resolutions of already-raised issues that might recur; discarded suspicions and
positive correctness narratives are omitted.

Reviewers examine ordinary startup and invocation for prerequisites that exist only in test setup.
They also check database evidence for actual persistence behavior and deferred work for concrete destinations.
Test-style improvements remain advisory. Missing or circular proof that leaves a required merge claim unsupported produces an actionable evidence finding.

See the [engineering decision contract](../skills/spec-work-tour/references/standalone-engineering-decisions.md)
for the stage-specific rules. These checks use the existing findings and verdicts.

## Review Record

A heading and one fenced `review:` YAML block identify `kind`, branch `iteration` or
`step`, exact SHA `target` range, `scope`, audited `commit`, `verdict`, and `findings`.
Branch reviews also retain `evidence_verdict`. Each finding appears once with stable
`id` and `signature`, severity/category/actionability, file/symbol/location, and an
`explanation` stating its failure condition and impact. Optional `correction` guides
repair; step findings identify their introducing commit. Only material `limitations`,
exceptional sourced `dismissals`, or an unresolved `decision_required` add metadata.

Consumers derive actionable counts from the finding list and reviewed commits from
the Git range. A no-findings review uses `findings: []`; advisory-only findings remain
listed with `verdict: pass`. Neither needs empty sections, lens inventories, or prose
repeating the YAML. Detailed verification stays in its original evidence records.
Existing interrupted runs may read older finding prose and checked commit lists when
needed; missing explanation or provenance never establishes a pass.

## Fix And Convergence

`spec-branch-fix` fixes code, tests, gates, artifacts, claim mappings, or proof boundaries and reruns affected evidence. A dismissal is typed. An `accepted-risk` dismissal suppresses recurrence only when the prepared decision cites actual user authorization or established project policy; the fixer cannot approve its own residual risk.

`spec-branch-refine` owns recurrence and the iteration cap. It stops:

- **proven** when the audit passes with proven evidence for the same HEAD;
- **stalled** when no material change is possible and the same required findings remain;
- **verified-at-cap** after the last fix when all actionable findings are resolved and
  required checks pass, without independently re-reviewing the final fixes;
- **cap** when the last fix leaves unresolved findings or incomplete required evidence.

`max-iterations` counts review → fix rounds, including the final fix. A limit of two
means review → fix → review → fix, with early exit for a clean review. Direct invocation
still defaults to ten. `spec-end-to-end` defaults to one when background step reviews
cover every step's commits, and two otherwise. Resume finishes an
interrupted round without resetting the budget. The completion record at
`reviews/refinement-completion.md` distinguishes a clean independent audit from verified
final fixes. Both successful outcomes can proceed to the tour and PR; neither permits
an automatic extra review. Stalled or unresolved capped outcomes remain blocked.

## HTML Work Tour

Every implemented spec produces `work-tour.json` and `work-tour.html`. The HTML is a navigable projection of existing evidence, not an ornamental summary. It covers:

- requested outcome and exact merge evidence verdict;
- sourced context, consequential decisions, deliberate omissions and new maintenance burden;
- separate deployment readiness, authorization/source, and post-deployment observations;
- before/after architecture, boundaries, and decisions;
- implementation steps, commits, and files;
- requirement-to-claim-to-gate traceability;
- rerunnable commands, artifacts, observed results, and honest proof limits;
- QA entrypoints, deterministic fixtures, ideal/non-ideal scenarios, visual captures, and automated coverage;
- migrations, configuration, observability, rollback/forward-fix, and residual risks;
- independent audit provenance and any evidence gaps.

For user-visible work, the QA section makes the implementation easy to explore without making a person's attention part of the safety system. Optional taste or discovery questions are labeled separately from correctness.

Domain rules and resolved challenges appear in `architecture.decisions`.
QA scenarios and gate results carry ordinary-entry observations and proof limits.
Accepted follow-ups appear in `context.omissions`, including the current limitation, destination, completion criteria, and revisit condition.
Local briefs include their actionable text in both the tour and PR. Unmet merge obligations remain in `gaps`.

## Ownership

- End-to-end orchestration owns stage order, workspace selection, handoff checks, and recovery.
- Architecture sets the initial evidence posture and provisional failure hypotheses.
- Critique attacks solution and evidence sufficiency.
- Spec writing owns stable AC/CL/FH/EV definitions and `evidence-plan.json`.
- Preparation code-grounds and corrects ready execution cards and their verification contracts.
- Step execution owns implementation plus assigned evidence and QA artifacts.
- Branch audit owns independent falsification and never edits code.
- Branch fix owns corrections and never rewrites the audit verdict.
- Refine owns convergence and hands a proven commit to the final tour.
- Work tour owns final evidence assembly and separate merge/deployment/authority/observation states.
- PR publication verifies freshness and distributes the already-complete case.

A later-phase gate may remain `pending` with a concrete procedure and no fabricated observation.
It does not block merge unless the gap also invalidates a merge claim. A known live failure that
reveals an implementation defect must not be hidden by phase labeling. The tour renderer validates
structure and contradictory statuses; the independent audit verifies truth, relevance and authority.

Existing packages require sourced context, consistent ready cards, and phase-aware
evidence-plan/tour version 2 before reuse. Preparation hashes and `preparation.json`
are not prerequisites. Reuse valid observations with honest provenance; no migration of application
data or automated compatibility layer is required to update workflow artifacts.

For unimplemented packages, use `spec-upgrade` to resolve context and refresh preparation before implementation.
It preserves original planning files and records changes in `upgrade.md`. Prepared status means ready to implement, not proven correct.
See [the transition guide](spec-workflow.md#transition-existing-unimplemented-specs) for single-spec and batch commands.

Shared tools still accept version 1 artifacts for existing callers outside this standalone workflow.
Their legacy output does not establish current standalone readiness.

Missing or contradictory prepared inputs return to `spec-write`; format changes alone
do not require re-preparation. Any code change after an audit or tour invalidates their readiness until affected gates, the integrated audit, and the tour are refreshed.
