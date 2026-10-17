# Matched combined-dispatch results

The combined route did not improve delivered correctness: both arms delivered **1/3 tasks**. Application completion fell from **3/3 baseline to 2/3 combined**. This does not justify replacing the baseline. All six observations pass corrected provenance, source replay, ownership and accounting audits.

Both arms reuse the exact run18 Sol plans, DeepSeek owner briefs and original sources. Baseline uses the current DeepSeek JSON writer with one existing local retry. Combined adds deterministic grouping, one Jev batch per plan, V4A writers and one same-model JSON fallback for a local failure. There are no new owner, Sol or model-review calls, and behavioral failures never feed writers. This measures the writing pipeline; fresh planning and whole-workflow speed are outside the comparison.

| Task | Baseline application / delivery | Combined application / delivery | Baseline writing s | Combined writing s | DS calls baseline / combined | Combined JSON fallbacks |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Calibration | pass / pass | pass / pass | 3.358 | 4.069 | 3 / 3 | 1 |
| Handoff | pass / fail | pass / fail | 36.834 | 33.569 | 20 / 17 | 5 |
| Lifecycle extraction | pass / fail | fail / fail | 7.680 | 4.606† | 4 / 2† | 1 |

† Combined extraction failed its first operation and blocked the other two. Its short time and low call count are **not completed-work savings**. On the two application-complete matched pairs only, combined writing totals 37.638s versus 40.192s (6.4% lower), with mixed cost $0.049847022 versus $0.035646228 (39.8% higher). Handoff still fails delivery in both arms; this subset establishes no suite-wide gain.

Writing time is baseline optimization wall plus execution wall, or combined preprocessing wall plus execution wall. Preprocessing already includes Jev and optimization. Summed provider latency overlaps across concurrent writers and is not wall time. Outer check duration is excluded from writing comparisons.

| Arm | DS calls (primary + retry) | Jev calls | Input | Output | Cache read | Total DS tokens | DS receipt USD | Jev input-estimated USD | Mixed USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 27 (26 + 1) | 0 | 44,901 | 19,876 | 57,088 | 121,865 | 0.037664028 | 0 | 0.037664028 |
| Combined | 22 (15 + 7) | 3 | 94,777 | 21,300 | 1,024 | 117,101 | 0.053999244 | 0.000308952 | 0.054308196 |

Cache-write tokens are zero. Jev adds 7,356 input and 579 output tokens; its estimate prices input only. All failed attempts are included. The cache-read asymmetry is substantial: these measured costs include different prompt/cache behavior and cannot be attributed solely to output format. Provider receipt prices and Jev estimates are not independently verified invoices. Campaign total is **52 calls/reservations, $0.091972224**, with zero unknown, orphaned, missing or unattributed reservations. The shared ledger snapshot is 960 entries/$4.9079638722 with zero unresolved exposure; earlier campaigns remain separate.

| Arm | Execution wall s | Preprocessing wall s | Jev stage s (contained) | Provider latency sum s | Visible/candidate checks s | Hidden grading s | Process total s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 47.871 | — | 0 | 77.144 | 99.521 | 93.167 | 240.800 |
| Combined | 41.458 | 0.786 | 0.753 | 74.770 | 36.081 | 65.153 | 143.717 |

These are retained attempted-phase totals, including the early extraction failure, not comparable completed-suite speed scores. Baseline optimization adds 0.001550s. Outer check duration also differs because candidates and selected tests differ.

Grouping reduced planned assignments **3→2, 19→12 and 4→3** (26→17), and dependency depth **2→1, 10→6 and 4→3**. All three Jev requests succeeded using `jev-1.13.0`, but returned no applied merge veto or context override. The dispatched plans therefore match deterministic defaults; this run demonstrates no incremental Jev routing benefit. Of 17 planned combined packets, 15 dispatched and two were blocked: V4A succeeded locally on 8/15, 7/15 needed JSON fallback, and 6/7 fallbacks recovered, leaving 14 completed packets. No whole-small-file context override was applied. Calibration's merge saved one assignment but its fallback consumed the saved writer call.

Handoff remains semantically incorrect in both arms. Combined hidden output reports 98/101 tests passing, with three failures from an undefined `loadCompletion` helper; its selected candidate suite reports 0/5 passing across fixture declarations, API calling convention and Pi/argv expectations. Baseline hidden output also reports 98/101 passing, but fails null-state handling and accepted-prerequisite classification; its changed-test command reports 93/103 passing. Both hidden results retain `completed:false`, exit1 and no timeout despite TAP summaries. These are cross-packet and test integration observations; the experiment does not isolate model, plan, grouping or format causality.

Baseline extraction applies, but hidden output reports 69/74 passing with cancellation/drain failures around an undefined callback. Combined extraction first creates syntactically invalid V4A content at line15, then its JSON source-composition fallback hits a nonunique range anchor. Both rejections are atomic; the candidate remains the original source, and hidden grading rejects the absent extracted module. Passing visible checks on that unchanged candidate is not implementation success. Selective deterministic source composition is a possible future investigation, not an implemented remedy.

The initial auditor stopped after calibration because it hashed equivalent source maps in different insertion orders. A corrected read-only audit reproduced the exact original workspace order and qualified both retained observations. They were not repeated. The remaining four used the original frozen worker/backend `b70a84c`; only the auditor/resume wrapper changed to `680ac3a`. The original stopped report remains intact.

This is one sequential, alternating-order observation per arm/task on three exposed development cases, with variable cache/provider latency and prior identical baseline-prompt exposure. Randomized repeats would be needed to separate cache and ordering effects. It combines grouping, context advice, format and fallback policy, so it is not an isolated-format test or a general reliability estimate. No managed `spec-end-to-end` integration, cross-test union, tuning or further trial is represented here. [Machine evidence and phase tables](results.json); [profile and limits](../../COMBINED-DISPATCH.md). Raw artifacts resolve from the spec-package runtime base at `combined-dispatch/01-matched`, with corrected six-observation results under `resume-01/`.
