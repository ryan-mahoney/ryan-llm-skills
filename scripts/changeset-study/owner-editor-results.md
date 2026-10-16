# Sol owner / DeepSeek editor results

Three exposed development cases against historical controls. All trial model calls, reviews, repairs and terminal grading count. Equivalent costs use the fixed comparison tariff, not invoices.

Speed ratios are failure-adjusted: each unqualified task receives the retained 1,500-second cap. Actual elapsed totals include failed attempts. A missing required audit is not a pass.

| Approach | Audited delivery | Seconds | Equivalent USD | Calls | Tokens |
|---|---:|---:|---:|---:|---:|
| Native Sol | 3/3 | 474.96 | 0.166109 | 28 | 514714 |
| 06-boundary-review | 3/3 | 319.74 | 0.107606 | 16 | 328670 |
| 07-boundary-review-repeat | 3/3 | 339.55 | 0.106833 | 17 | 340136 |
| 01-owner-editor | 2/3 | 884.14 | 0.416795 | 26 | 979146 |
| 02-editor-off | 1/3 | 851.13 | 0.281593 | 28 | 787968 |
| 03-concrete-contracts | 0/3 | 589.95 | unknown | 31 | unknown |

## 01-owner-editor

Owner: 17 calls / 305859 tokens. Editor: 9 calls / 673287 tokens. Recorded delivery: 2/3.

| Task | Audited delivery | Seconds | Owner calls | Editor calls | Repairs |
|---|---|---:|---:|---:|---:|
| hard-context-calibration | yes | 67.78 | 2 | 1 | 0 |
| hard-dependency-handoff | no | 607.60 | 9 | 7 | 1 |
| hard-lifecycle-extract | yes | 208.76 | 6 | 1 | 0 |

- Versus Native Sol: does not meet win criteria; geometric speed ratio 0.38.
- Versus 06-boundary-review: does not meet win criteria; geometric speed ratio 0.28.
- Versus 07-boundary-review-repeat: does not meet win criteria; geometric speed ratio 0.28.

## 02-editor-off

Owner: 20 calls / 316009 tokens. Editor: 8 calls / 471959 tokens. Recorded delivery: 1/3.

| Task | Audited delivery | Seconds | Owner calls | Editor calls | Repairs |
|---|---|---:|---:|---:|---:|
| hard-context-calibration | yes | 24.97 | 2 | 1 | 0 |
| hard-dependency-handoff | no | 561.69 | 7 | 5 | 1 |
| hard-lifecycle-extract | no | 264.47 | 11 | 2 | 1 |

- Versus Native Sol: does not meet win criteria; geometric speed ratio 0.27.
- Versus 06-boundary-review: does not meet win criteria; geometric speed ratio 0.20.
- Versus 07-boundary-review-repeat: does not meet win criteria; geometric speed ratio 0.20.

## 03-concrete-contracts

Owner: 21 calls / unknown tokens. Editor: 10 calls / 449415 tokens. Recorded delivery: 0/3.

Known reported tokens: owner 354221, editor 449415; incomplete accounting prevents an exact total or a cost-savings claim.

| Task | Audited delivery | Seconds | Owner calls | Editor calls | Repairs |
|---|---|---:|---:|---:|---:|
| hard-context-calibration | no | 56.86 | 4 | 2 | 1 |
| hard-dependency-handoff | no | 365.28 | 8 | 7 | 1 |
| hard-lifecycle-extract | no | 167.82 | 9 | 1 | 1 |

- Versus Native Sol: does not meet win criteria; geometric speed ratio 0.07.
- Versus 06-boundary-review: does not meet win criteria; geometric speed ratio 0.05.
- Versus 07-boundary-review-repeat: does not meet win criteria; geometric speed ratio 0.05.

Identical frozen repetitions delivering all cases: none.

See [OWNER-EDITOR-PROTOCOL.md](OWNER-EDITOR-PROTOCOL.md) for frozen roles, acceptance, budget and interpretation.
