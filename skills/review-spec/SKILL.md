---
name: review-spec
description: This skill should be used when the user asks to "review a spec", "review an issue", "check the plan", "review the implementation plan", "find gaps in the spec", or "review spec". Reviews a GitHub issue spec for gaps and viability, then directly edits the issue if improvements are needed.
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Review Spec

Review GitHub issue $ARGUMENTS.

Read the issue spec via `gh issue view $ARGUMENTS`. Assess whether the spec is viable for this project, whether there are gaps or errors, and whether there are important improvements.

### Ground the review in the codebase
Do not review the spec for internal consistency alone. Before trusting any claim, verify it against the actual repository:
- Every file, module, type, function, and API the spec references must actually exist — or, for new code, must sit plausibly alongside what exists. Read the referenced files (full reads, not just grep) rather than assuming.
- Architecture decisions, naming, and patterns must match this project's real conventions. Flag where the spec invents a pattern the codebase doesn't use.
- When resolving an ambiguity or filling a gap, draw the concrete answer from the code, not from a guess. Internal-only review misses the most damaging class of spec errors: confident references to things that don't exist or don't work the described way.

### Verify critique reconciliation
If the issue body ends with a `Spec folder: .specs/<feature-slug>/` line and `critique.md` exists in that folder, verify the critique landed in the spec:
- Every **Must Address** recommendation is either reflected in the Architecture/Implementation Steps or explicitly deferred in Notes with a rationale. A silently dropped Must Address item is a gap — restore it.
- **Should Address** items need no enforcement; flag only those the spec neither incorporates nor mentions when they would be cheap to include.
- For phase specs (footer says `(phase N)`), enforce only recommendations within this phase's scope. Items belonging to other phases are not this spec's gaps.

If there is no spec folder or no `critique.md`, skip this check.

### Editing the issue
If the spec should be changed, directly edit the content of issue $ARGUMENTS with an updated body that reflects an improved implementation spec. Edit with discipline:
- **Only edit for substantive gaps.** A sound spec needs no changes. Do not restyle, reword, or reorganize a spec that already passes the checklist — churn is a cost.
- **Preserve the author's intent and voice.** Refine specific sentences and sections; do not rewrite the whole spec into your own style.
- **Report what changed.** After editing, summarize for the user the specific changes made and why (gap closed, ambiguity resolved, step split), so the edit to the shared issue is reviewable. If you made no changes, say so and why the spec passed.
- **Converge on re-run.** Running this review again on an already-improved spec should find less each pass and trend toward no edits. If you find yourself rewriting prior edits, stop — the spec is already adequate.

## Review Checklist

### Required Sections
All 7 sections must be present and substantive (not just headings):
1. **Qualifications** — lists only skills actually needed, not a generic wish list.
2. **Problem Statement** — grounded in 2-4 sentences: what's missing/broken, current behavior, what the spec addresses.
3. **Goal** — one concrete sentence describing the outcome when complete.
4. **Architecture** — files with responsibilities, types/interfaces in concrete syntax, design decisions with rationale, dependency map. No vague descriptions.
5. **Acceptance Criteria** — numbered, observable, automatable assertions grouped by concern. Includes non-happy-path behaviors. No subjective criteria.
6. **Notes** — trade-offs with rationale (why this approach, what we give up, what we gain, alternatives considered). Risks and ambiguities called out.
7. **Implementation Steps** — see below.

### Architecture Review
Flag these problems:
- Designing for imagined future requirements instead of current needs.
- Abstractions with only one use or abstract layers "for future flexibility."
- Complex patterns without matching problem complexity.
- Optimizations without measured need.
- Missing failure modes or error propagation strategy.
- Data flow that can't be explained in under 5 minutes.
- Trade-offs stated without rationale.

### Ambiguity Review
Scan every section for statements that leave room for an implementer to make an undocumented judgment call. The test: *if two engineers built from this prose independently, could they produce different behavior?* If yes, it's ambiguous.

Flag these categories:
- **Vague qualifiers:** "typically", "usually", "appropriate", "reasonable", "graceful", "large/small/fast/slow" without numbers, "soon/eventually/immediately" without bounds.
- **Underspecified behavior:** "validates input" (how? what's invalid? what happens on failure?), "handles errors gracefully", "retries on failure" (how many? what backoff? which errors?), "logs the event" (level? fields?), "cleans up" / "normalizes" (what, to what form, on which paths?).
- **Missing defaults & thresholds:** optional params without defaults; timeouts, intervals, limits, batch sizes without numbers; "falls back to X" without the trigger condition.
- **Implicit conditionals:** "if the job exists" (checked how?), "when the queue is full" (capacity?), "once ready" (by what criterion?).
- **Type & shape ambiguity:** fields without type/optionality/range; "a status" without listing values; return values described as "an object" or "the result"; "an array of items" without item shape.
- **Concurrency & ordering gaps:** serial vs parallel, processing order, atomicity, locking, race behavior.
- **Side-effect gaps:** file ops (create vs overwrite, atomic vs streaming), network calls (timeout, retry, auth), logging destination/format/redaction.
- **Internal contradictions:** one section says A, another says B — both concrete, together ambiguous.

For each ambiguity found, resolve it in place: rewrite the prose with the concrete answer drawn from the codebase, existing conventions, or the spec's own intent. If the answer is genuinely indeterminate from available context, do not guess — call it out explicitly in the Notes section as an open question with the specific decision a domain expert must make.

### Implementation Steps Review
Each step must include:
1. What to do: exact files and changes required.
2. Why: tied to architecture or acceptance criteria.
3. Signatures/contracts: public API shape when adding or changing interfaces.
4. Tests: concrete automated test assertions and target test files.

Verify the four step constraints:
- **Deterministic:** No subjective instructions ("improve", "clean up", "refactor as needed").
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
- Every step must carry a `Covers: AC-n` tag line naming the criteria it satisfies (or trace to a stated architectural need). Add missing tags; correct tags that don't match the step's actual effect.
- Every acceptance criterion must be covered by at least one step's tags. An uncovered criterion is a missing step.
- A step that traces to neither a criterion nor an architectural need is scope creep — remove it or justify it.
- Verification tests in the steps should map to the observable assertions in the acceptance criteria.

### Granularity & Step Splitting
Look for steps doing too much, and split them when it makes the work more verifiable. Split a step when:
- It touches multiple files or modules that could each be completed and verified on their own.
- It bundles a type/contract change with the logic that consumes it (separate the contract from its consumer).
- It mixes pure/domain logic with stateful or I/O work.
- It maps to more than one acceptance criterion, or its tests form more than one independent group.
- It has more than one distinct "what to do," or needs more than one signature/contract to describe.
- Half of it could land and be verified while the other half is still broken — that seam is a split point.

After splitting, re-apply the four step constraints and the ordering rules to each new step. Each step must still be the smallest verifiable unit of progress.

Do not over-split. Keep steps together when:
- They are a contract and its sole consumer that cannot compile or be tested apart.
- The split would produce a step too trivial to verify on its own (e.g., a one-line change).
- Splitting forces a temporary compatibility shim that a single step would avoid (forward-only).

Flag and remove steps that should not exist:
- Manual testing or QA checklists.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting or lint-only chores.
- Git workflow or PR process steps.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
