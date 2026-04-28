---
name: specops-spec-conformance
description: Audit a SpecOps implementation spec against its source analysis spec to find requirements, policies, contracts, edge cases, error modes, invariants, defaults, side effects, or implementation steps that the implementation has dropped, weakened, contradicted, or silently changed — then patch the implementation spec to restore them. Use this skill whenever the user mentions auditing, comparing, conforming, reconciling, or checking an implementation spec against an analysis spec, finding gaps between two specs, ensuring an implementation spec preserves analysis behavior, or verifying spec derivation or traceability. Also trigger when the user describes "did the implementation spec lose anything from the analysis," "does the implementation match the analysis," "verify the implementation spec covers everything," or asks to confirm one spec is faithful to another. Run this before generating code from an implementation spec and after either spec is edited.
---

# SpecOps Spec Conformance Audit

The SpecOps method derives an implementation spec from a verified analysis spec. The implementation spec is supposed to be a faithful translation: same behaviors, same contracts, same edge cases, same error modes — just expressed in terms of a target language and stack.

In practice, translation drops things. A behavioral contract gets weakened. An error mode is collapsed. An invariant is forgotten. A default value drifts. An open question gets silently resolved. The implementation spec adds something the analysis never asked for.

This skill runs a three-phase conformance audit on a pair of specs (analysis + implementation):

1. **Trace** every concrete claim in the analysis through to the implementation.
2. **Identify** items the implementation dropped, weakened, contradicted, silently resolved, or unjustifiably added.
3. **Patch** the implementation spec — adding missing requirements, restoring weakened contracts, annotating justified design choices — with subagents verifying each gap in parallel.

The output is a hardened implementation spec where every behavior in the analysis has a corresponding entry in the implementation, and any deliberate divergence is documented with rationale.

## Inputs

Confirm with the user before starting:

- **Analysis spec path** — the upstream "what the legacy code does" document (e.g., `docs/specs/analysis/core/orchestrator.md`).
- **Implementation spec path** — the downstream "how we'll build it" document (e.g., `docs/specs/implementation/core/orchestrator.md`).
- **Source files (optional)** — the legacy code itself, used as a tiebreaker when the two specs disagree on what the actual behavior should be.
- **Working directory** — where to write the conformance report. Default: a sibling file `<implementation-name>.conformance.md` next to the implementation spec.

If only one spec path is given, look in `docs/specs/analysis/` and `docs/specs/implementation/` for matching filenames before asking.

---

## Phase 1: Trace and identify gaps

Read both specs end-to-end. Then enumerate every concrete claim in the analysis spec and check whether the implementation spec reflects it. Work claim-by-claim, not section-by-section — the implementation spec may organize content differently, and a claim from analysis Section 4 might legitimately live in implementation Section 6.

### What counts as a "claim"

Every analysis spec section produces traceable claims:

- **Purpose & Responsibilities** — what the module owns; what it explicitly does NOT do
- **Public Interface** — every exported function, parameter, return value, error mode
- **Data Models** — every structure, field, type, optionality, valid range, lifecycle
- **Behavioral Contracts** — preconditions, postconditions, invariants, ordering guarantees, concurrency behavior
- **State Management** — every piece of state, its lifecycle, crash recovery behavior
- **Dependencies** — every internal, external, and system-level dependency
- **Side Effects** — every file, network, process, log, and timing operation
- **Error Handling** — every error category, propagation strategy, recovery behavior
- **Integration Points** — upstream/downstream contracts, data transformations
- **Edge Cases** — every implicit behavior, default, workaround, magic number
- **Open Questions** — every flagged ambiguity (these MUST appear in the implementation either as a resolved decision with rationale or as a carried-forward open item)

### Categories of conformance gap

For each claim, look for:

**Missing claim**
- The analysis describes a behavior; the implementation makes no mention of it anywhere.
- Most often: error modes, edge cases, side effects, invariants, ordering guarantees.

**Weakened claim**
- The analysis is concrete; the implementation is vague.
- Examples: "atomic write" → "consistent write"; "FIFO ordering" → "preserves order"; "exactly three retries with 100ms / 200ms / 400ms backoff" → "retries with backoff".

**Contradicted claim**
- The implementation says something incompatible with the analysis.
- Different default values, different ordering, different error categories, different field types.

**Silently resolved open question**
- The analysis flagged an Open Question / OQ-N item. The implementation either picks an answer without justification or doesn't address it at all.

**Lost edge case or error mode**
- The analysis enumerates N cases; the implementation handles fewer.
- The analysis lists 5 distinct error categories; the implementation collapses them to 2.

**Type / schema drift**
- The analysis specifies a structure with fields A, B, C and constraints; the implementation has different fields, drops constraints, or relaxes optionality.

**Default-value drift**
- The analysis names a specific default; the implementation differs without justification.

**Dropped dependency or side effect**
- The analysis lists a dependency or side effect; the implementation omits it. (Logging is the most commonly dropped side effect.)

**Unjustified addition (reverse direction)**
- The implementation introduces a requirement or behavior not present in the analysis.
- Sometimes legitimate (TS-specific concerns like discriminated unions or strict null handling) but should always be noted with rationale. Sometimes scope creep that should be removed.

### Output of Phase 1

Write the gap list to `<implementation-spec-name>.conformance.md` next to the implementation spec. Format:

```markdown
# Conformance Audit: <implementation spec name>

- **Implementation spec:** <path>
- **Analysis spec:** <path>
- **Audited:** <date>

## Gaps

### G1
- **Type:** Missing claim
- **Analysis section:** Behavioral Contracts
- **Analysis claim:** "Status writes are serialized through a single-writer queue to prevent torn reads."
- **Implementation reference:** Searched Concurrency, State, and Public Interface sections — no mention.
- **Question for subagent:** Is this serialization mentioned anywhere in the implementation spec? If not, propose where to add it.

### G2
- **Type:** Weakened claim
- **Analysis section:** Error Handling
- **Analysis claim:** "On transient network failure, retries up to 3 times with exponential backoff (100ms, 200ms, 400ms) before propagating."
- **Implementation reference:** Implementation says "retries with backoff."
- **Question for subagent:** Should the implementation restate the exact retry count and backoff schedule?

### G3
- **Type:** Unjustified addition
- **Implementation claim:** "All public functions return Result<T, E> discriminated unions."
- **Analysis equivalent:** Analysis describes errors as thrown, not returned.
- **Question for subagent:** Is this a legitimate TS-specific design (preserves observable behavior at module boundary) or does it change observable behavior?

...
```

The audit runs end-to-end without pausing for confirmation. Phase 1 produces the list; Phase 2 starts immediately. The user reviews the resulting report asynchronously.

---

## Phase 2: Resolve via parallel subagents

Spawn one subagent per gap, all in the same turn.

### Subagent prompt template

```
You are auditing a single conformance gap between a SpecOps analysis spec and its derived implementation spec. Your job is to verify whether the gap is real, and if so, propose a precise patch to the implementation spec.

# The gap
- Type: <gap type>
- Analysis section: <section>
- Analysis claim: "<the claim from analysis>"
- Implementation reference: <where the claim should appear or was searched for>
- Question: <the specific question to answer>

# Documents to read
- Analysis spec: <full path>
- Implementation spec: <full path>
- (Optional) Legacy source files: <list> — read only if needed to break a tie between the two specs

# Your task
1. Read the relevant sections of both specs (don't skim — the claim may be paraphrased and live in a section you didn't expect).
2. Determine whether the gap is real:
   - If the implementation already covers the claim somewhere — possibly in a different section than expected, possibly with different wording — report `gap_real: false` and point to the location.
   - If the gap is real, propose a concrete patch.
3. For "Unjustified addition" gaps, decide which case applies:
   - Legitimate translation concern (e.g., TS-specific type design that preserves observable behavior at module boundaries) — note this with justification, propose an `annotate` patch that documents the rationale in the implementation spec.
   - Scope expansion (changes observable behavior beyond what the analysis specifies) — flag for review with a `defer` outcome.
4. Most gaps are mechanical — the implementation forgot or weakened something the analysis stated concretely. Resolve them with confident, specific patches. Defer only when resolution requires a real design decision that neither spec nor source can settle.

# Output format
Return a JSON object only, no commentary:

{
  "gap_id": "<like G1>",
  "gap_real": <true | false>,
  "found_in_implementation": "<if gap_real is false: section + brief excerpt where the claim actually appears>",
  "patch": {
    "implementation_section": "<which section of the implementation spec to update>",
    "operation": "<add | modify | annotate>",
    "before": "<existing text being replaced; null for 'add'>",
    "after": "<new or replacement text>",
    "rationale": "<one sentence: why this patch closes the gap>"
  },
  "evidence": [
    {"source": "<analysis | implementation | legacy_code>", "location": "<section name or file:lines>", "excerpt": "<relevant text>"}
  ],
  "deferred": <true | false>,
  "defer_reason": "<one of: requires_design_decision, contradiction_between_specs, missing_source_context — only if deferred>",
  "defer_context": "<what someone needs to decide and the relevant tradeoffs — only if deferred>",
  "suggested_resolver": "<who can decide — only if deferred>",
  "suggested_next_action": "<concrete next step — only if deferred>"
}
```

### Running the subagents

- Use the Task tool (or whatever subagent mechanism the host environment provides) to spawn one subagent per gap, all in the same turn.
- Each subagent runs independently. They do not share context.
- If the host has no subagent capability, fall back to processing each gap serially in the main loop using the same prompt and output format.

---

## Phase 3: Patch the implementation spec

When all subagents return:

1. **Sort results into three buckets.**
   - `gap_real: false` — false positive. The claim was already covered. Note in the audit report for traceability; no patch.
   - `gap_real: true, deferred: false` — apply the patch.
   - `deferred: true` — log to a "Deferred Design Decisions" section of the implementation spec with full context. The audit continues; deferrals don't block.

2. **Apply patches.** For each real, non-deferred gap:
   - `add` — insert the new content into the specified implementation section.
   - `modify` — replace `before` with `after` in the specified section.
   - `annotate` — add a justification note next to existing content (used for legitimate "Unjustified addition" cases where TS-specific design preserves observable behavior).

3. **Preserve voice and structure.** Don't rewrite whole sections. Apply minimal in-place edits that match the implementation spec's existing style.

4. **Log deferred items in the implementation spec** under a "Deferred Design Decisions" heading. Use this format so anyone picking up the item later has full context:

   ```markdown
   ### DD-<id>: <short title>
   - **Source claim:** <analysis section + the claim>
   - **Why deferred:** <one of: requires_design_decision, contradiction_between_specs, missing_source_context>
   - **Context:** <what's missing, contested, or needs to be decided — including relevant tradeoffs>
   - **Suggested resolver:** <e.g., "domain expert on retry policy" / "team that owns the calling code">
   - **Suggested next action:** <concrete next step>
   ```

5. **Append an audit log** at the end of the implementation spec:

   ```markdown
   ---
   ## Audit History

   ### <YYYY-MM-DD> — Conformance audit against analysis spec
   - Analysis spec audited against: <path>
   - Gaps identified: <count>
   - Resolved with patches: <count>
   - False positives (already covered elsewhere): <count>
   - Deferred (need design decision): <count>
   - Audit report: `<implementation-spec-name>.conformance.md`
   - Deferred items: see Deferred Design Decisions section for DD-<id> entries
   ```

6. **Save the conformance report** alongside the implementation spec. It records every gap, every subagent verdict, and the evidence — useful for reviewers and for diffing across audit passes.

7. **Summarize for the user.** Show:
   - Counts: identified, resolved, false positives, deferred.
   - The list of deferred items (DD-ids and short titles) so the user can see what's outstanding without opening the spec.
   - Note that the implementation spec is patched and the audit is complete; deferred items can be addressed out-of-band.

---

## Important behaviors

- **Run end-to-end without stopping.** The audit is automated. Don't pause between phases. The user reviews the patched implementation spec asynchronously.
- **Most gaps are mechanical.** When the analysis is concrete, the implementation should restate or refine — not weaken or omit. Treat confident, specific patches as the normal case.
- **Reorganization is not a gap.** The implementation spec may legitimately restructure the analysis's content. Subagents must check the entire implementation spec, not just the section that "matches" the analysis section. False positives are expected and aren't failures.
- **Deferral is rare and specific.** Real design-decision blockers usually trace to: an Open Question the analysis left for caller decision, a contradiction between the analysis and the source code, or behavior that depends on context neither doc captures.
- **Don't fabricate justifications.** If the implementation made a TS-specific choice (e.g., `Result<T, E>` instead of thrown errors), the patch must spell out why this preserves observable behavior — not silently assert it does.
- **Trace open questions forward.** Every OQ-N entry in the analysis must surface in the implementation either as a resolved decision (with documented rationale) or as a carried-forward DD-N item. Silent resolutions are a primary audit finding.
- **The reverse direction matters.** Things in the implementation not justified by the analysis are findings. Often legitimate, but always flagged and documented with rationale rather than left implicit.
- **Re-audit is cheap.** Both specs evolve. After material edits to either, re-run; convergence to zero gaps is a verification gate before code generation.

---

## Example flow

User: "Audit `docs/specs/implementation/core/orchestrator.md` against `docs/specs/analysis/core/orchestrator.md`."

1. Read both specs end-to-end.
2. Enumerate concrete claims in the analysis. Check each against the implementation spec. Find 22 potential gaps spanning all categories.
3. Write `orchestrator.conformance.md` with all 22.
4. Spawn 22 subagents in one turn.
5. Results: 6 false positives (the implementation covered the claim in a different section than expected). 14 real gaps with concrete patches. 2 deferred — both because the analysis flagged OQ-3 ("debounce interval depends on caller config") and the implementation would need to actually pick a value or document a sourcing strategy.
6. Apply 14 patches across the implementation spec — 4 `add` operations (missing error modes, missing logging), 8 `modify` operations (weakened contracts restored to concrete), 2 `annotate` operations (justifying TS-specific type design). Add 2 entries to a Deferred Design Decisions section. Append the audit log. Save the conformance report.
7. Summarize: "Implementation spec patched: 14 gaps closed, 6 false positives, 2 design decisions deferred (DD-1: debounce interval policy; DD-2: caller-supplied retry budget). Audit complete."

---

## Where this fits in the SpecOps pipeline

This skill is a pre-implementation gate. The full verification chain looks like:

1. Generate analysis spec from legacy source.
2. Run **specops-ambiguity-audit** on the analysis spec — hardens it by removing internal ambiguity.
3. Domain experts verify the analysis spec.
4. Generate implementation spec from the verified analysis.
5. Run **specops-spec-conformance** (this skill) — verifies the implementation faithfully derives from the analysis.
6. Generate code from the verified implementation spec.
7. (Optional, post-implementation) Re-analyze the generated code; diff against the original analysis to catch drift introduced during code generation.

Steps 2 and 5 are spec-level verification; step 7 is code-level verification. Each catches a different class of drift, and they compound.
