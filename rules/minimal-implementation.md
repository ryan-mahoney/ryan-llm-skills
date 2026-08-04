# Minimal Implementation Guide (v1.0)

**Core rule:** Build the least software that solves the stated problem. Verify it without limit.

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
- Anything the spec explicitly requires.

## 4. Verification Is Exempt

Minimality applies to construction, never to proof. Effort spent proving correctness — tests, adversarial cases, evidence artifacts — is well spent; effort spent building unrequested software is not. Do not trim tests, assertions, or evidence to make a diff smaller.

## 5. Final Test

1. Can I name the requirement behind every module, dependency, and abstraction?
2. Did I reuse before writing?
3. Would deleting anything leave behavior intact? Then delete it.
4. Is verification as strong as if the code were complex?
