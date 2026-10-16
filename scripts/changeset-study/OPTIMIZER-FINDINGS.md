# Optimizer findings: runs 03–08

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

Zero selected candidate checks means no candidate check ran; it is not a pass. Base visible checks can pass on an unchanged or partial candidate. Application completion is the primary outcome.

Runs 04–06 reused the same task bytes, implementation briefs and submitted query-plan bytes. Handoff and extraction reused the latest rejected `planning-attempt-1.json`, while calibration reused `raw-plan.json`. Full hashes and source origins are in the JSON. The common frozen-file inventory SHA-256 is `74b2aa4119b93d6fb7d141680d78f964cc61ea3ab85a5d4ff3c27d0ed071ff01`.

| Case | Shared raw plan SHA-256 prefix | Dispatch comparison |
|---|---|---|
| hard-context-calibration | `f783837fac0bdbb9` | 05 = 06 |
| hard-dependency-handoff | `1a4f6376a73ce2ff` | 05 = 06 |
| hard-lifecycle-extract | `7533611014162c45` | 05 = 06 |

On matched calibration, deterministic grouping reduced assignments from six to three, dependency depth from four to two, and writer calls from six to three. Writer plus optimizer time fell from 8.317990s to 6.981902s (16.1%). Tokens fell from 13,422 to 8,288. Run 05 passed application, visible, candidate and external checks; 04 failed visible and candidate checks. This single observation cannot separate grouping effects from generation variability.

Jev made two successful routing calls in 06: 4,294 tokens and $0.000169 estimated spend. It selected no vetoes or context changes. Every dispatched plan was byte-identical to 05, so these measurements show no benefit from Jev. Contextual calibration failed visible/candidate checks despite passing external grading. Its shorter handoff checks included no selected candidate tests, which prevents a quality-preserving speed claim.

Actual model usage counts newly incurred requests. Allocated usage adds the original owner/query work for 04–06 and only original owner work for 07–08. It excludes donor writing and checks. Reused planning is an allocation, not a new charge. Cache-write tokens are zero in all rows. Jev usage is separate from the Sol/DeepSeek columns.

| Actual run | Calls | Input | Output | Cache read | Total tokens | Normalized USD |
|---|---:|---:|---:|---:|---:|---:|
| 03 donor | 75 | 334,003 | 68,488 | 2,511,872 | 2,914,363 | 0.197457732 |
| 04 unoptimized | 20 | 31,009 | 15,101 | 13,440 | 59,550 | 0.027504540 |
| 05 deterministic | 14 | 18,813 | 12,282 | 17,792 | 48,887 | 0.020489052 |
| 06 contextual | 15 | 5,926 | 16,633 | 32,128 | 54,687 | 0.021930168 |
| 07 catalog | 7 | 48,759 | 6,708 | 384 | 55,851 | 0.022679604 |
| 08 richer catalog | 6 | 44,395 | 6,451 | 1,152 | 51,998 | 0.021066612 |

| Allocated run | Calls | Input | Output | Cache read | Total tokens | Normalized USD |
|---|---:|---:|---:|---:|---:|---:|
| 03 donor | 75 | 334,003 | 68,488 | 2,511,872 | 2,914,363 | 0.197457732 |
| 04 unoptimized | 91 | 359,553 | 80,915 | 2,524,288 | 2,964,756 | 0.220109628 |
| 05 deterministic | 85 | 347,357 | 78,096 | 2,528,640 | 2,954,093 | 0.213094140 |
| 06 contextual | 86 | 334,470 | 82,447 | 2,542,976 | 2,959,893 | 0.214535256 |
| 07 catalog | 67 | 168,182 | 50,428 | 2,509,568 | 2,728,178 | 0.126025608 |
| 08 richer catalog | 66 | 163,818 | 50,171 | 2,510,336 | 2,724,325 | 0.124412616 |

Phase totals below are actual seconds. Query includes deterministic catalog generation. Phase sums exclude initialization and process overhead; elapsed totals use process wall time.

| Run | Owner | Query | Routing | Optimizer | Writing | Checks | Actual elapsed | Allocated elapsed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 03 donor | 299.548 | 312.872 | 0.000 | 0.000 | 8.303 | 30.670 | 653.476 | 653.476 |
| 04 unoptimized | 0.000 | 0.000 | 0.000 | 0.002 | 52.010 | 158.917 | 211.612 | 824.033 |
| 05 deterministic | 0.000 | 0.000 | 0.000 | 0.004 | 44.651 | 159.834 | 205.188 | 817.609 |
| 06 contextual | 0.000 | 0.000 | 0.402 | 0.004 | 40.631 | 94.997 | 136.757 | 749.178 |
| 07 catalog | 0.000 | 79.311 | 0.000 | 0.001 | 8.414 | 30.632 | 120.177 | 419.725 |
| 08 richer catalog | 0.000 | 68.957 | 0.000 | 0.001 | 7.346 | 30.637 | 108.783 | 408.332 |

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

Budget snapshot at 2026-10-16T23:49:52.175501+00:00: the current reset ledger has 140 settled entries, 0 unsettled entries, and $1.071561824 settled exposure against its $50 limit. Retained exposure is also $1.071561824. Trial model receipts total $1.071302824; Jev routing adds $0.000169000. One other settled Jev entry contributes $0.000090000. The prior ledger archive is excluded from this reset balance.

Normalized model cost for 03–08 is $0.311127708, or $0.311296708 including trial Jev routing. The comparison tariff reprices Sol at DeepSeek rates; ledger settlements and comparison estimates are separate measures. Subscription invoices and quota are unmeasured. Allocated totals must not be summed as campaign spend because they reuse donor charges.

The next follow-up is a separate `catalog-lookup` mode with one bounded source batch (64 KiB) and a 160 KiB complete-request limit. Integration is pending and the mode is unmeasured. These bounds do not apply retroactively to 07 or 08. Source bindings, fixture interfaces and correction payloads still need offline verification before another live experiment; no repeat or lookup run is included in these findings.
