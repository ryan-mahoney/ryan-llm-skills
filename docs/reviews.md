# Integrated Evidence Audit And Work Tour

The standalone spec workflow does not depend on human code review. Its final authority is a commit-bound chain from requirement to falsifiable claim, credible failure hypothesis, executable gate, observed result, independent integrated audit, and deployment verdict.

`spec-branch-refine` alternates `spec-branch-review` and `spec-branch-fix` until the implementation and its evidence are proven or the loop is honestly blocked. A proven pass hands off to the explicit `spec-work-tour` stage, which emits the required machine verdict and HTML tour. A PR distributes that case; it is not where safety is expected to emerge.

## Artifact Package

```text
.specs/<feature>/
├── proposal.md
├── critique.md                         # optional challenge stage
├── spec.md
├── spec-steps.json
├── evidence-plan.json                  # posture + AC/CL/FH/EV graph
├── spec-prepare.md
├── criteria.md                         # optional prose guardrails
├── invariants.md                       # optional live invariants
├── preparation.json                    # hashes evidence plan too
├── step-<NNN>-subspec.md               # immutable execution card
├── step-<NNN>-learning.md              # command/evidence outcomes
├── evidence/                            # captures, logs, dry runs, QA inputs
├── merge-evidence.md
├── merge-evidence.json                 # pre-audit results bound to HEAD
├── blockers.md                          # when applicable
├── reviews/
│   ├── branch-<i>-review.md             # independent evidence audit
│   └── branch-<i>-fix.md
├── work-tour.json                      # final deploy verdict bound to HEAD
└── work-tour.html                      # architecture/evidence/QA tour
```

`.specs/` is usually gitignored. Worktree handoff copies the complete package and preserves relative evidence links.

## Evidence Audit Stages

`spec-branch-review` is read-only and independent of the fixer. It runs:

1. **Orientation and provenance:** resolve the prepared package, exact base/HEAD, commit mapping, evidence posture, hashes, dirty-tree exclusions, and prior decisions.
2. **Per-commit checks:** inspect each small diff against its step intent for correctness, security, reference integrity, simplification, and local evidence defects.
3. **Integrated branch checks:** inspect final producer/consumer contracts, real production reachability, cross-step behavior, data/policy boundaries, deployment concerns, and defects hidden by isolated commits.
4. **Executable-evidence audit:** walk every AC → CL → FH → EV chain, inspect gate relevance and independence, rerun selected gates, and try adversarial cases at crossed boundaries.
5. **Prepared guardrails:** compare the integrated result with criteria statements and live invariants.

The audit emits ordinary structured findings. `category: evidence` is used when a gate is missing, stale, irrelevant, circular, unreproducible, under-independent, or overclaims its proof boundary. A pass requires all merge-blocking claims proven, no actionable finding, a clean candidate scope, and an audit SHA equal to HEAD.

## Fix And Convergence

`spec-branch-fix` fixes code, tests, gates, artifacts, claim mappings, or proof boundaries and reruns affected evidence. A dismissal is typed. An `accepted-risk` dismissal suppresses recurrence only when the prepared spec/evidence plan already records that explicit decision; the fixer cannot approve its own residual risk.

`spec-branch-refine` owns recurrence and the iteration cap. It stops:

- **proven** when the audit passes with proven evidence for the same HEAD;
- **stalled** when no material change is possible and the same required findings remain;
- **cap** when bounded iterations are exhausted.

Stalled and capped outcomes are blocked evidence cases, never “send it for human review.”

## HTML Work Tour

Every implemented spec produces `work-tour.json` and `work-tour.html`. The HTML is a navigable projection of existing evidence, not an ornamental summary. It covers:

- requested outcome and exact commit verdict;
- before/after architecture, boundaries, and decisions;
- implementation steps, commits, and files;
- requirement-to-claim-to-gate traceability;
- rerunnable commands, artifacts, observed results, and honest proof limits;
- QA entrypoints, deterministic fixtures, ideal/non-ideal scenarios, visual captures, and automated coverage;
- migrations, configuration, observability, rollback/forward-fix, and residual risks;
- independent audit provenance and any evidence gaps.

For user-visible work, the QA section makes the implementation easy to explore without making a person's attention part of the safety system. Optional taste or discovery questions are labeled separately from correctness.

## Ownership

- Architecture sets the initial evidence posture and provisional failure hypotheses.
- Critique attacks solution and evidence sufficiency.
- Spec writing owns stable AC/CL/FH/EV definitions and `evidence-plan.json`.
- Preparation code-grounds, corrects, and hashes the implementation/evidence contract.
- Step execution owns implementation plus assigned evidence and QA artifacts.
- Branch audit owns independent falsification and never edits code.
- Branch fix owns corrections and never rewrites the audit verdict.
- Refine owns convergence and hands a proven commit to the final tour.
- Work tour owns final evidence assembly and deployment verdict.
- PR publication verifies freshness and distributes the already-complete case.

Any prepared-artifact drift blocks execution until `spec-prepare` republishes. Any code change after an audit or tour invalidates their readiness until affected gates, the integrated audit, and the tour are refreshed.
