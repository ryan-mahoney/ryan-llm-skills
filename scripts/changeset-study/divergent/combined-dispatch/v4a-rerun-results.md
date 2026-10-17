# Revised V4A combined-route rerun

The revised route completed **3/3 applications and delivered 2/3 tasks**: calibration and lifecycle extraction pass; handoff remains behaviorally incorrect. V4A succeeded locally on **15/17 primary packets**; both remaining local failures recovered through the single JSON fallback, completing all 17 packets. Strict matching, ambiguity, path, syntax and atomicity guards were unchanged. This supports the interface repair on these cases, not universal V4A reliability.

The new freeze `cbb3380` reuses exactly the prior tasks, raw Sol plans and DeepSeek owner briefs. It supplies complete physical source lines and selected bodies within 64,000 UTF-16 code units, without JSON-oriented body omission, and explicitly requires one patch envelope and forward source order. There are no new owner, Sol or model-review calls or behavioral-feedback repairs. This is a three-case combined-only rerun; the [earlier paired results](results.md) are historical references, not fresh controls.

| Task | V4A primary success | JSON fallback recovery | Application / delivery | Writing wall s | DS input / output / cache read | DS receipt + Jev estimate USD |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Calibration | 2/2 | — | pass / pass | 3.151 | 7,633 / 1,123 / 0 | 0.003667446 |
| Handoff | 10/12 | 2/2 | pass / fail | 34.939 | 55,298 / 16,762 / 1,408 | 0.036961980 |
| Lifecycle extraction | 3/3 | — | pass / pass | 58.090 | 26,030 / 22,533 / 512 | 0.034880946 |
| Total | 15/17 | 2/2 | 3/3 / 2/3 | 96.179 | 88,961 / 40,418 / 1,920 | 0.075510372 |

Writing wall includes preprocessing plus execution; preprocessing already contains Jev and optimization. All 17 planned packets dispatched. The earlier combined run dispatched only 15, accepted 8 V4A primaries, needed seven fallbacks and left two extraction dependents blocked. Its extraction duration of 4.606s describes early failed work and cannot be compared as a saving against this completed 58.090s extraction. The older JSON baseline completed 3/3 applications and delivered 1/3, but was not repeated here. No speed or isolated-format win follows from these historical configuration differences.

Full source/body exposure has a cost: extraction emitted 22,533 output tokens while copying the module and rewriting its delegates. The largest delivered source packet was 41,636 UTF-16 code units, below the 64,000-character bound; peak complete serialized request context was 49,484 bytes. These are different units. Complete bodies reduce omitted-source incompatibility but can require substantial literal output.

The two residual V4A failures were invalid hunks, correctly rejected. `runtime-imports` concatenated observedRuns lines 28–41 directly with a later comment at line52, skipping the intervening helper although the packet marked separate excerpts. `runtime-editor-outcome` marked newly invented continuation code as unchanged source context. Both JSON fallbacks succeeded. Neither observation supports weakening the applier or treating disjoint excerpts as contiguous source.

Handoff's base visible checks pass, but its selected candidate suite reports 0/4 passing from API/fixture/editor-outcome/path expectations. Hidden output reports 98/101 tests passing, with accepted prerequisites classified unknown/malformed and missing detail counts; the raw result is exit1, `completed:false`, no timeout. Application is therefore not delivered correctness. The prior undefined-helper failure is not the current failure mechanism. Calibration and extraction pass visible and completed hidden grading with protected files and path ownership intact.

| Stage or usage | Total |
| --- | ---: |
| Execution wall | 95.192 s |
| Preprocessing wall | 0.987 s |
| Jev stage, contained in preprocessing | 0.954 s |
| Provider latency sum, overlapping under concurrency | 118.674 s |
| Visible/candidate checks | 36.420 s |
| Hidden grading | 94.132 s |
| Process wall | 226.968 s |

Actual usage is **19 DeepSeek calls (17 V4A + 2 JSON) and 3 Jev calls**, joining 22 unique canonical reservations. DeepSeek used 88,961 input, 40,418 output, 1,920 cache-read and zero cache-write tokens: 131,299 total. Its catalog-priced receipts total $0.075201420. Jev adds 7,356 input/579 output tokens and $0.000308952 input-only estimated cost; mixed total is **$0.075510372**, with no unknown, missing, orphaned or unattributed exposure. None is independently verified invoice cost. The shared ledger snapshot is 982 entries/$4.9834742442 with zero holds; prior campaigns remain separate.

All three Jev requests succeeded using `jev-1.13.0`, with no applied merge veto or context override. Plans again contracted 26→17 assignments, so no incremental Jev routing benefit is demonstrated. Exact prior plan/brief/source identities, frozen Node/SDK/Jev/dependencies, request/response/receipt/ledger joins and staged candidate replay all pass audits. This sequential single rerun combines context and instruction changes and retains cache/provider variability; it cannot isolate causality or establish general reliability. No managed workflow change or further trial is included. [Machine evidence and attempt breakdowns](v4a-rerun-results.json); [diagnosis and unchanged applier constraints](V4A-FAILURES.md). Raw artifacts resolve from the spec-package runtime base at `combined-dispatch/02-revised-combined`.
