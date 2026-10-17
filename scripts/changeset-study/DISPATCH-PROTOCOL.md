# Small editor assignments with one planning phase

Sol reads the task and relevant source, settles interfaces, and dispatches one
dependency graph. DeepSeek implements its small assignments. Sol does not review
the edits, approve the result, or plan repairs after dispatch. Runtime scheduling,
staged current file state and executable checks are deterministic.

This tests a different explanation for the earlier failures: assignments combined
too many instructions and too much context. It does not assume DeepSeek cannot
follow instructions. The intervention combines smaller assignments, selected
context, local editor recovery and removal of owner review/repair; it does not
isolate their individual effects.

## Frozen treatment

- Strategy: `focused-dispatch`.
- Planner: `openai-codex/gpt-6.1-sol:low`.
- Editor: `deepseek/deepseek-flash:off` from the native DeepSeek provider,
  labeled DeepSeek V4.1 Flash in the retained catalog.
- Every write goes to the editor. Each assignment owns one writable file and one
  outcome. Objective, instruction and 1–5 requirements total at most 4,000
  characters; the instruction alone is at most 2,400. The planner chooses source
  excerpts from current declared files, capped at 16 excerpts and 32,000 source
  characters. These are experimental bounds, not proven optimal thresholds.
- Editors receive the scoped assignment and excerpts, not the full task. The
  planner owns coverage of the original specification and preservation constraints.
  Source-range operations can move unchanged bytes without regenerating them.
- Up to four independent assignments execute concurrently. File read/write
  conflicts serialize; later assignments see updated staged source. One writable
  file does not imply one assignment per file. Editors have no discovery tools.
- An editor can make one local recovery attempt after invalid output, failed
  application or syntax rejection. The rejected attempt changes no files. The
  retry receives the same assignment, failure and a bounded response excerpt.
  Budget/deadline exhaustion is not retried. No behavioral test feeds this loop.
- After file modification ends, the runtime runs the original visible checks and
  candidate-added tests. External grading runs after candidate freeze, outside
  model access. There is no model impact review and no batch repair.

## Workloads, measurement and stop

Use the same three exposed tasks: context calibration, dependency handoff and
lifecycle extraction. Retain the historical Sol-only and larger DeepSeek assignment
results. Do not reuse candidates or supply previous defects/terminal tests to models.
Freeze source, task bytes, dependencies, selectors, SDK and prompts before inference.
Keep original call/output/time limits and the shared cumulative $50 guard. Starting
guard exposure is $28.705461308, including $13.788583 of unresolved reservations;
these conservative holds are not invoices or zero-cost calls.

Run the three cases once. If all three satisfy the executable checks and required
posthoc audit, repeat the identical frozen treatment once. Otherwise retain the
failure analysis. Stop at this bounded comparison or the guard; spending the full
allowance is unnecessary. Record all local retry calls, failed attempts, editor
concurrency, request sizes, total elapsed time, token usage and equivalent cost.
Keep the existing Sol-at-DeepSeek comparison tariff and unknown-usage rules.

Measured delivery requires complete execution, visible/candidate checks, external
acceptance, no cell error and the required dirty-path diagnostic on handoff.
`review_accepted` is null, not a synthetic owner approval. Report no-owner-review
routing explicitly. The prior controls included owner review and batch repair;
timing comparisons describe different workflows, not an isolated model substitution.
Passing these exposed checks does not establish complete specification conformance,
especially given the retained acceptance gaps from previous studies.

## Reproduce

Runtime paths are resolved outside the checkout, under the adjacent experiment
package. Use the existing campaign ledger, never a fresh allowance.

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$NEW_DISPATCH_RUN" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:off --strategy focused-dispatch \
  --parser "$ACORN_MODULE"
```

An exact repeat uses `--freeze-from "$FIRST_DISPATCH_RUN"` instead of `--parser`.
The existing owner/editor reporter can summarize this strategy and validates that
no owner call occurs after editor dispatch. Audits retain candidate hashes. The
research backend does not change managed `spec-end-to-end` behavior.

## Pre-dispatch validation revision

The first frozen run passed no complete case. Handoff stopped on a nonexistent
source-excerpt endpoint; extraction stopped at the context-size cap before any
editor call. Calibration's implementation passed external checks, but its added
tests called a callback with the wrong arguments. Preserve all three results.

Before the next run, add a generic planning validation pass. Validate plan shape,
dependencies, initial-source excerpt anchors and size before launching any editor.
Return errors to Sol for at most one correction of its own plan. Source changed by
preceding operations is still checked against actual staged state during execution.
The planner is also told to check exact callback and fixture invocation signatures.
No candidate solution, task-specific fix or external test is provided to models.

This is planning, not review of editor work: every Sol call must precede the first
DeepSeek call. No owner call may inspect an editor result. Preserve scoped editor
instructions, one local application recovery, separate executable checks and no
batch repair. Run the three cases once more; repeat that freeze only if all pass.
Retain both attempts and stop after this bounded revision or the budget guard.
