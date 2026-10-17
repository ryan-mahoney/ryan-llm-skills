# Optimizer findings: runs 03–19

Smaller-region plans completed application across all three cases in run 18 and its exact frozen repeat, run 19. Full delivery fell from two cases to one, and writing plus optimization/routing rose from 73.550699 to 124.219280 seconds. These observations establish repeated application completion on the exposed cases, not reliable behavior or a quality-preserving win over Sol. Earlier deterministic grouping improved matched calibration; no global optimum is established.

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
| 13 syntax context | 1/3 | 2/3 | 1/2 selected cells | 1/3 | 1/3 |
| 14 unoptimized | 1/3 | 3/3 | 1/2 selected cells | 1/3 | 1/3 |
| 15 low writers | 2/3 | 3/3 | 1/2 selected cells | 1/3 | 1/3 |
| 16 grouped recovery | 2/3 | 1/3 | 1/2 selected cells | 1/3 | 1/3 |
| 17 ungrouped recovery | 1/3 | 2/3 | 1/2 selected cells | 1/3 | 1/3 |
| 18 smaller regions | 3/3 | 2/3 | 1/2 selected cells | 2/3 | 2/3 |
| 19 exact repeat | 3/3 | 1/3 | 1/2 selected cells | 1/3 | 1/3 |

Zero selected candidate checks means no candidate check ran; it is not a pass. Base visible checks can pass on an unchanged or partial candidate. Application completion is the primary outcome.

Runs 04–06 reused the same task bytes, implementation briefs and submitted query-plan bytes. Handoff and extraction reused the latest rejected `planning-attempt-1.json`, while calibration reused `raw-plan.json`. Full hashes and source origins are in the JSON. The common frozen-file inventory SHA-256 is `74b2aa4119b93d6fb7d141680d78f964cc61ea3ab85a5d4ff3c27d0ed071ff01`.

| Case | Shared raw plan SHA-256 prefix | Dispatch comparison |
|---|---|---|
| hard-context-calibration | `f783837fac0bdbb9` | 05 = 06 |
| hard-dependency-handoff | `1a4f6376a73ce2ff` | 05 = 06 |
| hard-lifecycle-extract | `7533611014162c45` | 05 = 06 |

On matched calibration, deterministic grouping reduced assignments from six to three, dependency depth from four to two, and writer calls from six to three. Writer plus optimizer time fell from 8.317990s to 6.981902s (16.1%). Tokens fell from 13,422 to 8,288. Run 05 passed application, visible, candidate and external checks; 04 failed visible and candidate checks. This single observation cannot separate grouping effects from generation variability.

Jev made two successful routing calls in 06: 4,294 tokens and $0.000169 estimated spend. It selected no vetoes or context changes. Every dispatched plan was byte-identical to 05, so these measurements show no benefit from Jev. Contextual calibration failed visible/candidate checks despite passing external grading. Its shorter handoff checks included no selected candidate tests, which prevents a quality-preserving speed claim.

Actual model usage counts newly incurred requests. Allocated usage adds the original owner/query work for 04–06 and only original owner work for 07–10 and 12; 11 incurs fresh owners; 13–17 allocate inherited 11 owners and 12 query/context work. It excludes donor writing and checks. Reused planning is an allocation, not a new charge. Cache-write tokens are zero in all rows. Jev usage is separate from the Sol/DeepSeek columns.

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
| 13 syntax context | 15 | 56,029 | 18,820 | 18,816 | 93,665 | 0.039505596 |
| 14 unoptimized | 21 | 50,916 | 18,569 | 36,608 | 106,093 | 0.037777248 |
| 15 low writers | 16 | 63,588 | 219,680 | 7,936 | 291,204 | 0.282740016 |
| 16 grouped recovery | 16 | 30,761 | 54,815 | 49,024 | 134,600 | 0.075300444 |
| 17 ungrouped recovery | 23 | 60,298 | 89,876 | 60,416 | 210,590 | 0.126303096 |
| 18 smaller regions | 33 | 201,138 | 40,862 | 5,760 | 247,760 | 0.109410360 |
| 19 exact repeat | 28 | 49,521 | 54,207 | 57,344 | 161,072 | 0.080248764 |

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
| 13 syntax context | 85 | 274,124 | 102,843 | 3,104,000 | 3,480,967 | 0.224272800 |
| 14 unoptimized | 91 | 269,011 | 102,592 | 3,121,792 | 3,493,395 | 0.222544452 |
| 15 low writers | 86 | 281,683 | 303,703 | 3,093,120 | 3,678,506 | 0.467507220 |
| 16 grouped recovery | 86 | 248,856 | 138,838 | 3,134,208 | 3,521,902 | 0.260067648 |
| 17 ungrouped recovery | 93 | 278,393 | 173,899 | 3,145,600 | 3,597,892 | 0.311070300 |
| 18 smaller regions | 99 | 341,024 | 116,721 | 3,090,944 | 3,548,689 | 0.260918064 |
| 19 exact repeat | 99 | 285,334 | 139,411 | 3,142,528 | 3,567,273 | 0.271748568 |

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
| 13 syntax context | 0.000 | 0.000 | 0.000 | 0.003 | 40.485 | 29.112 | 70.315 | 581.443 |
| 14 unoptimized | 0.000 | 0.000 | 0.000 | 0.001 | 43.286 | 95.100 | 139.101 | 650.229 |
| 15 low writers | 0.000 | 0.000 | 0.000 | 0.003 | 724.695 | 100.682 | 826.099 | 1337.227 |
| 16 grouped recovery | 0.000 | 0.000 | 0.000 | 0.003 | 143.401 | 26.479 | 170.636 | 681.764 |
| 17 ungrouped recovery | 0.000 | 0.000 | 0.000 | 0.001 | 321.036 | 29.229 | 351.035 | 862.163 |
| 18 smaller regions | 0.000 | 135.961 | 0.000 | 0.002 | 73.549 | 121.270 | 331.559 | 742.946 |
| 19 exact repeat | 0.000 | 0.000 | 0.000 | 0.002 | 124.218 | 123.156 | 248.127 | 795.475 |

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

The retained historical Sol controls completed all three cases: native Sol took 474.961857s at $0.166108800 normalized, and the boundary-review runs took 319.735002s/$0.107606136 and 339.549391s/$0.106832772. Full delivery across the cases remains missing from every measured three-role configuration, so no win over these controls is established.

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

11 model receipt charges were $0.200204044; 12 charges were $0.281194124. Their original time, failed checks and owner allocation remain retained.

Runs 13 and 14 reused the exact raw plans and owner briefs from 12. Run 13 froze `56aa535`, adding deterministic local syntax-error excerpts/compose-part mappings and literal-composition guidance to the existing single writer retry. Run 14 reused that exact frozen-file inventory, with optimization `none` instead of `deterministic`. Both incurred only DeepSeek writer calls: no owner, Sol query or Jev call. All request/receipt identities, donor task/result/plan hashes and provider routing passed audit. They are one matched backend/input comparison pair, not repeated estimates of success probability.

13 calibration applied 2/2 grouped operations and passed all checks. Handoff passed nine of 11 assignments; `wire-dependencies` failed `Replacement count mismatch: pi/extensions/spec-runtime/runtime.mjs`, blocking `completion-guard`. The failed assignment merged the separate raw `wire-dependencies` and `editor-outcomes` operations. Base, generated-candidate and external checks failed at the missing `buildDependencyHandoff` export. Extraction failed its first operation after two writer attempts: `Unexpected token 'export'` at `export async function resolveInput`, line 138 of the composed module; runtime rewire was blocked, with no changes applied. Unchanged-source visible checks passed; external acceptance failed.

14 calibration applied all three unoptimized operations and passed all checks. Handoff passed 13 of 15 operations. The separate `wire-dependencies`, `editor-outcomes` and `completion-guard` all applied, but `test-wave-authority` failed `Replacement count mismatch: pi/extensions/spec-runtime/runtime.test.mjs`; `test-profile-guidance` was blocked. Base visible checks passed, while generated-candidate and external checks failed. The first candidate failure was `wave handoff: fresh editor packets carry incomplete-packet state and length stop blocks completion`, with `Writer lease is absent, replaced, or revoked; stop this assignment.` Extraction failed after two attempts on `Identifier 'nativeCommand' has already been declared`, line 193; dependent rewire was blocked, with no changes applied. Its base visible checks passed on unchanged source and external acceptance failed.

| Run/case | Passed / failed / blocked operations | Writer calls | Writing s | Checks s | Full delivery |
|---|---:|---:|---:|---:|---|
| 13 context-calibration | 2 / 0 / 0 | 2 | 3.518 | 0.253 | pass |
| 13 dependency-handoff | 9 / 1 / 1 | 11 | 32.001 | 0.356 | fail |
| 13 lifecycle-extract | 0 / 1 / 1 | 2 | 4.967 | 28.503 | fail |
| 14 context-calibration | 3 / 0 / 0 | 3 | 3.648 | 0.264 | pass |
| 14 dependency-handoff | 13 / 1 / 1 | 16 | 33.340 | 66.138 | fail |
| 14 lifecycle-extract | 0 / 1 / 1 | 2 | 6.298 | 28.698 | fail |

Application completion and full delivery were each 1/3 in both runs. Handoff's different failure location does not establish that grouping caused the earlier failure or that ungrouped writing is reliable. On the application-complete matched calibration only, writer+optimizer time was 3.518605 seconds in 13 versus 3.648650 seconds in 14, with two versus three calls; both passed downstream checks. This is one observed pair, with model variability and no global optimum claim. Failed handoff/extraction timings cannot be treated as quality-preserving wins.

Actual model cost equals receipt charges for these native DeepSeek-only replays: $0.039505596 in 13 and $0.037777248 in 14. Run 13 used input/output/cache-read tokens 56,029/18,820/18,816, totaling 93,665 across 15 calls. Run 14 used 50,916/18,569/36,608, totaling 106,093 across 21 calls. Cache-write tokens are zero. Allocated totals add original 11 owner plus 12 query/context planning once, excluding donor writing/checks: 581.443141 seconds, 85 calls, 3,480,967 tokens and $0.224272800 normalized for 13; 650.229192 seconds, 91 calls, 3,493,395 tokens and $0.222544452 for 14. The roughly 64-second external handoff failures in 12 and 14 remain fully included; neither timed out.

Run 15 froze `7ff598e` and replayed exact 12 raw plans, briefs and deterministic dispatched plans with native DeepSeek writer reasoning `low`. The execution modules and writer prompt/engine matched 13; replay orchestration/reporting changed to retain the inherited `off` owner selector independently of the current writer. A local provider-boundary capture verified that `low` enables thinking with low reasoning effort and `off` disables it. Synthetic capture bounds are not trial limits: every actual task retained 32,000 output tokens, 300 seconds per call, 1,200 seconds per cell, 96 total calls and 300 seconds for grading.

15 calibration applied 2/2 operations and passed all checks, but writing took 27.275 seconds versus 3.518 in 13. Handoff applied 11/11 operations on exactly 11 writer calls, with no retry, length stop or transport error. Writing took 329.886 seconds. Base visible checks passed; generated-candidate and external checks failed. The first candidate failure was `wave handoff: step 13 owner prompt lists accepted step 1 despite eleven newer unrelated runs`: the generated fixture's steps 1–3 omitted `requires`/`writes`, causing `dependency-graph-invalid`. External checks failed after 64.209 seconds without timeout. This is completed application, not delivery.

Extraction created `wave-lifecycle.mjs`, then the runtime rewire's first attempt failed `Range anchor must be unique: pi/extensions/spec-runtime/runtime.mjs`. Its one application retry ended `Model stopped: length: ` after 179.899 seconds with 31,999 output tokens, all marked as reasoning tokens by receipt metadata. No fourth call ran. Module creation remains applied; rewire did not. Existing-runtime visible checks passed, no candidate test was selected, and external acceptance failed because runtime.mjs still exceeded 1,550 lines. No observed behavioral assertion was fed to any writer.

| Run 15 case | Applied operations | Writer calls | Writing s | Checks s | Output tokens | Reasoning subset | Length stops | Full delivery |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| hard-context-calibration | 2/2 | 2 | 27.275 | 0.255 | 10,400 | 9,202 | 0 | pass |
| hard-dependency-handoff | 11/11 | 11 | 329.886 | 71.747 | 140,644 | 125,478 | 0 | fail |
| hard-lifecycle-extract | 1/2 | 3 | 367.534 | 28.681 | 68,636 | 67,142 | 1 | fail |

15 application completion was 2/3 and full delivery 1/3. Actual elapsed was 826.098944 seconds, with 16 native low-reasoning writer calls, 291,204 tokens and $0.282740016 normalized/receipt cost. Input/output/cache-read tokens were 63,588/219,680/7,936; cache writes were zero. Reasoning metadata reports 201,822 tokens as a subset of output; it is never added again to tokens or cost. Allocation adds only inherited owner/query/context work: 1,337.226675 seconds, 86 calls, 3,678,506 tokens and $0.467507220 normalized. No new owner, Sol query or Jev call occurred. All request/receipt identities, roles, frozen plan/brief hashes and source provenance passed. Rebuilding 03–14 preserved all prior application/outcome/accounting/phase measurements.

Low reasoning completed handoff application in this observation, while calibration became slower and extraction still failed. These outcomes do not establish a reliable suite-wide configuration, a grouping winner, or a quality-preserving win over historical Sol controls. Through 15, no measured configuration completed application or delivery across all three cases.

Run 16 froze `1f7e427` and replayed exact 12 plans/briefs with `off` primary writers and `low` only on the existing single application retry. Its recovery audit binds each attempt to an operation, permits at most attempts zero and one, and preserves the same DeepSeek model. Calibration applied 2/2 and passed all checks. Handoff applied nine of 11 operations; low recovery fixed `test-wave-authority` but `wire-dependencies` still failed a runtime.mjs replacement count, blocking completion-guard. Base/candidate/external checks failed at the missing export. Independent source inspection found an actual newline in the rejected search where the unchanged target source contains literal `\n`; predecessors had not modified that target. This is a mechanical text mismatch, not behavioral feedback or proof that grouping caused it.

16 extraction applied both operations on their primary off-reasoning attempts, without low recovery. Writing took 6.369 seconds. Visible checks failed first at the spec-file/directory identity test reading undefined `dependency_paths`; external acceptance reported `targetSetup is not defined in wave-lifecycle.mjs`. Application completion was 2/3 and delivery 1/3. The treatment consumed 14 off calls and two low recoveries, with no owner/query/Jev call or length stop. Reasoning metadata was 32,347 tokens, a subset of output.

Run 17 reused run 16's exact frozen-file inventory and 12 raw plans/briefs, with optimization `none`. Its manifest records orchestration revision `2705cb0`; its execution files remain the `1f7e427` freeze. Calibration applied 3/3 and passed all checks. Handoff passed 12/15; separate wire-dependencies still failed replacement count after low recovery, blocking editor-outcomes and completion-guard. Base/candidate/external failed. Extraction recovered module creation but runtime rewire still failed `Range anchor must be unique: pi/extensions/spec-runtime/runtime.mjs`, leaving 1/2 operations applied; base visible passed on the retained runtime and external acceptance failed. Application and delivery were each 1/3.

17 used 18 off primaries and five low retries, with no owner/query/Jev or length stop. Its 67,502 reasoning tokens are a subset of output. Both runs passed exact donor hashes, provider/receipt and retry-bound audits. Neither supplied behavioral test failures to writers. Different observed outcomes and failure positions in one pair cannot establish a causal grouping effect or reliability; completed application remains separate from downstream delivery.

| Run/case | Passed / failed / blocked operations | Off / low calls | Writing s | Checks s | Application complete | Full delivery |
|---|---:|---:|---:|---:|---|---|
| 16 context-calibration | 2 / 0 / 0 | 2 / 0 | 3.422 | 0.255 | True | True |
| 16 dependency-handoff | 9 / 1 / 1 | 10 / 2 | 133.609 | 0.360 | False | False |
| 16 lifecycle-extract | 2 / 0 / 0 | 2 / 0 | 6.369 | 25.864 | True | False |
| 17 context-calibration | 3 / 0 / 0 | 3 / 0 | 4.069 | 0.257 | True | True |
| 17 dependency-handoff | 12 / 1 / 2 | 13 / 3 | 195.495 | 0.353 | False | False |
| 17 lifecycle-extract | 1 / 1 / 0 | 2 / 2 | 121.472 | 28.619 | False | False |

16 incurred 170.636118 seconds, 16 calls, 134,600 tokens and $0.075300444 native DeepSeek normalized/receipt cost. Input/output/cache-read tokens were 30,761/54,815/49,024. Allocation gives 681.763849 seconds, 86 calls, 3,521,902 tokens and $0.260067648 normalized. 17 incurred 351.035088 seconds, 23 calls, 210,590 tokens and $0.126303096; input/output/cache-read were 60,298/89,876/60,416. Allocation gives 862.162819 seconds, 93 calls, 3,597,892 tokens and $0.311070300. Cache writes are zero. Both allocate inherited 11 owner plus 12 query/context work once, excluding donor writing/checks. Prior 03–15 measurements remain unchanged.

Run 18 froze `80cf4f1`, reused the exact 11 owner briefs, and generated fresh Sol query plans under `smaller-regions` with optimization `none`. Query instructions split large same-file work into ordered, bounded regions rather than changing the owner behavior. Off primary writers and low application recovery were retained. The assignment cap was derived from the unchanged 96-call budget: three query calls reserved, at most two writer attempts per assignment, at most 46 assignments. Actual plans contained 3, 19 and 4 assignments. No owner or Jev call occurred, and every Sol query preceded writer dispatch.

18 completed application in all three cases. Calibration applied 3/3 operations and passed base, generated-candidate and external checks. Handoff applied 19/19 on primary off calls, without recovery, but failed visible/candidate/external checks. Its first visible error was `ERR_MODULE_NOT_FOUND` for `wave-receipts.mjs` imported by generated runtime.test.mjs. Extraction applied 4/4, including one low application recovery, and passed all 74 existing visible tests plus external acceptance; no generated candidate test was selected. Successful application across all cases is an observed milestone, not full delivery or an established success rate.

| Run 18 case | Applied | Query / off / low calls | Query incl. context s | Writing s | Checks s | Full delivery |
|---|---:|---:|---:|---:|---:|---|
| hard-context-calibration | 3/3 | 2 / 3 / 1 | 17.210 | 6.924 | 0.262 | pass |
| hard-dependency-handoff | 19/19 | 2 / 19 / 0 | 90.175 | 22.016 | 64.157 | fail |
| hard-lifecycle-extract | 4/4 | 1 / 4 / 1 | 28.575 | 44.609 | 56.851 | pass |

Actual elapsed was 331.558962 seconds: 33 calls (five Sol queries, 26 off writer primaries, two low retries), input/output/cache-read tokens 201,138/40,862/5,760, totaling 247,760. Cache writes and length stops were zero. Native receipt charges were $0.354722260; normalized comparison cost was $0.109410360. Writer reasoning metadata totals 11,562 tokens as a subset of output, counted once. Allocating only inherited owner work gives 742.945911 seconds, 99 calls, 3,548,689 tokens and $0.260918064 normalized. Fresh query/context overhead remains included; donor writing and checks do not enter allocation.

All task/brief/result hashes, provider routes, writer attempt bounds and retained plan hashes passed. Query calls were 2/2/1; complete query contexts were 27,461 and 48,156 bytes; 106,648 and 150,963; and 86,603, all below 160 KiB. Lookup batches were two requests/18,626 UTF-16 source characters and seven requests/37,914; hashes, exact snippet offsets/text, request identity and unique anchors passed. Extraction requested no lookup. Prior 03–17 outcome/accounting/phase measurements remained unchanged. No plan or candidate was manually repaired and no downstream failure was supplied to a model.

Run 19 repeated all three 18 raw plans, briefs and dispatched plan bytes under the exact 18 frozen-file inventory (`80cf4f1` execution; `88c90e1` orchestration). Application again completed 3/3, with the same 3/19/4 assignment counts. Calibration passed full delivery. Handoff needed two low recoveries and then applied 19/19, but visible/candidate/external checks failed; the first visible failure was the missing `corrupt.json` coverage gap. Extraction applied 4/4 on primary off calls, but visible/external checks failed: the spec-file/directory identity test expected an empty array and received undefined. No generated extraction candidate test was selected. Delivery was 1/3 versus 2/3 in 18.

| Exact-input comparison | Run 18 | Run 19 |
|---|---:|---:|
| Application-complete cases | 3/3 | 3/3 |
| Full delivery | 2/3 | 1/3 |
| Writing s | 73.548905 | 124.217734 |
| Writing + optimizer + routing s | 73.550699 | 124.219280 |
| Writer calls (off / low) | 28 (26 / 2) | 28 (26 / 2) |
| Actual elapsed s | 331.558962 | 248.127157 |
| Allocated elapsed s | 742.945911 | 795.475250 |

The writer comparison uses only application-complete configurations with identical cases, raw plans, briefs and execution code. Two observations do not establish a stable success rate. Recoveries moved between cases: 18 used one each in calibration/extraction, while 19 used both in handoff. Lower actual end-to-end time in 19 excludes fresh queries because it reused planning; allocated totals retain those queries and inherited owner work. Downstream quality did not repeat, so neither the writing observation nor total elapsed establishes a quality-preserving win.

| Run 19 case | Applied | Off / low calls | Writing s | Checks s | Full delivery |
|---|---:|---:|---:|---:|---|
| hard-context-calibration | 3/3 | 3 / 0 | 3.019 | 0.259 | pass |
| hard-dependency-handoff | 19/19 | 19 / 2 | 108.464 | 71.459 | fail |
| hard-lifecycle-extract | 4/4 | 4 / 0 | 12.735 | 51.438 | fail |

19 incurred 248.127157 seconds and 28 native DeepSeek calls, with input/output/cache-read tokens 49,521/54,207/57,344, totaling 161,072. Native receipt and normalized cost were $0.080248764. Writer reasoning metadata totals 23,735 as a subset of output, counted once; cache writes and length stops were zero. Allocation adds original 11 owner plus 18 query/context work exactly once: 795.475250 seconds, 99 calls, 3,567,273 tokens and $0.271748568 normalized. It excludes donor writing/checks. No new owner, query or Jev call occurred. All frozen/input/donor hashes, provider/receipt identities and operation retry bounds passed; prior 03–18 measurements remained unchanged. No observed behavioral failure was fed to a model or used to repair a candidate.

Settled budget through 19: 422 entries, zero holds, $3.200381476 exposure against $50. Trial model receipts total $3.200122476; trial Jev adds $0.000169000 and another settled Jev entry $0.000090000. The prior archived ledger is excluded. Normalized model cost for 03–19 is $1.445934360, or $1.446103360 including trial Jev. Allocated charges are reused work, not additional campaign spend.

The local application diagnostic at `22f1056` is implemented and checked offline but was absent from frozen 18/19. The following controls compare writers on that same earlier backend; they do not evaluate the diagnostic or full-workflow delivery.

## Matched Sol writer controls

The separate [writer-boundary results](writer-control-results.md), [JSON evidence](writer-control-results.json) and [compact visual](writer-control-results.html) compare DeepSeek 18/19 with Sol controls 01/02. Main DeepSeek run rows and their dated through-19 budget remain unchanged. The controls retain all three original cases, exact 18 plans/briefs/dispatched partitions, frozen `80cf4f1` execution code, source bounds, concurrency four and one local retry. Their `bb2b6dd` harness/full SDK/dependency/task/input inventories match. Source replay audits validate staged excerpts, edits, candidate/protected paths and request/receipt identities.

| Writer observation | Writing + optimizer/routing s | Calls / retries | Application | Delivery | Normalized USD | Receipt USD |
|---|---:|---:|---:|---:|---:|---:|
| DeepSeek 18 | 73.550699 | 28 / 2 | 3/3 | 2/3 | 0.069418260 | 0.069418260 |
| DeepSeek 19 | 124.219280 | 28 / 2 | 3/3 | 1/3 | 0.080248764 | 0.080248764 |
| Sol 01 | 102.315176 | 26 / 0 | 3/3 | 2/3 | 0.043043700 | 0.314406000 |
| Sol 02 | 108.180454 | 26 / 0 | 3/3 | 2/3 | 0.039677424 | 0.292922400 |

Only writer execution, optimizer and routing enter these elapsed denominators; owner/query/check/startup time is excluded. Token/call/cost rows include only writers. DeepSeek’s two-observation mean is 98.884990 seconds versus Sol’s 105.247815; ranges are 73.55–124.22 and 102.32–108.18. These sequential, non-randomized pairs do not establish a speed winner or significance. Recovery, provider latency and cache usage vary. Sol required no retry, and its mean normalized writer cost was $0.041360562 versus DeepSeek’s $0.074833512; mean SDK receipt charges were $0.303664200 versus $0.074833512. Normalized tariffs are requested comparison estimates; receipts use the SDK catalog, while subscription invoices/quota are unmeasured.

Application completed across all cases in both observations for each route. Handoff failed downstream in every observation. Extraction passed delivery for DeepSeek18 and both Sol controls, but failed for DeepSeek19. These checks remain outcomes rather than writer feedback or prerequisites for including completed application in timing.

Requested task limits and execution code match, but effective provider policy is not identical: the pinned Sol adapter omits maxTokens, whereas DeepSeek sends max_tokens. No equal provider-enforced output ceiling is established. Sol’s same-selector retry could catch nonterminal transport/model errors; none occurred. DeepSeek’s configured off-to-low retry is restricted to local format/application/syntax rejection. No new owner/query/review/Jev call occurred in either Sol control; DeepSeek18’s earlier queries are excluded from this writer-only comparison. No independent semantic review or global optimum is claimed.

The shared ledger now has 474 settled entries, zero holds and $3.807709876 exposure. The prior DeepSeek campaign snapshot remains $3.200381476 across 422 entries; the separate controls add $0.607328400 across 52 entries ($0.082721124 normalized). These charges are not attributed to DeepSeek runs, and inherited planning is not charged again.

The next main step is the prespecified bounded-local-diagnostic pair 20–21, protocol `6a29f45`, not yet started. It tests recovery variability without predicting a win. The `22f1056` diagnostic is checked offline and was absent from all four matched observations. Configuration selection remains provisional; the goal is active and divergent live experiments remain queued.
