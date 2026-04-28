---
name: specops-implementation-drift
description: Audit migrated code by re-running the SpecOps analysis on the new target folder, comparing it against the original analysis spec, and generating corrective specs for each behavioral divergence so the next code-generation iteration converges toward the original behavior. Use this skill whenever the user mentions checking whether migrated code preserves original behavior, comparing migrated code against the original analysis, finding drift between legacy and migrated implementations, post-implementation verification, generating correction specs from a code analysis diff, closing the loop on a code-gen iteration, or reanalyzing a migrated module. Also trigger when the user describes "does the new code do what the old code does," "find where the migration drifted," "diff the migrated implementation against the spec," or "generate corrective specs based on a code diff." Run this after any round of code generation in a SpecOps migration, then iterate until corrections converge.
---

# SpecOps Implementation Drift Audit

After a round of code generation in a SpecOps migration, the question is: does the migrated code actually do what the legacy code did? Spec-level audits (ambiguity, conformance) can verify that the *specs* are sound, but they can't see what the code generator actually produced. Bugs introduced during code generation — dropped error handlers, weakened concurrency, lost edge cases — are invisible to spec audits.

This skill closes the loop. It re-runs the SpecOps analysis on the migrated code (treating it as if it were itself "legacy"), then diffs that new analysis against the original analysis to find behavioral divergences. For each real divergence, it generates a corrective spec describing what needs to change so the next code-gen iteration moves toward convergence.

The cycle is: code-gen → drift audit → corrections → code-gen → drift audit → ... until corrections become insignificant.

## Inputs

Confirm with the user before starting:

- **Original analysis spec** — the verified analysis derived from legacy code (e.g., `docs/specs/analysis/core/orchestrator.md`).
- **Migrated source files** — the code produced by the most recent code-gen iteration (e.g., `src-ts/core/orchestrator.ts` and related files).
- **Analysis prompt** — the project's existing analysis prompt template (typically `docs/specops/analysis-prompt.md`). The same prompt that produced the original analysis must be used here, otherwise the diff is comparing apples to oranges.
- **Output locations** (defaults shown — all generated artifacts live under `analysis-target/`, mirroring the structure of the original `analysis/` directory so the two trees can be diffed directly):
  - Re-analysis of migrated code: `docs/specs/analysis-target/<module-path>.md`
  - Drift report: `docs/specs/analysis-target/<module-path>.drift.md`
  - Corrective specs: `docs/specs/analysis-target/<module-path>.corrections.md`

  Example: if the original is `docs/specs/analysis/core/orchestrator.md`, the re-analysis goes to `docs/specs/analysis-target/core/orchestrator.md`, with `.drift.md` and `.corrections.md` siblings.

If the user names only the module, infer the rest from the project's `analysis-orchestration.md` (which lists the source files and analysis output paths per module).

---

## Phase 1: Re-analyze the migrated code

Spawn a single subagent that runs the project's analysis prompt against the migrated source files, producing a fresh analysis spec. Use exactly the same prompt template and section structure as the original analysis — symmetry is essential for the diff to be meaningful.

### Subagent prompt (re-analysis)

```
You are running a SpecOps analysis on a migrated implementation. Use the project's analysis prompt template, with the migrated source files as the input.

# Analysis prompt template
<contents of docs/specops/analysis-prompt.md>

# Module variables
- MODULE_NAME: <module name, matching the original analysis>
- SOURCE_FILES: <list of migrated source file paths>

# Your task
Read the source files completely. Produce the analysis spec following the prompt's section structure exactly. Be exhaustive within each section — match the rigor of the original analysis. Describe behavior in implementation-language-agnostic terms (no language-specific syntax in prose).

# Output
Write the resulting analysis to: <path to migrated analysis output>
```

This subagent runs alone (the analysis is one cohesive task). Wait for it to finish before Phase 2.

---

## Phase 2: Diff and classify divergences

Read both analyses end-to-end. Enumerate every concrete behavioral claim in the original analysis and check whether the migrated analysis reflects it. Also enumerate claims in the migrated analysis that have no counterpart in the original (additions or scope drift).

### Filtering noise

Both analyses are LLM-generated descriptions of code behavior. Many surface-level "differences" are just prose variation describing the same behavior. The diff must distinguish real behavioral divergence from prose noise. The unifying test:

> *"If both analyses are accurate descriptions of their respective code, would a caller observe a different behavior?"*

If not, the difference is cosmetic and should be filtered out.

### Categories of divergence

**Missing behavior**
- The original describes a behavior; the migrated analysis makes no mention of it.
- Most often: error modes, edge cases, side effects (logging is the classic), invariants.

**Weakened behavior**
- The original is concrete; the migrated is vague.
- "Atomic write through single-writer queue" → "writes the status file"; "exactly three retries with exponential backoff" → "retries on failure".

**Changed behavior**
- The migrated does something incompatible with the original.
- Different default values, different error categories, different ordering, different concurrency model.

**Lost edge case or error mode**
- The original enumerates N cases; the migrated handles fewer.

**Type / schema drift**
- Field types, optionality, valid ranges differ between analyses.

**Side-effect drift**
- Logging dropped, file operations changed, network behavior altered.

**Dependency drift**
- The original lists a dependency; the migrated removes it (or adds one not justified by the original).

**Unjustified addition**
- The migrated has behaviors not present in the original. Sometimes legitimate (TS-specific runtime checks that preserve observable behavior); often scope creep that should be removed.

### Severity classification

Classify each real divergence:

- **Critical** — observable behavior change. A caller, test, or downstream system would see a different result. These block convergence; they must be corrected before the migration is considered done.
- **Important** — internal contract violation that may not show up in normal use but breaks an invariant the original maintains (concurrency, ordering, atomicity, resource cleanup). These should be corrected; they tend to surface as production bugs.
- **Cosmetic** — naming, structure, organization, or prose-level differences without behavioral impact. These can be ignored or addressed opportunistically.

### Output of Phase 2

Write the drift report to `docs/specs/analysis-target/<module-path>.drift.md`:

```markdown
# Drift Report: <module>

- **Original analysis:** <path>
- **Migrated analysis:** <path>
- **Migrated source:** <list>
- **Audited:** <date>

## Divergences

### D1
- **Type:** Missing behavior
- **Severity:** Critical
- **Original section:** Behavioral Contracts
- **Original claim:** "Status writes are serialized through a single-writer queue to prevent torn reads under concurrent access."
- **Migrated analysis:** Section 4 describes status writes as direct file writes; no mention of serialization.
- **Question for subagent:** Verify divergence is real by inspecting migrated code. If real, generate a correction spec.

### D2
- **Type:** Weakened behavior
- **Severity:** Important
- **Original section:** Error Handling
- **Original claim:** "Retries up to 3 times with exponential backoff (100ms, 200ms, 400ms)."
- **Migrated analysis:** "Retries with backoff."
- **Question for subagent:** Is the migrated code actually doing the right thing (analysis is just imprecise) or is the retry behavior actually different?

### D3
- **Type:** Unjustified addition
- **Severity:** Cosmetic (pending verification)
- **Migrated claim:** "All public functions return Result<T, E> discriminated unions."
- **Original equivalent:** Original describes errors as thrown.
- **Question for subagent:** Does this preserve observable behavior at the module boundary, or does it change how callers must consume the API?

...
```

The audit runs end-to-end without pausing. Phase 2 produces the divergence list; Phase 3 starts immediately.

---

## Phase 3: Verify and generate corrective specs via parallel subagents

Spawn one subagent per divergence, all in the same turn. Each subagent's job is to verify the divergence is real (by reading the migrated code, not just the analyses) and produce the correction spec content.

### Subagent prompt template

```
You are verifying a single behavioral divergence in a SpecOps drift audit and generating a corrective spec entry. The original analysis describes the legacy code's behavior; the migrated analysis describes the migrated code's behavior. Your job is to (1) confirm whether the divergence is real by reading the actual migrated code, and (2) if real, produce a correction spec that describes what must change.

# The divergence
- Type: <type>
- Severity: <severity>
- Original section: <section>
- Original claim: "<quoted original behavior>"
- Migrated analysis: "<what migrated analysis says>"
- Question: <verification question>

# Documents to read
- Original analysis spec: <path>
- Migrated analysis spec: <path>
- Migrated source files: <list>
- (Optional) Legacy source files: <list> — read only as a tiebreaker if the original analysis is itself ambiguous

# Your task
1. Read the relevant sections of both analyses.
2. Read the migrated code directly. The migrated analysis is an LLM-generated description and may itself be imprecise — the code is ground truth for what currently exists.
3. Determine whether the divergence is real:
   - If the migrated code actually preserves the original behavior and only the migrated analysis was imprecise, report `divergence_real: false` and quote the relevant lines of migrated code.
   - If the migrated code actually behaves differently, the divergence is real.
4. For "Unjustified addition" cases, decide:
   - Legitimate translation choice (preserves observable behavior at module boundary, justified by target language idioms) — `divergence_real: true` but `correction_needed: false`. The correction spec just annotates the rationale.
   - Scope expansion or behavior change — `divergence_real: true, correction_needed: true`.
5. If a correction is needed, produce a correction spec entry that describes what must change in the migrated code, in implementation-language-agnostic terms. Specify the required behavior, not the exact code. Leave the implementer free to choose mechanism as long as the behavioral contract is met.

# Output format
Return a JSON object only:

{
  "divergence_id": "<like D1>",
  "divergence_real": <true | false>,
  "correction_needed": <true | false>,
  "code_evidence": [
    {"file": "<migrated file>", "lines": "<range>", "excerpt": "<relevant code>"}
  ],
  "correction_spec": {
    "title": "<short title>",
    "severity": "<critical | important | cosmetic>",
    "original_behavior": "<concise statement of what the original does>",
    "current_behavior": "<concise statement of what the migrated currently does>",
    "required_change": "<what must be true after the fix, behaviorally>",
    "constraints": "<any invariants the fix must preserve>",
    "rationale": "<why this matters: what breaks if not corrected>"
  },
  "annotation_only": <true | false>,
  "annotation_note": "<if annotation_only is true: the rationale for accepting the divergence>"
}
```

### Running the subagents

Spawn all subagents in one turn. Each runs independently and reads the migrated code directly — the analyses are starting points, the code is the source of truth.

If the host has no subagent capability, fall back to processing each divergence serially in the main loop using the same prompt and output format.

---

## Phase 4: Assemble corrections and assess convergence

When all subagents return:

1. **Sort results.**
   - `divergence_real: false` — false positive (migrated analysis was imprecise; migrated code actually matches). Note in drift report; no correction needed.
   - `divergence_real: true, correction_needed: false` — legitimate translation choice. Generate an annotation entry rather than a correction.
   - `divergence_real: true, correction_needed: true` — generate a correction entry.

2. **Write the corrections file** at `docs/specs/analysis-target/<module-path>.corrections.md`:

   ```markdown
   # Corrections: <module>

   - **Source:** Drift audit on <date>
   - **Migrated source:** <list>
   - **Drift report:** <path>

   ## Required corrections

   ### CS-1: <title>
   - **Severity:** Critical
   - **Original behavior:** <from subagent>
   - **Current behavior:** <from subagent>
   - **Required change:** <from subagent>
   - **Constraints:** <from subagent>
   - **Rationale:** <from subagent>
   - **Code reference:** <file:lines from evidence>

   ### CS-2: <title>
   ...

   ## Accepted divergences (annotations)

   ### AN-1: <title>
   - **Original behavior:** <...>
   - **Migrated behavior:** <...>
   - **Why accepted:** <legitimate translation rationale>
   ```

3. **Update the original analysis spec's audit log.** Append:

   ```markdown
   ### <YYYY-MM-DD> — Drift audit (post code-gen iteration <N>)
   - Migrated source: <list>
   - Migrated analysis: `<path to migrated analysis>`
   - Divergences identified: <count>
   - False positives (analysis was imprecise, code matches): <count>
   - Real corrections needed: <count> (Critical: <n>, Important: <n>, Cosmetic: <n>)
   - Accepted as legitimate translation: <count>
   - Drift report: `<path>`
   - Corrections: `<path>`
   ```

4. **Assess convergence.** Compute:
   - Critical corrections remaining: <count>
   - Important corrections remaining: <count>
   - Cosmetic-only corrections remaining: <count>

   Recommend:
   - Any Critical → another code-gen iteration is required.
   - Important > 0 and Critical = 0 → another iteration is recommended; behavioral correctness is close but invariants are at risk.
   - Cosmetic-only or empty → migration of this module has converged.

5. **Summarize for the user.**
   - Counts by severity.
   - Convergence recommendation.
   - The corrections file path so the user can feed it into the next code-gen iteration.
   - If applicable, a "diff trajectory" line: how the count compares to the prior drift audit on the same module (improving, plateauing, regressing).

---

## Important behaviors

- **Run end-to-end without stopping.** The audit is automated. Don't pause between phases. The user reviews the drift report and corrections asynchronously.
- **The migrated code is ground truth, not the migrated analysis.** Both analyses are LLM-generated descriptions; subagents must read the actual migrated code to verify each divergence. False positives where "the analysis was imprecise but the code is fine" are common and expected.
- **Use the same analysis prompt as the original.** Symmetry between the two analyses is what makes the diff meaningful. If the project's analysis prompt has changed since the original analysis was generated, regenerate the original analysis first or note the asymmetry in the drift report.
- **Most divergences are mechanical and obvious.** Missing logging, dropped error handlers, weakened concurrency primitives. Subagents resolve these confidently.
- **Severity matters more than count.** A single Critical correction blocks convergence; ten Cosmetic ones don't. Reports lead with severity counts, not totals.
- **Corrections describe behavior, not code.** A correction says "status writes must be serialized" — not "use a worker thread." The implementer chooses the mechanism; the spec defines the contract.
- **Track convergence across iterations.** Each drift audit on the same module should produce fewer and less-severe corrections. If the count plateaus or grows, the code-gen process has a systematic blind spot — surface it to the user rather than continuing to iterate.
- **Re-audit after every code-gen round.** This skill is the iteration gate; running it once isn't the goal. The goal is repeated runs that drive convergence.

---

## Example flow

User: "Run a drift audit on the orchestrator module. The migrated code is in `src-ts/core/orchestrator.ts`."

1. Look up the original analysis (`docs/specs/analysis/core/orchestrator.md`) and the project's analysis prompt.
2. Spawn one subagent to re-analyze `src-ts/core/orchestrator.ts` using the same prompt; write to `docs/specs/analysis-target/core/orchestrator.md`.
3. Read both analyses. Enumerate 19 potential divergences across all categories.
4. Write `docs/specs/analysis-target/core/orchestrator.drift.md`.
5. Spawn 19 subagents in one turn. Each reads the migrated code directly.
6. Results: 7 false positives (analysis was imprecise; code is fine). 9 real corrections needed (3 Critical, 4 Important, 2 Cosmetic). 3 accepted as legitimate translation choices (e.g., `Result<T, E>` in place of thrown errors, with module-boundary behavior preserved).
7. Write `docs/specs/analysis-target/core/orchestrator.corrections.md` with 9 CS entries and 3 AN entries.
8. Append to the original analysis's audit log.
9. Summarize: "3 Critical, 4 Important, 2 Cosmetic corrections needed. Migration has not converged — another code-gen iteration is required. Corrections file: `analysis-target/core/orchestrator.corrections.md`. Compared to the previous drift audit (which had 6 Critical), the migration is improving."

---

## Where this fits in the SpecOps pipeline

This skill is the post-implementation iteration gate. The full verification chain:

1. Generate analysis spec from legacy source.
2. **specops-ambiguity-audit** — hardens the analysis spec.
3. Domain experts verify the analysis spec.
4. Generate implementation spec from the verified analysis.
5. **specops-spec-conformance** — verifies the implementation spec faithfully derives from the analysis spec.
6. Generate code from the verified implementation spec.
7. **specops-implementation-drift** (this skill) — re-analyzes the generated code and diffs against the original analysis. If corrections are needed, feed them into another code-gen iteration. Repeat until convergence.

Steps 2 and 5 are spec-level verification (catching errors in description). Step 7 is code-level verification (catching errors in generation). Each catches a class of drift the others can't see, and they compound — running all three drives the migration toward behavioral fidelity faster than any one alone.
