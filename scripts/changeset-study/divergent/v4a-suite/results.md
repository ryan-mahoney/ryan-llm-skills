# V4A and executable JSON pilot results

All four encoding treatments qualified 14/14 positive edits and correctly refused 2/2 impossible edits. For implementation goals, DeepSeek and MiMo qualified 8/8; Muse qualified 7/8, with one output-length failure. No applied-but-incorrect candidate occurred. These are two observations of each small synthetic fixture, not a general reliability or model ranking claim.

The sequential harness made 88 calls for $0.0437494612. Harness wall time was 804.952 seconds, measured from the start marker to the final aggregate write. Generation latency below excludes runtime setup, snapshot verification and private grading. Reasoning tokens are a subset of output, not additive. No Sol calls or subscription-cost normalization apply.

Measured source revision: `dd44d723be04194c1b7ff206ddf5a10b0c0d08e2`. Node v22.23.3 and the actual SDK 1.2.0 dependency snapshot were frozen. [Machine-readable results](results.json) include frozen identities and individual outcomes; the [protocol](PROTOCOL.md) describes preparation and evaluation.

## Settled edit encoding

| Treatment | Positive qualified | Correct refusal | Calls | Median generation s | Sum generation s | Input | Output | Cache read / write | Total tokens | USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v4a / deepseek/deepseek-flash:off | 14/14 | 2/2 | 16 | 1.037 | 16.785 | 5066 | 1005 | 3968 / 0 | 10039 | 0.0027496080 |
| json / deepseek/deepseek-flash:off | 14/14 | 2/2 | 16 | 1.181 | 19.248 | 4394 | 2093 | 6912 / 0 | 13399 | 0.0038712720 |
| json / openrouter/meta/muse-spark-1.3-contributor:high | 14/14 | 2/2 | 16 | 8.613 | 281.557 | 10942 | 23763 | 0 / 0 | 34705 | 0.0058468000 |
| json / primalabs/primalabs-ai/MiMo-V2.6-Pro:medium | 14/14 | 2/2 | 16 | 1.219 | 22.985 | 2674 | 4328 | 8048 / 0 | 15050 | 0.0049575228 |

## Implementation goals

| Treatment | Positive qualified | Correct refusal | Calls | Median generation s | Sum generation s | Input | Output | Cache read / write | Total tokens | USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| json / deepseek/deepseek-flash:off | 8/8 | 0/0 | 8 | 1.871 | 16.249 | 2888 | 3916 | 3584 / 0 | 10388 | 0.0055871040 |
| json / openrouter/meta/muse-spark-1.3-contributor:high | 7/8 | 0/0 | 8 | 30.895 | 344.063 | 6254 | 33716 | 0 / 0 | 39970 | 0.0073686000 |
| json / primalabs/primalabs-ai/MiMo-V2.6-Pro:medium | 8/8 | 0/0 | 8 | 4.947 | 79.907 | 2244 | 14228 | 3904 / 0 | 20376 | 0.0133685544 |

On the matched 14 positive encoding edits, V4A/JSON ratios for DeepSeek were 0.863× summed generation latency, 0.901× median latency, 0.475× output tokens and 0.692× receipt cost. This comparison excludes the two expected refusals per format and does not compare implementation across formats. Refusal-only and combined ratios are retained in JSON.

## Per-repeat gates

Gate denominators are positive edits; expected refusals have a separate column. Unmeasured gates are not passes.

| Track / treatment | Repeat | Parsed | Applied | Unambiguous | Syntax | Correct | Qualified | Refusal |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| encoding / v4a / deepseek/deepseek-flash:off | 1 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| encoding / json / deepseek/deepseek-flash:off | 1 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| encoding / json / openrouter/meta/muse-spark-1.3-contributor:high | 1 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| encoding / json / primalabs/primalabs-ai/MiMo-V2.6-Pro:medium | 1 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| implementation / json / deepseek/deepseek-flash:off | 1 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 0/0 |
| implementation / json / openrouter/meta/muse-spark-1.3-contributor:high | 1 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 0/0 |
| implementation / json / primalabs/primalabs-ai/MiMo-V2.6-Pro:medium | 1 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 0/0 |
| implementation / json / primalabs/primalabs-ai/MiMo-V2.6-Pro:medium | 2 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 0/0 |
| implementation / json / openrouter/meta/muse-spark-1.3-contributor:high | 2 | 3/4 | 3/4 | 3/4 | 3/4 | 3/4 | 3/4 | 0/0 |
| implementation / json / deepseek/deepseek-flash:off | 2 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 0/0 |
| encoding / json / primalabs/primalabs-ai/MiMo-V2.6-Pro:medium | 2 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| encoding / json / openrouter/meta/muse-spark-1.3-contributor:high | 2 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| encoding / json / deepseek/deepseek-flash:off | 2 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |
| encoding / v4a / deepseek/deepseek-flash:off | 2 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 7/7 | 1/1 |

## Retained failure and compiler assistance

Muse stopped with length on second-repeat impl-header-normalization after 94.173 seconds. It returned 1470 bytes of final text. Provider usage reported 8408 output tokens, including 7786 reasoning tokens, despite the requested 8,192-token output limit. The truncated response was not parsed or applied, and no retry ran. This is an output-cap failure, not incorrect applied code; the report does not infer a cause for the reasoning volume.

The JSON compiler added the old renamed path to one operation's writes (r2-20-enc-create-delete-move-json-primalabs); no dependencies were added. This deterministic assistance is retained in JSON rather than described as fully declared raw output. All selected V4A matches used the exact tier; the lenient-wrapper diagnostic did not rescue any primary failure.

Implementation outputs were executable plans, but often used whole-file replacement through the allowed replace vocabulary: DeepSeek produced 18 operations across 8 parsed outputs, with 12/20 replacements covering the entire current file in 7 outputs; Muse produced 7 operations across 7 parsed outputs, with 13/18 whole-file replacements in 5 outputs, plus its one length stop; MiMo produced 8 operations across 8 parsed outputs, with 10/20 whole-file replacements in 4 outputs. Whole-file replacements were allowed, not silently disqualified. These outcomes do not show that the models chose narrow source splices or sophisticated dependency graphs.

## Fixtures and scope

All fixtures are synthetic. Encoding covers replacement, separated edits, selecting a duplicate occurrence, CRLF/tabs/Unicode, EOF without a final newline, create/delete/move, dependent edits, and explicit impossible-edit refusal. Implementation covers a duration helper, receipt API migration, header normalization, and dependency ordering. Gold and private behavioral checks were excluded from prompts; protected-file equality and completion-marker grading were required.

The maximum complete serialized context was 3,828 bytes, far below the 32 KiB guard. This pilot does not test the earlier large-repository discovery/planning interface failures or establish that these models can handle those workloads.

V4A used a guarded compatible adapter, not stock upstream application: multiple matches at the first successful matching tier are rejected; updates preserve context bytes, individual line endings and original EOF-newline presence; inserted lines use the first source ending, and added files use LF. Primary parsing required the exact envelope; wrapper tolerance was diagnostic only. The upstream revision, Apache license and departures are retained in applier.mjs, LICENSE, NOTICE and results.json.

All 88 request reservations joined priced ledger entries, with no unresolved reservations or unknown costs. The canonical ledger moved from $4.7722421870 to $4.8159916482 of $50. The separate $5 exposure guard remained active. Two fixed reversed repeats do not establish 95% reliability; generation latency is not end-to-end developer workflow time. MiMo's configured medium setting enabled thinking without a distinct medium wire effort.
