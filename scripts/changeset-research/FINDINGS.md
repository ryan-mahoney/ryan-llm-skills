# Changeset experiment findings

These are the original PoC findings. The subsequent [matched end-to-end study](../changeset-study/FINDINGS.md)
adds a conventional coding-agent baseline and a broader frozen evaluation.

Prepared plans can execute without an editor conversation. A staged workspace gives
later edits current content, deterministic operations avoid inference, and independent
model operations can run together. Behavior checks and an impact reviewer decide
whether the resulting batch can be published. One explicit strong repair is available
at that boundary; the default editor itself never retries.

The initial three-model training campaigns exposed malformed JSON, incomplete ownership,
contract loss, numerical edge cases and output truncation. The runtime now normalizes
mechanical ownership, preserves original task context, rejects invalid outputs and
retains failed batches. Successful earlier edits survive a repair in memory.

## Integrated validation

The selected configuration passed 14/14 cells across seven synthetic workloads,
each repeated twice. Thirteen passed on the first batch; one used the single allowed
Sol repair. Two held-out workloads passed all four repetitions. The complete pipeline
included planning, application, deterministic behavioral checks and model impact review.

The impact reviewer found an arithmetic error beyond the fixed assertions:
retryDelay(1024, {baseMs: 2**-1022, capMs: 10000}) returned 10000 instead of 4.
A separate replay of retained drafts confirmed that error before repair and 4 afterward.
This is a post-hoc confirmation of the review finding, not an additional held-out test.

Fifty-four focused local checks passed, including transaction rollback, stale inputs,
mode preservation, dependency ordering, owned output, budget limits, frozen campaigns,
and strong batch repair. These checks do not represent CI or a repository-wide suite.
One later filename-mode correction was checked locally; the live workload files do
not exercise that edge and their original run hashes remain unchanged.

## Executor comparison

All rows use the same frozen cross-file plan and initial source, with two repetitions
and alternating order. Source planning and final impact review are excluded from these
application times. External behavioral assertions are included. The dependency chain
limits concurrent work, so these rows primarily compare editors and routing.

| Application strategy | Passed | Seconds, both runs | Mean equivalent USD |
|---|---:|---:|---:|
| DeepSeek low, 16k + Mercury | 2/2 | 44.06, 29.86 | 0.008738 |
| DeepSeek low, 32k + Mercury | 2/2 | 42.23, 48.88 | 0.013937 |
| DeepSeek reasoning off + Mercury | 2/2 | 3.30, 6.33 | 0.000654 |
| Sol involved edits + Mercury | 2/2 | 9.81, 11.74 | 0.000735 |
| Serial DeepSeek low, 16k + Mercury | 1/2 | 20.22, 54.11 | 0.011698 |
| Serial Sol for every operation | 2/2 | 20.22, 20.70 | 0.001659 |

Equivalent USD prices Sol tokens at DeepSeek's observed rates, following the operator's
subscription economics. Original catalog costs remain in [results.json](results.json).
These are estimates, not invoices. The failed serial run remains in its time and cost
figures. Two repetitions do not establish model success rates or statistical significance.

Raising the allowance to 32k did not improve latency in this sample. Disabling DeepSeek
reasoning passed both runs substantially faster. Sol was also economical under equal
rates. The selected configuration uses Sol planning/review, deterministic mechanical
edits, Mercury simple edits, DeepSeek with reasoning off for involved edits, and Sol
for an explicitly bounded repair batch when needed.

## Independent edits: scheduling comparison

A separate frozen plan assigned four independent formatting modules to Mercury,
plus one deterministic configuration edit. Parallel and serial strategies used the
same model, plan, initial files and graders. Order alternated over three repetitions;
no other inference workloads ran concurrently.

| Repetition | Parallel | Serial |
|---|---:|---:|
| 1 | 8.58s, passed | 13.29s, passed |
| 2 | 2.11s, passed | 9.09s, passed |
| 3 | 2.62s, passed | 7.60s, failed |

Parallel used four editor calls, just as serial did. Its advantage here was overlap,
not fewer calls or cheaper models. Both successful matched pairs favored parallel;
the failed serial run remains recorded and cannot establish time to a correct answer.
This supports fan-out for this prepared workload, not an end-to-end agent speedup.

## What remains unproved

There is no conventional coding-agent baseline in this experiment. We therefore have
not established lower end-to-end time or cost than the typical read/edit/check approach.
A matched baseline must start from the same task and repository, permit ordinary tools
and batching, apply the same acceptance criteria, and count discovery, planning, edits,
checks, failures, repairs and final review. Repeated real repository tasks are needed
before claiming a general improvement. Do not force the baseline into an artificial
per-file loop when it would naturally batch changes.

## Limits

These are small synthetic workloads with settled contracts and supplied context. The
experiment does not measure repository discovery, ambiguous specifications, large
refactors, or a conventional interactive coding agent. Application speedups cannot be
presented as end-to-end agent speedups. Passing assertions and model review are evidence
for these cases, not a general correctness guarantee. Source audits also found and
corrected transaction and evidence-fidelity defects; focused regressions protect those
observed failures.

The workspace requires an exclusive disk writer, supports small UTF-8 trees, and rolls
back caught synchronous failures. Multi-file publication is not crash-atomic. Graders
are trusted local scripts; temporary repositories are not OS sandboxes. Runtime and
workload bytes are copied into every gym campaign and results retain their hashes.
