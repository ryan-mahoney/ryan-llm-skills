# Research-only integration proposal

**Status:** design for a bounded research comparison. This branch does not implement
this path in the managed runtime or change production routing.

The [configuration assessment](CONFIGURATION.md) selects the provisional writing
candidate from the completed tuning sequence: small assignments, bounded catalog
lookup, four concurrent DeepSeek writers, and no optional grouping or Jev routing.
Its lower observed writing time does not establish a quality-preserving or complete
workflow improvement. Integration must measure the existing owner's work, query
planning, writing, required checks and separate review together.

The proposed sequence is:

```text
Prepared step and current source
                 ↓
Existing DeepSeek step owner settles the implementation brief
                 ↓
Sol binds the brief to source and compiles writer packets
                 ↓
Deterministic optimizer; optional Jev advice on context choices
                 ↓
DeepSeek bounded writers apply the packets to a private candidate
                 ↓
Existing required test/verification gates and spec_complete handoff
                 ↓
Coordinator's separate independent step review
```

The existing owner retains implementation reasoning and decides behavior, architecture,
interfaces, preservation rules and acceptance obligations. The Sol query planner receives
that settled brief and deterministic source metadata; it translates decisions into exact
source bindings, file ownership and a dependency graph. It does not re-decide the design,
inspect writer output, or review the resulting diff. Deterministic optimization may group
only work whose ownership and dependencies prove it safe. Jev may advise context choices;
its advice is optional, recorded and non-authoritative. Writers remain on the explicitly
selected DeepSeek route.

Permit one pre-dispatch planner correction when plan validation rejects a source binding,
before any writer starts. The experimental `catalog-lookup` route additionally permits
one batch of bounded source requests before the final plan: at most eight requests and
64,000 source characters, with a 160 KiB complete serialized request limit. Sol can use
exact symbols, literal searches, a bounded file tail or a small whole file. The local
resolver supplies exact source slices, hashes and unique bindings. This route makes at
most three Sol calls, including its optional lookup and validation correction; catalog
mode without lookup retains its 80 KiB request limit. In lookup mode, malformed JSON
may use the same single correction allowance as a rejected plan; the three-call
ceiling still counts the malformed response. These limits are research settings,
not measured production defaults.

After dispatch, do not call Sol to review, replan or repair the
writer batch. A writer may receive one local application retry for a rejected edit format,
stale anchor or syntax/application failure; that retry returns the application error and a
bounded summary to the same writer before the candidate changes. A failed required test or
other acceptance gate remains a visible failure for ordinary workflow resolution, not an
automatic model review loop.

## Historical evidence

The [small-workload findings](FINDINGS.md) and [hard-workload findings](HARD-FINDINGS.md)
describe earlier mixed-model runs. The Sol + Nemotron backend did not completely deliver
any of the six harder tasks. Those runs do not test the proposed DeepSeek-owner / Sol-query /
DeepSeek-writer sequence.

The [Sol-only development protocol](ITERATION-PROTOCOL.md) records improvements to bounded
patches, deterministic execution, source-range composition and test feedback. Those changes
remain in the research backend. The later [Sol owner / DeepSeek editor experiment](OWNER-EDITOR-FINDINGS.md)
reported differing results across its three configurations and exposed planning, editor,
repair and time costs. It is historical evidence for that route, not a reliability claim for
DeepSeek owners or for the architecture proposed here.

Earlier runs also showed that fixed tests can miss an incorrect dirty filename. Preserve
relevant helper contracts and discovered boundary cases in acceptance coverage. A benchmark
pass does not establish complete spec compliance.

## Existing managed-runtime seams

The repository already owns process, checkout and acceptance boundaries. Any research
prototype must attach to those boundaries rather than publish edits itself.

| Seam | Current responsibility | Research integration obligation |
|---|---|---|
| [Managed dispatch](../../pi/extensions/spec-runtime/runtime.mjs) and [tool schema](../../pi/extensions/spec-runtime/index.ts) | `spec_dispatch` launches a retained owner under the selected owner model; `spec_editor` launches fresh bounded editor sessions under the selected editor model. The runtime owns the checkout lock, process lifetime and cancellation. | Add an explicit, opt-in query-and-dispatch route. Keep the owner and writer selectors explicit. The Sol query call must finish before dispatch; writers must use the existing lease and private candidate. |
| [Step owner profile](../../pi/agents/spec-step-owner.md) | The owner reads source, chooses the approach, sends bounded assignments, uses `spec_verify` for focused commands, records handoff with `spec_complete`, and leaves independent review to the coordinator. | Have the owner produce the settled brief once. The query planner compiles it; it does not replace the owner's decisions or add another implementation-analysis pass. |
| [Editor boundary](../../pi/extensions/spec-runtime/index.ts) and [paired execution contract](../../skills/spec-step-run/references/paired-execution.md) | `spec_editor` accepts one assignment or two to four disjoint path-fenced packets. Editors do not run verification; the owner cannot verify while editor work is active. | Map each packet to a bounded DeepSeek writer with exact reads, one owned destination and dependency ordering. Keep any application retry local to that packet and before candidate application. Do not add a post-dispatch Sol review or repair stage. |
| [Completion contract](../../pi/extensions/spec-runtime/completion.mjs) | `spec_complete` records decisions, evidence and learning; it does not accept independent review or certify evidence. | Preserve canonical receipts and handoff semantics. The outer coordinator's independent review/fix cycle remains a separate downstream workflow. |
| [Research executor](../changeset/engine.mjs) and [workspace](../changeset/workspace.mjs) | The prototype compiles dependencies and stages exact edits in a private workspace. | Adapt only its source binding, dependency and candidate-application behavior. Its standalone model, budget and publication adapters are not managed-runtime authority. |

## Integration obligations

1. **Keep the route opt-in and bounded.** Owner brief, Sol query calls, optional advice,
   deterministic planning and DeepSeek writer calls must be separately attributable in
   receipts. Keep complete request limits and model-call limits. Do not silently change
   provider or thinking selectors.
2. **Bind against current staged source.** Build the source catalog from the checkout at
   dispatch time. Give the planner only the unchanged owner brief, named file tree,
   protected paths, bounded source metadata and explicitly requested source excerpts.
   Ambiguous paths or missing anchors
   must block before any write; unresolved names remain discovery obligations, never
   inferred writable paths. A pre-dispatch correction can fix only these bindings.
3. **Preserve ownership and dependencies.** Each writer has a bounded packet and fenced
   write path. Grouping must preserve every original dependency and serialize overlapping
   writes. Dependent packets read updated staged source and use anchors valid at their
   execution point. Model-produced edits are applied only by the private candidate
   executor under the managed writer lease.
4. **Keep application retry local.** A rejected edit response may be retried once by the
   same writer with the concrete application error and bounded rejected-edit summary.
   The rejected attempt changes no candidate files. Do not turn syntax failures, failed
   tests, or semantic concerns into another Sol planning/review pass.
5. **Retain test-first and outer acceptance gates.** When a step requires test-first work,
   dispatch the test change first, run it through the existing focused verification path
   and observe the intended failure, then dispatch implementation and run the required
   final focused checks. Preserve changed-test commands, helper-contract checks, evidence
   applicability and known failures. A plan or application success is not acceptance.
6. **Keep verification and independent review distinct.** `spec_verify` runs necessary
   bounded checks after writers are inactive; it is not a Sol reviewer. `spec_complete`
   records the owner handoff. The coordinator's independent reviewer runs afterward under
   the normal workflow. No research planner or writer verdict can replace that review.
7. **Define failure and publication behavior.** Malformed plans, stale source, writer
   application failures, cancellation, crashes and failed gates need durable, actionable
   receipts. Keep candidate changes private until the existing owner/workflow accepts the
   required evidence and follows its normal commit path. The prototype's synchronous
   rollback alone is not evidence of crash-safe multi-file publication.

The source-edit representation remains an experiment choice. Compare native multi-file
patches with the operation vocabulary under the same owner brief, source context, DeepSeek
writers and outer acceptance policy. A single response or successful application does not
establish atomic publication or crash recovery.

## Evaluation

Compare the proposed route with the **current managed owner/editor process** on fresh real
steps, matched initial revisions and the same acceptance requirements. Earlier benchmark
timings used a native Pi baseline, not the managed `spec-end-to-end` process; its 24% mean
time reduction cannot be projected onto this workflow.

Count time through focused verification and the separate independent review, planning and
writer calls, reported tokens, equivalent cost, first-pass acceptance, application-retry
rate, failed-gate rate and operator interventions. Keep routing effects separate from
deterministic application and reduced handoffs. Predeclare the comparison and acceptance
rules; expand eligibility only after the evidence shows useful savings without observed
acceptance regression. Do not treat optional Jev advice as correctness evidence.
