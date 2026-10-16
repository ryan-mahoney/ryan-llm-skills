# Sol-only development iterations

Three exposed historical tasks, unchanged initial source and acceptance checks. The previous native Sol runs are reference measurements, not concurrent controls. All attempts are retained. Full delivery requires external checks, visible checks, review and successful execution.

| Strategy / run | Recorded delivery | Including required posthoc audit | Total seconds | Equivalent USD | Calls | Tokens | Beats reference |
|---|---:|---:|---:|---:|---:|---:|---|
| Previous native Sol | 3/3 | reference | 474.96 | 0.16611 | 28 | 514714 | reference |
| 01-patch-editors | 1/3 | 1/3 | 520.14 | 0.20269 | 24 | 606086 | no |
| 02-direct-edits | 2/3 | 2/3 | 545.49 | 0.11048 | 15 | 278886 | no |
| 03-source-ranges | 2/3 | 2/3 | 321.94 | 0.08259 | 15 | 240006 | no |
| 04-checked-ranges | 3/3 | 2/3 | 326.55 | 0.06967 | 13 | 202034 | no |
| 05-checked-ranges-repeat | 2/3 | 2/3 | 301.48 | 0.07845 | 14 | 235807 | no |
| 06-boundary-review | 3/3 | 3/3 | 319.74 | 0.10761 | 16 | 328670 | yes |
| 07-boundary-review-repeat | 3/3 | 3/3 | 339.55 | 0.10683 | 17 | 340136 | yes |

A win requires all three deliveries, lower total time and equivalent cost, and a geometric mean paired speed ratio above one. It must repeat with unchanged code. Failed tasks receive 1,500 seconds in that ratio. Actual elapsed totals include failed attempts and do not imply successful throughput. Sol is priced at DeepSeek rates; equivalent costs are not invoices.

Known posthoc defects disqualify a win. Required posthoc checks must pass; an unrun audit is not a pass. Original recorded delivery and terminal outcomes remain unchanged.

Repeated development win with identical frozen files: 06-boundary-review and 07-boundary-review-repeat.

## 01-patch-editors

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 36.99 | 3 | 0.00740 |
| hard-dependency-handoff | fail | no | unrun | 243.39 | 8 | 0.08716 |
| hard-lifecycle-extract | fail | no | not required | 239.76 | 13 | 0.10812 |

Failure-adjusted geometric speed ratio: 0.24; above 1 favors changesets.

## 02-direct-edits

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 18.47 | 2 | 0.00400 |
| hard-dependency-handoff | fail | no | unrun | 188.91 | 8 | 0.05192 |
| hard-lifecycle-extract | pass | yes | not required | 338.11 | 5 | 0.05457 |

Failure-adjusted geometric speed ratio: 0.50; above 1 favors changesets.

## 03-source-ranges

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 20.77 | 2 | 0.00440 |
| hard-dependency-handoff | fail | no | unrun | 208.68 | 8 | 0.05627 |
| hard-lifecycle-extract | pass | yes | not required | 92.49 | 5 | 0.02192 |

Failure-adjusted geometric speed ratio: 0.74; above 1 favors changesets.

## 04-checked-ranges

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 18.42 | 2 | 0.00445 |
| hard-dependency-handoff | pass | yes | fail | 215.87 | 6 | 0.04269 |
| hard-lifecycle-extract | pass | yes | not required | 92.25 | 5 | 0.02254 |

Failure-adjusted geometric speed ratio: 0.77; above 1 favors changesets.

## 05-checked-ranges-repeat

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 20.79 | 2 | 0.00452 |
| hard-dependency-handoff | pass | no | fail | 197.91 | 8 | 0.05803 |
| hard-lifecycle-extract | pass | yes | not required | 82.77 | 4 | 0.01590 |

Failure-adjusted geometric speed ratio: 0.77; above 1 favors changesets.

## 06-boundary-review

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 23.83 | 2 | 0.00540 |
| hard-dependency-handoff | pass | yes | pass | 202.79 | 9 | 0.07393 |
| hard-lifecycle-extract | pass | yes | not required | 93.11 | 5 | 0.02828 |

Failure-adjusted geometric speed ratio: 1.37; above 1 favors changesets.

## 07-boundary-review-repeat

| Task | Behavior checks | Recorded delivery | Required audit | Seconds | Calls | Equivalent USD |
|---|---|---|---|---:|---:|---:|
| hard-context-calibration | pass | yes | not required | 22.26 | 2 | 0.00263 |
| hard-dependency-handoff | pass | yes | pass | 221.84 | 10 | 0.07645 |
| hard-lifecycle-extract | pass | yes | not required | 95.44 | 5 | 0.02776 |

Failure-adjusted geometric speed ratio: 1.35; above 1 favors changesets.

See [ITERATION-PROTOCOL.md](ITERATION-PROTOCOL.md) for selection, stopping rules, accounting and interpretation limits.
