# Owner/query/writer optimizer results

Actual incurred model usage excludes reused planning. plans_from adds original owner/query work; brief_source adds only the inherited owner, retaining newly incurred query/context generation work exactly once. Jev estimated spend is separate from normalized Sol/DeepSeek cost. Allocated seconds exclude donor writing, checks, initialization and routing. Query seconds include deterministic query-context generation.

| Run | Mode | Applied | Pending | Actual s | Allocated s | Writing s | Writing + optimizer + routing s |
|---|---|---:|---:|---:|---:|---:|---:|
| 03-owner-query-writer | none/discovery | 0/3 | 0 | 653.48 | 653.48 | 8.30 | 8.30 |
| 04-corrected-unoptimized | none/discovery | 1/3 | 0 | 211.61 | 824.03 | 52.01 | 52.01 |
| 05-deterministic | deterministic/discovery | 1/3 | 0 | 205.19 | 817.61 | 44.65 | 44.66 |
| 06-contextual | contextual/discovery | 1/3 | 0 | 136.76 | 749.18 | 40.63 | 41.04 |
| 07-catalog-deterministic | deterministic/catalog | 1/3 | 0 | 120.18 | 419.73 | 8.41 | 8.41 |

| Run | Calls actual / allocated | Tokens actual / allocated | Equivalent USD actual / allocated | Jev calls | Jev tokens | Jev est. USD |
|---|---:|---:|---:|---:|---:|---:|
| 03-owner-query-writer | 75 / 75 | 2914363 / 2914363 | 0.197458 / 0.197458 | 0 | 0 | 0.000000 |
| 04-corrected-unoptimized | 20 / 91 | 59550 / 2964756 | 0.027505 / 0.220110 | 0 | 0 | 0.000000 |
| 05-deterministic | 14 / 85 | 48887 / 2954093 | 0.020489 / 0.213094 | 0 | 0 | 0.000000 |
| 06-contextual | 15 / 86 | 54687 / 2959893 | 0.021930 / 0.214535 | 2 | 4294 | 0.000169 |
| 07-catalog-deterministic | 7 / 67 | 55851 / 2728178 | 0.022680 / 0.126026 | 0 | 0 | 0.000000 |

| Cell | Valid | Applied | Visible base | Candidate failures | External | Owner s* | Query s* | Routing s | Optimization s | Writing s | Checks s |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| 03-owner-query-writer/000-hard-context-calibration | true | false | false | 1/1 | true | 54.72 | 26.67 | 0.00 | 0.00 | 8.30 | 0.25 |
| 03-owner-query-writer/001-hard-dependency-handoff | false | false | true | 0/0 | false | 63.66 | 192.28 | 0.00 | 0.00 | 0.00 | 1.84 |
| 03-owner-query-writer/002-hard-lifecycle-extract | false | false | true | 0/0 | false | 181.16 | 93.92 | 0.00 | 0.00 | 0.00 | 28.58 |
| 04-corrected-unoptimized/000-hard-context-calibration | true | true | false | 1/1 | true | 54.72 | 26.67 | 0.00 | 0.00 | 8.32 | 0.26 |
| 04-corrected-unoptimized/001-hard-dependency-handoff | true | false | true | 1/1 | false | 63.66 | 192.28 | 0.00 | 0.00 | 29.90 | 130.29 |
| 04-corrected-unoptimized/002-hard-lifecycle-extract | true | false | true | 0/0 | false | 181.16 | 93.92 | 0.00 | 0.00 | 13.80 | 28.37 |
| 05-deterministic/000-hard-context-calibration | true | true | true | 0/1 | true | 54.72 | 26.67 | 0.00 | 0.00 | 6.98 | 0.27 |
| 05-deterministic/001-hard-dependency-handoff | true | false | true | 1/1 | false | 63.66 | 192.28 | 0.00 | 0.00 | 25.14 | 130.96 |
| 05-deterministic/002-hard-lifecycle-extract | true | false | true | 0/0 | false | 181.16 | 93.92 | 0.00 | 0.00 | 12.53 | 28.60 |
| 06-contextual/000-hard-context-calibration | true | true | false | 1/1 | true | 54.72 | 26.67 | 0.18 | 0.00 | 6.14 | 0.26 |
| 06-contextual/001-hard-dependency-handoff | true | false | true | 0/0 | false | 63.66 | 192.28 | 0.18 | 0.00 | 23.21 | 66.31 |
| 06-contextual/002-hard-lifecycle-extract | true | false | true | 0/0 | false | 181.16 | 93.92 | 0.04 | 0.00 | 11.29 | 28.42 |
| 07-catalog-deterministic/000-hard-context-calibration | true | true | false | 1/1 | true | 54.72 | 56.10 | 0.00 | 0.00 | 8.41 | 0.26 |
| 07-catalog-deterministic/001-hard-dependency-handoff | false | false | true | 0/0 | false | 63.66 | 3.55 | 0.00 | 0.00 | 0.00 | 1.85 |
| 07-catalog-deterministic/002-hard-lifecycle-extract | false | false | true | 0/0 | false | 181.16 | 19.66 | 0.00 | 0.00 | 0.00 | 28.53 |

*Owner and query seconds include allocated original planning for replays. JSON retains actual phase time and all stage calls/tokens separately. Application completion means execute returned ok, independently of downstream checks.

Observed writer, optimizer and routing elapsed performance among application-complete, integrity-valid configurations with identical cases, raw plans and briefs; downstream outcomes remain separate. No global optimality claim.

pending matched application-complete configurations.

| Historical control (unmatched) | Seconds | Calls | Tokens | Equivalent USD |
|---|---:|---:|---:|---:|
| Native Sol (historical; unmatched) | 474.96 | 28 | 514714 | 0.166109 |
| 06-boundary-review (historical; unmatched) | 319.74 | 16 | 328670 | 0.107606 |
| 07-boundary-review-repeat (historical; unmatched) | 339.55 | 17 | 340136 | 0.106833 |

Historical controls use exposed development cases and different workflows; they are retained context, not matched optimizer ablations.
