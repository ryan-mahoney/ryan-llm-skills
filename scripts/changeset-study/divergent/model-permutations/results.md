# Four model permutations: constrained planning results

Only calibration reached writing. Sol → Muse and Sol → MiMo each delivered that
case; no arm delivered all three tasks. Handoff and lifecycle stopped at the
bounded source/plan interface, so these results do not rank their writers' ability
on those tasks or establish a new optimal whole-workflow configuration.

The original campaign retained all 12 route observations. A separately frozen,
reviewed MiMo credential fix resumed its one eligible calibration case using the
exact original Sol plan; the original zero-call credential block remains recorded.
The other two MiMo cases retained their failed Sol preparation without new planning.

| Route | Tasks reaching writes | Application complete | Terminal accepted | Audited delivery | Allocated calls | Allocated route seconds | Subscription-normalized route cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Muse high, executable changesets itself | 0/3 | 0/3 | 0/3 | 0/3 | 6 | 201.402 | $0.008622400 |
| Muse high → DeepSeek off | 1/3 | 1/3 | 1/3 | 0/3 | 8 | 475.067 | $0.014998008 |
| Sol low → Muse high | 1/3 | 1/3 | 1/3 | 1/3 | 7 | 145.705 | $0.023066300 |
| Sol low → MiMo configured medium | 1/3 | 1/3 | 1/3 | 1/3 | 7 | 82.151 | $0.032598345 |

Route seconds sum allocated preparation process time plus execution/check/grading
process time and any path audit. They include failed preparations and are not
writing-only times. The common Sol preparation is allocated in full to both Sol
routes, including failed task preparation; those allocations must not be summed as
actual campaign spending. The MiMo route uses the corrected resume observation;
its time excludes the earlier zero-call auth block and engineering fix time, which
remain separate harness evidence.

## Calibration: the only matched writer comparison

Sol → Muse and Sol → MiMo used the same plan hash, same source, identical initial
writer system/input packets, identical execution backend/SDK and the same original
limits. Each made two calls with no extra attempt. Both passed protected-file,
visible/changed-test and terminal checks. This is one observation per writer.

| Writer on the exact Sol calibration plan | Writing seconds | Writer calls | SDK receipt/ledger writer cost | Full calibration route seconds | Normalized full calibration route cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Muse high | 107.752 | 2 | $0.003816800 | 124.347 | $0.008373500 |
| MiMo configured medium | 44.217 | 2 | $0.013348845 | 60.793 | $0.017905545 |

MiMo was faster and more expensive in this single matched observation. Its requested
`medium` setting maps to **thinking enabled**; the configured SDK sends no distinct
medium-effort value. Muse sends explicit `reasoning: {effort: 'high'}`. No broader
latency, reliability or model ranking follows from one small case.

Muse → DeepSeek used a different fresh Muse plan: writing took 2.894 seconds and
$0.001999308. File application and hidden acceptance passed, while visible and
changed regression checks failed. It is **not audited delivery** and is not a
matched plan comparison against either Sol-led writer. A cheap application alone
does not meet the correctness objective.

## Why the remaining routes did not reach writing

Muse-self requested a second lookup batch in each task, violating the frozen
one-batch contract. Muse-delegated handoff stopped on non-unique context anchors;
its lifecycle preparation also requested another lookup batch. Sol's handoff
lookup requested the complete `runtime.mjs`: 108,558 UTF-16 characters against a
64,000-character batch cap. Its lifecycle preparation likewise requested another
batch. Requested paths, full-file sizes and hashes are retained in the adjacent
`handoff-planning-boundary.json` artifact. These are planning-interface outcomes;
no handoff or lifecycle writer ran. There was no task-specific tuning or replan.

This points to future work on source preparation and the planning interface, not
a supported ranking of model implementation quality. No such new experiment was
run here. Morph/Relace remain excluded on cost under the recorded user decision;
this campaign neither reopens nor reruns those specialized-writer treatments.

## Actual spend and provenance

Across both freezes, **23 actual calls** incurred **$0.171700053** in SDK-priced
receipts and matching shared-ledger settlements. Repricing Sol subscription calls
at the established DeepSeek rates gives **$0.060035553**; this normalization is
separate from the unchanged literal ledger charges. Sol's five preparation calls
cost $0.130914000 at receipt prices or $0.019249500 normalized, paid once and
allocated to each Sol-led route. The resume added two MiMo calls and no Sol calls.

Actual token categories: 176,366 input, 87,361 output, 768 cache read, zero cache
write, and 264,495 total. Reported reasoning tokens were 74,217, an informational
subset of output that must not be added again. No unresolved charge or reservation
remained. The canonical shared ledger ended at 820 entries and $4.772242187 of its
unchanged $50 cap, including prior campaigns. Prices are SDK calculations from
usage, not independently verified provider invoices. Sol-normalized USD/M rates
are input 0.3, output 1.2, cache read 0.006 and cache write 0.3; other models retain
their receipt prices.

Original freeze: `6284c83b2bb99bcfc51607076757a5266279f698`.
Credential-resume freeze: `c47826b502c2f6ab9f6242b76d47977a83ec1e25`.
Both preserve original run 03 tasks/source, full SDK/dependencies, parser and Node
identities. The first model owned implementation and planning; there was no extra
DeepSeek owner, model review after writing or hidden-feedback repair. All failures,
lookups, plans, attempts, candidates and checks remain retained.

[Sanitized result data](results.json) contains the original 12 observations, three
resume observations, effective route summaries, stage times, all token categories,
actual versus allocated accounting, shared-plan/packet hashes and freeze identities.
Detailed artifacts live at `model-permutations/01-four-arms` and
`model-permutations/02-mimo-auth-resume` relative to the declared adjacent runtime root.
No further paid calls were made or queued by this campaign.
