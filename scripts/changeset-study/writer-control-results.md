# Matched writer-boundary control

All three original cases at the writer/application boundary. Seconds include execution, optimizer and routing; exclude owner, query, checks, startup and inherited planning. Calls/tokens/cost include writers only.

Both routes completed application in all three cases twice. DeepSeek writing totals varied more; neither route delivered all cases. The comparison does not establish a speed winner or behavioral reliability.

[Compact visual](writer-control-results.html) · [JSON evidence](writer-control-results.json) · [Control protocol](divergent/writer-control/PROTOCOL.md) · [Three-role findings](OPTIMIZER-FINDINGS.md)

| Whole-suite observation | Writing + optimizer/routing s | Calls | Retries | Application | Delivery | Normalized USD | Receipt USD |
|---|---:|---:|---:|---:|---:|---:|---:|
| DeepSeek 18 | 73.550699 | 28 | 2 | 3/3 | 2/3 | 0.069418260 | 0.069418260 |
| DeepSeek 19 repeat | 124.219280 | 28 | 2 | 3/3 | 1/3 | 0.080248764 | 0.080248764 |
| Sol control 1 | 102.315176 | 26 | 0 | 3/3 | 2/3 | 0.043043700 | 0.314406000 |
| Sol control 2 | 108.180454 | 26 | 0 | 3/3 | 2/3 | 0.039677424 | 0.292922400 |

| Route, two observations | Mean writing s | Observed range s | Mean normalized USD | Mean receipt USD |
|---|---:|---:|---:|---:|
| DeepSeek off to low | 98.884990 | 73.550699–124.219280 | 0.074833512 | 0.074833512 |
| Sol low | 105.247815 | 102.315176–108.180454 | 0.041360562 | 0.303664200 |

Means describe these two sequential whole-suite observations; they do not select the fastest cell or establish significance. DeepSeek’s recoveries moved between cases. Sol required no retry in either control.

| Case / observation | Writing s | Calls / retries | Input | Output | Cache read | Total tokens | Delivery |
|---|---:|---:|---:|---:|---:|---:|---|
| hard-context-calibration / DeepSeek 18 | 6.923954 | 4 / 1 | 15,031 | 2,196 | 384 | 17,611 | pass |
| hard-dependency-handoff / DeepSeek 18 | 22.016941 | 19 / 0 | 70,289 | 15,208 | 4,608 | 90,105 | fail |
| hard-lifecycle-extract / DeepSeek 18 | 44.609805 | 5 / 1 | 19,891 | 14,113 | 768 | 34,772 | pass |
| hard-context-calibration / DeepSeek 19 repeat | 3.018989 | 3 / 0 | 560 | 1,199 | 10,368 | 12,127 | pass |
| hard-dependency-handoff / DeepSeek 19 repeat | 108.464832 | 21 / 2 | 46,523 | 48,434 | 35,968 | 130,925 | fail |
| hard-lifecycle-extract / DeepSeek 19 repeat | 12.735459 | 4 / 0 | 2,438 | 4,574 | 11,008 | 18,020 | fail |
| hard-context-calibration / Sol control 1 | 10.008857 | 3 / 0 | 10,325 | 1,137 | 0 | 11,462 | pass |
| hard-dependency-handoff / Sol control 1 | 70.757669 | 19 / 0 | 65,736 | 11,172 | 0 | 76,908 | fail |
| hard-lifecycle-extract / Sol control 1 | 21.548650 | 4 / 0 | 12,522 | 1,415 | 0 | 13,937 | pass |
| hard-context-calibration / Sol control 2 | 11.408167 | 3 / 0 | 10,325 | 1,137 | 0 | 11,462 | pass |
| hard-dependency-handoff / Sol control 2 | 74.688183 | 19 / 0 | 61,853 | 11,426 | 3,840 | 77,119 | fail |
| hard-lifecycle-extract / Sol control 2 | 22.084104 | 4 / 0 | 4,458 | 1,283 | 8,064 | 13,805 | pass |

Cache-write tokens are zero. Normalized costs reprice Sol at DeepSeek rates; receipt charges use the SDK catalog. Subscription invoices and quota are unmeasured. All four observations retain 3/3 application completion; candidate-count zero means no generated check ran.

Run18 initial source, briefs, raw/dispatched partitions, dependencies, source bounds, concurrency four and the exact frozen backend are retained. Control01/02 harness, full SDK, dependencies, tasks and input inventories match. Sol audits replayed staged excerpts and edits, checked local diagnostics/candidate/protected paths, and confirmed only writer calls. DeepSeek rows retain their existing source/provider/attempt audits. Later dependent bytes can differ because each arm uses its own staged writes.

Provider-policy limits remain material: the pinned Sol adapter omits requested maxTokens while DeepSeek sends max_tokens; equal enforced output ceilings are unproven. Sol’s legacy retry could catch nonterminal transport/model failures, but neither control retried. Neither Sol control incurred owner/query/review/Jev calls; DS18’s earlier query work is excluded from this writer-boundary comparison. Behavioral feedback was absent for both routes.

Handoff failed downstream in all four observations. Extraction passed delivery in DeepSeek18 and both Sol controls, but failed in DeepSeek19. Calibration passed throughout. These outcomes remain separate from writer application.

The controls were sequential, not randomized, and cache/provider latency varied. No independent semantic review or full-workflow comparison is claimed.

Shared ledger: 474 settled entries, zero holds, $3.807709876 exposure. The prior campaign contributes $3.200381476 across 422 entries; these controls add $0.607328400 across 52. Their normalized cost is $0.082721124. Main DeepSeek 03–19 report rows and their dated budget snapshot are unchanged.

No clear writing-speed winner is established. The prespecified bounded diagnostic pair 20–21 is the next main step, not yet started; no expected benefit is claimed. The goal remains active, and divergent live experiments remain queued.
