# Whole-file changeset handoffs failed on harder workloads

The Sol + Nemotron workflow did not completely deliver any of six historical
tasks. One candidate passed the external behavior checks, but it lacked a requested
regression test and its editor execution remained incomplete. This implementation
does not demonstrate a quality-preserving efficiency gain and is not ready to own
steps in `spec-end-to-end`.

| Measure, six tasks per workflow | Native Sol | Sol + Nemotron |
|---|---:|---:|
| External behavior checks passed | 4/6 | 1/6 |
| Complete delivery | 4/6 | 0/6 |
| Total elapsed time across all attempts | 17.9 min | 24.1 min |
| Model calls | 64 | 61 |
| Reported total tokens | 1,077,298 | 1,301,339 |
| Equivalent cost, Sol at DeepSeek rates | $0.339 | $0.427 |

The combined workflow used three fewer calls but about 35% more elapsed time and
26% more equivalent cost, with fewer accepted outcomes. The failure-adjusted
geometric speed ratio was 0.25, where values above 1 favor the combined workflow.
Its task-bootstrap interval was 0.12–0.53; six selected tasks are too few to infer
general reliability or a production speedup.

The [results table](hard-workflow-results.md), [machine-readable evidence](hard-workflow-results.json)
and [timing chart](hard-workflow-timing.svg) retain every scheduled outcome.
External acceptance and complete delivery are separate measures: delivery also
requires successful execution, visible checks and reviewer acceptance. Fast failed
attempts are not successful time savings.

## What failed

The changeset editor receives source and instructions in one call and returns
complete replacement files inside JSON. It cannot use tools to apply a small patch
or check its work. This interface became expensive and unreliable on large source
files, even when the requested semantic change was small.

| Task | Combined-workflow observation |
|---|---|
| Dependency handoff | Sol created the extracted module but returned no files for runtime wiring. A Nemotron repair reached its output limit. Required wiring and tests remained missing. |
| Context calibration | Nemotron implemented behavior that passed the external checks. Its regression-test edit returned malformed JSON; repair exhausted the output allowance. Review rejected the missing test. |
| Lifecycle extraction | Both Sol editor attempts returned empty file objects. No Nemotron request ran. Both impact reviews accepted the empty change, while the terminal structural check rejected the missing module. |
| Wave recovery | Both Sol editor attempts returned no files, blocking dependent work. No Nemotron request ran. Eleven of 21 external checks failed. |
| Fallback setup | Three Nemotron calls reached the output limit. An applied edit still used a copy operation that failed on a destination symlink with `EEXIST`; the hidden run reported two failures out of 129 checks. |
| Admission overlap | Sol returned no runtime edits in either round. A Nemotron documentation edit returned malformed JSON; deterministic repair added only a comment. Ten of 96 external checks failed. |

Nemotron received **10 editor requests across four tasks**. Five stopped at 32,000
reported output tokens; two other calls ended normally but returned malformed JSON.
The remaining three produced applied edits, with differing behavioral quality.
Counting ten requests as ten useful edits would substantially overstate throughput.
Two complete task failures occurred without any Nemotron call, so the results do
not isolate Nemotron's coding capability.

For lifecycle extraction, the first Sol editor request carried 111,457 input tokens,
including a 142,996-byte runtime file. The planner also asked that no-tools editor
to run tests. Sol returned an empty files object with a normal stop. These are
observed contract and workload mismatches; the precise cause of the empty response
is not established. Native Sol completed the same task successfully.

Native Sol's recovery failure was different: it implemented most of the change,
passed 18 of 21 external checks, and missed specific collision, drain and orphaned
claim cases within its one repair allowance. A logic failure after substantive work
should not be grouped with an empty editor response or malformed output.

Native Sol also failed two of 96 admission-overlap checks. It handled most overlap
cases, but attempted stale-run cleanup before rejecting two unknown-finish cases,
raising a path error instead of the required `run-active` refusal. Visible checks
and impact review accepted that candidate; terminal tests exposed the gap.

## What the numbers mean

The sole pair passing external checks in both workflows was context calibration:
native Sol took about 23 seconds and the combined workflow about 189 seconds.
The combined candidate still lacked complete delivery. Fallback setup took about
149 seconds for successful native delivery versus 575 seconds for the failed
combined attempt. There is no successful combined delivery from which to estimate
cost or time per fully delivered task.

The report includes all stages: initialization, discovery, planning, execution,
checks, review, repair and terminal grading. Failed trials receive the declared
1,500-second cap in the failure-adjusted comparison. Raw elapsed medians include
failures and cannot be read as time to a correct result. Sol equivalent costs use
DeepSeek rates under the subscription assumption; these estimates are not invoices.

The earlier [small-workload study](FINDINGS.md) remains valid for its own corpus:
Sol's changeset arm passed all 16 post-hoc checks and reduced mean elapsed time by
about 24%. However, 15 of those 16 trials used no separate editor call. That was
primarily evidence for exact edits supplied by a capable planner, not for delegating
large whole-file rewrites to another model. The historical [HTML visual](visual.html)
and its embedded charts describe that earlier study, not this Nemotron campaign.

## Limits and adapter diagnosis

This is an exploratory comparison of two complete workflows, once each on six
selected tasks from one repository. The operator narrowed an original 72-trial
schedule for elapsed time after three results were observed and a fourth trial
was running. All tasks were retained, one eligible native result was reused
regardless of its outcome, and earlier observations remain in the report.
No frozen worker, prompt, task or grader was tuned using these outcomes.

The native baseline uses standard Pi coding tools, low reasoning and bounded
repair. It is not the full managed `spec-end-to-end` workflow, and these results
do not establish Sol's usual failure rate or a general model ranking.

An [offline payload audit](hard-provider-audit.json) confirmed that the pinned Sol
adapter forwards instructions and low reasoning, but does not forward the requested
32,000-token output limit. Sol's empty edits cannot be attributed to that limit.
Nemotron receipts explicitly show length stops at 32,000 output tokens, including
reasoning; one calibration repair spent all 32,000 on reasoning. Harness call and
trial deadlines still applied. The [protocol](PROTOCOL.md) records this distinction,
grader exclusions and the unchanged experimental limits.

## Next implementation direction

1. Return bounded edits with mechanically checked preconditions. Use deterministic
   moves and extraction where unchanged text can be preserved exactly.
2. Classify an operation by source size, output size and required judgment, as well
   as semantic complexity. A simple change to a large file is not a small output.
3. Give editors instructions compatible with their tools. Route operations requiring
   exploration or test execution to a tool-capable owner or editor.
4. Include execution failures, blocked operations and required artifacts in review
   input. Successful behavior checks alone cannot establish complete delivery.
5. Evaluate the revised interface on fresh cases against the actual managed
   owner/editor process. Treat any rerun of these exposed cases as development data.

These corrections are proposals, not implemented improvements or measured savings.
The [integration notes](INTEGRATION.md) retain the existing managed editor boundary
as the proposed seam and now require this handoff correction before rollout.
