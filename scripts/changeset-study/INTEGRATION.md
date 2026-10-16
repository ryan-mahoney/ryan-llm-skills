# Integrate changesets at the managed editor boundary

Proposed status: opt-in execution backend; not implemented by this branch.

`spec-end-to-end` already separates a capable step owner from bounded editors.
The owner chooses behavior, supplies current source context, and can dispatch two
to four closed packets concurrently when their write paths are disjoint. Changesets
can extend that existing boundary with deterministic application, dependency-aware
staging and fewer model calls. They do not require another workflow coordinator.

The recommendation follows the [small-workload findings](FINDINGS.md) and
[hard-workload findings](HARD-FINDINGS.md): start with capable planning and exact
executable edits. The current Sol + Nemotron backend did not completely deliver
any of the six harder tasks. Mixed-model routing has not demonstrated a
quality-preserving advantage in this study.

The subsequent Sol-only development implements bounded patches, execution-aware
review, direct deterministic plans, source-range composition, candidate-test
feedback and unchanged-helper context for review. The [development protocol](ITERATION-PROTOCOL.md) preserves
the original tasks and one repair opportunity. These changes are in the research
backend; the earlier mixed-model campaign remains frozen. Evaluate the revised
backend on fresh cases before allowing it to own managed step delivery.

The development runs also exposed an acceptance gap: a candidate could pass the
fixed tests while reporting an incorrect dirty filename. Keep review supplied
with relevant helper contracts beyond the diff, and retain discovered boundary
cases as acceptance coverage. Passing a benchmark is not sufficient evidence of
complete spec compliance.

## Proposed execution path

```text
Prepared step + current source/context pack
                  ↓
Retained step owner settles a coherent batch
                  ↓
spec_editor: existing assignment OR executable changeset
                  ↓
Managed writer lease → private candidate → dependency scheduler
                  ↓
Owner assesses batch + spec_verify runs required focused gates
                  ↓
Bounded repair or ordinary editor fallback when needed
                  ↓
Existing commit → spec_complete → independent step review
```

Use the owner already present in the process as the planner. Adding another planner
would duplicate reasoning and could consume the savings. Compile exact operations
against source available when the step executes, after prerequisite steps land.
Prepared specifications should carry behavior, scope, preservation constraints and
acceptance requirements; they need not freeze fragile text anchors in advance.

## Code and instruction seams

Paths in this table are relative to the repository root; links resolve from this file.

| Seam | Existing responsibility | Proposed addition |
|---|---|---|
| [Tool schema](../../pi/extensions/spec-runtime/index.ts) | `spec_editor` accepts one assignment or disjoint packets. | Add a mutually exclusive changeset input or an explicit execution mode. Preserve ordinary assignments. |
| [Managed runtime](../../pi/extensions/spec-runtime/runtime.mjs) | Writer leases, editor launches, cancellation, verification and receipts. | Run the compiled executor under the same authority; record operation and batch outcomes. |
| [Step owner](../../pi/agents/spec-step-owner.md) | Chooses transformations, attaches excerpts, assesses returned edits and runs verification. | Permit a settled changeset and one batch assessment; retain diagnosis and fallback authority. |
| [Paired execution contract](../../skills/spec-step-run/references/paired-execution.md) | Defines owner/editor responsibilities and bounded handoffs. | Describe eligibility, candidate state, failure recovery and test-first boundaries. |
| [Executor](../changeset/engine.mjs) and [workspace](../changeset/workspace.mjs) | Compile dependencies and stage exact or model-produced edits. | Adapt snapshot and publication to the managed checkout lifecycle. |
| [Completion](../../pi/extensions/spec-runtime/completion.mjs) | Records evidence and learning for the current revision. | Reference managed changeset receipts without creating a second acceptance ledger. |

The [prototype workflow](../changeset/workflow.mjs) contains its own verification/review callbacks.
Adapt those responsibilities to the existing owner, `spec_verify`, and independent
review. Do not invoke an extra research-review loop around the managed workflow.
Keep `spec_complete`, per-step commits, and coordinator reconciliation authoritative.

## Integration obligations

1. **Preserve writer ownership.** Bind executor work to the existing lease, path
   fences, cancellation and process-lifecycle rules. Models return candidate edits;
   they must not independently publish to the checkout. No overlapping owner checks
   or unmanaged writers during application.
2. **Snapshot only supported scope.** The prototype's whole-directory loader is too
   restrictive for a typical repository. Snapshot declared reads/writes plus required
   context, preserve pre-existing dirty contents, and reject or route unsupported
   inputs through the ordinary editor. Retain modes and file/directory transitions.
3. **Bind plans to source.** Capture hashes mechanically; never ask a model to guess
   them. Detect external changes before publication. Dependent operations must use
   preconditions and anchors valid for the updated candidate, not the initial file.
4. **Define publication and recovery.** Choose how required commands inspect a staged
   candidate and how accepted changes enter the managed checkout. Retain enough
   state to diagnose cancellation or a crash. The prototype's synchronous rollback
   is not sufficient evidence of crash-safe multi-file publication.
5. **Keep acceptance obligations.** Preserve behavioral gates, shared-helper contract
   checks and independent review. A test-first step needs a test batch, an observed
   intended failure, then an implementation batch; one final check cannot substitute.
   Execute new or changed candidate tests before the owner's assessment, and supply
   failures to repair. The research selector understands Node test declarations;
   production must use each repository's supported test runner and focused commands.
6. **Make fallback explicit.** Malformed plans, stale anchors, ambiguous behavior and
   failed checks return actionable results to the owner. Permit bounded repair, then
   the ordinary editor route without silently dropping files or acceptance criteria.
   Keep successful private draft work distinguishable from published work.
7. **Use existing telemetry.** Record planning, execution, verification, repairs,
   publication, review and fallback costs through managed receipts. The study's
   standalone provider and budget adapters are not the production authority path.

The edit representation is a separate choice from this integration boundary.
Compare a native multi-file patch batch with the prototype operation vocabulary
under the same planner, source context and review policy. Require the same private
staging and precondition checks for either format; a single patch response alone
does not establish atomic publication or crash recovery.

## Rollout and the next comparison

Start with opt-in, bounded steps whose behavior and source boundaries are settled.
Prefer deterministic operations; retain model operations for unresolved local
implementation details. Jev can advise eligibility or escalation, but it cannot
waive acceptance or establish correctness. Avoid a new mandatory changeset DSL in
every prepared spec until the backend earns its use.

Compare the new backend with **the current managed owner/editor process**, using
fresh real-repository steps, matched initial revisions, the same owner model and
acceptance requirements. The completed benchmark used a native Pi agent baseline,
not the managed `spec-end-to-end` process; its 24% mean-time reduction cannot be
projected onto the entire workflow.

Count elapsed time through independent review and accepted repairs, model calls,
reported tokens, equivalent cost, first-pass acceptance, fallback rate and operator
interventions. Include planning overhead and unsuccessful runs. Keep subscription
cost assumptions separate from latency and quota consumption. Predeclare the
comparison and acceptance rules before observing results.

Expand eligibility only after those comparisons show useful savings without an
observed acceptance regression. Evaluate cheaper model routing separately so its
effect can be distinguished from deterministic execution and reduced round trips.
