# Recommendations: where to take the changeset executor next

Written 2026-10-16 from the retained runs on branch `spec-changeset-execution-poc`
(Sol-only iterations 01 to 07, the owner/editor DeepSeek runs, the dispatch runs and
the first three-role run) and the native reference transcripts. Code paths are
relative to the agents repository checkout. Run records live in the adjacent
experiment package's runtime store, outside Git. Vendor figures for the apply models
are claims I have not measured; they are marked as such.

> **Addendum, 2026-10-16 evening.** Runs 18 to 23 and the Sol writer controls now
> complete application 3/3, so the claim below that the three-role design never
> completed writing is out of date. The revised assessment is in the final section,
> "Addendum: the provisional winner at the writer boundary". The recommendations
> themselves stand.

## Summary

1. Stop optimizing the writing stage. In every delivered Sol-only trial it took zero
   seconds. All the time and tokens are in discovery planning.
2. Keep the batch-boundary feedback loop (own tests, boundary review, one repair).
   Every configuration that removed it failed the harder tasks.
3. Decide the production owner model first. If it is Sol, the Sol-only pattern is the
   backend and what remains is integration. If it is DeepSeek, run a DeepSeek-only
   arm under the current executor; the earlier verdict rests on one trial that never
   applied an edit.
4. Treat apply models (Morph v3 fast, Relace apply 3) as a fix for one failure class,
   anchor binding, not as a speedup. Pair them with the weaker planner, wrap them in a
   deterministic unchanged-region check, and measure them as a frozen arm.
5. Park the plan optimizer and the Jev context router until some delegated
   configuration completes writing on all three tasks. They tune 8 seconds of 90.

## Reasons

### The cost is discovery, not writing

| Handoff task | Planning | Writing | Outcome |
|---|---:|---:|---|
| Sol-only, iterations 06 and 07 | 95 to 113 s | 0 s | delivered, one repair |
| Sol owner, DeepSeek editors (01) | 46 s | 128 s, then 306 s repair | failed |
| Three-role (03) | 63 s DeepSeek owner + 192 s Sol query | never reached | failed |

Lifecycle extraction tells the same story: Sol-only planned in 23 to 32 seconds and
applied in zero; the three-role DeepSeek owner spent 152 seconds and 36 tool calls
planning before Sol spent another 94 seconds binding the brief. Calibration went
from 18 to 24 seconds (Sol-only) to 90 seconds (three-role).

The query-planner role doubles discovery. Sol must re-read source to bind a brief it
did not write and without the step text. On handoff that cost 192 seconds and 134k
input tokens, nearly twice Sol-only discovery. The boundary also loses facts: the
calibration writer was told to create a test file that already existed.

Every receipt across all campaigns shows zero cache reads. On handoff Sol made three
to five tool round trips at 20 to 45 seconds each over 20k to 130k inputs. That is
the lever: fewer round trips, smaller inputs, and a cached stable prefix if the
Codex adapter supports it.

### Feedback at the batch boundary is what delivered

Iteration 03 (source ranges, no own tests) delivered 2/3; iteration 04 added the
candidate's own changed tests and delivered 3/3. The two handoff defects the terminal
oracle caught were exactly the two the candidate's own tests exposed. The Sol-only
findings record the conclusion directly: eliminating all feedback did not reliably
deliver the harder tasks. The dispatch-only and three-role designs remove it anyway
and measure "application completion" instead. That proxy has already diverged from
delivery twice: focused-dispatch calibration applied fully and passed external checks
while its added test called a callback with the wrong arguments. Deferring
verification to the outer workflow does not remove the repair; it turns a batch repair
into a full editor packet.

### DeepSeek-only was ruled out on one malformed trial

| Campaign | DeepSeek changeset result | Interface at the time |
|---|---|---|
| Small corpus, 16 trials | 16/16 passed, 15/16 after post-hoc audit | whole-file editors, no own tests |
| Hard tasks | 1 trial (lifecycle), failed | whole-file editors, no ranges, no own tests |

The hard trial spent 403 seconds in discovery over 35 shell calls and 14 reads, then
returned prose ("Oops, I a...", "I'll inclu...") instead of JSON on both planning
attempts. Nothing was applied; the second review accepted an empty change. Sol under
the same interface went 0/6 with Nemotron editors. The four executor changes that
produced the Sol-only win (source ranges, candidate tests, boundary review,
pre-dispatch validation) have never run with DeepSeek as planner. The native DeepSeek
agent passed lifecycle in 336 seconds, which is the right comparator for a
DeepSeek-only changeset arm. Sol's equivalent cost is a tariff; DeepSeek's is money.

### Anchor binding is the dominant delegated failure, and it is structural

Delegated runs died on "excerpt anchor must be unique" (twice), "replacement count
mismatch", "create requires absent owned path", the 32,000-character context cap, and
length stops. Pre-dispatch validation checks anchors against initial source, but a
dependent assignment runs against staged content that an earlier assignment changed.
In validated-dispatch the test-helpers assignment edited the test file; the next
assignment's anchor was then no longer unique. Two fixes, either sufficient:

- Validate anchors against simulated staged state in dependency order. For
  deterministic predecessors the engine can compute it; for model predecessors it
  cannot, so excerpts for those dependents must be resolved at dispatch time.
- Resolve excerpts by symbol (function or constant name plus a deterministic
  top-level outline) rather than literal text, and bind to the current staged file
  when the assignment starts.

An apply model is a third answer: it tolerates imprecise anchors by construction.
That is its only advantage here, and it comes with a cost described below.

### Forced delegation is a research control, not a candidate

Every editor strategy forbade the planner from emitting edits. That isolates editor
capability, which was the question at the time, but no production configuration
would refuse a settled edit from a capable planner. The shippable hybrid is the
original patch-editors contract: deterministic where settled, delegate only
unresolved local work. Report forced-delegation arms as controls.

## Proposed experiment: cheap planner, apply-model writer

### Question

Can a DeepSeek planner, with the current executor and an apply model absorbing anchor
imprecision, fully deliver the three exposed tasks faster than the native DeepSeek
agent, at lower real cost, with no acceptance regression against the audited
Sol-only candidates?

### Arms

| Arm | Planner | Writer | Feedback |
|---|---|---|---|
| A. DeepSeek-only changeset | `deepseek/deepseek-flash:off`, tools, emits deterministic edits and ranges | none (engine applies) | own tests, boundary review, one repair |
| B. DeepSeek planner + Morph apply | same planner, emits lazy snippets for operations it marks `apply` | `openrouter/morph/morph-v3-fast` | same |
| C. DeepSeek planner + Relace apply | same planner, same plan format | `openrouter/relace/relace-apply-3` | same |
| Control | native DeepSeek agent, retained result (lifecycle 336 s; run the other two once) | | |

Arm A runs first. If its failures are anchor or format failures, arms B and C are
worth running. If its failures are discovery time, apply models cannot help and the
next lever is the symbol outline, not a writer.

Arms B and C replay arm A's frozen plans where the plan is valid, so planner
variation does not confound the writer comparison. Record the plan hash each replay
used. Where arm A produced no valid plan, the apply arms plan fresh and say so.

### Plan format for apply operations

An operation may carry `executor: "apply"` with `snippet` instead of `edits`:

```json
{"id":"seed-calibration","executor":"apply","reads":[],"writes":["pi/extensions/context-budget/policy.mjs"],
 "depends_on":[],"instruction":"Seed calibration from the last usage entry on session_start",
 "snippet":"// ... existing code ...\nfunction seedCalibration(entries) {\n  ...\n}\n// ... existing code ...\n"}
```

The engine formats the snippet into the vendor's layout (Morph uses tagged
instruction, code and update sections; Relace takes original code plus the edit
snippet), sends the current staged file, and receives a complete merged file.
Deterministic and range edits remain available in the same plan; the planner chooses
`apply` only where it cannot name exact anchors.

### Deterministic verifier around the apply model

Apply models regenerate the whole file and can drop or alter code. Vendor accuracy
claims are around 98 percent, which means a defect every few dozen applications.
The engine therefore checks each merged file before staging it:

1. Split the snippet on its elision markers into literal segments.
2. Every region of the original file not covered by a literal segment's landing zone
   must appear byte-identical in the output, in order. Compute with a diff: every
   changed hunk must overlap a literal segment; any hunk outside that is a rejection.
3. Run the existing syntax check on the merged file.
4. On rejection, one retry with the diff of the offending hunk, then fail the
   operation. Rejections count as application failures in the report.

This keeps the loud-failure property that made search/replace safe while letting the
planner skip exact anchors.

### Frozen controls

Same three tasks, source bytes, dependency mounts, SDK, output and time limits,
protected files, terminal oracle and one batch repair as the Sol-only iterations.
Register `morph/morph-v3-fast` and `relace/relace-apply-3` through the existing
`scripts/changeset-study/model-catalog.mjs` pattern, with metadata observed from the
OpenRouter models endpoint and dated; the pinned Pi 1.2.0 catalog lists only
`relace/relace-search`. Confirm each model's maximum output tokens before freezing:
the 143 KB runtime file is around 36k tokens, and an apply model that cannot return
it in one call forces chunking by function, which changes the operation shape.

Add one planner format retry: when the planning response is not JSON, re-ask once
with the parse error. This addresses the actual failure in the earlier DeepSeek trial
and applies to every arm.

### Measurement

Per task and in total: audited delivery (external acceptance, own tests, review,
successful execution, path diagnostic on handoff), elapsed time by stage, planner
tool round trips, model calls, input, output and cache tokens, real cost from
provider usage for DeepSeek and the apply models, apply-model rejections and
retries, and first mechanical failure class for every failed trial. Report the
apply models' own latency and tokens separately from planning.

Primary outcome is audited delivery, as in the Sol-only protocol. Writing completion
and apply-model rejection rate are secondary diagnostics. Failed trials take the
1,500-second cap in speed ratios. A win against the native DeepSeek control requires
3/3 audited delivery, lower total time, lower real cost, and an identical frozen
repeat that also delivers 3/3. These are exposed development cases; a win here
motivates fresh matched cases, it does not establish a general advantage.

### Stopping rule

Run arm A once. Run arms B and C only if arm A's failures are anchor or format
failures. Repeat whichever arm first delivers 3/3. Stop at the shared budget guard
or after the repeat, whichever comes first. Do not tune prompts against the three
tasks between arms; any change is a new frozen arm with its reason recorded.

## Smaller items to carry regardless of arm

- Give the planner a deterministic top-level outline of each declared file (name,
  kind, start line, end line) in the discovery input. On handoff this replaces at
  least one `rg -n` plus `sed -n` round trip per file, which is 20 to 45 seconds of
  Sol time each.
- Pre-read the files the spec names before the first planner call. The spec cards
  already list them.
- Put the stable prefix (source files, task contract) first and the per-call
  instruction last in every request, then check whether cache reads become nonzero.
- Keep audited delivery as the selection criterion in the experiment notes. "Select
  the best configuration observed" will otherwise select on writing completion.
- State the production owner model in the integration plan. Borrowed planning time
  differs by an order of magnitude between a Sol owner (10 to 30 s) and a DeepSeek
  owner (55 to 181 s) on the same tasks, so the allocation is meaningless without it.

## Addendum: the provisional winner at the writer boundary

Written after reading `CONFIGURATION.md`, `OPTIMIZER-FINDINGS.md`,
`writer-control-results.md`, `deepseek-only-results.md` and runs 18 to 23 plus the two
Sol writer controls.

### What the evidence now supports

The selected configuration (DeepSeek owner brief, Sol query planner with catalog
lookup and smaller regions, four DeepSeek `:off` writers, no grouping, no Jev) is a
defensible choice **at the writer boundary**. Eight consecutive runs, including two Sol
writer controls on the same plans, completed application 3/3. DeepSeek wrote in 35 to
137 seconds against Sol's 102 to 108, at receipt costs of roughly $0.03 to $0.08
against $0.29 to $0.31. The anchor-binding failure class that killed runs 01 to 17 is
gone at this granularity. That is a real result and worth keeping.

### What it does not support

| Measure | Sol-only (06, 07) | Winner, run 18 | Winner, runs 19 to 23 |
|---|---:|---:|---:|
| Audited delivery | 3/3 twice | 2/3 | 1/3 every time |
| Writing seconds | 0 | 74 | 35 to 137 |
| End-to-end seconds, owner brief included | 320 to 340 | about 743 | not measured fresh |

Run 18 reused the owner briefs from run 11, which took 54, 205 and 152 seconds. Adding
those to run 18's query planning and writing gives roughly 79, 382 and 282 seconds per
task, about 743 in total, for 2/3 delivery. Sol-only delivered 3/3 in 320 to 340. The
winner is a cheaper writer inside a slower, less reliable pipeline.

The delivery failures are all behavioral, none mechanical:

- **Handoff failed in all eight runs on the same hidden tests**, with Sol writers as
  well as DeepSeek. The defect is upstream of the writer, in the owner brief or the
  query plan, and in run 18 the candidate tests could not even load because the plan
  referenced a module that was never created. The Sol-only strategy fixed this exact
  class with one repair driven by the candidate's own tests. The winner has no such
  loop, so the defect ships every time.
- **Lifecycle flipped from delivered (18) to failed (19, 22, 23) on an identical frozen
  plan.** All four operations applied cleanly each time; the writer's output simply
  broke wave runtime behavior in the repeats. Application completion cannot see this.
  Only a behavioral check can, and the configuration runs none before freezing.

### What "acceptable" has to mean

Acceptable is defensible only if the outer spec workflow supplies the review and repair
loop that the changeset stage removed, and only once the cost of those repairs is
measured. Right now a 1/3 to 2/3 first-pass delivery rate means one or two editor
packets per step after the writer stage, and those packets are the expensive path the
executor was meant to replace. The integration plan should state that cost before
calling the configuration adopted.

### Three adjustments, in order

1. **Put the own-test check and one repair back inside the changeset stage.** The
   Sol-only evidence is direct: iteration 03 without own tests delivered 2/3; iteration
   04 with them delivered 3/3, and the repair cost 20 to 40 seconds. Route the repair to
   whoever owns the logic. Since Sol writers fail handoff identically, that is the owner,
   not the writer. Keep writers dumb; make the owner answer for behavior.
2. **Measure one fresh end-to-end run before any integration work.** The only run with
   fresh owner briefs (11) delivered 1/3. Every later run borrowed its briefs. Fresh
   owner, query, writing, checks and review time together is the number the production
   decision needs, and it does not exist yet.
3. **Report the winner against delivered tasks, not writer seconds.** Writing seconds
   compare 35 against 108 while delivery compares 1/3 against 3/3. The writer-boundary
   table in `CONFIGURATION.md` already says this in prose. Put it in the headline.

### On the specialized-writer protocol

The branch's own apply-model protocol (DeepSeek prepares per-file snippets in at most
eight requests, Morph and Relace apply full files sequentially, no retries, no review)
is a cleaner architecture test than the in-plan `apply` operation this file proposed,
and both models passed the integration probe. Two expectations to write down before
running it: it will show the same pattern as runs 18 to 23, high application and
delivery limited by owner logic, because it also has no behavioral loop; and the
runtime file at about 36k tokens sits at Morph's 38k completion ceiling, so the bytes
over four estimate may admit a request that length-stops. Relace's 128k ceiling makes it
the safer first arm for lifecycle.
