# Combined changeset dispatch

The opt-in `optimized-v4a` research profile connects the existing DeepSeek implementation owner and Sol query planner to deterministic changeset preprocessing, Jev advice, and DeepSeek V4A writers. It does not change the managed `spec-end-to-end` runtime or the historical default configuration.

```text
DeepSeek settles the implementation brief
  → Sol binds source and creates small writer packets
  → local validation and deterministic merge candidates
  → one batched Jev decision about grouping and context
  → deterministic optimization and dependency scheduling
  → up to four DeepSeek V4A writers on current staged source
      → guarded local application and syntax check
      → on a local failure: one same-model JSON edit fallback
  → existing outer verification and independent review
```

Sol finishes before any writer starts. It does not inspect writer results or plan repairs. Jev cannot change implementation requirements, authorize a dependency conflict, or waive verification. An unavailable or uncertain Jev answer leaves deterministic policy in charge. High-confidence advice can keep an eligible pair separate or request complete context for a bounded, independently owned small file. Unasked pairs are not described as Jev-approved.

## Preprocessing and execution

[`preprocessChangeset`](preprocess-changeset.mjs) is a callable preprocessing boundary for the owner integration. It accepts Sol's plan and the current source map, rejects invalid ownership or bindings, requests advice once, and returns the optimized plan, source/plan identities and transformation metrics. It does not execute writers or publish files. The research cell invokes it on behalf of the owner; a managed owner tool remains future integration work.

The optimizer combines at most two compatible assignments to the same file, including pairs separated by independent work. It deduplicates context and rewires dependencies. Consumers of an intermediate file state prevent merging. Instructions and requirements remain in the combined packet, and packet-size limits still apply. Binding checks for source changed by predecessors are deferred until the writer receives the actual staged state.

The existing executor runs independent operations concurrently and serializes read/write conflicts. Every writer owns one destination and receives bounded current excerpts, not the complete step. V4A application uses the guarded adapter from the capability pilot: ambiguous matches are rejected, paths are fenced, and existing line endings and EOF-newline presence are preserved.

The revised V4A input expands selected boundary lines, sorts them by source position and deduplicates overlaps. It supplies complete selected bodies within an explicit 64,000-character limit. It does not use the JSON writer's 32,000-character body-compaction policy: V4A cannot copy an omitted body by reference. Original selectors remain metadata for the settled recipe and JSON fallback. The primary contract requires one patch envelope, complete physical source lines and forward-only hunks; the applier's matching rules are unchanged. [Failure analysis](divergent/combined-dispatch/V4A-FAILURES.md) explains the observed incompatibilities. This context/prompt revision is a separate treatment from the initial comparison below.

A local format, path, application or syntax failure leaves the staged files unchanged. DeepSeek then gets the same assignment, bounded source excerpts, a bounded rejected-patch excerpt and an application diagnostic. It has one attempt to return the existing executable JSON edit vocabulary. That fallback supports source-range composition, so an unchanged source body can be copied without regeneration. It does not add a second V4A attempt or a general editing-agent loop. Transport, provider, output-length, cancellation and budget failures do not trigger this fallback.

Behavioral test failures are reported by the outer workflow after file modification. They never feed this fallback. Application success remains distinct from delivered correctness.

## Dispatch options and the lean profile

Both optimized profiles accept `dispatchOptions` (validated in [`dispatch-profile.mjs`](dispatch-profile.mjs)). `optimized-v4a` keeps the historical defaults; `optimized-lean` is the route the replay rounds under [`divergent/stacked-optimization/`](divergent/stacked-optimization/) recommend, and explicit options still override its fields. In the final side-by-side replays (twelve lean and nine reference passes, alternating, on the retained run18 plans) the lean route delivered 20 of 36 cells against the reference's 11 of 27, applied 30 of 36 against 21 of 27, wrote a three-task pass in 55 s against 87 s and emitted 24,200 output tokens against 36,100; single observations per cell, exposed development cases.

| Option | Values | Effect |
| --- | --- | --- |
| `advice` | `jev` (v4a default), `none` (lean) | Skip the Jev routing request; deterministic grouping only |
| `writer_routing` | `v4a` (v4a default), `json`, `hybrid` (lean), `hybrid-wide` | Per-packet representation: an absent destination is written as literal V4A; an existing destination whose recipe names a source range goes to the executable JSON writer with its local retry; `hybrid-wide` also sends merged packets and packets with three or more excerpts to JSON |
| `prune_dependencies` | `false` (v4a default), `true` (lean) | Drop declared `depends_on` edges with no file overlap before optimization; `compile` still orders every read/write overlap |
| `prompt_order` | `target-first` (v4a default), `static-first` (lean) | Put the shared writer contract before the per-packet ownership sentence so DeepSeek's prefix cache applies across packets |
| `concurrency` | 1..32 (4 v4a default, 8 lean) | Executor width |
| `anti_dependencies` | `serialize` (both defaults), `snapshot` | Let a writer start once the reader of its file has started; readers snapshot their inputs at start |
| `seam_retry_reasoning` | `off` (v4a default), `low` (lean) | Run the second seam attempt on a seeded move with the same DeepSeek model at low reasoning; in the replay rounds it recovered both seeds the `:off` retry had missed, at about 30 s and 8,500 output tokens per use |
| `seed_moves` | `false` (v4a default), `true` (lean) | Pre-fill an absent destination with its declared source excerpts when the recipe says compose/copy/move/extract, and hand the writer an `Update` on that seed; a rejected seam patch gets one more seam attempt carrying the applier diagnostic instead of the JSON fallback |

The V4A applier runs in its declared `lenient-wrapper` envelope: outer blank lines, one whole fence or heredoc, and repeated consecutive trailing `*** End Patch` markers are tolerated; nested envelopes, prose and partial lines are still rejected. Each attempt records whether the strict envelope would also have parsed.

## Roles in spec-end-to-end terms

The entry point accepts the names `spec_dispatch` uses: `--strong-owner-model` is the query planner (and the owner of a hard step), `--owner-model` an explicit brief owner for other steps, `--editor-model` the writer. `--model` remains the alias of `--strong-owner-model`. Each manifest and result records them as `spec_roles` (`owner_model`, `strong_owner_model`, `editor_model`). With `--strategy focused-dispatch` one strong-owner discovery agent plans the writer packets directly, with no separate brief or catalog query, and the same preprocessing, gates and writers apply; with `owner-query-writer` an owner brief precedes the planning call, and a planner that reports a missing owner decision gets the owner's revision up to three times.

## Use and retained evidence

Add `--dispatch-profile optimized-v4a` to the existing `iterate.mjs` owner/query/writer invocation. Keep the selectors explicit:

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$REFERENCE_WORKFLOW_RUN" --output "$NEW_RESEARCH_RUN" \
  --ledger "$EXISTING_CAMPAIGN_LEDGER" \
  --strategy owner-query-writer --dispatch-profile optimized-v4a \
  --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:off \
  --parser "$ACORN_MODULE"
```

The profile requires `catalog-lookup`, `smaller-regions` and contextual optimization. Contradictory overrides and alternate recovery selectors are rejected. Without the profile, the existing defaults remain unchanged. Replaying plans preserves their original planning-granularity identity; a historical plan is not relabeled to fit the new profile.

Each cell retains the raw and dispatched plans, preprocessing metrics, Jev request/answer/receipt evidence, writer requests/responses, and per-attempt format, local failure category, application status and elapsed time. Jev request counts distinguish reservations from transport starts. Its input-token cost estimate remains separate from provider receipt costs, and an unknown remote charge retains its reservation. The shared call budget reserves room for advice and two writer attempts per assignment.

Library entry/package hashes and actual returned Jev model identity are recorded. Generic `iterate.mjs` runs load the configured Jev installation at runtime; their replay checks do not pin that installation. Use the dedicated [comparison runner](divergent/combined-dispatch/runner.mjs) for the matched experiment: it snapshots and verifies the Jev dependency tree alongside the model SDK, source and parser before execution.

## Evidence and comparison

The [revised V4A rerun](divergent/combined-dispatch/v4a-rerun-results.md) applied all three tasks and delivered two after supplying complete source lines and bodies. Fifteen of 17 primary V4A attempts succeeded; two malformed patches were rejected and recovered through JSON fallback. Extraction passed with three primary calls and no fallback, but literal source copying took 58.090 seconds and produced 22,533 output tokens. The rerun cost $0.075510372 across 19 DeepSeek calls and three Jev requests. It reused the retained plans without rerunning the baseline, so it establishes the application improvement on these cases, not a general speed or cost advantage. The handoff task still failed behavioral checks.

Focused controlled-transport checks exercise the complete research cell: one Sol planning response, one Jev batch, deterministic grouping, parallel writers, a rejected V4A patch, one successful manual fallback, unchanged protected source and separate outer grading. Historical query-granularity checks still pass. Writer checks separately cover path fencing, atomic rejection, syntax diagnostics, source-range fallback and terminal request failures.

The [six-trial matched comparison](divergent/combined-dispatch/results.md) delivered one of three tasks in each arm. Application completion fell from three of three with the JSON baseline to two of three with the combined profile. Grouping reduced 26 planned assignments to 17, but seven of 15 dispatched V4A attempts required fallback. Jev ran successfully without changing the deterministic default choices. The combined configuration remains experimental; these observations do not justify replacing the baseline.

Both arms used retained Sol plans and identical starting files. Planning was reused, so the comparison measures the writing stage, including optimization and advice; it cannot establish fresh end-to-end workflow speed. The combined extraction case stopped early, so its lower time and call count are not completed-work savings. Application completion, fallback rates, downstream acceptance, token counts and costs remain separate in the report.
