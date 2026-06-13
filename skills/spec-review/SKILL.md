---
name: spec-review
description: This skill should be used when the user asks to "review a spec", "review an issue", "check the plan", "review the implementation plan", "find gaps in the spec", or "review spec". Reviews .specs/<slug>/spec.md for gaps and viability, edits it when needed, and mirrors changes to GitHub only when a GitHub mirror exists.
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Spec Review

Review a spec for viability, ambiguity, traceability, and implementation readiness. The repository-local spec file is canonical.

## Output Contract

Always apply substantive review changes to the resolved local spec file first:

```txt
.specs/<feature-slug>/spec.md
```

GitHub issues are optional mirrors. Never update a GitHub issue instead of the local file, and never treat the issue body as the only persisted review output.

## Resolve the Spec

Resolve the spec target in this order:

1. If `$ARGUMENTS` is a path to a markdown file, review that file.
2. If `$ARGUMENTS` names a folder under `.specs/`, review `.specs/<feature-slug>/spec.md`.
3. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and review the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md` before reviewing.
4. If no argument is provided, review the most recently modified `.specs/*/spec.md`.

If no local spec can be resolved, stop and report the missing input. Do not review a GitHub issue as the only source of truth unless you first materialize it to `.specs/<feature-slug>/spec.md`.

## Optional GitHub Mirror

When the reviewed spec has a GitHub issue mirror, update that issue after editing `spec.md`.

A GitHub mirror exists when:

- The user passed a GitHub issue number and `gh issue view` succeeded, or
- The spec footer or surrounding conversation clearly identifies an issue number for the current GitHub repo.

If the GitHub mirror cannot be updated, keep the local `spec.md` edits and report the mirror failure. Do not roll back the local review.

## Ground the Review in the Codebase

Do not review the spec for internal consistency alone. Before trusting any claim, verify it against the actual repository:

- Every file, module, type, function, and API the spec references must actually exist, or for new code, must sit plausibly alongside what exists. Read the referenced files fully instead of assuming.
- Architecture decisions, naming, and patterns must match this project's real conventions. Flag where the spec invents a pattern the codebase does not use.
- When resolving an ambiguity or filling a gap, draw the concrete answer from code, existing conventions, or the spec's own intent. If the answer is genuinely indeterminate, call it out in Notes as an open question.

## Verify Critique Reconciliation

If the spec footer names `Spec folder: .specs/<feature-slug>/` and `critique.md` exists in that folder, verify the critique landed in the spec:

- Every **Must Address** recommendation is either reflected in Architecture/Implementation Steps or explicitly deferred in Notes with a rationale. A silently dropped Must Address item is a gap; restore it.
- **Should Address** items need no enforcement. Flag only those the spec neither incorporates nor mentions when they would be cheap to include.
- For phase specs, enforce only recommendations within that phase's scope. Items belonging to other phases are not this spec's gaps.

If there is no spec folder or no `critique.md`, skip this check.

## Editing the Spec

If the spec should be changed, directly edit `spec.md` with an improved body.

Edit with discipline:

- Only edit for substantive gaps. A sound spec needs no changes. Do not restyle, reword, or reorganize a spec that already passes the checklist.
- Splitting an oversized implementation step is substantive, not churn; see Granularity & Step Splitting.
- Preserve the author's intent and voice. Refine specific sentences and sections; do not rewrite the whole spec into your own style.
- Report what changed and why so the edit is reviewable.
- Converge on re-run. Running this review again on an already-improved spec should trend toward no edits. If you find yourself rewriting prior edits, stop; the spec is already adequate.

After editing `spec.md`, mirror the final body to GitHub only when an available mirror exists.

## Output Steps

1. Write any reviewed changes to the resolved local `spec.md`.
2. If a GitHub mirror exists, update the issue with the final local `spec.md` body.
3. Report:
   - Spec path.
   - GitHub issue URL or "not mirrored".
   - Whether the local file changed.
   - What changed and why, or that the spec already passed review.

## Review Checklist

### Required Sections

All 8 sections must be present and substantive:

1. **Qualifications** - lists only skills actually needed, not a generic wish list.
2. **Problem Statement** - grounded in 2-4 sentences: what's missing/broken, current behavior, what the spec addresses.
3. **Goal** - one concrete sentence describing the outcome when complete.
4. **Architecture** - files with responsibilities, types/interfaces in concrete syntax, design decisions with rationale, dependency map. No vague descriptions.
5. **Acceptance Criteria** - numbered, observable, automatable assertions grouped by concern. Includes non-happy-path behaviors. No subjective criteria.
6. **Notes** - trade-offs with rationale, risks and ambiguities.
7. **Implementation Steps** - see below.
8. **Applicable Rules** - each listed rule path resolves to a real file, each has a relevance reason, and the selection matches what the spec touches (no padding with irrelevant rules; no obviously relevant rule missing — e.g. a spec that builds a form should select the form rule if one exists). "N/A" is correct for work touching no rule domain.

### Architecture Review

Flag these problems:

- Designing for imagined future requirements instead of current needs.
- Abstractions with only one use or abstract layers "for future flexibility."
- Complex patterns without matching problem complexity.
- Optimizations without measured need.
- Missing failure modes or error propagation strategy.
- Data flow that cannot be explained in under 5 minutes.
- Trade-offs stated without rationale.

### Ambiguity Review

Scan every section for statements that leave room for an implementer to make an undocumented judgment call. The test: if two engineers built from this prose independently, could they produce different behavior? If yes, it is ambiguous.

Flag these categories:

- **Vague qualifiers:** "typically", "usually", "appropriate", "reasonable", "graceful", "large/small/fast/slow" without numbers, and "soon/eventually/immediately" without bounds.
- **Underspecified behavior:** "validates input" without rules, "handles errors gracefully", "retries on failure" without counts/backoff/error classes, "logs the event" without level/fields, or "normalizes" without a target form.
- **Missing defaults & thresholds:** optional params without defaults; timeouts, intervals, limits, batch sizes without numbers; "falls back to X" without trigger conditions.
- **Implicit conditionals:** "if the job exists", "when the queue is full", or "once ready" without the exact check.
- **Type & shape ambiguity:** fields without type/optionality/range; "a status" without values; return values described as "an object" or "the result".
- **Concurrency & ordering gaps:** serial vs. parallel, processing order, atomicity, locking, race behavior.
- **Side-effect gaps:** file operations, network calls, logging destinations, redaction, retries, auth.
- **Internal contradictions:** one section says A and another says B.

Resolve each ambiguity in place when the answer can be drawn from code, conventions, or the spec's own intent. If not, add a concrete open question in Notes with the decision a domain expert must make.

### Implementation Steps Review

Each step must include:

1. What to do: exact files and changes required.
2. Why: tied to architecture or acceptance criteria.
3. Signatures/contracts: public API shape when adding or changing interfaces.
4. Tests: concrete automated test assertions and target test files.

Verify the four step constraints:

- **Deterministic:** No subjective instructions such as "improve", "clean up", or "refactor as needed".
- **Minimal:** Smallest verifiable unit of progress.
- **Self-contained:** Executable in isolation by a separate engineer or LLM context.
- **Forward-only:** Target architecture only. No unnecessary compatibility layers.

Verify step ordering:

- Types and contracts first.
- Pure/domain logic next.
- Stateful and I/O modules after.
- Integration wiring and verification tests last.

### Traceability

Check coverage in both directions between Acceptance Criteria and Implementation Steps:

- Every step must carry a `Covers: AC-n` tag line naming the criteria it satisfies, or trace to a stated architectural need. Add missing tags and correct mismatched tags.
- Every acceptance criterion must be covered by at least one step's tags.
- A step that traces to neither a criterion nor an architectural need is scope creep; remove it or justify it.
- Verification tests in the steps should map to observable assertions in the acceptance criteria.

### Granularity & Step Splitting

Evaluate every implementation step against the split triggers below. This is required on each step, not optional polish. Treat any step touching multiple files or mixing concerns as a split candidate until the triggers say otherwise.

Split a step when:

- It touches multiple files or modules that could each be completed and verified on their own.
- It bundles a type/contract change with the logic that consumes it.
- It mixes pure/domain logic with stateful or I/O work.
- It maps to more than one acceptance criterion, or its tests form more than one independent group.
- It has more than one distinct "what to do," or needs more than one signature/contract to describe.
- Half of it could land and be verified while the other half is still broken.

After splitting, re-apply the four step constraints and ordering rules to each new step.

Do not over-split. Keep steps together when:

- They are a contract and its sole consumer that cannot compile or be tested apart.
- The split would produce a step too trivial to verify on its own.
- Splitting forces a temporary compatibility shim that a single forward-only step would avoid.

Flag and remove steps that should not exist:

- Manual testing or QA checklists.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting or lint-only chores.
- Git workflow or PR process steps.

When summarizing the review, state the granularity verdict explicitly: which steps were split and why, or that every step was checked and none met a split trigger.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
