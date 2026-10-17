# DeepSeek preparation with specialized full-file writers

This separate experiment measures one DeepSeek implementation preparation per exposed
hard task, then independently applies its retained instruction/update snippets through
Morph V3 Fast and Relace Apply3. Specialized writers are an alternative to executable
changesets. No changeset operation, source range, optimizer, Sol planning/review,
model review or repair participates in this measured route.

The original run03 task specifications, sources, protected paths, dependency mounts,
check commands, hidden terminal graders and phase limits remain frozen. The shared
freezer verifies task, SDK and dependency identities and snapshots all runtime inputs.
Its retained legacy discovery overlay and planner skill are unused here. Execute the
frozen `experiment.mjs`; its manifest binds code, parser, SDK, dependencies and Node. The runner selects that verified frozen SDK/runtime
for actual model initialization, then restores the caller environment on exit.

The direct `deepseek/deepseek-flash:off` owner sees the task, visible check, protected
paths, complete source-tree names/sizes, and existing source files explicitly named
in the task (full path or backtick-quoted basename). It requests further actual source through JSON
`read` arrays; those files accumulate verbatim in later prompts. At most eight counted
requests include discovery and final preparation. When the format correction is unused, the seventh request must emit the final
preparation, reserving the eighth for a malformed-JSON correction. If the correction
was spent earlier, final emission is mandatory on the eighth request. Further source
requests are rejected at that final boundary. Unlike the initial all-source proposal, this
explicit source selection avoids flooding the owner with unrelated dependency files;
the complete candidate filesystem and task remain unchanged. Unlike the earlier native
agent experiment, this wrapper has no coding-editor preamble or command tools. These
changes prevent a controlled causal comparison against that old architecture. A single JSON parsing correction is
allowed within that same bound, using the unchanged source/task and previous malformed
response. Invalid semantic preparation, transport errors and timeouts are never retried.
The owner produces one settled array of unique target paths, per-file instructions and
code update snippets. New files are allowed; deletion is unsupported. No benchmark
solution is authored by the harness. No candidate, previous failure or hidden feedback
is supplied to any model.

Each vendor gets exactly that preparation and each target's original complete source.
Files execute sequentially with no retries; failure stops the remaining files of that
cell. Arms also run sequentially, preventing concurrent inference timing contention.
Both successful and partial candidates are frozen before downstream checks. Application
means all requested full files returned normally, passed syntax checks and were installed;
complete delivery additionally requires implementation within the original 1,200-second
allowance (including reused owner time and visible/changed-candidate checks), protected
files, hidden grading, and the candidate-bound handoff path audit. An unrecognized audit
structure is retained as structurally inapplicable and cannot certify delivery.

The advertised completion ceilings are explicitly enforced: Morph 38,000 tokens,
Relace 128,000. Both use the experiment-only `utf8-bytes-div4` input estimate plus a
1,024-unit reserve. This is an approximate eligibility heuristic, not a tokenizer or
acceptance guarantee; provider rejection remains an observed failure. The adapter's
default remains the conservative UTF-8 byte guard. There is no chunking. Length stops
and other non-normal completions fail after incurred usage is settled. The original
32,000-token cap remains the owner's cap, not a hidden apply-model cap.

All requests use the existing canonical schema-1/$50 ledger, never a reset ledger.
An additional $5 exposure guard includes both charges and unresolved holds and checks
each reservation before inference. Different calls may be conservatively ineligible
because of reservations; retain that failure. Preparation time, calls, tokens and cost
are separate from each writer stage. Actual campaign totals count preparation once;
each hypothetical complete vendor route allocates that same preparation once. Never
sum those route estimates as actual campaign spend. Shared-ledger fees are catalog
usage estimates, not exact invoices; harness development is outside this ledger.

Original phase accounting is preserved: preparation, file modification and visible/changed-
candidate checks share the 1,200-second implementation allowance, with 180-second per-
command limits. Hidden terminal grading receives its own fresh 300-second allowance.
Modification and downstream checks are measured separately, and no check feedback
returns to any model. Hidden results do
not return to models. The unchanged original task check can include known baseline
failures; report them without weakening acceptance. The path audit is posthoc, never
model input. This is one run per vendor over three exposed development tasks, not a
representative benchmark or basis for general winner claims. Missing preparations,
local eligibility failures, truncations, model failures and failed deliveries remain
in the six-cell denominator.

Focused offline checks:

```sh
node --test scripts/changeset-study/divergent/specialized-writer/experiment.test.mjs
node --test scripts/changeset-study/divergent/specialized-writer/writer.test.mjs
```

The first paid freeze completed all three owner preparations, then stopped before any
vendor call because the harness passed a fractional remaining duration to Node's
integer-only timeout API. That infrastructure attempt is retained. The corrected
freeze can use `prepare --reuse-preparation PRIOR_RUN` to copy and pin those exact
three owner outcomes, their complete preparation files/receipts, original source
manifest/revision and canonical reservation IDs. Tasks, owner selector, ledger,
routing and accounting must match. Source reservation IDs must contain only those
owner requests. No owner is rerun, including a failed preparation. Reused charges
remain part of each estimated complete route and the combined actual experiment
once; `new_entries` separately counts only newly incurred vendor calls.

A posthoc vendor-format check found a limitation of this frozen treatment: the owner
prompt requests code anchors but does not require unchanged-section preservation
markers, and every retained handoff update has zero such markers. [Morph's official
edit-format guidance](https://www.morphllm.com/fast-apply-model#the-edit-format) assigns
deletion meaning to missing preservation markers. [Relace’s agent](https://docs.relace.ai/docs/instant-apply/agent) and
[workflow](https://docs.relace.ai/docs/instant-apply/workflow) instructions likewise
prescribe precisely placed unchanged-section comments, which are absent. Thus the
observed missing helper and duplicate function cannot be treated as controlled
model-only failures. A new file has no unchanged sections to preserve. Runtime inputs and all measured
outcomes remain unchanged; no corrected-format trial was run.
