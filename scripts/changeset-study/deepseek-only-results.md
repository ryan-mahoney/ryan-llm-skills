# DeepSeek-only changesets: one frozen run

Audited delivery was **0/3**. Calibration's initial two-operation plan applied, but its generated regression failed and the one repair failed an exact replacement. Both larger cases exhausted the original 96-call discovery limit before emitting a plan. These outcomes do not establish a speed win or general DeepSeek incapability.

[JSON evidence](deepseek-only-results.json) retains hashes, phases, calls, tokens and qualification. The [prospective protocol](divergent/deepseek-direct/PROTOCOL.md) describes the separate treatment: DeepSeek Flash off performs planning, boundary review and at most one batch repair. There is no Sol, reused owner brief/query plan, delegated writer, optimizer or router. Original tasks, source and limits come from run03; hidden grading is terminal and never returns to a model. This includes review/repair work and is not the earlier writer-only denominator.

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
