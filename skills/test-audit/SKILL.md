---
name: test-audit
description: "Evaluate a scoped test suite for redundant coverage, weak assertions, brittle tests, and unnecessary cost. Use when asked to audit test value, cull or reduce tests, or simplify an overgrown suite. Ordinary feature testing uses the shared test guide without a separate audit."
license: MIT
metadata:
  version: "1"
---

# Test Audit

Reduce test maintenance and execution cost while preserving useful protection. Read
`~/.agents/rules/unit-testing.md` and the target repository's instructions before judging
cases. The guide owns the rubric and preservation rules. This skill owns the scoped audit.

## Scope and mode

Invocation: `test-audit <behavior or path> [mode=assess|apply]`.

- `assess`: inspect and report concrete proposed edits. This is the default for a review
  or evaluation request. Do not change tests, production code, or execution policy.
- `apply`: implement the scoped test improvements and removals. A request to reduce, cull,
  simplify, or fix the tests authorizes this mode unless the user limits it to a proposal.
  Respect authorization already given. Do not insert another blanket approval step.

Resolve the named behavior or path, code checkout, current revision, and uncommitted work.
If no scope is supplied, inventory the suite and choose a bounded behavior group, stating
the selection. Do not silently turn a local audit into a repository-wide rewrite.
Preserve unrelated changes. Keep `.specs/` artifacts in the primary checkout when that
workflow is in use. Application checks run in the selected code checkout.

## Inspect protection and cost

Group cases by the behavior they protect. Read the production entry points, relevant
callers, fixtures, nearby boundary tests, requirements, and targeted history. Test names,
duplicated text, setup size, and timings find candidates but do not establish redundancy.

Apply the guide's purpose, failure detection, added protection, refactoring tolerance,
oracle quality, and cost dimensions. Use `strong`, `concern`, or `unknown` with evidence,
not a summed score. Assess the behavior group first, then its candidate cases.

Classify findings as **keep**, **improve**, **consolidate**, **move**, **remove**, or
**investigate**. For move, name the destination boundary or execution stage and preserve
required gates. Useful outcomes include stronger assertions and cheaper fixtures with
no deletions. Do not create an inventory entry for every unrelated passing case.

For each removal, name retained evidence and compare inputs, boundaries, outcomes, and
oracle independence, or cite the source retiring the obligation. Similar filenames,
shared source lines, and a green remaining suite are insufficient. Preserve unresolved
candidates. Ask only for unresolved consequential intent while continuing independent work.

## Apply scoped changes

In assess mode, finish with findings and proposed edits. Label static reasoning, unexecuted
checks, and unmeasured costs honestly. Run existing checks only when needed and isolated
appropriately under repository policy. Do not install tools to produce a score.

In apply mode:

1. Obtain a focused baseline before edits when feasible. Inspect actual command expansion,
   dependencies, and isolation. Record unavailable or failing baselines instead of claiming
   a clean starting point. Diagnose relevant failures without deleting tests to get green.
2. Improve weak assertions and unnecessary setup first. Consolidate or remove only the cases
   with established retained protection or a sourced retirement. Keep production behavior
   unchanged. Preserve independently diagnosable cases and known regression counterexamples.
3. For disputed redundancy, use a targeted faulty version or old regression in a disposable
   checkout when the likely value warrants it. Follow repository isolation and finite-deadline
   requirements. Restore temporary faults and inspect the final diff. Do not run a broad
   mutation campaign or add a mutation framework by default.
4. Run affected checks after edits and the required repository completion checks. Reuse valid
   results and run broad checks once at completion. Report timeouts or unavailable checks as
   gaps. Compare equivalent commands and environments before claiming runtime savings.

The audit can reveal missing protection. Add only cases needed to preserve or repair the
scoped obligation. Record unrelated gaps as follow-ups. A production defect is not a test
cleanup: report it separately and repair it only within the user's authorized scope.

## Report and stop

Use the existing review or work record, or return the findings in the response. Do not
require a new ledger or business-rule catalog. For material findings include:

| Field | Content |
|---|---|
| Scope | Behavior, revision, relevant sources, and inspection limits |
| Candidate | File and named case or assertion group |
| Failure | Wrong behavior rejected, or demonstrated assertion weakness |
| Decision | Disposition and concrete reason |
| Retained protection | Surviving named evidence and comparison, or sourced retirement |
| Cost | Observed setup, execution, diagnosis, or maintenance concern |
| Verification | Baseline and final command results, elapsed time, revisions, and limits |

Report removals separately from stronger assertions, reduced setup, and measured savings.
Fewer lines or parameterized declarations do not imply fewer executed cases.
Stop when scoped findings are resolved or explicitly left uncertain and required checks
are complete. Do not pursue a deletion quota, unrelated cleanup, or another review cycle
merely because the suite still has many tests. State any unresolved verification gap.
