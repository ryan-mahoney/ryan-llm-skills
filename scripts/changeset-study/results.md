# Matched study results

Frozen campaign: 2026-10-16T14-49-04-971Z-eval. 96 cells; 8 workload families; 2 repetitions per model and arm.

Native Pi coding tools form the conventional baseline. Each pair uses the same model for all roles. Total process wall time includes planning, tool execution, visible checks, impact review, repairs, grading and process startup. Hidden graders run only after candidates freeze.

| Model | Agent accepted | Changeset accepted | Agent median seconds | Changeset median seconds | Capped speed ratio (95% task interval) |
|---|---:|---:|---:|---:|---:|
| deepseek/deepseek-flash:off | 16/16 | 15/16 | 8.94 | 7.08 | 0.87 (0.36–1.49) |
| openai-codex/gpt-6.1-sol:low | 16/16 | 16/16 | 19.02 | 13.54 | 1.32 (1.17–1.52) |
| openrouter/inception/mercury-2.5:low | 14/16 | 10/16 | 22.25 | 19.34 | 0.40 (0.17–0.85) |

Ratios above 1 favor changesets. The capped metric assigns 300 seconds to unsuccessful cells. Medians include failures and are not time-to-correct-answer claims. Confidence intervals resample workload families, not individual repeats. This is a purposive small corpus, not a random sample of software engineering. An all-pass sample can produce a degenerate bootstrap interval; it does not establish equal population reliability.

| Model | Agent model calls | Changeset model calls | Agent equivalent USD | Changeset equivalent USD |
|---|---:|---:|---:|---:|
| deepseek/deepseek-flash:off | 106 | 69 | 0.05003 | 0.04469 |
| openai-codex/gpt-6.1-sol:low | 77 | 41 | 0.05869 | 0.03020 |
| openrouter/inception/mercury-2.5:low | 128 | 109 | 0.01598 | unknown |

Equivalent costs price Sol tokens at DeepSeek rates per the operator’s subscription assumption. Original catalog costs, raw token totals, stage times, failures and task-level comparisons are retained in the companion JSON. Estimates are not invoices.

Acceptance is determined by external tests, independently of reviewer opinion. A correct candidate can pass even if a final review response is malformed. Workflow completion and protocol errors remain separate operational measures:

| Model | Agent completed workflow | Changeset completed workflow | Agent uncaught errors | Changeset uncaught errors |
|---|---:|---:|---:|---:|
| deepseek/deepseek-flash:off | 15/16 | 16/16 | 0 | 0 |
| openai-codex/gpt-6.1-sol:low | 16/16 | 16/16 | 0 | 0 |
| openrouter/inception/mercury-2.5:low | 14/16 | 10/16 | 1 | 1 |

## Supplemental contract coverage audit

Source inspection found that the original legacy-session grader missed the specified behavior for files without a session header. Additional checks cover that case and other explicit contract boundaries. The reference solutions passed. All 96 frozen candidates were rechecked, with no model calls, implementation changes or repair feedback. These are post-hoc observations, separate from the preregistered scores above.

| Model | Agent accepted after supplemental checks | Changeset accepted after supplemental checks | Newly detected regressions |
|---|---:|---:|---:|
| deepseek/deepseek-flash:off | 16/16 | 13/16 | 2 |
| openai-codex/gpt-6.1-sol:low | 16/16 | 16/16 | 0 |
| openrouter/inception/mercury-2.5:low | 12/16 | 8/16 | 4 |

| Model | Post-hoc capped speed ratio (95% task interval) | Equivalent cost per accepted outcome, agent / changeset |
|---|---:|---:|
| deepseek/deepseek-flash:off | 0.63 (0.25–1.34) | 0.00313 / 0.00344 |
| openai-codex/gpt-6.1-sol:low | 1.32 (1.17–1.52) | 0.00367 / 0.00189 |
| openrouter/inception/mercury-2.5:low | 0.43 (0.18–0.93) | 0.00133 / unknown |

The original timing observations remain unchanged. Original conditional speed ratios do not imply speed to a correct result under these expanded checks. Sol acceptance is unchanged; DeepSeek and Mercury require the weaker reliability conclusion shown here.

## Per-workload results under original grading

| Model | Task | Agent passes | Changeset passes | Mean seconds, agent / changeset |
|---|---|---:|---:|---:|
| deepseek/deepseek-flash:off | exact-account-report | 2/2 | 2/2 | 8.72 / 9.90 |
| deepseek/deepseek-flash:off | transport-migration | 2/2 | 2/2 | 6.92 / 4.85 |
| deepseek/deepseek-flash:off | csv-row-parser | 2/2 | 2/2 | 12.18 / 8.41 |
| deepseek/deepseek-flash:off | historical-action-lookup | 2/2 | 2/2 | 14.60 / 12.27 |
| deepseek/deepseek-flash:off | python-ledger | 2/2 | 2/2 | 6.46 / 5.74 |
| deepseek/deepseek-flash:off | formatting-library | 2/2 | 2/2 | 8.94 / 5.29 |
| deepseek/deepseek-flash:off | shared-options | 2/2 | 1/2 | 7.10 / 3.43 |
| deepseek/deepseek-flash:off | historical-session-version | 2/2 | 2/2 | 40.39 / 22.89 |
| openai-codex/gpt-6.1-sol:low | csv-row-parser | 2/2 | 2/2 | 19.78 / 16.98 |
| openai-codex/gpt-6.1-sol:low | shared-options | 2/2 | 2/2 | 27.14 / 21.29 |
| openai-codex/gpt-6.1-sol:low | formatting-library | 2/2 | 2/2 | 20.78 / 19.68 |
| openai-codex/gpt-6.1-sol:low | historical-session-version | 2/2 | 2/2 | 17.01 / 13.21 |
| openai-codex/gpt-6.1-sol:low | historical-action-lookup | 2/2 | 2/2 | 19.15 / 12.10 |
| openai-codex/gpt-6.1-sol:low | exact-account-report | 2/2 | 2/2 | 25.85 / 13.03 |
| openai-codex/gpt-6.1-sol:low | python-ledger | 2/2 | 2/2 | 15.70 / 11.84 |
| openai-codex/gpt-6.1-sol:low | transport-migration | 2/2 | 2/2 | 18.20 / 16.66 |
| openrouter/inception/mercury-2.5:low | historical-action-lookup | 0/2 | 0/2 | 31.11 / 19.05 |
| openrouter/inception/mercury-2.5:low | csv-row-parser | 2/2 | 0/2 | 11.65 / 21.89 |
| openrouter/inception/mercury-2.5:low | shared-options | 2/2 | 1/2 | 17.22 / 14.41 |
| openrouter/inception/mercury-2.5:low | formatting-library | 2/2 | 1/2 | 51.49 / 15.66 |
| openrouter/inception/mercury-2.5:low | python-ledger | 2/2 | 2/2 | 10.85 / 19.39 |
| openrouter/inception/mercury-2.5:low | transport-migration | 2/2 | 2/2 | 22.97 / 12.06 |
| openrouter/inception/mercury-2.5:low | historical-session-version | 2/2 | 2/2 | 28.42 / 51.05 |
| openrouter/inception/mercury-2.5:low | exact-account-report | 2/2 | 2/2 | 22.70 / 28.17 |

Six synthetic tasks and two extracted historical modules cover mechanical migration, independent edits, shared-file parsers, cross-file precision, CSV parsing, Python aggregation, catalog validation and legacy session compatibility. Historical tasks require discovery in small module snapshots; they do not measure navigation in a full production repository. Visible tests are sparse, hidden checks cover specified boundaries, and model review is fallible.

Provider caching, serving load and a single host can affect latency. Pair order is balanced across repetitions and randomized across tasks. No other study inference jobs run concurrently. SDK bytes are pinned; provider-side model deployments are outside the harness control. The study cannot establish general superiority, production readiness or success on ambiguous specifications and large refactors.
