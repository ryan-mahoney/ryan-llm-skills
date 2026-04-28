---
name: specops-spec-coherence
description: Audit a set of SpecOps analysis specs for cross-spec coherence — establish a dependency-ordered implementation sequence, then verify pairwise integration contracts at module boundaries plus three cross-cutting consistency dimensions (shared data models, side-effect ownership, terminology) — and patch the affected specs to resolve gaps. Use this skill whenever the user mentions cross-spec consistency, integration gaps between specs, conflicts between specs, duplicate work across specs, implementation order, dependency order for migration, building an implementation-order checklist, ensuring specs interoperate, terminology drift across specs, or shared data model conflicts. Also trigger when the user describes "do my specs agree with each other," "what order should I implement these in," "find inconsistencies across all my specs," or asks to audit a folder of analysis specs as a set rather than individually. Run this once after generating a full set of analysis specs, before deriving implementation specs.
---

# SpecOps Spec Coherence Audit

Each analysis spec is generated from a single module's source files in isolation. The result is a set of specs that are individually coherent but collectively under-coordinated. Two specs can each be internally correct and still disagree about the shape of a shared data structure, the owner of a shared resource, or the name of a shared concept.

This skill audits the entire set of analysis specs as a system. It produces five things:

1. An **implementation order** — a dependency-driven sequence for migration, written as a numbered checklist.
2. **Pairwise integration checks** — for each (depender, dependee) edge in the dependency graph, verify the contracts at the module boundary agree.
3. **Shared data model checks** — for each named structure that appears in multiple specs, verify all references agree on shape, optionality, and constraints.
4. **Side-effect ownership checks** — for each shared resource (file path, directory, env var, network port, lock), verify exactly one spec claims ownership.
5. **Terminology checks** — a global pass identifying domain terms used inconsistently across the set.

Findings from all five become patches applied to the relevant specs, with deferral for items that genuinely need a design decision.

## Inputs

Confirm with the user before starting:

- **Specs directory** — the folder containing analysis specs to audit as a set (e.g., `docs/specs/analysis/`). The skill operates on every spec in this tree.
- **Optional scope filter** — a subset of specs to audit (e.g., only `core/` and `ui/`) for incremental work. Default is the full tree.
- **Output locations** (defaults shown):
  - Implementation order: `docs/specs/implementation-order.md`
  - Coherence report: `docs/specs/coherence-audit.md`
  - Patches applied directly to individual specs, with entries appended to each spec's audit log.

If the project has an analysis-orchestration document (e.g., `docs/specops/analysis-orchestration.md`), read it first — it usually lists the canonical set of specs and their source-file groupings, which is faster than directory scanning.

---

## Phase 1: Build the dependency graph and implementation order

Read every spec in scope. From each spec's "Dependencies" section (and any internal references in other sections), extract:

- **Internal dependencies** — which other modules in the set this spec depends on.
- **External dependencies** — third-party libraries (recorded but not part of the graph).
- **System dependencies** — file system, env, network (recorded for the side-effect ownership pass).

Build a directed graph where each node is a spec and each edge is "X depends on Y." Detect cycles; if any exist, flag them as findings (a true cycle in legacy code is rare but possible — it indicates a shared mutable state or a bidirectional protocol that needs explicit handling in the implementation).

Produce a topological ordering with leaf modules first. When ties occur (multiple modules with no remaining dependencies at the same level), order by simplicity — smaller surface area first — to maximize the value of early implementations as building blocks.

### Output: implementation-order.md

```markdown
# Implementation Order

- **Generated:** <date>
- **Specs audited:** <count>
- **Cycles detected:** <count, with details>

This order is derived from the dependency graph across all analysis specs. Modules earlier in the list have fewer or simpler dependencies and should be implemented first. Each tier groups modules that are mutually independent and can be implemented in parallel.

## Tier 1 — Leaf modules (no internal dependencies)
- [ ] 1. `config` — <one-line summary>
- [ ] 2. `utils` — <one-line summary>

## Tier 2 — Depend only on Tier 1
- [ ] 3. `providers` — depends on: utils
- [ ] 4. `core/file-io` — depends on: config, utils

## Tier 3 — ...
...

## Cycles requiring resolution
- (none) | <list with the modules involved and the nature of the dependency>
```

This file is also a living checklist. As migration progresses, the user can check off items.

---

## Phase 2: Identify checks to run

From the dependency graph and a scan of all specs, enumerate four categories of checks. Each check becomes one subagent task.

### 2a. Pairwise integration checks

For each edge `(A → B)` in the graph (A depends on B), generate one check:

- **Question:** Do A's stated expectations of B's interface match B's stated public interface? Do A's data assumptions about what B returns match B's described return types? Do A's assumptions about B's error modes match B's stated error handling?

There are typically tens to a hundred such edges. They run in parallel.

### 2b. Shared data model checks

Scan all specs for named data structures (typically in Section 3 of each analysis spec). Build an index: for each structure name (`Job`, `Task`, `Status`, `PipelineEvent`, etc.), list every spec that references it.

For each name appearing in 2+ specs, generate one check:

- **Question:** Do all references to `<name>` agree on its fields, types, optionality, and valid value ranges? If they disagree, what's the actual shape according to the source code?

A name appearing in only one spec needs no check.

### 2c. Side-effect ownership checks

Scan all specs (typically Sections 5 and 7 — State Management and Side Effects) for shared resources:

- File paths and directories
- Environment variables
- Network ports and bind addresses
- Lock files and named mutexes
- Database tables, queues, channels
- Process names

For each resource referenced by 2+ specs, generate one check:

- **Question:** Which spec creates this resource? Which read it? Which write to it? Is there exactly one owner? Are reader/writer relationships consistent with concurrency claims in the affected specs?

### 2d. Terminology check (global)

A single check, not parallelized. Build a glossary of domain terms used across all specs (entities like "job", "task", "execution", "run", "pipeline"; verbs like "submit", "enqueue", "dispatch", "trigger"). For each cluster of terms that may refer to the same concept, generate a glossary entry showing where each variant appears.

---

## Phase 3: Spawn subagents

All checks fan out in parallel. Use one subagent per check from 2a, 2b, and 2c, plus one subagent for 2d.

### Subagent prompt template — pairwise integration

```
You are auditing the integration contract between two SpecOps analysis specs. Your job is to determine whether the depender's assumptions match the dependee's stated interface, and propose patches if they don't.

# The pair
- Depender (A): <path>
- Dependee (B): <path>
- Edge nature: <function call | data flow | event subscription | etc.>

# Your task
1. Read both specs. Focus on: A's references to B (what A assumes B provides, accepts, returns, throws); B's Public Interface section, Data Models section, and Error Handling section.
2. Identify any mismatch:
   - A calls B's function with arguments B doesn't accept
   - A consumes a return shape B doesn't produce
   - A assumes B handles an error mode B doesn't describe
   - A assumes ordering/concurrency B doesn't guarantee
   - A and B disagree on a side effect (e.g., A says B creates the directory; B says A creates it)
3. For each mismatch, propose a patch to A, B, or both — specifying which side to change.

# Output
{
  "edge": "A → B",
  "mismatches": [
    {
      "type": "<argument | return | error | concurrency | side_effect_ownership>",
      "description": "<what disagrees>",
      "evidence": [{"spec": "<A or B>", "section": "<section>", "excerpt": "<quote>"}],
      "patch": [
        {"spec": "<A or B>", "section": "<section>", "operation": "<add | modify | annotate>", "before": "...", "after": "...", "rationale": "..."}
      ],
      "deferred": <true | false>,
      "defer_reason": "<if deferred>"
    }
  ]
}
```

### Subagent prompt template — shared data model

```
You are auditing whether all specs that reference a shared data structure agree on its shape.

# The structure
- Name: <e.g., Job>
- Specs that reference it: <list>

# Your task
1. Read every listed spec's references to <name>. Note the fields, types, optionality, valid ranges, and lifecycle each spec describes.
2. Build a unified picture: are there contradictions, omissions, or extensions?
3. If contradictions exist, the source code is the tiebreaker. The original analysis spec generation may have introduced inconsistency that the source resolves cleanly.
4. Produce patches: usually, one spec is "right" and others should be aligned to it. Sometimes all are wrong and need correction. Each patch targets a specific spec.

# Output
{
  "structure_name": "<name>",
  "specs_affected": [<list>],
  "canonical_shape": "<the agreed-upon shape, prose>",
  "inconsistencies": [
    {
      "spec": "<path>",
      "section": "<section>",
      "issue": "<what's wrong>",
      "patch": {"operation": "...", "before": "...", "after": "...", "rationale": "..."}
    }
  ],
  "deferred": <true | false>
}
```

### Subagent prompt template — side-effect ownership

```
You are auditing ownership of a shared resource across multiple specs.

# The resource
- Resource: <e.g., the directory `pipeline-data/jobs/<id>/status.json`>
- Specs that reference it: <list>

# Your task
1. For each spec, identify what role it plays toward this resource (creates / reads / writes / deletes / watches / locks).
2. Determine whether ownership is well-defined: exactly one creator, clear writer protocol, consistent reader assumptions.
3. Identify gaps: nobody creates it, multiple specs claim creation, conflicting concurrency assumptions, etc.
4. Produce patches that establish a single owner and align reader/writer claims.

# Output
{
  "resource": "<resource>",
  "specs_affected": [<list>],
  "intended_owner": "<spec path>",
  "issues": [
    {"type": "<no_owner | multiple_owners | reader_writer_conflict | concurrency_mismatch>", "description": "...", "patches": [...]}
  ],
  "deferred": <true | false>
}
```

### Subagent prompt template — terminology

```
You are performing a single global terminology audit across all SpecOps analysis specs in a set.

# Specs in scope
<list of all spec paths>

# Your task
1. Build a glossary of domain terms used as nouns or verbs across the specs. Focus on entities the system reasons about (job, task, run, execution, pipeline, stage, step) and verbs that act on them (submit, enqueue, dispatch, trigger, run, execute).
2. Cluster terms that appear to refer to the same concept. Within each cluster, identify the term that appears most consistently or matches the source code's actual identifiers.
3. For each spec that uses a non-canonical term, propose a patch that aligns it with the canonical term — preserving any place where the term is intentionally distinct (e.g., a "task" inside a "job" is a different concept than the "job" itself; don't collapse those).

# Output
{
  "glossary": [
    {
      "canonical_term": "<term>",
      "definition": "<one-line>",
      "variants_seen": ["<variant>", "<variant>"],
      "patches": [
        {"spec": "<path>", "section": "<section>", "before": "...", "after": "...", "preserves_distinction": <true | false>}
      ]
    }
  ],
  "deferred": [<terms where the canonical choice needs a human decision, with context>]
}
```

---

## Phase 4: Aggregate, patch, and report

When all subagents return:

1. **Collect all patches** across all four check types. Group them by target spec — a single spec often receives patches from multiple sources (a pairwise check, a data model check, and a terminology check might all touch the same section).

2. **Reconcile patch overlaps.** If two patches modify the same passage of the same spec, merge them into a single coherent edit. If they conflict, prefer the patch with the strongest evidence (source code > pairwise > terminology) and log the conflict.

3. **Apply patches to each affected spec.** Append an entry to each spec's audit log:

   ```markdown
   ### <YYYY-MM-DD> — Coherence audit (cross-spec)
   - Patches applied: <count>
   - Sources: <pairwise | data_model | side_effect | terminology>
   - Coherence report: `<path>`
   ```

4. **Write the coherence report** at `docs/specs/coherence-audit.md`:

   ```markdown
   # Coherence Audit

   - **Audited:** <date>
   - **Specs in scope:** <count>
   - **Implementation order:** `implementation-order.md`

   ## Summary
   - Pairwise edges checked: <count>
   - Pairwise mismatches found: <count> (resolved: <n>, deferred: <n>)
   - Shared data structures checked: <count>
   - Data model inconsistencies: <count> (resolved: <n>, deferred: <n>)
   - Shared resources checked: <count>
   - Ownership issues: <count> (resolved: <n>, deferred: <n>)
   - Terminology variants normalized: <count>
   - Total patches applied: <count> across <n> specs
   - Cycles in dependency graph: <count>

   ## Findings by category
   <per-category sections with details>

   ## Deferred items
   <items needing design decisions, with full context per the deferral schema>

   ## Glossary
   <canonical terms and definitions>
   ```

5. **Write/update the implementation order file** with any cycles discovered, plus the dependency tier listing.

6. **Summarize for the user.**
   - The implementation-order.md is ready as a checklist.
   - The coherence audit found N issues across the set; M resolved, K deferred.
   - The audit completes regardless of deferrals; the spec set is now internally coherent except for the K deferred items, which are logged with context.

---

## Important behaviors

- **Run end-to-end without stopping.** Phases 1–4 chain automatically. The user reviews artifacts asynchronously.
- **Pairwise is the primary axis; cross-cutting checks fill the gaps.** Most integration mismatches surface as pairwise findings. The data model, ownership, and terminology passes catch what pairwise structurally cannot see (N-way conflicts, global naming, exclusive ownership).
- **Patches are minimal and targeted.** This skill applies many small edits across many specs, not large rewrites. Each patch has a single rationale and a single source check that produced it.
- **Source code is the tiebreaker.** When two specs disagree about a shared structure or behavior and neither is obviously right, subagents may read the legacy source to determine the canonical answer.
- **The glossary is a deliverable.** Even if no terminology patches are applied, the glossary in the coherence report is a reusable artifact for downstream implementation specs and code review.
- **Deferral is uncommon but real.** Coherence issues that need a design decision (e.g., "two modules both reasonably claim to own the status directory; which is canonical?") are logged with context per the same deferral pattern as the other skills.
- **Re-audit after material changes.** After any spec is regenerated or significantly edited, the coherence audit may need to re-run. Tracking the count over time is a useful signal: a stable, low number means the spec set is converging toward coherence.
- **Run before deriving implementation specs.** The output of this skill is the input to the implementation-spec generation phase. Implementing from incoherent analysis specs guarantees the incoherence propagates into implementation specs and then code.

---

## Example flow

User: "Run a coherence audit on `docs/specs/analysis/`."

1. Read all 17 specs. Extract dependencies. Build the graph. Topologically sort.
2. Write `docs/specs/implementation-order.md` with 5 tiers, leaf modules (`config`, `utils`) first, UI components last. No cycles detected.
3. Identify checks: 34 pairwise edges, 8 shared data structures (Job, Task, PipelineEvent, Status, etc.), 6 shared resources (status directory, artifact directory, SSE endpoint, etc.), 1 global terminology check.
4. Spawn 49 subagents in one turn.
5. Results:
   - Pairwise: 34 edges, 11 mismatches (mostly: A's calls to B use parameters B doesn't document; B describes return fields A doesn't consume).
   - Data models: `Job` referenced in 9 specs, 3 disagree on the `status` enum values; `PipelineEvent` referenced in 4 specs, all agree.
   - Ownership: status directory is created in 2 specs simultaneously; artifact directory has no documented creator.
   - Terminology: "job" and "execution" used interchangeably in 5 specs; "stage" and "step" overlap in 3.
6. Apply 31 patches across 14 specs. Defer 4 items (mostly ownership questions where the source code is genuinely ambiguous).
7. Write `coherence-audit.md` with full findings and the glossary.
8. Summarize: "Implementation order generated (5 tiers). 49 checks run, 31 patches applied across 14 specs, 4 design decisions deferred. Spec set is coherent enough to proceed to implementation-spec generation; the deferred items are logged in the coherence report and don't block."

---

## Where this fits in the SpecOps pipeline

This skill operates on the full set of analysis specs after they're individually generated. Updated pipeline:

1. Generate analysis spec from each module's legacy source.
2. **specops-ambiguity-audit** — hardens each analysis spec individually (per-spec).
3. **specops-spec-coherence** (this skill) — audits the set as a system; produces implementation-order.md and patches cross-spec gaps.
4. Domain experts verify the now-coherent analysis spec set.
5. Generate implementation specs in dependency order (per implementation-order.md).
6. **specops-spec-conformance** — verifies each implementation spec faithfully derives from its analysis spec.
7. Generate code from verified implementation specs.
8. **specops-implementation-drift** — re-analyzes generated code, diffs against analysis, produces corrections; iterate until convergence.

The four skills together cover the four classes of drift: within-spec (ambiguity), cross-spec (coherence), spec-to-spec downstream (conformance), spec-to-code (drift). Each catches a class the others structurally cannot see.
