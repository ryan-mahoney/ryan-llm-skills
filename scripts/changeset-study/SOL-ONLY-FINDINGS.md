# Sol-only changesets on three historical tasks

The final Sol-only strategy fully delivered all three tasks twice with identical
frozen code, passing both the original gates and the added boundary audit. It used
**28.5–32.7% less elapsed time** and **35.2–35.7% lower equivalent cost** than the
retained native Sol references. This meets the development stopping rule on these
three exposed tasks; it does not establish a general performance advantage.

| Run | Delivery plus required audit | Seconds | Equivalent USD | Calls | Tokens |
|---|---:|---:|---:|---:|---:|
| Previous native Sol | 3/3 | 474.96 | 0.166109 | 28 | 514,714 |
| Final strategy | 3/3 | 319.74 | 0.107606 | 16 | 328,670 |
| Identical repeat | 3/3 | 339.55 | 0.106833 | 17 | 340,136 |

Both changeset runs used one repair for dependency handoff and none for calibration
or extraction. Calibration took 23.83 and 22.26 seconds versus 23.03: the gain is
concentrated in the larger cases. Handoff took 202.79 and 221.84 seconds versus
245.25; extraction took 93.11 and 95.44 versus 206.68.

The [complete results](sol-only-results.md), [machine-readable summary](sol-only-results.json)
and [stage timing chart](sol-only-timing.svg) retain every development attempt.
The [protocol](ITERATION-PROTOCOL.md) defines the comparison and stopping rule.

## What changed

The planner still reads source and reasons about implementation. It emits a batch
of concrete operations, which the executor applies to staged file state. Later
operations see earlier changes. Independent operations can run concurrently, but
the successful strategy uses deterministic operations and no model editors; these
results do not establish a benefit from parallel model routing.

Four changes addressed observed failure modes:

1. **Emit edits directly.** The capable planner settles replacements instead of
   sending large files to another model for implementation. Execution failures
   enter review explicitly. Bounded editor patches remain an evaluated alternative.
2. **Move unchanged source by reference.** `compose` and `replace-range` carry
   uniquely anchored spans into new files. The extraction planner supplies imports
   and delegates without regenerating the moved method bodies. One earlier direct
   plan emitted 20,217 output tokens and took 265.6 seconds for that call alone;
   the source-range extraction completed end to end in about 92 seconds.
3. **Run the candidate's own changed tests before review.** The original visible
   command selected existing tests and missed new cases. Those new tests exposed
   the same two intentional-null errors the terminal checks later found. In the
   first successful handoff, one repair changed the null fallback expression and
   left the tests intact. Parsing outer test declarations also includes dynamic
   nested cases without running unrelated tests in the same file.
4. **Supply contracts outside the diff.** Review of the changed parser omitted the
   unchanged helper that trimmed its input. The next strategy supplies bounded
   definitions of unchanged same-file helpers called by changed functions or
   methods, and asks review to assess each independent behavior. Its first review
   identified both the null-value and parsing defects together; one repair fixed
   both. It also adds generic boundary-analysis guidance to planning, so this is
   a combined intervention rather than a context-only ablation.

This retains a feedback loop at the batch boundary. The strongest observed design
is capable planning, mechanical application, focused feedback and bounded repair.
Eliminating all feedback did not reliably deliver the harder tasks.

## Development record

| Strategy | Delivery | Total seconds | Main observation |
|---|---:|---:|---|
| Bounded patch editors | 1/3 | 520.14 | Handoff logic defect; incomplete extraction |
| Direct concrete edits | 2/3 | 545.49 | Handoff omitted tests initially; extraction generated a large response |
| Source-range edits | 2/3 | 321.94 | Extraction accelerated; handoff still missed two assertions |
| Source ranges plus candidate tests | 3/3 | 326.55 | Own-test feedback enabled the repair |
| Identical repeat | 2/3 | 301.48 | Final review found a separate parsing defect |
| Helper context and boundary review | 3/3 | 319.74 | Both defects caught together; added audit passes |
| Identical boundary-review repeat | 3/3 | 339.55 | Review caught a command-error propagation defect; repair and audit pass |

Delivery in this table is the original recorded benchmark outcome. The follow-up
audit found that the first checked run drops the first character of an unstaged
path, while its repeat adds a leading space to staged and renamed paths. Both
passed the fixed terminal tests. These are known correctness gaps, so the first
run's apparent win is withdrawn. Original trial records remain intact; reports
carry posthoc audit status separately.

The same six-case [path diagnostic](sol-only-audits.json) passes on the native
reference and both final candidates. It executes each candidate's actual parsing
block and same-file helpers against disposable Git repositories, covering staged,
unstaged, renamed, mixed and leading-space paths, plus command failure. It does
not exercise prompt launch or receipt loading. Each audit took about 0.10–0.11
seconds, retained separately from original trial timing; no diagnostic code or
output enters model feedback. The earlier fixture assumed a standalone formatter
and could not handle the repeat's inline implementation. That fixture error was
retained, and all relevant candidates were rerun with the final diagnostic.

The source-range strategy also added a generic completeness instruction, so its
effect cannot be isolated from that prompt change. The candidate-test strategy
retained the same planner prompt. All tasks, initial source, external checks,
dependency versions, model selector and one-repair allowance remained fixed.

## Interpretation and integration

These are adaptive development results on three exposed cases against historical
native measurements. Repetition checks whether the selected strategy succeeds
again; it does not supply fresh tasks, concurrent controls or a population estimate.
Provider latency can vary. Full elapsed time includes discovery, checks, review,
repair and terminal grading. Failed attempts remain visible and count toward
development expenditure.

Seven development iterations ran 21 trials: their summed trial time was 44.58
minutes and their total equivalent cost was $0.758327, including failed attempts.
This is development expenditure, separate from the final strategy's per-run cost.

The native reference uses Pi's standard coding tools, including shell commands
that can batch changes. It was not forced into a per-file edit/check loop. The
comparison therefore measures these particular harnesses and workloads, not the
maximum performance attainable with the model or every native patch interface.

Equivalent cost prices Sol tokens at the requested DeepSeek rates. It is a workload
comparison, not a subscription invoice or quota estimate. The separate cumulative
$50 guard uses conservative catalog exposure and includes the earlier campaigns.
It ended at $16.093792, including $3.911864 retained for four unknown-usage calls
from earlier campaigns. No active reservations or trial workers remained. All
21 Sol-only trials had complete accounting.

## Verification

Frozen file hashes, task equality, reference/candidate hashes, protected files,
receipt counts and the identical-repeat bytes were reconciled. A separate Python
calculation agreed with the reporter's time, token, cost and delivery totals for
all seven iterations. Both final extractions preserve all 16 moved function/method
bodies exactly and retain existing tests unchanged; their runtime files contain
1,422 and 1,421 lines, within the task's 1,550-line limit.

Focused harness evidence covers bounded patch ownership and stale anchors,
source-range moves, full-capacity budget refusal, changed-test selection and
unchanged-helper review context. The final helper-context check passed in 44 ms;
the real-Git diagnostic detects the earlier candidates' defects and passes the
native reference and final candidates. The generated timing chart was inspected.
Jev checkpoints returned offline/unavailable advice; focused verification remained
the implementation owner's responsibility. Broad repository testing is
operator-managed and outside this study's evidence.

## Integration consequence

The practical integration path remains the existing managed editor boundary:
let the retained step owner emit a settled changeset, execute it under the writer
lease, feed required focused checks back to that owner, and preserve independent
review and ordinary-editor fallback. The research Node test selector needs
repository-specific runner support in production. See [integration notes](INTEGRATION.md).

Fresh matched steps against the current managed owner/editor process are still
needed before adopting this as the default. Neither this result nor the earlier
small-task study measures whole-workflow savings in `spec-end-to-end`.

A useful next ablation holds planning and review fixed while comparing one native
multi-file patch response with this operation vocabulary. Evaluate concurrency
and cheaper editor models separately. This separates the effect of batching from
the choice of edit format and from model routing.

## Connections to prior work

[ReWOO](https://arxiv.org/abs/2305.18323) separates reasoning from tool observations;
[LLMCompiler](https://arxiv.org/abs/2312.04511) separates planning, task dispatch and
parallel execution. They provide architectural precedents for reducing repeated
reasoning between tool calls. Their reported benchmark improvements do not measure
this spec-driven editing workflow.

[CodePlan](https://www.microsoft.com/en-us/research/publication/codeplan-repository-level-coding-using-llms-and-planning/)
uses incremental dependency and impact analysis to order repository changes.
It still makes an LLM call for each planned location. Its evidence supports
dependency-aware planning, without establishing that all execution can be settled
in a single generation.

[Code the Transforms](https://mlforsystems.org/assets/papers/neurips2024/paper15.pdf)
generates reusable transformations from examples, with execution feedback.
The connection here is an inference: a compact executable description can avoid
regenerating unchanged code. Our source-range operations use a fixed vocabulary;
this study has not evaluated unrestricted generated codemods.

[CodeStruct](https://aclanthology.org/2026.acl-long.607/) provides named AST-unit
retrieval and syntax-validated edits. It motivates future symbol-based moves and
the bounded helper context used in the next review strategy. This experiment
has not measured CodeStruct itself or established that its published gains transfer.

[Pre-action verification research](https://arxiv.org/abs/2609.11957) reports cleaner
failures for content anchors than location-only edits in its benchmark. This is
not a universal guarantee that search/replace cannot misapply. Unique anchors and
source preconditions reject stale or ambiguous operations; they do not prove the
model selected the right behavior. Likewise, a scoped AST selector must resolve
ambiguity rather than choose the first matching function name.
