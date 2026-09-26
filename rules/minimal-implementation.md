# Minimal Implementation Guide (v1.0)

**Core rule:** Build the least sustainable software that solves the stated problem. Use the least
costly, least invasive evidence that rejects credible failures in the actual project context.

This rule applies to all implementation work — frontend, backend, infrastructure, tooling.

## 1. The Necessity Ladder

Before writing any code, stop at the first rung that holds:

1. Does this need to exist at all? If no requirement names it, skip it.
2. Does the codebase already do it? Reuse the existing helper, util, or pattern.
3. Does the standard library cover it? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency cover it? Use it.
6. Can it be one line? Write one line.
7. Only then: write the minimum code that works.

Climb the ladder after understanding the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then pick a rung. A small diff in the wrong place is a second bug, not efficiency.

## 2. Guardrails

- No abstractions with a single caller; no interfaces or layers "for future flexibility."
- No new dependency when the codebase, stdlib, or platform covers it.
- No speculative config, flags, hooks, or extension points.
- Forward-only: no compatibility shims unless compatibility is a stated constraint.
- Deletion over addition. Boring over clever. Fewest files that stay coherent.
- Shortest working diff — in the right place. Fix the root cause, not the reported symptom path; check the other callers of anything you change.
- Question complexity: "does the requirement actually need X, or does Y cover it?"
- When two equal-size approaches differ in edge-case correctness, take the correct one. Minimal means less code, not weaker logic.
- Mark a deliberate simplification that cuts a real corner (global lock, O(n²) scan, naive heuristic) with a comment naming the ceiling and the upgrade path.

## 3. The Safety Floor — never cut

- Input validation at trust boundaries.
- Error handling that prevents data loss.
- Security and accessibility.
- Applicable acceptance criteria and sourced project constraints. Correct an invented or
  inapplicable obligation through the owning planner; a generated spec cannot authorize itself.

## 4. Proportionate Verification

Preserve applicable correctness coverage; do not weaken assertions to obtain a pass. Match proof
to credible failures, actual exposure, data value, reversibility, and uncertainty. Reuse existing
tests and fixtures; one well-chosen gate can cover several claims. Prefer a focused check or
disposable verifier to new maintained infrastructure when it establishes the same evidence.

Tests, harnesses, flags, environments, and release machinery have maintenance and operational
costs too. Name the remaining uncertainty before adding one. Stop when applicable claims are
supported and the required independent audit finds no material gap. Correct an overestimated
obligation using sourced project facts; do not disguise unresolved failures as scope reductions.
Verification never grants permission to affect shared or production systems.

## 5. Final Test

1. Can I name the requirement behind every module, dependency, and abstraction?
2. Did I reuse before writing?
3. Would deleting anything leave behavior intact? Then delete it.
4. Does the evidence reject the credible failures without unnecessary cost or external effects?
