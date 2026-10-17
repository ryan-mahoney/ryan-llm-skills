# Stacked file-writing interventions: briefing for Fable

The combined writing stack now applies all three tested tasks, but it has **not demonstrated overall time or cost savings**. Compared with the retained Sol-plan → DeepSeek-JSON baseline, the revised stack roughly doubles writing time and cost while increasing tasks passing behavioral checks from one to two. Deterministic consolidation reduces assignments and calls; literal source copying through V4A consumes the savings on the extraction case.

We want an independent opinion on what to keep, what to remove, and the smallest useful next experiment. This is a research implementation, not an integration into the managed `spec-end-to-end` workflow.

## Objective and constraints

The broader objective is to reduce sequential read → reason → edit loops during spec-driven implementation. When a step's implementation is settled, much of its file work may be described in advance, consolidated deterministically, and dispatched concurrently to cheaper writers. The intended architecture separates responsibilities:

1. DeepSeek owns step implementation decisions and settles an implementation brief.
2. Sol 6.1 turns that brief into bounded, source-bound changesets for writers.
3. A local runtime validates, optimizes and schedules those changesets.
4. DeepSeek applies each packet against the current staged source.
5. The outer workflow performs behavioral verification and later review.

Sol should finish after query planning/dispatch. It should not inspect DeepSeek's work or orchestrate repair. The writer may recover from a local application failure, but behavioral test feedback belongs outside file modification. Failed behavioral checks remain failures; the experiment does not ask writers to repair them.

The user wants Sol used where its ability to solve difficult planning problems is valuable, without depending on it for every edit. Subscription economics make Sol's marginal cash cost different from API list pricing; the current comparison has no new Sol calls and therefore does not resolve that economic question.

## Locations and revision

This file's directory is the **research base**. The following shell assignments resolve the local bases without embedding a machine username. Run them from the research base if using the relative runtime path:

```sh
study_checkout="$HOME/.worktrees/agents/changeset-execution-poc"
study_runtime="$(cd ../../specs/changeset-execution-poc/runtime && pwd)"
```

The worktree is separate from the main checkout. Branch: `spec-changeset-execution-poc`. Published head at the time of this briefing: `72e16b9` (results documentation). Revised execution code: `cbb3380c76297fafe321cfebe5b14261001a7d92`. The worktree was clean and synchronized with its remote before writing this briefing.

Repository: [ryan-mahoney/ryan-llm-skills, research branch](https://github.com/ryan-mahoney/ryan-llm-skills/tree/spec-changeset-execution-poc). Local paths below are relative to `study_checkout` unless explicitly marked as runtime or research paths. Raw runtime artifacts are local evidence and are not implied to be available through GitHub.

| Read first | Path |
| --- | --- |
| Architecture and configuration | `scripts/changeset-study/COMBINED-DISPATCH.md` |
| Original paired comparison | `scripts/changeset-study/divergent/combined-dispatch/results.md` and `results.json` |
| Revised V4A results | `scripts/changeset-study/divergent/combined-dispatch/v4a-rerun-results.md` and `v4a-rerun-results.json` |
| Diagnosis of original patch failures | `scripts/changeset-study/divergent/combined-dispatch/V4A-FAILURES.md` |
| Experiment protocol and limits | `scripts/changeset-study/divergent/combined-dispatch/PROTOCOL.md` |
| Earlier small V4A capability pilot | `scripts/changeset-study/divergent/v4a-suite/results.md` |

Implementation entry points:

- `scripts/changeset-study/iterate.mjs`: owner/query/writer research entry point; opt-in `--dispatch-profile optimized-v4a`.
- `scripts/changeset-study/preprocess-changeset.mjs`: callable validation, advice and optimization boundary.
- `scripts/changeset-study/optimizer.mjs`: deterministic grouping and dependency transformations.
- `scripts/changeset-study/v4a-context.mjs`: complete-line, complete-body source selection.
- `scripts/changeset-study/v4a-editor.mjs`: V4A writer instructions, local application and JSON fallback.
- `scripts/changeset-study/focused-editors.mjs`: existing focused JSON editing machinery.
- `scripts/changeset-study/divergent/v4a-suite/applier.mjs`: guarded V4A-compatible application.
- `scripts/changeset-study/divergent/combined-dispatch/runner.mjs`, `worker.mjs`, `audit.mjs`: frozen comparison execution and audit.

Raw evidence, relative to `study_runtime`:

- `combined-dispatch/01-matched/`: original paired campaign, frozen inputs, individual observations and original stopped report.
- `combined-dispatch/01-matched/resume-01/results.json`: final six-observation results after correcting the observer's source-map ordering check.
- `combined-dispatch/02-revised-combined/`: revised three-case rerun; `results.json`, `execution-summary.json`, manifests, requests, responses, receipts, candidate outputs and grades.
- Revised trial directories: `0-hard-context-calibration-combined`, `1-hard-dependency-handoff-combined`, `2-hard-lifecycle-extract-combined`.
- `budget.json`: shared experiment ledger; this briefing does not reset it.

Additional local research context: [experiment history](EXPERIMENT-NOTES.md), [V4A study proposal](V4A-WRITER-SUITE.md), [recommendations](RECOMMENDATIONS.md), [batched-edit ideas](Batched%20Edits%20for%20Spec-Driven%20Development.md), [research notes](Efficient%20LLM%20Code%20Editing%20Research%20Notes.md), [ideas](ideas.md), and [creative ideas](creative-ideas.md). These include proposals and older observations; the two combined-dispatch result reports are authoritative for the numbers below.

## What the implemented stack does

```text
DeepSeek implementation brief → Sol changeset plan
  → local ownership/binding validation and merge candidates
  → one batched Jev advice request per plan
  → deterministic consolidation and dependency scheduling
  → up to four concurrent DeepSeek V4A writers
      → guarded application and syntax check
      → one DeepSeek JSON fallback on a local failure
  → separate behavioral verification and review
```

The optimizer can combine up to two compatible assignments to the same destination, including assignments separated by independent work. It deduplicates context and rewires dependencies. Consumers of an intermediate state prevent merging. The executor serializes read/write conflicts and supplies the current staged source after predecessors run; independent destinations can execute concurrently.

Jev can advise keeping an eligible pair separate or supplying complete context for a bounded small file. It cannot change implementation intent, waive checks or authorize conflicting dependencies. Unavailable or uncertain advice leaves deterministic policy in control. The research cell calls preprocessing on behalf of the owner; a managed DeepSeek owner tool is still future integration work.

V4A is the writer's patch representation; changesets describe assignments, ownership, dependencies and source context. They serve different layers. The JSON fallback can compose source ranges without asking the model to regenerate their contents. A local format, path, application or syntax failure can trigger that one fallback. Transport, cancellation, budget and output-length failures do not trigger it, and downstream test failures never enter the writer fallback.

Configured selectors documented for the profile are `openai-codex/gpt-6.1-sol:low` for query planning and native `deepseek/deepseek-flash:off` for writing. These are the recorded selectors; do not infer a different provider/model version from conversational model names. The runs measured here replayed existing Sol plans and owner briefs rather than invoking those stages again. Jev returned `jev-1.13.0`.

## Comparison design and measured outcomes

The original comparison ran three tasks once per arm, using identical starting source, retained Sol plans and settled DeepSeek briefs. The baseline used focused JSON writes without consolidation and its existing local retry. The combined arm added consolidation, Jev, V4A and JSON fallback. The revised run repeated only the combined arm after repairing the V4A interface.

| Metric | Original JSON baseline | Original combined stack | Revised combined stack |
| --- | ---: | ---: | ---: |
| Tasks applied completely | 3/3 | 2/3 | 3/3 |
| Tasks passing behavioral/ownership grading | 1/3 | 1/3 | 2/3 |
| Planned writer assignments | 26 | 17 | 17 |
| DeepSeek calls, including recovery | 27 | 22 | 19 |
| Jev calls | 0 | 3 | 3 |
| Primary V4A acceptance | n/a | 8/15 dispatched | 15/17 dispatched |
| Writing wall time, summed across tasks | 47.872 s | 42.244 s† | 96.179 s |
| Writing cost | $0.037664028 | $0.054308196† | $0.075510372 |

† Original combined extraction stopped early and blocked two dependent assignments. Its lower time and call count are not completed-work savings.

Writing wall time includes preprocessing and execution; Jev time is already inside preprocessing. It excludes reused planning and outer checks. Calls count actual writer attempts, not just successful edits. Costs combine DeepSeek catalog-priced receipts with Jev's input-token-only estimate; they are not invoice verification.

| Task | Baseline writing time / cost | Revised writing time / cost | Baseline delivery → revised delivery |
| --- | --- | --- | --- |
| Calibration | 3.358 s / $0.001631808 | 3.151 s / $0.003667446 | pass → pass |
| Handoff | 36.834 s / $0.034014420 | 34.939 s / $0.036961980 | fail → fail |
| Lifecycle extraction | 7.680 s / $0.002017800 | 58.090 s / $0.034880946 | fail → pass |

Overall the revised stack takes about twice the writing time and costs about twice as much. For calibration and handoff together, it is approximately 5% faster and 14% more expensive. That subset includes a behavioral failure in both arms and is not a demonstration of equal-quality delivered-work savings.

The extraction result dominates the revised totals. It now passes, but reproducing complete source and delegates emitted 22,533 output tokens. The largest delivered source packet contained 41,636 UTF-16 code units; peak serialized request context was 49,484 bytes. Deterministic source copying could avoid regeneration, but the proposed hybrid has not been evaluated here.

| DeepSeek token usage | JSON baseline | Revised stack |
| --- | ---: | ---: |
| Input, excluding separately reported cache reads | 44,901 | 88,961 |
| Output | 19,876 | 40,418 |
| Cache read | 57,088 | 1,920 |
| Total | 121,865 | 131,299 |

Cache writes are zero. Revised Jev usage adds 7,356 input and 579 output tokens. The cache asymmetry is substantial; previous identical baseline-prompt exposure and different prompt formats affect measured costs. Fewer calls did not produce fewer total DeepSeek tokens.

The revised campaign's 22 reservations all reconcile with requests/responses/receipts. DeepSeek cost was $0.075201420 and Jev's estimate was $0.000308952. No unknown, orphaned or unattributed reservations remain. The shared ledger snapshot after the rerun is 982 entries and $4.9834742442 against the existing $50 allowance; this is not the cost of this single run or a measure of all development effort.

## Why V4A failed, and what changed

The original writer reused context designed for JSON source-range edits. Some excerpts ended mid-line or omitted source bodies. JSON can copy a referenced body; a literal V4A Add File cannot reproduce a body it never receives. Generated patches also had backward hunks, duplicate envelopes and partial-line removals. Extraction produced a syntactically incomplete new file despite a normal provider stop.

The repair supplies complete physical boundary lines and selected bodies, orders and deduplicates source selections, and removes JSON-oriented body compaction. Source is bounded at 64,000 UTF-16 code units rather than relying on the prior 32,000-character compacted context. Instructions explicitly require a single envelope, complete lines and forward source order. Oversized or ambiguous selections fail before a provider call.

The applier was not loosened. Path fencing, ambiguous-match rejection, source-order rules, syntax checks and atomic rejection remain. The two remaining revised failures were malformed model patches: one joined disjoint source excerpts across an omitted helper; the other marked newly invented code as unchanged context. Both were correctly rejected and recovered through JSON.

This repair demonstrates improved usability on these cases, not universal V4A reliability or an isolated format effect: both context and instructions changed.

## Test results and remaining failures

Focused local checks reported for the implementation revision:

| Checks | Result | What they cover |
| --- | --- | --- |
| `v4a-context.test.mjs` + `v4a-editor.test.mjs` | 10/10 pass | Complete physical lines/bodies, overlap handling, limits and ambiguous selectors, application/fallback contracts |
| `combined-dispatch.test.mjs` + `divergent/combined-dispatch/audit.test.mjs` | 7/7 pass | Combined cell wiring, separate grading, ownership/integrity and audit behavior |
| `divergent/combined-dispatch/runner.test.mjs` | 5/5 pass | Combined-only scheduling and reference identity validation |

These are focused implementation checks, not a claimed repository-wide suite pass. The final documentation commit did not change executable code. Independent code and evidence reviews closed without material findings. Frozen source/dependency identities, original plan/brief identities, staged replay and accounting were verified. No tests were rerun merely to prepare this briefing.

In the revised live run, calibration and extraction pass visible checks and completed hidden grading, with protected files and ownership intact. Handoff applies but fails delivery: its candidate suite passes 0/4 and hidden output reports 98/101 passing. Failures involve API/fixture/editor-outcome/path expectations, accepted prerequisites classified unknown/malformed, and missing detail counts. The hidden result retains exit 1 and `completed:false`, without a timeout. These are real remaining behavioral failures, not patch-format rejections. The baseline also failed handoff; its extraction applied but failed cancellation/drain behavior.

The original campaign also encountered an observer bug: equal source maps were hashed in different insertion orders. A corrected read-only audit qualified the retained observations, and the remaining four trials resumed without repeating paid calibration. Original evidence was preserved. This was distinct from the writer defects.

## Jev: recommendation versus implementation

Jev made three successful advice calls in each combined run and changed no default merge or context decisions. No incremental routing benefit has been demonstrated. Its revised overhead was approximately 0.954 seconds and $0.000309 for the three calls, so it is unnecessary overhead on this workload but not the cause of the main regression.

The current recommendation is to remove Jev from the default writing path and retain it as an optional experiment. **That removal has not been implemented or measured.** The checked-in `optimized-v4a` profile still includes Jev and all reported combined results include it. This recommendation concerns writing-path advice, not unrelated verification/review checkpoints elsewhere in the tooling.

## What the evidence does not establish

- This is not a fresh comparison against Sol alone, a conventional sequential editing agent, or the full `spec-end-to-end` workflow. Owner/planner costs and latency are excluded.
- There is one observation per arm/task, and only the combined arm was rerun after the fix. The baseline is historical, not a simultaneous control for the revised implementation.
- The three cases are exposed development cases. There are no randomized repetitions or held-out workload results establishing general reliability.
- Consolidation, context, advice, format and recovery change together. We cannot attribute the quality improvement or timings to one intervention.
- Total process wall was approximately 240.800 s for the baseline and 226.968 s for the revised stack, but selected tests and candidates differ. That is not evidence of an end-to-end speed win; writing itself became slower.
- Mechanical application success is not delivered correctness. Repair effort after the failed handoff is not measured, so cost per successful final delivery remains unresolved.

## Questions for Fable

1. Is the best next design deterministic consolidation plus JSON/source-range composition, with V4A only for localized edits? Which operations should deterministically select each representation?
2. Does removing Jev from this path make sense given zero observed decision changes, or is there a specific workload where its incremental value should be tested first?
3. Is the extraction regression mainly an avoidable representation choice, or a sign that the packet/query design should change more fundamentally?
4. What is the smallest fair next comparison? One candidate is a fresh baseline versus consolidation-only JSON versus a hybrid V4A/source-copy route, on a small frozen workload with comparable cache conditions and repeated ordering. This is a proposal, not an authorized or started run.
5. How should we measure the tradeoff between writing latency and delivery quality without treating failed implementations as savings? Which outer checks and review costs should be held constant?
6. What must be demonstrated before integrating this into `spec-end-to-end`, while retaining the constraint that Sol plans and dispatches rather than checking or repairing writer output?

Please distinguish recommendations supported by the observed results from new hypotheses. The immediate decision is which interventions deserve to remain in the default route, not whether the current aggregate stack can already be claimed as an efficiency win.
