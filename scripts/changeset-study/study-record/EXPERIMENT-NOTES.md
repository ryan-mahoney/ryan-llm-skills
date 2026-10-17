# Changeset execution: evidence and implementation plan

Updated 2026-10-16. Code paths are relative to the agent-tooling repository on
branch `spec-changeset-execution-poc`. Retained run paths below are relative to
`specs/changeset-execution-poc/runtime/dispatch-deepseek` in adjacent project storage.
This note lives in research storage, outside the worktree.

## What works, and what remains unproven

The strongest completed result remains the historical Sol-only changeset executor:
two runs completed all three exposed cases in 319.74 and 339.55 seconds, versus
474.96 seconds for native Sol. Calls fell from 28 to 16–17 and total tokens from
514,714 to 328,670–340,136. These are small-sample development results with review
and repair, not a matched control for the new dispatch-only architecture or proof
of a production-wide speedup. See `scripts/changeset-study/SOL-ONLY-FINDINGS.md`.

The new architecture has now run live: DeepSeek settles implementation decisions,
Sol compiles that brief into bounded writer assignments, and DeepSeek writes.
Sol makes no calls after dispatch. Writers receive one file, up to 4,000 assignment
characters, selected current source, and one application/format/syntax retry.
Behavioral tests and review remain outside file modification. Failed application,
failed downstream checks, and completed feature delivery are distinct outcomes.

The executor supports a staged in-memory filesystem, dependencies, concurrent
independent writes, exact replacement and source-range moves. It retains successful
staged operations when another assignment fails. Conflicting file operations
serialize and later assignments read current staged contents.

## Matched optimizer comparison

Runs `04-corrected-unoptimized`, `05-deterministic`, and `06-contextual` reuse
identical owner briefs and raw query plans from `03-owner-query-writer`, with an
identical corrected backend freeze. None completed all planned writes across the
three cases. Each completed calibration; handoff and extraction failed application.
Only deterministic calibration passed all visible, candidate-added and external
checks. All attempts and failed results remain retained.

| Treatment | Complete writing cases | Writer calls | Writer tokens | Writing + optimization + routing | New run elapsed | New normalized cost |
|---|---:|---:|---:|---:|---:|---:|
| Unoptimized | 1/3 | 20 | 59,550 | 52.012 s | 211.612 s | $0.027505 |
| Deterministic | 1/3 | 14 | 48,887 | 44.655 s | 205.188 s | $0.020489 |
| Jev contextual | 1/3 | 15 | 54,687 | 41.036 s | 136.757 s | $0.022099 |

Jev adds two calls and 4,294 tokens to its row's writer usage; its estimated cost is
included. The elapsed totals are not quality-preserving speed comparisons: failed
operations prevent later writes and can prevent downstream tests from being selected.
In particular, contextual handoff ran fewer candidate checks. Do not rank incomplete
batches by elapsed time alone.

Calibration provides a narrower positive result. Deterministic grouping combined
six assignments into three, reduced dependency depth from four to two, and cut
writing from 8.318 to 6.981 seconds (about 16%). Calls halved and tokens fell from
13,422 to 8,288. This is one exposed case and one run per arm. Jev chose exactly the
same eligible merges as the deterministic policy in both cases where it ran; its
routing added approximately 0.4 seconds overall without changing a plan. There is
no demonstrated benefit from paying for that decision on these inputs.

Allocating the original 612.421 seconds of owner/query planning to each replay gives
824.033, 817.609 and 749.178 seconds respectively. Those are slower than the historical
Sol controls and incomplete. We have not beaten Sol alone with this three-role design.
The reporting code keeps actual new usage separate from allocated pipeline usage.

## Implemented optimizations

The deterministic optimizer deduplicates context and merges at most two compatible
same-file assignments. It retains every instruction and requirement, checks size
limits and dependency observers, and does not infer that prose edits are redundant.
Jev supplies optional grouping/context advice; local code retains authority for
ownership, dependencies and bounds. Uncertain advice falls back to fixed policy.

The comparison exposed generic backend errors: a filename containing `budget`
incorrectly suppressed a retry; an unnecessary instruction sublimit rejected an
otherwise valid assignment; oversized source blocked extraction before writing.
These were corrected before the matched runs, so the optimizer does not receive
credit for those fixes.

The latest backend revision is locally verified and has now had one live run:

- Overlapping source selections are unioned before progressive function-body
  compaction. Every delivered chunk remains an exact contiguous source slice,
  with offsets and explicit omissions. The retained staged handoff failure shrinks
  from 130,702 selected characters to 26,389 delivered characters under the same
  32,000-character bound. This fixes a payload failure, not proven task behavior.
- A deterministic source catalog supplies named paths, exact unique anchors,
  symbols, imports, methods and test names. Sol can compile the settled brief in
  one bounded request, with at most one pre-dispatch correction. There are no
  source-discovery tools in this mode. Catalogs are capped at 48 KiB and complete
  requests at 80 KiB; measured original-brief requests fit at roughly 19–68 kB.
- Unknown names stay explicit unresolved metadata. They never become invented
  writable files. New destinations need explicit catalog bindings. Dependent
  assignments may receive bounded contents of a newly created staged file.
- Writer prompts state the sole writable destination and whether it exists.
  They clarify that compose creates once rather than appending. Recovery includes
  a compact list of every rejected edit, even when the response text is truncated.

Seventeen focused runtime checks passed in about 0.55 seconds. A subsequent
compaction-provenance regression passed after review corrected selector attribution.
These checks establish runtime contracts, not model success or production readiness.
The shared Jev verification/review CLI returned its budget/context fallback; direct
study routing worked and its calls were charged to the experiment ledger.

## Catalog comparison and next measurement

Run `07-catalog-deterministic` reused the exact original DeepSeek owner briefs.
Calibration applied all three optimized assignments and passed external acceptance,
but its generated test failed. Query planning took 56.104 seconds (two calls,
including a binding correction), writing 8.414 seconds and checks 0.257 seconds.
Handoff and extraction stopped before writing: the catalog lacked fixture/helper
bindings, constants and leading-comment boundaries needed by their briefs. These
are failed attempts, not speed improvements.

Actual total was 120.177 seconds, 7 calls and 55,851 tokens at $0.022680 normalized
cost. Adding the original owner work gives 419.725 seconds, 67 calls, 2,728,178
tokens and $0.126026 normalized cost. The owner was not rerun. No Sol call followed
writing. Brief provenance and accounting passed; the blocked cases lack dispatched
plans and therefore cannot establish execution integrity or completed work.

Run `08-richer-catalog-deterministic` measured that enrichment at commit `435f458`.
It reused the owner briefs and writer backend. Calibration took one Sol query
instead of two, applied all three grouped assignments, and passed external grading;
visible and candidate checks still failed. Handoff stopped before writing because
its catalog lacked EOF append and launchProcess/prepare fixture bindings.

Extraction's first seven-operation plan passed source preflight with compaction.
Strict catalog pair validation rejected six ranges even though their individual
endpoints were genuine, unique and ordered. The correction was 82,206 bytes against
the 81,920-byte complete-request cap, exceeding it by 286 bytes. It was refused
before transport. This was a catalog-harness restriction and correction-size
failure, not proof that source preflight could not dispatch the submitted plan.
The plan and candidate were not manually changed.

08 actual total was 108.783377 seconds, six calls and 51,998 tokens at $0.021066612
normalized cost ($0.123617412 in receipt charges). Owner-only allocation gives
408.331819 seconds, 66 calls, 2,724,325 tokens and $0.124412616 normalized cost.
Application completed one of three cases; no case achieved full delivery. No owner
was rerun and no Sol call followed writing. The measurement artifacts and offline
HTML now include 08; all 03–07 claims and quality limits remain retained.

Runs `09-catalog-lookup-deterministic` and `10-bounded-query-recovery` now measure the separate lookup mode: one bounded source batch, at most 64,000 UTF-16 code units/source characters, three query calls total, and 160 KiB complete requests. Both retained the original 03 owner briefs. All emitted lookup artifact hashes, original source-request identity, whole-source hashes, exact snippet offsets/text, unique anchors and followup packet identity passed audit. No Sol call followed writers.

09 froze `a6a0be5`. Calibration failed before writing on malformed query JSON at position 328 (line 2 column 2). Handoff applied all 11 grouped operations, then failed its visible and generated candidate checks; the first visible failure was ENOENT reading the fixture's `spec-steps.json` inside `buildDependencyHandoff`. External grading hit its retained 300-second timeout. Extraction applied all five operations but failed startup because `wave-lifecycle.mjs` did not export `createWaveLifecycle`. Full delivery was 0/3 despite application completion of 2/3. Actual total: 605.715241 seconds, 25 calls, 245,261 tokens, $0.105010284 normalized and $0.441198984 receipt charges. Owner allocation gives 905.263683 seconds and $0.208356288 normalized. All failed check time/cost remains counted.

10 froze `abb8623`, with predeclared bounded format recovery and interchangeable supplied endpoints. Calibration applied 3/3 operations and passed base, four generated candidate tests and external acceptance. Handoff used eight lookup requests/30,461 source characters, then explicitly blocked on the inherited owner's conflicting profile-path recipe: from `pi/extensions/spec-runtime/runtime.test.mjs`, `../../../agents/spec-step-owner.md` resolves to `agents/spec-step-owner.md`, while the supplied and required actual profile is `pi/agents/spec-step-owner.md` (`../../agents/...`). No writer ran. Extraction applied 4/4 operations with five writer calls, but nine of 74 visible tests and external acceptance failed. The first failure was `wave runtime: a validated member binds its run and bypasses only the serial latest-run exclusion`, a TypeError reading `workerPid` from undefined in `Runtime.start`, `runtime.mjs:935:47`. No behavioral feedback or manual candidate repair followed.

10 actual total: 150.335635 seconds, 13 calls, 114,743 tokens, $0.040694676 normalized and $0.209625076 receipt charges. Owner allocation gives 449.884077 seconds, 73 calls, 2,787,070 tokens and $0.144040680 normalized. Application completed 2/3, full delivery 1/3. Query/writing/check seconds were 31.410/6.638/0.258 for calibration, 12.408/0/1.843 for handoff, and 31.562/12.504/51.836 for extraction. Jev made no calls in 09 or 10. Lower query times and completed writing still do not establish a suite-wide quality win or a win over the historical Sol controls.

Run `11-fresh-owner-briefs` regenerated all three owners from original tasks/source under owner-prompt revision `d08577e` (freeze `25d0463`). Calibration applied 2/2 operations and passed every check. Handoff and extraction stopped before any Sol query/writer: catalog extraction mishandled the existing `/work/scripts/spec-observe/steps.mjs` alias as a second ambiguous path, and the extraction catalog was 51,727 bytes against 49,152 (2,575 over). All 66 owner calls and failed time remain counted. Total 468.257817 seconds, 70 calls, 3,327,081 tokens: input 162,892/output 78,365/cache read 3,085,824, no cache writes. Actual=allocated $0.161420544 normalized; receipt charges $0.200204044. Application and full delivery each 1/3.

Run `12-root-aware-catalog` froze `5bfe134` and reused exact 11 owner-brief bytes. It normalizes known existing `/work` source-root aliases, permits a 64 KiB catalog only in lookup mode and checks the exact serialized Client context (system prompt/messages/tools; no provider options) against 160 KiB. The separate lookup source cap remains 64,000 UTF-16 code units/source characters. These bounds do not apply retroactively.

12 calibration applied 2/2 operations and passed all checks. Handoff applied 11/11 grouped operations using 14 writer calls; visible, candidate and external checks failed. The first visible failure was the CURRENT handoff assertion that a coverage gap mentions `corrupt.json`; it observed false. External grading failed after 64.080 seconds without timeout. Extraction's first operation failed syntax checking after two bounded writer attempts: `Unexpected identifier 'TRANSPORT_ENV_NAMES'` at line 149 of composed `wave-lifecycle.mjs`; the dependent runtime rewire was blocked, with no changes applied. Its unchanged-source visible checks passed, while external acceptance failed on the missing module. No behavioral failure was fed to a query or writer, and no candidate was manually repaired.

12 primary application completion is 2/3; full delivery is 1/3. Actual: 246.396421 seconds, 22 calls, 182,657 tokens (input 130,130/output 31,023/cache read 21,504/cache write 0), $0.076395624 normalized and $0.281194124 receipt charges. Adding only inherited 11 owner planning gives 657.783371 seconds, 88 calls, 3,483,586 tokens and $0.227903328 normalized. Query/writing/check seconds are 13.503/3.273/0.259, 63.083/40.989/66.046 and 23.155/6.623/28.739. Jev made no calls. All22 receipts, provider roles, owner bytes and plan hashes passed audit; query calls1/2/1 and packet bytes25,460;104,647/127,368;84,602 stayed bounded. The sole lookup batch delivered5 requests/18,264 source characters with verified exact-source provenance.

Runs `13-syntax-context` and `14-unoptimized-syntax-context` replayed the exact 12 raw plans and owner briefs. Run 13 froze `56aa535`, adding generic deterministic local syntax excerpts/compose-part mappings and literal-composition guidance to the existing one-retry writer. Run 14 reused that exact frozen backend and raw inputs with optimization `none`, isolating the grouping treatment in one observed pair. No new owner, Sol query or Jev call occurred. Full artifact/provider/request-receipt provenance passed.

13 calibration applied 2/2 grouped operations and passed all checks. Handoff applied 9/11; merged `wire-dependencies`+`editor-outcomes` failed a runtime.mjs replacement-count check, blocking completion-guard. Missing buildDependencyHandoff export then failed base/candidate/external checks. Extraction failed two attempts with unexpected `export` at composed line 138; runtime rewire blocked, no changes applied. Primary application and full delivery each 1/3. Actual 70.315409 seconds,15 writer calls,93,665tokens (input 56,029/output 18,820/cache 18,816), $0.039505596normalized=receipts. Allocated 581.443141 seconds,85 calls,3,480,967tokens, $0.224272800normalized.

14 calibration applied 3/3 unoptimized operations and passed all checks. Handoff applied 13/15; separate wire-dependencies/editor-outcomes/completion-guard passed, but test-wave-authority failed a runtime.test.mjs replacement count, blocking test-profile-guidance. Base visible passed; candidate and external failed. First candidate failure was incomplete-packet continuation with an absent/replaced/revoked writer lease. Extraction failed both attempts with duplicate nativeCommand declaration at composed line 193; rewire blocked/no changes. Primary application and delivery each 1/3. Actual 139.101461 seconds,21 writer calls,106,093tokens (input 50,916/output 18,569/cache 36,608),$0.037777248normalized=receipts. Allocated 650.229192 seconds,91 calls,3,493,395tokens, $0.222544452normalized. All cache-write counts zero. Failed outer check time remains included;14 handoff external failed after63.822 seconds without timeout.

Matched calibration writer+optimizer time was 3.518605 seconds in 13 versus 3.648650 seconds in 14 (two versus three calls), with all checks passing. Both configurations still failed the larger application cases. Different handoff failure positions do not establish causality or a suite-wide grouping winner, and failed work cannot support a quality-preserving speed claim. No behavioral feedback entered prompts, no candidate was manually repaired, and no further trial had started at that checkpoint. Next work is offline mechanical replacement/compose diagnosis.

Run `15-writer-low` froze `7ff598e` and replayed exact 12 raw plans/briefs/dispatched plans, changing only writer reasoning to low while inheriting the off-reasoning owner. Execution-module hashes matched 13. Local provider-boundary capture confirmed actual thinking enable/low effort versus off disable. Actual trial bounds remained 32,000 output tokens, 300 seconds per call, 1,200 seconds per cell, 96 calls and 300 seconds grading; synthetic 16k capture settings do not describe live limits.

15 calibration applied 2/2 and passed all checks, but writing took 27.275 seconds versus 3.518 in 13. Handoff applied 11/11 on 11 calls with no retries, errors or length stops. Writing took 329.886 seconds; base visible passed, candidate/external failed. First candidate failure was the generated step 13 fixture omitting requires/writes on steps1–3, causing dependency-graph-invalid. External failed after 64.209 seconds without timeout. Extraction successfully created wave-lifecycle.mjs, then rewire failed a nonunique range anchor. Its single retry stopped at length after 179.899 seconds/31,999 output tokens (all reported as reasoning). Final error was `Model stopped: length: `; no fourth call. Existing-runtime visible tests passed; external rejected runtime.mjs over 1,550 lines. No behavioral feedback entered writers.

Application completion 2/3, full delivery 1/3. Actual 826.098944 seconds, 16 native low writer calls,291,204 tokens: input 63,588/output 219,680/cache 7,936/write cache 0. Reasoning metadata 201,822 is a subset of output, never added again. Normalized cost equals receipt charges $0.282740016. Allocated owner/query/context gives 1,337.226675 seconds, 86 calls,3,678,506 tokens, $0.467507220 normalized. All 16 receipts/provider roles/source hashes and inherited owner provenance passed; 03–14 prior measurements remained unchanged. No owner, Sol query or Jev call occurred. Low reasoning completed handoff application but increased calibration/handoff writing overhead and still failed extraction; this is no suite-wide reliable configuration or quality win.

Run `16-writer-recovery` froze `1f7e427`, replaying exact 12 plans/briefs with off primary writers and low only on the existing single application retry. Calibration applied 2/2 and passed all checks. Handoff applied 9/11: test-wave-authority recovered, but wire-dependencies still failed replacement count, blocking completion-guard. An independent source check found an actual newline in the rejected search where the unchanged target source contains literal `
`; predecessors had not modified the target. This is mechanical escaping, not behavioral feedback or proof that grouping caused failure. Extraction applied both operations on primary off calls without recovery, but visible tests first read undefined dependency_paths and external acceptance reported targetSetup undefined in wave-lifecycle.mjs. Application 2/3, delivery 1/3.

16 actual: 170.636118 seconds, 16 calls (14 off + 2 low), input 30,761/output 54,815/cache 49,024, total 134,600, $0.075300444 normalized=receipts. Reasoning 32,347 is a subset of output. Allocated: 681.763849 seconds, 86 calls, 3,521,902 tokens, $0.260067648 normalized.

Run `17-ungrouped-recovery-control` reused exact 16 frozen files (`1f7e427` execution; `2705cb0` orchestration) and exact 12 raw plans/briefs with grouping disabled. Calibration applied 3/3 and passed all checks. Handoff applied 12/15; separate wire-dependencies still failed replacement count, blocking editor-outcomes/completion-guard. Extraction recovered module creation but rewire failed a nonunique runtime.mjs anchor after low recovery; 1/2 applied. Handoff base/candidate/external failed; extraction base visible passed on the retained runtime and external failed. Application and delivery each 1/3.

17 actual: 351.035088 seconds, 23 calls (18 off + 5 low), input 60,298/output 89,876/cache 60,416, total 210,590, $0.126303096 normalized=receipts. Reasoning 67,502 is a subset of output. Allocated: 862.162819 seconds, 93 calls, 3,597,892 tokens, $0.311070300 normalized. Both runs have zero cache writes, owner/query/Jev calls and length stops; all donor/provider/receipt/operation-attempt provenance passed. No behavior failures entered any prompt. One pair with different outcomes cannot establish grouping causality or reliability, and no suite-wide quality win is established.

Run `18-smaller-regions` froze `80cf4f1` and reused exact 11 owner briefs, with fresh Sol queries that split large same-file assignments into ordered bounded regions. Optimization was none; writers retained off primary and one low application retry. The unchanged 96-call budget reserves 3 queries and 2 attempts per assignment, deriving 46 maximum assignments. Actual plans contained 3/19/4. All queries preceded writers; no owner or Jev call occurred.

18 completed application across all three cases once. Calibration applied 3/3 and passed base/candidate/external checks. Handoff applied 19/19 on 19 off primary calls, but visible/candidate/external failed; first visible error was missing wave-receipts.mjs imported by generated runtime.test.mjs. Extraction applied 4/4, with one low recovery, and passed 74 visible tests and external acceptance; no candidate test was selected. Full delivery 2/3 is distinct from application 3/3 and does not establish suite-wide correctness or reliability.

18 actual 331.558962 seconds,33 calls (5 Sol queries + 26 off primaries + 2 low recoveries),247,760 tokens: input 201,138/output 40,862/cache 5,760/write cache 0. Native receipts $0.354722260; normalized $0.109410360. Writer reasoning metadata 11,562 is a subset of output, counted once. Allocating inherited 11 owner only gives 742.945911 seconds,99 calls,3,548,689 tokens, $0.260918064 normalized. Query/writing/check seconds: calibration 17.210/6.924/.262; handoff 90.175/22.016/64.157; extraction 28.575/44.609/56.851. All failed check time remains included.

18 task/brief/result hashes, provider routing, retry bounds and 46-assignment cap passed audit. Query calls 2/2/1; max packet 150,963 bytes below 160 KiB. Lookup batches 2 requests/18,626 UTF-16 source characters and 7 requests/37,914 passed exact hashes/text/offsets/unique anchors; extraction requested no lookup. All 03–17 prior measurements remained unchanged. No plan/candidate was manually repaired and no downstream failure entered a model prompt.

Run `19-smaller-regions-repeat` reused exact 18 raw plans, briefs, dispatched plan bytes and frozen execution inventory (`80cf4f1`; orchestration `88c90e1`). Application completed 3/3 again, with 3/19/4 operations. Calibration passed delivery. Handoff applied 19/19 after two low recoveries but failed visible/candidate/external checks; its first visible failure was the missing corrupt.json coverage gap. Extraction applied 4/4 on off primaries but failed visible/external checks: spec-file/directory identity expected an empty array and received undefined. No candidate extraction test was selected. Full delivery fell from 2/3 in 18 to 1/3 in 19.

Writing plus optimization/routing was 73.550699 seconds in 18 and 124.219280 in 19 (pure writing 73.548905/124.217734). Both used 28 writer calls, 26 off and two low, but recovery moved from calibration/extraction to handoff. Actual elapsed was 331.558962/248.127157 seconds; the repeat incurred no new query work. Allocated elapsed, retaining original owner/query/context work, was 742.945911/795.475250. Compare the completed writing observations without treating omitted fresh planning or failed delivery as speed wins. Two application-complete observations do not establish a stable success rate or behavioral reliability.

19 actual input/output/cache-read tokens were 49,521/54,207/57,344, total 161,072; normalized native receipt cost $0.080248764. Reasoning metadata 23,735 is a subset of output, counted once. Cache writes and length stops were zero. Allocation gives 99 calls, 3,567,273 tokens and $0.271748568 normalized. All donor/frozen-plan/brief hashes, request/receipt identities, provider roles and operation retry bounds passed; prior 03–18 measurements remained unchanged. No new owner/query/Jev call, behavioral feedback or manual candidate repair occurred.

The main DeepSeek publication retains 03–19. Separate matched Sol writer controls and their repeat are now measured, without changing the main DeepSeek route or its report invariants. The repository reports are `scripts/changeset-study/writer-control-results.json`, `.md` and `.html`.

Both Sol controls completed application across all three cases and passed frozen source-replay, assignment, candidate/protected-path and provider/receipt audits. Each used 26 writer calls with no retries or length stops; neither incurred owner/query/review/Jev calls. DeepSeek 18's fresh queries remain excluded from the writing denominator. All four observations retain identical initial source, owner briefs, raw/dispatched partitions, dependencies, source bounds and exact execution backend 80cf4f1; controls use the identical bb2b6dd harness/full SDK/node/dependency/input inventories. Dependent excerpts legitimately use each arm's own staged writes. No behavioral feedback or independent semantic review occurred.

| Whole-suite writer observation | Writing + optimizer/routing seconds | Calls / retries | Application | Delivery | Normalized USD | SDK receipt USD |
|---|---:|---:|---:|---:|---:|---:|
| DeepSeek 18 | 73.550699 | 28 / 2 | 3/3 | 2/3 | 0.069418260 | 0.069418260 |
| DeepSeek 19 | 124.219280 | 28 / 2 | 3/3 | 1/3 | 0.080248764 | 0.080248764 |
| Sol 01 | 102.315176 | 26 / 0 | 3/3 | 2/3 | 0.043043700 | 0.314406000 |
| Sol 02 | 108.180454 | 26 / 0 | 3/3 | 2/3 | 0.039677424 | 0.292922400 |

Two whole-suite observations per route give descriptive mean writing times 98.884990 seconds for DeepSeek and 105.247815 for Sol. DeepSeek's wide recovery-dependent range overlaps both Sol observations. Sequential, non-randomized execution, provider latency and varying cache usage prevent a significance or stable-speed claim. Mean normalized cost was $0.074833512 DeepSeek versus $0.041360562 Sol; mean SDK receipt charges were$0.074833512 versus $0.303664200. Repricing is a comparison policy; subscription invoices/quota are unmeasured. The JSON retains writer-only per-case input/output/cache tokens and all costs.

Provider policies are not identical despite matched requested task limits: the pinned Sol adapter omits maxTokens, while DeepSeek sends max_tokens. Equal provider-enforced output ceilings are unproven. Sol's legacy same-selector retry can catch transport/model errors, but none occurred; DeepSeek's off-to-low recovery is local format/application/syntax only. No owner/query/check/startup time enters writing totals. Application qualifies completed writing separately from downstream behavior: all handoff observations failed delivery, and extraction failed only in DeepSeek 19. No treatment delivered all cases, and no reliable global optimum or clear writing-speed winner is established.

The prespecified bounded local-diagnostic pair 20–21, protocol 6a29f45, is now measured below. Application completed 3/3 twice, delivery remained 1/3, and only one retry received the new diagnostic. No improvement is established. The fixed-off comparison is now measured below; the goal remains active and divergent live experiments remain queued. No further trial has started.

Before run 20, the local application diagnostic had passed focused offline checks
and had no live result. It remains absent from frozen 18/19; the measured 20/21
results follow below. It privately replays
rejected replacements to identify the first failing edit and exact match counts.
JSON literals preserve escapes; a unique exact location or whole-line prefix can
provide a bounded source window, labeled as context from private replay rather than
an authorized replacement. Ambiguous locations are omitted. The addition is capped
at 4 KiB, retaining lengths/hashes for abbreviated literals. It adds no fuzzy
application, model calls, retries or behavioral feedback.

Repeat a promising frozen configuration before treating it as stable. Preserve the
full cases and failed attempts. The next selection evidence is the frozen repeat
and an equivalent writing-boundary comparator, not a proven suite-wide optimum.
No production managed-runtime integration
has been implemented, and the current goal remains incomplete.

## Fresh-owner run and the next bounded comparison

Run `11-fresh-owner-briefs` regenerated all three implementation briefs from original
sources. Calibration completed both assignments and all downstream checks. Handoff
and extraction stopped before Sol or writers: the catalog confused a known absolute
sandbox path with another relative path, and extraction's 51,727-byte catalog exceeded
the 49,152-byte limit. These two failures describe the harness, not editor capability.

The run incurred 468.258 seconds, 70 model calls and 3,327,081 tokens, including
3,085,824 cache-read tokens. Normalized comparison cost was $0.161421; settled model
receipts were $0.200204. No Sol call followed writer dispatch. The shared ledger now
holds $1.922589928 across 248 settled entries, with zero pending reservations.

Protocol 12 will reuse the exact fresh briefs. The harness normalizes existing absolute
paths under the declared source root and admits a 64 KiB catalog in lookup mode.
Unknown absolute paths remain unresolved. The complete query-context cap remains
160 KiB and delivered writer source remains 32,000 characters. Offline preflight and
review precede live execution; no result or speed claim is available yet.

## Follow-up experiments requested after this goal

The user supplied `RECOMMENDATIONS.md` in this same research directory and explicitly
requested subagent-led additional experiments after the current goal is complete.
Keep that ordering: do not start a separate campaign prematurely or reset the tracker.

The proposed sequence is a DeepSeek-only arm using the improved deterministic/range
executor, then apply-model arms only if its observed failures justify them, with
matched controls and a frozen repeat. Read the recommendation's stopping rule and
measurement contract before execution; confirm current provider capabilities and
output bounds then. Keep this separate from the current DeepSeek-owner / Sol-query /
DeepSeek-writer comparison. Any outer review remains outside the writing subsystem.

Several recommendations match current findings: source discovery dominates complete
pipeline cost; outline preparation can reduce model round trips; completed writing
alone cannot establish delivery. The note's claim that all receipts have zero cache
reads is no longer true for current retained runs, which report substantial cache
usage. Use live receipts rather than carrying that claim into new analysis.

A prospective smaller-assignment treatment would separate work by destination region
and syntactic transformation: scaffolding, declaration transfers, method-container
conversions and source cleanup. In the frozen 12 extraction plan, one assignment
combines these tasks across five methods; the other combines import cleanup, factory
wiring, removals and delegates. Local application diagnostics in 13/14 show missing
object-method separators followed by scope/declaration errors on retry. These facts
motivate the hypothesis; they do not establish that assignment size caused the errors.
The rewiring assignment was blocked, so its granularity has no observed writer result.

Split same-file assignments would form an explicit dependency chain, retain valid
syntax at each stage, and finish source copies before deleting originals. Sol would
only partition the settled owner decisions and bind source; DeepSeek would write.
Compare the retained plan with a separately frozen split plan using exactly the same
source and owner-brief bytes, writer settings and backend, with the optimizer disabled
to prevent regrouping. Count application completion, local retries, total calls,
tokens, cost and elapsed time. This planning treatment was subsequently measured in 18 and repeated in 19,
as reported above. Application completed across all cases twice; behavioral
reliability and a quality-preserving performance benefit remain unestablished.

The optional same-model DeepSeek `:off` → `:low` recovery route was implemented at
`e52b504`. It changes only the existing single local retry after format, application
or syntax rejection; it adds no behavioral-feedback or Sol review phase. Its initial proposal preceded the completed 15–19 measurements reported above.
Fixed-selector run 15 did not include this recovery treatment; runs 16–19 did.

## Integration into spec-end-to-end

The user subsequently authorized building divergent scenarios in parallel. Two
isolated prototypes have been built under the checkout's
`scripts/changeset-study/divergent/`: a DeepSeek-only executable-changeset runner
using the existing modern executor, and an apply-writer adapter with deterministic
checks that preserve source outside explicitly owned regions. Preparation and
offline tests can proceed during the current study; their live comparisons remain
queued until this goal completes. Both passed focused offline tests and independent
review. The DeepSeek runner now requires the existing canonical donor ledger and
binds result qualification to its frozen model selector. The apply writer reports
whether syntax checking ran. These prototypes were pushed at `abb8623`; the DeepSeek-only changesets runner has now made the single measured run below;
the apply-writer prototype has not made a live task comparison. Neither prototype
changes the frozen three-role treatment. Morph and Relace remain unconfigured candidates, not measured routes.

A third isolated prototype now lives at
`scripts/changeset-study/divergent/provenance-compiler/`. It compiles eligible
mechanical recipes from exact hash-bound source spans and verbatim fenced code in
the settled owner brief. All other assignments remain delegated. It preserves the
plan graph and initially accepts independent operations only, excluding any source
or target another operation writes. Three focused offline tests cover activation,
provenance rejection, unchanged fallback, fences and target-byte preservation. Review closed
prewritten-edit and malformed-fence bypasses. Its returned files are a private
preview; the compiled plan executes against the original snapshot. It has no model
connection or live performance result and does not change the current treatment.

A fourth isolated prototype lives at
`scripts/changeset-study/divergent/source-splice/`. It copies exact source ranges
into an existing staged target, using hash-bound snapshots, explicit read/write
ownership and unique anchors. It reuses the existing transform and syntax checker,
returns a private preview and leaves inputs untouched on rejection. Three focused
offline tests passed, including overlapping-anchor rejection. This addresses an
executor limitation: ordinary compose creates absent files only, so a prompt-only
partition cannot progressively insert copied source into an already created file.
The prototype has no live planner integration or measured performance benefit.

The apply-writer prototype must not treat guessed lazy-snippet landing locations
as proof of edit ownership. Its first version uses explicit allowed source regions;
this is a narrower contract than accepting arbitrary imprecise anchors and must be
reported as such.

Insert this at the existing step owner's writing boundary. The production owner
already decides implementation, so reuse that reasoning. Sol compiles its settled
batch into source bindings and dependencies; it does not redo implementation design
or inspect writer results. Local optimization and optional Jev advice happen before
dispatch. DeepSeek writers run under existing writer leases, path fences, cancellation,
receipts and staged-source rules.

The outer workflow retains test-first ordering where required, behavioral verification,
independent review and any resulting implementation work. Application recovery stays
inside the writer; behavioral correction stays outside file modification. Do not add
a Sol review or repair phase to this writing subsystem. See the proposed seams in
`scripts/changeset-study/INTEGRATION.md`.

## Models, cost and retained evidence

Live models remain Sol 6.1 (`openai-codex/gpt-6.1-sol:low`) for query planning and
native-provider DeepSeek V4.1 Flash (`deepseek/deepseek-flash:off`) for ownership and
writing. Mercury and Nemotron are excluded. Sol uses DeepSeek's comparison tariff,
as requested; normalized comparison cost differs from catalog charges and conservative
budget holds. Root/development subscription work is not a live-study provider charge.

The user reset the money tracker. The prior ledger remains archived with $29.2873046
of exposure, including unresolved older reservations; the new $50 allowance is active.
The prior through-19 snapshot was 422 entries/$3.200381476, including model receipts $3.200122476 plus prior Jev entries. Main artifacts now include runs through23. The separate Sol controls add 52 settled entries/$0.607328400 in SDK receipt charges ($0.082721124 normalized). Latest shared ledger: 582 settled entries, zero holds, $3.995906392 exposure against the existing $50 limit. Control charges are not attributed to DeepSeek run rows. DeepSeek-route campaign through23: 530 entries/$3.388577992, normalized model cost $1.634130876, with controls stated separately; allocated donor costs are not new spend. Use the live ledger for the exact current balance;
do not silently reset it again. Raw requests, receipts, source hashes, candidates and
`optimized-report.json` remain in adjacent experiment storage. User idea files remain
untouched, and implementation/reporting tasks may be delegated to Sol or Luna.

## Diagnostic pair 20–21 measured

The prespecified pair froze `2220f52`, retained exact 18 raw plans, briefs, dispatched partitions and task bytes, and used the same off primary/low local recovery policy with optimization `none`. Run 21 reused the exact 20 frozen inventory. The reachable executor change from 18 was the bounded local application diagnostic; no owner, query, review or Jev call occurred. No behavioral feedback entered any model, and plans/candidates were not manually repaired.

| Case | 20 application / delivery | 21 application / delivery | 20 writing + optimizer s | 21 writing + optimizer s | 20 checks s | 21 checks s |
|---|---|---|---:|---:|---:|---:|
| hard-context-calibration | complete / pass | complete / pass | 3.511531 | 3.045034 | 0.253591 | 0.249953 |
| hard-dependency-handoff | complete / fail | complete / fail | 98.095381 | 111.237409 | 64.268243 | 246.020546 |
| hard-lifecycle-extract | complete / fail | complete / fail | 8.465988 | 22.527357 | 26.615073 | 25.978840 |

Application completed 3/3 in both observations, with delivery 1/3 in both. Run 20 handoff first failed visible import validation because generated runtime.test.mjs imported `EDITOR_PROFILE`, which runtime.mjs did not export. Extraction's first visible failure was an undefined data argument in wave-lifecycle.mjs registration; external grading also rejected runtime.mjs exceeding 1,550 lines. Run 21 handoff passed base visible tests, but its candidate's first assertion expected a length-limit message and received a revoked/absent writer-lease message. Candidate checking retained its 180-second timeout; external checks failed. Run 21 extraction first failed spec-file/directory identity (`undefined !== []`) and external grading rejected the module line bound. No generated extraction candidate test was selected.

Run 20 used 27 writer calls (26 off/one low); its sole retry used existing syntax context. Run 21 used 29 calls (26 off/three low): one format retry, one syntax retry and one new application-diagnostic retry. That diagnostic identified edit index 1, a replace in runtime.test.mjs with expected one/actual zero exact matches. The serialized addition was 599 bytes, within 4 KiB, and the retry applied successfully. Thus the new diagnostic was exposed once across the pair; successful recovery on that one event does not establish a causal benefit. No length stop or transport/model retry occurred. Reasoning metadata remains a subset of output and is counted once.

| Pair metric | 20 | 21 |
|---|---:|---:|
| Writing + optimizer/routing s | 110.072900 | 136.809800 |
| Process-total s | 201.957334 | 409.795767 |
| Allocated pipeline s | 749.305427 | 957.143859 |
| Actual calls | 27 | 29 |
| Input / output / cache-read tokens | 40,374 / 30,159 / 52,864 | 59,161 / 42,182 / 53,376 |
| Actual tokens | 123,397 | 154,719 |
| Normalized / receipt USD | 0.048620184 | 0.068686956 |
| Allocated calls / tokens | 98 / 3,529,598 | 100 / 3,560,920 |
| Allocated normalized USD | 0.240119988 | 0.260186760 |

The diagnostic-pair writing mean is 123.441350 seconds, range 110.072900–136.809800, versus 98.884990 (73.550699–124.219280) for the earlier exact-plan DeepSeek pair 18/19. Neither pair establishes a speed improvement, and delivery did not improve. These are sequential, non-randomized observations with varying caches, provider latency and recovery work. Process-total time includes all failed checks; it is not the writing denominator. Allocation retains original 11 owner plus 18 query/context work exactly once and excludes donor writing/checks. All source/provider/receipt/attempt audits passed; prior 03–19 measurements remain unchanged.

At through-21 publication, the shared ledger had 530 settled entries, zero holds and $3.925017016 exposure against $50. The separate Sol controls remained 52 entries/$0.607328400; the DeepSeek-route campaign through21 was 478 entries/$3.317688616. Its model receipts total $3.317429616; trial Jev adds $0.000169000 and another settled Jev entry $0.000090000. Main normalized model cost is $1.563241500, or $1.563410500 with trial Jev. Allocated donor costs are not new spend.

The final fixed-off diagnostic pair 22–23 is now measured below. No further main trial has started. No global optimum, quality-preserving win or full-workflow Sol improvement is established.


## Final main tuning pair: fixed off 22–23

The final pair retained all three original tasks, exact 18 raw plans/briefs/dispatched partitions, smaller-region assignments, optimization `none`, original limits and diagnostic backend. Run 22 froze `3a4de3f`; run 23 retained its exact frozen inventory. The only writer-policy change from 20/21 removed the low-reasoning recovery selector: both primary and any existing retry would use off. Reachable main runtime modules and the injected parser matched 20. No owner, query, review, Jev or behavioral-feedback call occurred.

| Case | Applied each run | Delivery each run | 22 writing + optimizer s | 23 writing + optimizer s | 22 checks s | 23 checks s |
|---|---:|---|---:|---:|---:|---:|
| hard-context-calibration | 3 | pass | 2.992324 | 2.753049 | 0.253830 | 0.265526 |
| hard-dependency-handoff | 19 | fail | 24.933117 | 25.484960 | 72.269142 | 191.928447 |
| hard-lifecycle-extract | 4 | fail | 22.156735 | 7.061948 | 51.939481 | 53.365427 |

Application completed 3/3 in both runs; full delivery was 1/3 in both. Calibration passed base/candidate/external checks. Both handoff base suites passed, but generated candidate and external checks failed. Run 22's first candidate failure was a fixture dependency-graph error: steps 1–3 omitted requires/writes; external checks also found undefined packagePath. Run 23's first candidate failure was an undefined path passed to join in buildDependencyHandoff. Run 22 extraction first failed spec-file/directory identity (`undefined !== []`). Run 23 extraction first failed wave-member startup because ensureWaveDeadline tried to call an undefined method. Both extraction external checks failed; no generated extraction candidate check was selected. All failed check time remains included.

Each run used exactly 26 off primary calls and zero retries. No diagnostic packet, reasoning token, length stop or transport retry occurred. The strict fixed-off audits independently replayed staged-source edits and validated all tasks, source/brief/raw/dispatched bytes, frozen SDK/backend/dependencies, provider/request/receipt identities, call bounds and qualification. Audit exit zero means integrity passed; it does not mean delivery passed. The audits made no provider call. Previous 03–21 report objects remain unchanged.

| Accounting | 22 | 23 |
|---|---:|---:|
| Writing + optimizer/routing s | 50.082176 | 35.299958 |
| Process-total s | 175.258161 | 281.556840 |
| Allocated pipeline s | 722.606254 | 828.904933 |
| Actual calls | 26 | 26 |
| Input / output / cache-read tokens | 41,621 / 20,864 / 53,504 | 44,427 / 16,166 / 52,992 |
| Actual tokens | 115,989 | 113,585 |
| Normalized / receipt USD | 0.037844124 | 0.033045252 |
| Allocated calls / tokens | 97 / 3,522,190 | 97 / 3,519,786 |
| Allocated normalized USD | 0.229343928 | 0.224545056 |

Cache writes are zero. Allocation retains inherited 11 owner plus 18 query/context exactly once, excluding donor writing/checks. Actual writing-stage cost equals native DeepSeek receipts; allocated work is not charged again.

| Whole-suite writer pair | Mean writing + optimizer/routing s | Observed range s | Calls per suite | Retry exposure | Application / delivery |
|---|---:|---:|---|---|---|
| DeepSeek 18/19 off → low, earlier backend | 98.884990 | 73.550699–124.219280 | 28 / 28 | 2 / 2 | 3/3 twice; 2/3 then 1/3 |
| DeepSeek 20/21 off → low, diagnostic backend | 123.441350 | 110.072900–136.809800 | 27 / 29 | 1 / 3; new diagnostic 0 / 1 | 3/3 twice; 1/3 twice |
| DeepSeek 22/23 fixed off, diagnostic backend | 42.691067 | 35.299958–50.082176 | 26 / 26 | 0 / 0 | 3/3 twice; 1/3 twice |
| Separate matched Sol controls 01/02 | 105.247815 | 102.315176–108.180454 | 26 / 26 | 0 / 0 | 3/3 twice; 2/3 twice |

The fixed-off pair has the lowest observed writer mean and range on these exact tasks/plans. It is a provisional first-pass writing candidate. Because no fixed-off retry occurred, neither fast recovery capability nor a causal speed benefit from changing recovery mode is established. Only two sequential, non-randomized observations per pair, varying output/cache/provider latency and imperfect provider-output-cap parity limit comparisons. Sol's downstream outcomes were stronger; none of these configurations delivered every case. The historical full-workflow Sol observations are unmatched and cannot establish a writing-boundary win. No global optimum or quality-preserving full-workflow speedup is claimed.

Final main snapshot: shared ledger 582 settled entries, zero holds, $3.995906392 of $50. Separate Sol controls remain 52 entries/$0.607328400; DeepSeek-route campaign03–23 is 530 entries/$3.388577992. Main model receipts $3.388318992 plus trial Jev $0.000169000 and other Jev $0.000090000 reconcile to that campaign exposure. Main normalized model cost is $1.634130876, or $1.634299876 including trial Jev.

Main tuning stops here for configuration selection. At through-23 publication, the separate DeepSeek-only changesets architecture was prepared for a subsequent comparison. Its later result is recorded separately below. No further main trial has started.

## Separate DeepSeek-only changesets run measured

Audited delivery was **0/3**. Calibration's initial two-operation plan applied, but its generated regression failed and the one repair failed an exact replacement. Both larger cases exhausted the original 96-call discovery limit before emitting a plan. These outcomes do not establish a speed win or general DeepSeek incapability.

`scripts/changeset-study/deepseek-only-results.json` retains hashes, phases, calls, tokens and qualification. The `scripts/changeset-study/divergent/deepseek-direct/PROTOCOL.md` describes the separate treatment: DeepSeek Flash off performs planning, boundary review and at most one batch repair. There is no Sol, reused owner brief/query plan, delegated writer, optimizer or router. Original tasks, source and limits come from run03; hidden grading is terminal and never returns to a model. This includes review/repair work and is not the earlier writer-only denominator.

| Case | Initial / final application | External acceptance | Recorded / audited delivery | Calls | Process-total s | Audited elapsed s | Receipt USD |
|---|---|---|---|---:|---:|---:|---:|
| hard-context-calibration | 2/2 / 1/2 | pass | fail / fail | 4 | 16.324921 | 16.325450 | 0.012367092 |
| hard-dependency-handoff | no plan / no execution | fail | fail / fail | 96 | 221.558075 | 221.734511 | 0.101107140 |
| hard-lifecycle-extract | no plan / no execution | fail | fail / fail | 96 | 287.549407 | 287.649892 | 0.121860504 |

Calibration used two planning calls and two boundary reviews. Its initial regression's clamped-ratio assertion failed; the repair duplicated the regression and failed `Replacement count mismatch: pi/extensions/context-budget/policy.mjs`. Final visible checks and boundary review rejected it even though terminal external acceptance passed. Initial edit application is an observed mechanism success, not final delivery.

Handoff and extraction each used all 96 calls in read-only discovery, ending with `Cell model-call limit exceeded`. Neither emitted a plan or ran an edit batch. Their retained final candidates are the original source snapshots. Handoff's required frozen post-hoc path diagnostic was attempted, but failed: `Diagnostic requires one identifiable dirty-state block or function; inspect candidate before adapting diagnostic`. No successful candidate-hash-bound path audit exists, so audited delivery cannot qualify.

Read-only planning is intentional: the embedded skill requires a final executable JSON plan, after which the deterministic executor applies edits. Prompt inspection found a generic coding-agent preamble describing edit/write and a tool block saying “(none)” despite actual bash/read tools; late handoff calls probed temporary state repeatedly. A planner/tool-role conflict is possible, but causality is unproven. Missing write capability is not an established executor blocker. A future bounded-discovery or stricter-planner-prompt treatment would be a separate freeze; none was implemented here.

| Usage | Calls | Input | Output | Cache read | Cache write | Total tokens | Receipt USD |
|---|---:|---:|---:|---:|---:|---:|---:|
| hard-context-calibration | 4 | 25,507 | 3,917 | 2,432 | 0 | 31,856 | 0.012367092 |
| hard-dependency-handoff | 96 | 64,895 | 36,461 | 6,314,240 | 0 | 6,415,596 | 0.101107140 |
| hard-lifecycle-extract | 96 | 71,262 | 50,165 | 6,713,984 | 0 | 6,835,411 | 0.121860504 |
| Total | 196 | 161,664 | 90,543 | 13,030,656 | 0 | 13,282,863 | 0.235334736 |

| Recorded phase seconds | Calibration | Handoff | Extraction |
|---|---:|---:|---:|
| initialize | 0.145566 | 0.130250 | 0.134060 |
| planning | 5.375533 | 0.000000 | 0.000000 |
| execution | 0.057067 | 0.000000 | 0.000000 |
| visible-check | 0.340188 | 1.730391 | 28.969048 |
| impact-review | 5.238219 | 0.000199 | 0.000168 |
| repair-planning | 4.970808 | 0.000000 | 0.000000 |
| terminal-grading | 0.102051 | 0.116505 | 0.027418 |
| discovery-planning | 0.000000 | 219.326631 | 258.162725 |

Actual process-total was 525.432402 seconds; audited elapsed including post-hoc qualification was 525.709853. Audited capped time-to-success is **4,500 seconds**: every failed delivered case receives its original 1,200-second cell plus 300-second grading cap. The frozen calibration field recorded 16.324921 seconds from external acceptance; JSON preserves that field separately rather than treating it as delivered success. Request/receipt usage is counted once, with zero reported reasoning tokens and no length stop. Tiny impact-review stage durations on the larger cases are deterministic overhead; no model review call occurred there.

Post-run checks verified frozen Node 22.23.3, code/overlay, full SDK, dependencies, parser and task pins. All 196 requests and receipts match the explicit DeepSeek off selector and canonical ledger; candidate/result/plan hashes and terminal-oracle exclusion passed. The prepared manifest hash is `f465e02c1019cea11faf64ef677415bb20298b6644aa8a5c45f4504149cbe56a`, harness revision `bb2b6dd`.

Shared ledger: 780 settled entries, zero holds, $4.231698378 against $50. Prior main study plus Sol controls remain 582 entries / $3.995906392; this run adds 196 entries / $0.235334736. Two separate specialized-writer integration probes add $0.000457250. Costs use retained native receipt/catalog fields, not independently checked invoices. Main 03–23 and Sol-control results are unchanged; no allocation credits or charges are transferred between routes.

There is no matched three-task native DeepSeek baseline. The retained 336-second native lifecycle observation is historical and unmatched in scope. No performance claim is warranted. No repeat or further live trial was started.

The separate [specialized-writer integration probes](https://github.com/ryan-mahoney/ryan-llm-skills/blob/37bdfeb/scripts/changeset-study/divergent/specialized-writer/integration-probe-results.md) each passed one synthetic full-file update (Morph V3 Fast and Relace Apply3), two calls/$0.000457250 combined. This confirms request wiring and local application on that fixture, not a full-task benchmark or comparative win. These charges remain separate from the DeepSeek-only changesets run.


## Specialized full-file alternatives: original three-task run

Neither complete route delivered a task: Morph V3 Fast 0/3; Relace Apply3 0/3. This standalone alternative uses direct DeepSeek Flash off to settle instructions/update snippets, then sends identical snippets and original full-file sources to each vendor. No changeset IR, Sol planning/review, hidden feedback, model review or semantic repair participates. Three exposed development tasks, one retained preparation each and one attempt per vendor do not establish a general winner.

DeepSeek preparation took 126.124s, 4 calls,$0.104863656 and 276,839tokens. Calibration and handoff settled 2 and 6 targets in 5.397s/1 call and 37.571s/1 call. Lifecycle's initial prose/tool markup was invalid JSON; its one format correction stopped at the 32,000-token output cap. Lifecycle therefore remains owner-failed in both vendor denominators, with no vendor test. The first paid freeze then hit a fractional-millisecond harness timeout error before any vendor call; the corrected freeze pinned/reused the exact original preparation without another owner call.

| Vendor / eligible task | Applied | Delivery | Writing s | Complete-route s | Writer calls / catalog USD |
| --- | --- | --- | ---: | ---: | ---: |
| Morph / calibration | 2/2 files | fail | 1.446 | 7.097 | 2 / 0.013181600 |
| Morph / handoff | 6/6 files | fail | 22.230 | 360.486 | 6 / 0.158110000 |
| Relace / calibration | 2/2 files | fail | 1.809 | 7.460 | 2 / 0.013621700 |
| Relace / handoff | stopped at file 3 | fail | 5.488 | 45.015 | 3 / 0.079066800 |

Both calibration hidden suites completed/pass and five existing tests pass, but an owner-generated regression incorrectly expects a 540,000-character request to pass: minimum ratio 0.5 projects 90,517 against the 90,000 guard. Full delivery stays failed. Morph handoff drops the existing promptRevision helper; six existing checks raise ReferenceError. Posthoc review found zero preservation markers in every handoff update, and the frozen owner prompt did not require them. [Morph assigns deletion meaning to missing markers](https://www.morphllm.com/fast-apply-model#the-edit-format), so this is an integration-format confound, not an unambiguous model retention error; causality remains unisolated. Generated checks additionally have a missing fixture-directory failure. Its hidden suite reports failures and is killed by the 300s external abort without completion (SIGKILL/137, raw timedOut false); cleanup is confirmed. Relace returns duplicate currentHandoff definitions where source/update each have one; its [agent](https://docs.relace.ai/docs/instant-apply/agent) and [workflow](https://docs.relace.ai/docs/instant-apply/workflow) docs also prescribe unchanged-section comments absent from the supplied update, so model-only attribution is confounded; local syntax validation rejects that third file before installation. Its partial candidate retains the original runtime and hidden grading fails the missing buildDependencyHandoff export. Both handoff path audits are structurally inapplicable and cannot qualify delivery.

Actual combined spend is 17 priced calls/$0.368843756/537,544tokens, zero holds. This counts 4 original owner calls once plus 13 new writer calls. Morph route allocation is 12 calls/$0.276155256/449,118tokens; Relace is 9 calls/$0.197552156/365,265tokens, each allocating preparation once. Route totals must not be summed as actual spend. Capped time to delivered success is 4,500s per route because all three delivered outcomes fail. Lifecycle contributes its failed preparation, never a zero-time successful write. Relace's early failure cannot establish faster completed application.

Posthoc checks verify frozen Node/code/SDK/dependencies, source/snippet identity, routing, candidate/protected hashes and canonical reservations. Nine focused offline checks pass (~199ms); independent review closed the timeout/reuse and final report findings. Owner revision 56a11ea; writer-only resume 6284c83. Full-file output ceilings differ (Morph 38,000, Relace 128,000) with explicit approximate bytes/4 input estimation. No writer context refusal or writer length stop occurred. Provider catalog costs are estimates, not invoice-exact charges. Development/recovery/freeze elapsed is outside route estimates; no matched native baseline or whole-workflow efficiency win is claimed. Earlier reports are unchanged.

Posthoc format corrections change attribution, not measurements; no corrected-format trial ran. The [OpenCode Morph plugin](https://github.com/JRedeker/opencode-morph-fast-apply#safety-guards) documents import-loss, truncation and marker-leakage guards that reject known damage before writes. They do not establish general automatic repair. Relace's diff-to-agent review suggestion is outside the frozen no-model-review boundary. No guard follow-up was implemented or measured.

### Specialized writer selection decision

The operator excluded Morph and Relace from current implementation candidates on cost. Retain their measured results and the preservation-marker format limitation; no further tuning or paid trials for either model. Reconsider specialized writing only for a materially lower-cost alternative. The Muse, DeepSeek, Sol and MiMo changeset permutations continue independently.

### Four model permutations: planning boundaries and one matched writer case

The four changeset routes were Muse Spark 1.3 Contributor high alone (implementation plus executable edits), Muse high → native DeepSeek off, Sol 6.1 low → Muse high, and Sol low → PrimaLabs MiMo-V2.6-Pro requested medium. The last setting uses the explicitly approved configured mapping: thinking enabled, with no distinct medium-effort value on the wire. The original 12 route observations are retained. A separately reviewed credential-store fix resumed MiMo calibration with the exact paid Sol plan and no new planning call; the original credential block remains a harness outcome.

Only calibration reached writers. Muse-self stopped in all three tasks after requesting another source batch. Muse-delegated handoff stopped on a non-unique context anchor; its lifecycle plan requested another batch. Sol's handoff request asked for the complete 108,558-character runtime file against the 64,000-character lookup cap; its lifecycle preparation also requested another batch. No handoff or lifecycle writer ran. These expose the frozen bounded-planning interface, not failed writer implementation ability or a supported model ranking. No source-protocol tuning or task-specific replan ran.

| Route | Application complete | Terminal accepted | Audited delivery | Allocated calls | Normalized allocated route USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Muse executable edits itself | 0/3 | 0/3 | 0/3 | 6 | 0.008622400 |
| Muse → DeepSeek | 1/3 | 1/3 | 0/3 | 8 | 0.014998008 |
| Sol → Muse | 1/3 | 1/3 | 1/3 | 7 | 0.023066300 |
| Sol → MiMo, after credential fix | 1/3 | 1/3 | 1/3 | 7 | 0.032598345 |

The sole matched writing comparison is calibration on the exact same Sol plan, initial writer packets, source, execution backend and SDK. Both writers made two calls and passed full delivery: Muse high took 107.752s/$0.003816800, versus MiMo thinking-on 44.217s/$0.013348845. MiMo was faster and more expensive in this single observation; neither has three-case delivery evidence here. Muse → DeepSeek used a different plan and took 2.894s/$0.001999308: application and hidden acceptance passed, but visible/changed regression checks failed, so audited delivery is false. Cheap application is not successful delivery.

Actual combined spend was 23 calls, $0.171700053 in SDK receipt prices/matching ledger charges, or $0.060035553 with Sol subscription calls normalized at the established DeepSeek rates. Actual tokens were 176,366 input, 87,361 output, 768 cache read, zero cache write and 264,495 total. The 74,217 reported reasoning tokens are part of output, not additional tokens. Shared Sol preparation was paid once (five calls; raw $0.130914000, normalized $0.019249500), allocated in full to both routes, including their failed preparations. Do not sum route allocations as actual spending. Final canonical ledger: 820 entries/$4.772242187/$50, no unresolved charges or holds. Normalization never rewrites literal ledger charges; SDK prices are not independently verified invoices.

The original freeze is 6284c83; credential-resume freeze c47826b. Detailed observations, stage times, hashes and all failures remain under `model-permutations/01-four-arms` and `model-permutations/02-mimo-auth-resume`, relative to the changeset-execution-poc spec runtime root. The original 12 observations and separate three-row resume are preserved. No new optimal whole-workflow configuration is established. Future source-preparation work would need its own frozen treatment; no further paid calls ran. The Morph/Relace cost exclusion above remains in force, with reconsideration only for a materially cheaper alternative.

### V4A and executable JSON capability pilot

DeepSeek Flash generated correct V4A patches and executable JSON changesets on every settled encoding case in this pilot. Muse Spark Contributor high and MiMo V2.6 Pro configured medium also passed every JSON encoding case. Sol is therefore not the only model demonstrated to generate executable changesets. This is a small, fully supplied capability screen, not a replay of the earlier large tasks or evidence of production reliability.

The frozen corpus contains seven positive encoding fixtures, one impossible instruction requiring refusal, and four implementation fixtures. Each condition ran twice, with the second order reversed, for 88 sequential calls. Encoding covers replacement, separated edits, repeated blocks, CRLF/tabs/Unicode, missing final newline, create/delete/move, and dependent edits. Implementation covers a duration helper, receipt API migration, safe header normalization, and dependency ordering. All source was supplied; the largest serialized context was 3,828 bytes. No Sol call, source lookup, separate writer, model review, repair or retry participated.

| Treatment | Encoding edits | Expected refusals | Implementation | Encoding median generation s | Implementation median generation s |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek off, V4A | 14/14 | 2/2 | not tested | 1.037 | — |
| DeepSeek off, JSON | 14/14 | 2/2 | 8/8 | 1.181 | 1.871 |
| Muse high, JSON | 14/14 | 2/2 | 7/8 | 8.613 | 30.895 |
| MiMo configured medium, JSON | 14/14 | 2/2 | 8/8 | 1.219 | 4.947 |

Encoding latency includes the two refusal calls. These are generation times, not complete workflow times. Across the same 16 encoding cells, DeepSeek V4A used 1,005 output tokens and $0.002749608, versus JSON's 2,093 output tokens and $0.003871272. The adapter is V4A-compatible with documented guards, not an exact stock implementation: it rejects ambiguous matches and preserves source line endings and missing final newlines. No silent whitespace, string, comment or AST normalization was used. Primary parsing was strict; lenient V4A wrapper handling remained a separate diagnostic.

The sole failure was Muse's second header-normalization attempt: output-length stop after 94.173 seconds, with 1,470 final-text bytes and no application. The request specified 8,192 output tokens; the provider reported 8,408, including 7,786 reasoning tokens. Requested and reported limits remain distinct. This was an incomplete answer, not an applied incorrect candidate. The other 87 calls qualified, including all eight expected refusals. No applied-but-incorrect output occurred. Implementation qualification required private completed behavioral assertions and protected-file preservation; matching reference source was not required.

Whole-file replacement remained valid. DeepSeek used at least one whole-current-file replacement in seven of eight implementation outputs, Muse in five of seven parsed outputs, and MiMo in four of eight. DeepSeek emitted 18 implementation operations with nine declared dependency edges; Muse and MiMo used one multi-file operation per parsed output and no dependency edges. These results demonstrate executable edits and behavior on tiny cases, not sophisticated changeset decomposition or source discovery. The earlier bounded-discovery failures on a 108,558-character runtime remain separate evidence.

Actual model usage was 88 calls, $0.0437494612, 34,462 input tokens, 83,049 output tokens, 26,416 cache-read tokens and 143,927 total tokens. The 63,678 reasoning tokens are part of output, not additional usage. Every request joins its response, receipt and canonical ledger entry; no unknown charges or integrity failures remain. Prices come from frozen SDK metadata and receipts, not independently verified invoices. MiMo retains the approved thinking-enabled mapping without a distinct medium effort value on the wire.

The measured freeze is `dd44d72`, with artifacts under `v4a-suite/02-pilot` relative to the changeset-execution-poc spec runtime root. An unused `01-pilot` preparation was retained without inference because concurrent optimizer edits were present; the measured run instead used a clean detached committed checkout. Frozen code, actual SDK, Node, corpus, prompts, candidates, gates and accounting were independently checked. The committed harness and protocol live under `scripts/changeset-study/divergent/v4a-suite/` in the study repository. No specialized-writer reconsideration or whole-workflow integration was performed.

## Combined intervention comparison: fixed plans, six observations

The combined route did not improve delivered correctness. The same three run18 Sol plans, original sources and settled DeepSeek briefs yielded baseline application 3/3 and delivery 1/3, versus combined application 2/3 and delivery 1/3. Baseline used DeepSeek Flash off JSON edits; combined enabled deterministic grouping, one Jev batch per plan, V4A primary edits and one same-model local JSON fallback. There were no new owner/Sol/review calls or behavioral feedback. This is a writing-boundary comparison, not fresh end-to-end workflow speed.

Calibration writing took 3.358 s baseline versus 4.069 s combined, both delivered. Handoff took 36.834 s versus 33.569 s, both applied but failed downstream. On these two application-complete pairs, combined totals 37.638 s versus 40.192 s (6.4% lower), at mixed cost $0.049847022 versus $0.035646228 (39.8% higher); this subset is not a suite-wide win. Combined extraction's 4.606 s versus baseline 7.680 s is an early-failure duration, not a speed gain: V4A syntax rejection was followed by a nonunique JSON composition anchor, leaving original source and blocking two dependents. Baseline extraction applied but failed cancellation/drain behavior. No candidate was repaired after behavioral checks.

Grouping reduced planned assignments 26→17 and depth 2→1/10→6/4→3 across the three cases. Of 17 planned combined packets, 15 dispatched: 8 V4A primaries succeeded locally, 7 needed JSON fallback and 6 of those recovered, yielding 14 completed packets. Jev made 3 successful requests using `jev-1.13.0`, with no applied merge veto or whole-file context override; no incremental routing benefit was demonstrated. Combined handoff hidden output reports 98/101 tests passing with 3 undefined-loadCompletion failures; baseline also 98/101 but with different null-state/prerequisite-classification failures. Combined emitted candidate checks report 0/5 passing for fixture/API/environment reasons; baseline changed-test command 93/103 passes. Both retain hidden completed:false, exit 1 and no timeout despite TAP summaries. These results do not isolate model, plan or format causality. Selective deterministic source composition remains a possible future investigation, not a shipped remedy.

All 52 campaign reservations reconcile: 49 DeepSeek writer calls plus 3 Jev calls, $0.091663272 DS receipt cost plus $0.000308952 Jev input-token estimate, total $0.091972224; zero unknown/orphaned/unattributed charges. Baseline DS usage is 44,901 input/19,876 output/57,088 cache-read/121,865 total tokens; combined 94,777/21,300/1,024/117,101. Cache writes are zero; Jev adds 7,356 input+579 output. Different prompt formats and prior identical baseline-prompt exposure make cache effects a substantial confound; the cost difference cannot be assigned solely to V4A output. Shared ledger snapshot 960 entries/$4.9079638722 has zero unresolved exposure; prior campaigns remain separate. Catalog receipt prices and Jev estimates are not invoice verification.

An auditor source-map insertion-order mismatch initially stopped after calibration. Exact unchanged bytes in workspace traversal order verified the two original observations; a corrected read-only auditor resumed only the remaining four. No paid observation was repeated. All six retain original worker/backend `b70a84c`; auditor/resume `680ac3a`. Raw evidence is `combined-dispatch/01-matched` under the changeset-execution-poc spec runtime root, with final results in `resume-01/results.json`; compact publication is `scripts/changeset-study/divergent/combined-dispatch/results.{md,json}` in the study repository. Timing includes preprocessing (Jev/optimization once) plus execution wall, excluding outer checks and reused planning; overlapping provider latency is separate. One alternating-order observation per arm/task cannot establish general reliability or an optimum. Managed spec-end-to-end was not changed, and no further trial was started.

## Revised V4A interface: combined-only rerun

The revised combined route completes 3/3 applications and delivers 2/3 tasks: calibration and lifecycle extraction pass; handoff remains behaviorally incorrect. Of 17 primary V4A packets, 15 pass locally and two correctly rejected hunks recover through the single JSON fallback, completing all 17 packets. The applier's strict matching, path, ambiguity, syntax and atomicity guards are unchanged. The new `cbb3380` freeze supplies complete physical source lines and selected bodies within 64,000 UTF-16 code units, with no JSON-oriented body omission, plus one-envelope and forward-source-order instructions. Exact earlier tasks/plans/briefs are reused; no new owner/Sol/review calls or behavioral-feedback repair occurs.

Writing wall is 3.151s calibration, 34.939s handoff and 58.090s extraction (96.179s total), including preprocessing/Jev once and excluding outer checks. Extraction now passes on three V4A primaries with zero fallback, emitting 22,533 output tokens. Its earlier combined 4.606s ended before implementation and is not a completed-work speed comparator. Prior JSON baseline and initial combined outcomes remain historical; neither was freshly repeated. This demonstrates improved observed application usability, not an isolated causal or speed win. Full literal body copying can be expensive: peak delivered source is 41,636 UTF-16 code units; peak serialized context is 49,484 bytes. Units and bounds differ.

The remaining invalid V4A hunks join disjoint source excerpts as a contiguous block (`runtime-imports`) or label new continuation code as unchanged context (`runtime-editor-outcome`). Both are rejected without staged mutation and recover with JSON; no reason to loosen the applier follows. Handoff base checks pass, its candidate checks pass 0/4, and hidden output passes 98/101 with accepted prerequisites classified unknown/malformed and absent detail counts. Raw hidden flags remain exit1/completed:false/no timeout. This differs from its prior undefined-helper failure; application still does not establish delivery.

All 22 canonical reservations reconcile: 19 DeepSeek calls (17 V4A primary + 2 JSON fallback) and 3 Jev calls, no unresolved/orphaned/unattributed exposure. DeepSeek uses 88,961 input/40,418 output/1,920 cache-read/zero cache-write/131,299 total tokens, costing $0.075201420 at retained catalog prices. Jev adds 7,356 input/579 output and $0.000308952 input-only estimate; mixed campaign total $0.075510372. All advice succeeds on `jev-1.13.0` but changes no default merge/context choices, so no incremental routing benefit is demonstrated. Global ledger snapshot is 982 entries/$4.9834742442, zero holds; earlier costs remain separate and none is invoice verification.

Frozen identities and staged replay pass for all three cells. Raw artifacts are `combined-dispatch/02-revised-combined` relative to the changeset-execution-poc spec runtime root. Publication is `scripts/changeset-study/divergent/combined-dispatch/v4a-rerun-results.{md,json}` in the study repository. This single sequential, changed-interface configuration has no fresh baseline or randomized repeat, so context/instruction/cache/provider effects remain unisolated. The diagnosed interface repair and requested rerun are complete on this bounded workload; V4A is not universally reliable, handoff delivery remains unresolved, and no further trial was started.
