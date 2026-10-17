# Optimizer findings: runs 03–12

Deterministic grouping produced the best fully passing DeepSeek calibration observation. No three-role configuration completed all three cases, and none established a quality-preserving win over the retained Sol controls. These exposed development cases and historical controls do not establish reliability or a global optimum.

The [measurement tables](optimized-results.md), [JSON evidence](optimized-results.json) and [interactive report](optimized-results.html) retain actual and allocated accounting, phase times, provider checks and artifact hashes. [Sol-only measurements](sol-only-results.json) provide historical, unmatched controls.

Run 03 used a DeepSeek implementation owner, a Sol query planner and DeepSeek writers. Calibration stopped after an invalid create edit; its retry classifier mistakenly matched `budget` in a source path. Handoff exceeded a redundant instruction sublimit. Extraction selected 44,600 source characters against the 32,000 delivered-character limit. Those rejected plans and all charges remain retained.

Runs 04–06 share one corrected backend freeze: exact retry classification, a 4,000-character total assignment bound, and deterministic compaction of oversized module context into exact source slices. Compaction preserves the delivered-source limit. This backend change applies to all three arms, including unoptimized 04.

| Run | Applied | Base visible passes | Candidate check passes | External passes | Full delivery |
|---|---:|---:|---:|---:|---:|
| 03 donor | 0/3 | 2/3 | 0/1 selected cells | 1/3 | 0/3 |
| 04 unoptimized | 1/3 | 2/3 | 0/2 selected cells | 1/3 | 0/3 |
| 05 deterministic | 1/3 | 3/3 | 1/2 selected cells | 1/3 | 1/3 |
| 06 contextual | 1/3 | 2/3 | 0/1 selected cells | 1/3 | 0/3 |
| 07 catalog | 1/3 | 2/3 | 0/1 selected cells | 1/3 | 0/3 |
| 08 richer catalog | 1/3 | 2/3 | 0/1 selected cells | 1/3 | 0/3 |
| 09 catalog lookup | 2/3 | 1/3 | 0/1 selected cells | 0/3 | 0/3 |
| 10 bounded recovery | 2/3 | 2/3 | 1/1 selected cells | 1/3 | 1/3 |
| 11 fresh owners | 1/3 | 3/3 | 1/1 selected cells | 1/3 | 1/3 |
| 12 root-aware catalog | 2/3 | 2/3 | 1/2 selected cells | 1/3 | 1/3 |

Zero selected candidate checks means no candidate check ran; it is not a pass. Base visible checks can pass on an unchanged or partial candidate. Application completion is the primary outcome.

Runs 04–06 reused the same task bytes, implementation briefs and submitted query-plan bytes. Handoff and extraction reused the latest rejected `planning-attempt-1.json`, while calibration reused `raw-plan.json`. Full hashes and source origins are in the JSON. The common frozen-file inventory SHA-256 is `74b2aa4119b93d6fb7d141680d78f964cc61ea3ab85a5d4ff3c27d0ed071ff01`.

| Case | Shared raw plan SHA-256 prefix | Dispatch comparison |
|---|---|---|
| hard-context-calibration | `f783837fac0bdbb9` | 05 = 06 |
| hard-dependency-handoff | `1a4f6376a73ce2ff` | 05 = 06 |
| hard-lifecycle-extract | `7533611014162c45` | 05 = 06 |

On matched calibration, deterministic grouping reduced assignments from six to three, dependency depth from four to two, and writer calls from six to three. Writer plus optimizer time fell from 8.317990s to 6.981902s (16.1%). Tokens fell from 13,422 to 8,288. Run 05 passed application, visible, candidate and external checks; 04 failed visible and candidate checks. This single observation cannot separate grouping effects from generation variability.

Jev made two successful routing calls in 06: 4,294 tokens and $0.000169 estimated spend. It selected no vetoes or context changes. Every dispatched plan was byte-identical to 05, so these measurements show no benefit from Jev. Contextual calibration failed visible/candidate checks despite passing external grading. Its shorter handoff checks included no selected candidate tests, which prevents a quality-preserving speed claim.

Actual model usage counts newly incurred requests. Allocated usage adds the original owner/query work for 04–06 and only original owner work for 07–10 and 12; 11 incurs fresh owners. It excludes donor writing and checks. Reused planning is an allocation, not a new charge. Cache-write tokens are zero in all rows. Jev usage is separate from the Sol/DeepSeek columns.

| Actual run | Calls | Input | Output | Cache read | Total tokens | Normalized USD |
|---|---:|---:|---:|---:|---:|---:|
| 03 donor | 75 | 334,003 | 68,488 | 2,511,872 | 2,914,363 | 0.197457732 |
| 04 unoptimized | 20 | 31,009 | 15,101 | 13,440 | 59,550 | 0.027504540 |
| 05 deterministic | 14 | 18,813 | 12,282 | 17,792 | 48,887 | 0.020489052 |
| 06 contextual | 15 | 5,926 | 16,633 | 32,128 | 54,687 | 0.021930168 |
| 07 catalog | 7 | 48,759 | 6,708 | 384 | 55,851 | 0.022679604 |
| 08 richer catalog | 6 | 44,395 | 6,451 | 1,152 | 51,998 | 0.021066612 |
| 09 catalog lookup | 25 | 182,657 | 41,740 | 20,864 | 245,261 | 0.105010284 |
| 10 bounded recovery | 13 | 98,095 | 9,352 | 7,296 | 114,743 | 0.040694676 |
| 11 fresh owners | 70 | 162,892 | 78,365 | 3,085,824 | 3,327,081 | 0.161420544 |
| 12 root-aware catalog | 22 | 130,130 | 31,023 | 21,504 | 182,657 | 0.076395624 |

| Allocated run | Calls | Input | Output | Cache read | Total tokens | Normalized USD |
|---|---:|---:|---:|---:|---:|---:|
| 03 donor | 75 | 334,003 | 68,488 | 2,511,872 | 2,914,363 | 0.197457732 |
| 04 unoptimized | 91 | 359,553 | 80,915 | 2,524,288 | 2,964,756 | 0.220109628 |
| 05 deterministic | 85 | 347,357 | 78,096 | 2,528,640 | 2,954,093 | 0.213094140 |
| 06 contextual | 86 | 334,470 | 82,447 | 2,542,976 | 2,959,893 | 0.214535256 |
| 07 catalog | 67 | 168,182 | 50,428 | 2,509,568 | 2,728,178 | 0.126025608 |
| 08 richer catalog | 66 | 163,818 | 50,171 | 2,510,336 | 2,724,325 | 0.124412616 |
| 09 catalog lookup | 85 | 302,080 | 85,460 | 2,530,048 | 2,917,588 | 0.208356288 |
| 10 bounded recovery | 73 | 217,518 | 53,072 | 2,516,480 | 2,787,070 | 0.144040680 |
| 11 fresh owners | 70 | 162,892 | 78,365 | 3,085,824 | 3,327,081 | 0.161420544 |
| 12 root-aware catalog | 88 | 270,016 | 106,882 | 3,106,688 | 3,483,586 | 0.227903328 |

Phase totals below are actual seconds. Query includes deterministic catalog generation. Phase sums exclude initialization and process overhead; elapsed totals use process wall time.

| Run | Owner | Query | Routing | Optimizer | Writing | Checks | Actual elapsed | Allocated elapsed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 03 donor | 299.548 | 312.872 | 0.000 | 0.000 | 8.303 | 30.670 | 653.476 | 653.476 |
| 04 unoptimized | 0.000 | 0.000 | 0.000 | 0.002 | 52.010 | 158.917 | 211.612 | 824.033 |
| 05 deterministic | 0.000 | 0.000 | 0.000 | 0.004 | 44.651 | 159.834 | 205.188 | 817.609 |
| 06 contextual | 0.000 | 0.000 | 0.402 | 0.004 | 40.631 | 94.997 | 136.757 | 749.178 |
| 07 catalog | 0.000 | 79.311 | 0.000 | 0.001 | 8.414 | 30.632 | 120.177 | 419.725 |
| 08 richer catalog | 0.000 | 68.957 | 0.000 | 0.001 | 7.346 | 30.637 | 108.783 | 408.332 |
| 09 catalog lookup | 0.000 | 216.231 | 0.000 | 0.005 | 85.021 | 300.843 | 605.715 | 905.264 |
| 10 bounded recovery | 0.000 | 75.381 | 0.000 | 0.003 | 19.142 | 53.936 | 150.336 | 449.884 |
| 11 fresh owners | 411.387 | 21.653 | 0.000 | 0.001 | 3.425 | 30.886 | 468.258 | 468.258 |
| 12 root-aware catalog | 0.000 | 99.741 | 0.000 | 0.006 | 50.885 | 95.044 | 246.396 | 657.783 |

04–06 each allocate 612.420656s of original owner/query planning. Run 07 allocates 299.548442s of original owner work and incurs 79.310576s of fresh query/context work, including 0.128773s of catalog generation. Its allocated planning is 378.859018s; allocated elapsed is 419.725242s. No later Sol review or repair occurred after writers started.

Catalog mode 07 replaced discovery queries with bounded catalog queries and retained the original owner briefs. It incurred four Sol query calls and three DeepSeek writer calls. Compared with 03, query time fell from 312.872214s to 79.310576s, but both larger cases stopped before writing. This reduction did not preserve completion quality. Calibration needed one catalog-binding correction, then failed visible and candidate checks.

Handoff returned the following pre-dispatch blocker:

> needs discovery: a bounded source excerpt containing the completeOutcomes declaration in pi/extensions/spec-runtime/completion.mjs (the only encompassing catalog range is 34,830 characters, exceeding the 32,000-character packet limit), and source bindings/context for makePackageFixture in pi/extensions/spec-runtime/package-fixture.mjs and validateStepIndex in scripts/spec-observe/steps.mjs, including the fixture's target-id shape and validated index interface.

Extraction returned:

> needs discovery: exact source anchors delimiting the moved leading comments and the end of ROOT_BOOTSTRAP in runtime.mjs, before the nativeCommand comment that must stay. The catalog supplies declaration anchors but no comment boundaries; these are needed to perform the required verbatim moves without moving or leaving behind the wrong comments.

These are planner-reported blockers, not claims that source compaction cannot handle those ranges. The rejected cells retain valid brief provenance and complete accounting, but lack valid raw/dispatched plans.

Run 08 measured richer variable, comment, nested helper and import bindings under a new freeze, while retaining the owner briefs and writer backend. Calibration required one Sol query instead of two: query/context took 26.815192s and writing 7.346148s. It applied all three optimized assignments and passed external acceptance, but still failed visible and candidate checks. Both larger cases stopped before writing; the lower elapsed total does not establish a completion-quality improvement.

08 handoff returned:

> needs discovery: runtime.test.mjs lacks a catalog range for the EOF append location and selectable source context for the existing launchProcess prompt-capture wrappers and prepare helper needed by the five regression cases. Supply exact start_anchor/end_anchor bindings for those ranges.

08 extraction produced a seven-operation first plan that passed strategy validation and source preflight with compaction. The catalog harness nevertheless rejected six context bindings: two in `create-lifecycle` and four in `rewire-runtime`. Each start and end was a genuine catalog endpoint, recombined across listed pairs. Strict pair membership rejected these combinations; the source anchors were unique, ordered and within the delivered-source limit after compaction. The plan and candidate were not manually changed.

The initial complete extraction request was 70,674 bytes. Its correction, including the previous 10,599-byte plan and validation errors, was 82,206 bytes against an 81,920-byte cap: 286 bytes over. The runtime refused that correction before transport. Final failure was `needs discovery: catalog query exceeds 80 KiB`, with one paid extraction query and zero writer calls. This separates a harness binding restriction from a source-preflight defect and from the correction-payload bound.

08 incurred 108.783377s, six calls and 51,998 tokens at $0.021066612 normalized cost ($0.123617412 in receipt charges). Owner-only allocation gives 408.331819s, 66 calls, 2,724,325 tokens and $0.124412616 normalized. No owner was rerun and no Sol call followed writing.

The retained historical Sol controls completed all three cases: native Sol took 474.961857s at $0.166108800 normalized, and the boundary-review runs took 319.735002s/$0.107606136 and 339.549391s/$0.106832772. Successful completion across the cases remains missing from every measured three-role configuration, so no win over these controls is established.

Runs 09 and 10 measured the separate catalog-lookup mode: at most one source batch, 64,000 UTF-16 code units/source characters, three total query calls, and a 160 KiB complete-request limit. Both reused original 03 owner briefs. Source requests, lookup artifacts, whole-source hashes, exact snippet text/offsets, unique anchors and followup packet identity passed independent provenance checks. No Sol call followed writer dispatch. Run 09 froze `a6a0be5`; run 10 froze `abb8623`, adding bounded query-format recovery and interchangeable supplied endpoints. These are sequential development treatments, not matched controls.

| Run/case | Applied operations | Base visible | Candidate checks | External | First failure |
|---|---:|---|---|---|---|
| 09 calibration | 0; no dispatch | pass unchanged | none | fail | Malformed query JSON at position 328, line 2 column 2 |
| 09 handoff | 11/11 | fail | fail | fail | ENOENT reading fixture spec-steps.json in buildDependencyHandoff |
| 09 extraction | 5/5 | fail | none | fail | wave-lifecycle.mjs missing createWaveLifecycle export |
| 10 calibration | 3/3 | pass | 4 tests pass | pass | none |
| 10 handoff | 0; blocked | pass unchanged | none | fail | Inconsistent owner profile-path recipe |
| 10 extraction | 4/4 | 65/74 pass | none | fail | Runtime.start reads workerPid from undefined |

09 handoff demonstrates completed application of all eleven grouped operations, not delivery quality. Its first visible failure was `editor packet context attaches exact ranges and per-packet reasoning overrides only the editor thinking`: ENOENT opening the fixture's `spec-steps.json` in `buildDependencyHandoff`, then `dependencyContext` and `Runtime.start`. External grading consumed the retained 300-second limit and timed out; all failed check time and charges remain included. Extraction applied all five operations but failed module startup because `wave-lifecycle.mjs` did not export `createWaveLifecycle`. Calibration's initial malformed JSON was not recovered under that freeze.

10 calibration applied all three operations and passed base, four generated candidate tests and external acceptance. Handoff queried one eight-request source batch (30,461 characters), then explicitly blocked before writing: the inherited owner recipe used `new URL('../../../agents/spec-step-owner.md', import.meta.url)` while requiring the existing `pi/agents/spec-step-owner.md` profile. From `pi/extensions/spec-runtime/runtime.test.mjs`, that URL resolves to `agents/spec-step-owner.md`; `../../agents/...` resolves to the actual `pi/agents/...` location. This confirms an inconsistent owner instruction, not an absent supplied profile. The original brief was retained unchanged.

10 extraction applied four operations using five writer calls, including bounded application recovery. Nine of 74 visible tests failed. The first was `wave runtime: a validated member binds its run and bypasses only the serial latest-run exclusion`, with `Cannot read properties of undefined (reading 'workerPid')` at `Runtime.start`, `runtime.mjs:935:47`. External acceptance also failed without timeout. No behavioral feedback was supplied to models and no candidate was manually repaired.

| Run/case | Query incl. context s | Writing s | Checks s | Actual s | Calls | Input | Output | Cache read | Normalized USD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 09 context-calibration | 4.734 | 0.000 | 0.174 | 7.986 | 1 | 5,517 | 146 | 0 | 0.001830300 |
| 09 dependency-handoff | 148.610 | 77.260 | 300.541 | 526.668 | 17 | 122,368 | 35,923 | 19,456 | 0.079934736 |
| 09 lifecycle-extract | 62.887 | 7.761 | 0.128 | 71.061 | 7 | 54,772 | 5,671 | 1,408 | 0.023245248 |
| 10 context-calibration | 31.410 | 6.638 | 0.258 | 38.512 | 5 | 21,056 | 4,338 | 1,152 | 0.011529312 |
| 10 dependency-handoff | 12.408 | 0.000 | 1.843 | 15.652 | 2 | 43,728 | 494 | 0 | 0.013711200 |
| 10 lifecycle-extract | 31.562 | 12.504 | 51.836 | 96.171 | 6 | 33,311 | 4,520 | 6,144 | 0.015454164 |

09 incurred $0.441198984 in model receipt charges; 10 incurred $0.209625076. Each allocates only the original 299.548442 seconds of owner work plus its fresh query/context work. Allocated elapsed is 905.263683 seconds for 09 and 449.884077 seconds for 10. Lookup requests/characters were 8/27,623 for 09 handoff, 2/12,088 for 10 calibration and 8/30,461 for 10 handoff. Other cells made no lookup request. All complete query packets stayed below 160 KiB and all cells stayed within three query calls. Jev made no calls in either run.

Run 11 regenerated all three DeepSeek owner briefs from only the original tasks/source, under owner-prompt revision `d08577e`, frozen at `25d0463`. Calibration applied both optimized assignments and passed base, candidate and external checks. Both larger cases failed catalog construction before a Sol query or writer ran. Handoff reported `ambiguous basename steps.mjs`: the source contains only `scripts/spec-observe/steps.mjs`, but catalog path extraction treated its `/work/scripts/...` alias as a second absent relative path. Extraction's catalog was 51,727 bytes against the 49,152-byte cap, 2,575 bytes over. These are harness failures; the fresh briefs and all owner calls remain retained.

Run 12 froze `5bfe134` and reused all three run 11 briefs byte for byte. It normalized existing `/work` source-root aliases, raised only lookup-mode catalog capacity to 64 KiB, and checked the exact serialized Client context shape (system prompt and user message, excluding provider framing and options) against the unchanged 160 KiB request cap. The source-lookup batch remains capped at 64,000 UTF-16 code units/source characters. These distinct bounds must not be conflated.

12 calibration applied 2/2 operations and passed every check. Handoff applied all 11 optimized operations using 14 writer calls; its 15 raw assignments grouped to 11, dependency depth six to five and context selections 26 to 20. Visible, generated-candidate and external checks failed. The first visible failure was `CURRENT handoff carries bounded latest prerequisite facts and preserves explicit instructions`: `current.coverage_gaps.some(gap => gap.includes('corrupt.json'))` was false at `runtime.test.mjs:972`. External grading took 64.080 seconds and failed without timeout. Completed writing does not establish delivery.

12 extraction failed its first operation after two bounded writer attempts. Syntax checking the composed `wave-lifecycle.mjs` reported `Unexpected identifier 'TRANSPORT_ENV_NAMES'` at line 149. `rewire-runtime` was blocked by that failure; neither operation applied. Existing-source visible checks passed on the unchanged candidate; external acceptance failed because `wave-lifecycle.mjs` was absent. This is a mechanical application failure, distinct from downstream behavioral failures. No candidate was manually changed and no behavioral feedback entered subsequent models.

| Run/case | Applied | Base visible | Candidate checks | External | Query incl. context s | Writing s | Checks s |
|---|---|---|---|---|---:|---:|---:|
| 11 context-calibration | 2/2 | pass | pass | pass | 21.516 | 3.425 | 0.244 |
| 11 dependency-handoff | 0; blocked | pass | none | fail | 0.002 | 0.000 | 1.858 |
| 11 lifecycle-extract | 0; blocked | pass | none | fail | 0.135 | 0.000 | 28.784 |
| 12 context-calibration | 2/2 | pass | pass | pass | 13.503 | 3.273 | 0.259 |
| 12 dependency-handoff | 11/11 | fail | fail | fail | 63.083 | 40.989 | 66.046 |
| 12 lifecycle-extract | 0/2 | pass | none | fail | 23.155 | 6.623 | 28.739 |

11 incurred 70 calls: 66 DeepSeek owner calls, two Sol queries and two DeepSeek writer calls. Actual and allocated usage are identical because no planning was borrowed. 12 incurred 22 calls: four Sol queries and 18 DeepSeek writer calls, with zero new owner calls. Its actual input/output/cache-read totals are 130,130/31,023/21,504 tokens; owner allocation gives 270,016/106,882/3,106,688, totaling 3,483,586 tokens and 88 allocated calls. Cache-write tokens and Jev calls are zero. Allocated elapsed adds only 411.386950 seconds of run 11 owner work to 246.396421 actual seconds, giving 657.783371 seconds; no donor writing/checks are borrowed.

All 22 run 12 request/receipt identities, provider roles, retained raw/dispatched plan hashes and owner-brief provenance passed. Query calls were 1/2/1; exact Client context bytes were 25,460; 104,647 and 127,368; and 84,602. Handoff's one lookup batch delivered five requests/18,264 source characters, with verified whole-source hashes, exact snippet offsets/text and unique anchors. Calibration and extraction used direct plans with no lookup. No Sol call followed any writer.

| Run 12 case | Raw-plan SHA-256 | Dispatched artifact SHA-256 |
|---|---|---|
| hard-context-calibration | `3967db25f7c90bfdb0ebf7118cf40f1df07a6af65a1af062b9100390adf96e34` | `5255170149318024bedaba6617bc32d01a871ed5c0a9296d944c41a482d001f7` |
| hard-dependency-handoff | `ba9ca32f452b763781d63207510982fc19d9e30996c6e6f3634746bfc1dd881c` | `751b886783a794fc7797172dc78a17f55fd1fe829ad31c6476100d9dcfacdbd8` |
| hard-lifecycle-extract | `9fc4c77f53498bf5c285826ecb10a4de52ba39441a7789472b6023003b6e4096` | `9fc4c77f53498bf5c285826ecb10a4de52ba39441a7789472b6023003b6e4096` |

11 model receipt charges were $0.200204044; 12 charges were $0.281194124. Budget snapshot at 2026-10-17T00:33:43.287645+00:00: 270 settled entries, zero holds, $2.203784052 settled exposure against $50. Trial model receipts total $2.203525052; trial Jev adds $0.000169000 and another settled Jev entry $0.000090000. The archived prior ledger is excluded. Normalized model cost for 03–12 is $0.694648836, or $0.694817836 including trial Jev. Normalized tariffs and settled exposure remain distinct; allocated donor charges must not be summed as new campaign spend.

The next work is offline diagnosis of the extraction compose/syntax failure, preserving source, briefs, plans, candidates and observed failures. No repeat has been run. A later same-freeze/same-plan repeat could measure mechanical application variability, but cannot establish delivery reliability by itself. The study remains incomplete: no configuration completed application across all three cases, no configuration delivered all three, and no quality-preserving win over the historical Sol controls is established.
