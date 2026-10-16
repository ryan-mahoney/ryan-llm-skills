# Sol-only changeset development

Compare changeset strategies against the retained native Sol results for context
calibration, dependency handoff and lifecycle extraction. These cover a small
behavior change with a regression test, dependent edits across files, and a large
source extraction. All three references passed their external checks and completed
delivery. Their combined elapsed time was 474.96 seconds. Keep all three cases
throughout development, including any that resist optimization.

Use `openai-codex/gpt-6.1-sol:low` for every model call. Preserve initial source,
task text, visible checks, terminal checks, dependencies, SDK, time limits and one
batch repair opportunity. Keep the shared $50 campaign ledger, including previous
experiments. Each invocation freezes its code and prompts before inference and
retains requests, responses, drafts, errors, costs and terminal results. Historical
native results are references and are not charged again.

Start with bounded editor patches in place of complete file responses. Include
execution status in impact review. Then evaluate direct executable plans that
remove editor handoffs. Further strategies may follow observed failures, but must
remain generic: no task-id routing, copied gold changes, candidate reuse, or hidden
test input to a model. Terminal tests run only after the candidate freezes.

This is adaptive development on exposed tasks, not an independent confirmation
study. Publish every iteration and the reasons for subsequent changes. Existing
native timing reflects its original provider conditions; do not attribute every
timing difference to architecture.

An iteration beats the references only if it fully delivers all three tasks and
has lower summed elapsed time, lower summed equivalent cost, and a geometric mean
of paired native/changeset elapsed-time ratios above one. Full delivery requires
external acceptance, visible acceptance, reviewer acceptance and successful final
execution without an uncaught error. Also show every per-case result, calls and
tokens. Unknown costs do not establish savings. Include initialization, discovery,
planning, execution, checks, review, repair and terminal grading in elapsed time.
Failed trials receive the same 1,500-second failure-adjusted cap as the reference
protocol; rapid failures cannot establish an improvement.

After a promising strategy, repeat its frozen code on all three cases once before
calling the development result verified. Both repetitions must satisfy the above
criteria. Further fresh matched cases would be needed for a general efficiency
claim. Continue developing until that result or the existing budget guard stops
inference; never change acceptance criteria to manufacture a win.

Run storage is outside the checkout. Shell variables below denote resolved local
paths; `PREVIOUS_WORKFLOW_RUN` is the completed six-task Sol/Nemotron comparison.

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$NEW_ITERATION_DIRECTORY" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --strategy patch-editors
```

Use a new output directory for each iteration. `direct-edits` selects the second
strategy. To confirm a strategy, add `--freeze-from "$PROMISING_ITERATION"`; the
runner copies and verifies that iteration's exact frozen bytes. There is no
automatic resume of an unfinished trial: reconcile its
process and accounting before scheduling more work. The code frozen for an active
iteration is immutable even while the next strategy is being developed.
