# Sol owner with DeepSeek V4.1 Flash editors

Delegating every write to DeepSeek did **not** improve the retained Sol-only
results. Three configurations ran the same three historical tasks. They delivered
2/3, 1/3 and 0/3 respectively; none qualified for a successful-repeat run. The
successful Sol-only changeset strategy remains the strongest result in this study.

| Approach | Complete delivery | Seconds | Calls | Total tokens | Equivalent USD |
|---|---:|---:|---:|---:|---:|
| Historical native Sol | 3/3 | 474.96 | 28 | 514,714 | 0.166109 |
| Sol-only changesets | 3/3 twice | 319.74–339.55 | 16–17 | 328,670–340,136 | 0.106833–0.107606 |
| Sol owner / DeepSeek low | 2/3 | 884.14 | 26 | 979,146 | 0.416795 |
| Sol owner / DeepSeek off | 1/3 | 851.13 | 28 | 787,968 | 0.281593 |
| Concrete owner contracts / DeepSeek off | 0/3 | 589.95 | 31 | Unknown; 803,636 reported | Unknown |

The last configuration includes a Sol provider request-processing error with no
priced usage. Its total cost and token accounting remain unknown. Its two other
cases failed independently of that service error. Faster failed attempts do not
establish successful throughput.

See the [full results](owner-editor-results.md), [machine-readable evidence](owner-editor-results.json),
[path diagnostics](owner-editor-audits.json) and [protocol](OWNER-EDITOR-PROTOCOL.md).
The [Sol-only findings](SOL-ONLY-FINDINGS.md) retain the successful comparator.

## Division of work

The owner was `openai-codex/gpt-6.1-sol:low`. Every initial and repair editor call
went directly to `deepseek/deepseek-flash`, the API name for DeepSeek V4.1 Flash
in the [provider model table](https://api-docs.deepseek.com/quick_start/pricing/).
Both simple and involved operations used that editor. The owner could discover
source and settle decisions, but the harness rejected owner-authored executable
edits. No fallback silently moved writing back to Sol.

```text
Sol reads source and assigns owned files, instructions and dependencies
                         ↓
DeepSeek returns exact replacements or source-range operations
                         ↓
Runtime validates edits, stages current files and schedules dependencies
                         ↓
Original visible checks + candidate's changed tests
                         ↓
Sol reviews integrated behavior with unchanged-helper context
                         ↓
At most one owner-planned, DeepSeek-written repair batch
                         ↓
Frozen candidate → external grading → separate known-defect diagnostic
```

Independent operations could run concurrently, with a ceiling of four. Conflicting
reads/writes serialized against the updated staged filesystem. Editors had no
tools or private edit/check loop. The 32,000-token response allowance, deadlines,
shared call limit, task/source bytes and original gates stayed fixed. All plans,
requests, responses and failures were retained outside the checkout.

## What happened

**Low thinking:** calibration and extraction delivered; dependency handoff failed.
The small edit took 67.78 seconds, including 51.86 seconds for DeepSeek. That editor
response used 11,464 reasoning tokens and 2,559 other output tokens. The larger
implementation hit its 32,000-token limit after 25,874 reasoning tokens. Its JSON
could not apply, so Sol split the repair into smaller packets. They applied, but
the final review found contract errors and a missing test import. The extraction
passed, but regenerated the new file instead of composing unchanged bodies from
source references. Its 16 moved bodies retained the same AST; 14 were byte-identical
and two differed in indentation. Existing tests were unchanged.

**Thinking off:** calibration delivered in 24.97 seconds, close to Sol-only's
22–24 seconds. Larger tasks failed. A new handoff regression hung twice and reached
the unchanged 180-second command deadline. Sol identified multiple semantic
defects, but DeepSeek returned `{"edits":[]}` for the first repair packet, blocking
dependent repairs. Extraction still exhausted 32,000 output tokens without
thinking; its repair introduced a duplicate declaration and failed syntax checks.
The first two configurations used identical execution code and prompts; only the
editor thinking selector changed. Ancillary reporting and diagnostic files differed.

**Concrete contracts:** each owner packet additionally specified implementation
steps, boundary semantics and verification/fixture obligations. The prompt also
asked the owner to omit irrelevant verification-only source from editor context.
This bundled prompt intervention did not establish reliable execution. Calibration's
first batch contained an invalid replacement count of zero; its repair added a
failing regression. Handoff packets delivered imports while omitting assigned
runtime behavior and tests. After repair, all five requested test cases were still
missing and the dirty-path whitespace defect had returned. Extraction suffered the
Sol service error, then DeepSeek created the new module without removing or wiring
the old definitions; it also left an injected error helper out of scope.

Seven of nine candidates passed the external benchmark checks. Only three met the
complete delivery requirements, which also included visible/candidate checks,
owner acceptance and successful execution. Required regression tests and edge
semantics can remain missing despite an external pass. Retaining those obligations
prevented incomplete work from being counted as a win.

## Where the additional work went

| Configuration | Owner calls | Editor calls | Owner tokens | Editor tokens |
|---|---:|---:|---:|---:|
| DeepSeek low | 17 | 9 | 305,859 | 673,287 |
| DeepSeek off | 20 | 8 | 316,009 | 471,959 |
| Concrete contracts | 21 | 10 | Unknown; 354,221 reported | 449,415 |

The owner still performed discovery, planning, review and repair planning. Editor
context and generation were added to that workload. Turning thinking off reduced
generation time on small packets, but did not prevent partial edits, invalid edit
instructions, output truncation or broken test fixtures. More detailed planning
and smaller source packets also did not produce a complete delivery here.

These observations support retaining direct Sol executable plans as the reference
implementation. This experiment does not justify replacing the managed editor
default with DeepSeek or relaxing its verification. A future study could isolate
small closed editing packets, or compare Sol and DeepSeek as editors under the
same owner/editor design. That comparison was not run here.

## Evidence and limits

- Nine finalized trials and 85 calls: 84 priced and one unpriced service error.
  Requests and receipts reconcile by reservation; every write operation was
  delegated and every editor request used the selected DeepSeek provider.
- Frozen code, source/reference files and candidate hashes were checked. An
  independent arithmetic calculation reconciled elapsed time, calls, reported
  tokens and all fully priced equivalent costs.
- Focused strategy checks passed in 40.51 ms, covering ownership, stale anchors,
  source preservation, owner-write rejection and packet-contract forwarding.
  Syntax checks and `git diff --check` passed. Broad repository testing remains
  operator-managed; no repository CI result is claimed.
- The path diagnostic now recognizes extracted helpers and aliases in the output
  fields. Real-Git fixtures still reject both historical bad candidates and accept
  the historical native and two successful Sol-only candidates. They also accept
  the first DeepSeek handoff's path handling and reject the third's unstaged-path
  handling. The second failed handoff has an unsupported diagnostic shape, recorded
  as unassessed rather than passed. All three handoffs already fail delivery on
  other gates. Each executed diagnostic took about 0.10–0.12 seconds, outside trial
  timing; its input/output never entered model feedback.
- Jev verification/review triage ran offline and returned unavailable/context-limited
  fallbacks. Main-agent judgment retained the focused checks and all real failures.
- Cumulative campaign guard exposure is **$28.705461308 / $50**, including
  **$13.788583** in five unpriced reservations from this and earlier work. The new
  Sol service error accounts for **$9.87671875** of those holds. These are conservative
  reservations, not confirmed charges. No active reservations or trial workers remain.

Equivalent costs price Sol at the retained DeepSeek tariff and DeepSeek at its
installed catalog tariff, equal to the provider's published peak rates. Actual
off-peak billing, subscription charges and quota are not measured. Cached input
is included in token totals and priced using the retained cache tariff.

These are adaptive experiments on three exposed tasks with historical controls,
one run per new configuration, and changing provider conditions. They establish
no general model ranking or population performance estimate. The third intervention
bundles handoff detail and context selection; the last cell also has a service-error
confound. The research backend is implemented; production `spec-end-to-end`
integration remains proposed in the [integration notes](INTEGRATION.md).
