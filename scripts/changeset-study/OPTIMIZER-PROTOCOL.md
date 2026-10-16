# Three-role writer optimization comparison

DeepSeek owns implementation decisions, Sol compiles a settled brief into a query
plan, and DeepSeek applies bounded assignments. Sol never reviews writer output.
Testing and behavioral review belong to the outer workflow. This experiment
measures writing completion and performance separately from downstream quality.

## Frozen roles and controls

Use `owner-query-writer`, Sol `openai-codex/gpt-6.1-sol:low`, and native DeepSeek
`deepseek/deepseek-flash:off` for both implementation ownership and writing.
Keep the original three exposed tasks, source snapshots, SDK, dependency mounts,
output and time limits, protected files, and separate terminal grading. No previous
candidate, test failure, or terminal grading feedback is given to a model.

The DeepSeek owner gets the step and read-only source tools. Its settled brief
contains behavior, interfaces, preservation obligations and required test edits.
Sol gets that brief, a file tree and read-only tools, without the original step.
It may correct its own invalid source bindings once before dispatch. A missing
implementation decision is reported as an input gap rather than invented by Sol.
Writers get one file, at most 4,000 assignment characters, selected current source
at most 32,000 characters, and one local application/syntax retry. No behavioral
check feeds that retry. At most four independent assignments run concurrently.

## Treatments

1. `none`: run the bounded query plan unchanged except deterministic conflict
   ordering and duplicate context removal.
2. `deterministic`: contract adjacent compatible assignments to the same file,
   retaining every instruction, obligation and dependency. At most three original
   assignments may combine, and the original packet size limits still apply.
   Refuse contraction when an intermediate state is observed, preconditions need
   independent enforcement, or initial combined source excerpts cannot resolve.
3. `contextual`: the same local optimizer, with one batched Jev request choosing
   whether eligible pairs should stay separate and whether uniquely owned small
   files benefit from full context. Whole-file expansion is capped at 8,000
   characters per file and 16,000 total. Files eligible for contraction do not get
   individual context questions. Jev never decides dependency safety or removes
   requirements. Advice below 0.7 confidence falls back to fixed policy; this is
   an uncalibrated routing heuristic. Errors retain fallback and cost uncertainty.

The optimizer never discards a prose instruction as redundant. Source-range edits
already move unchanged bytes without generation. Eliminating intermediate writes
or bypassing writers requires stronger executable semantics than this IR supplies;
those are future extensions, not claimed measured optimizations.

## Paired measurement

Run `none` first to obtain the owner briefs and raw query plans. Retain each plan
and brief hash. Run deterministic and contextual writing from those exact inputs
in fresh source snapshots, using the same frozen code. These replays make no owner
or query calls. Report actual incremental spending separately from allocated
pipeline costs: add the donor's owner/query time, calls and usage when estimating
the complete three-role workflow. Do not add its writing or test time. All actual
calls, including Jev, count toward the money tracker.

Report per-case and total owner/query/routing/optimizer/writer/check elapsed time,
assignment count, dependency depth, observed concurrency, retries, calls,
input/output/cache tokens, normalized cost and accounting uncertainty. Keep Sol's
comparison tariff equal to DeepSeek's. Jev uses its separately recorded estimated
input-only tariff. Conservative reservations are not cash invoices.

Primary writing outcome is completion of every planned operation without an
application error. Visible tests, candidate-added tests and terminal acceptance
are separate downstream outcomes. A fast incomplete batch is not a writing win.
A completed batch with failing tests is not complete feature delivery. Report
both dimensions when selecting a configuration. Historical native Sol and reviewed
Sol-only runs are contextual controls, not matched comparisons to these roles.

Run the three treatments, then repeat a promising frozen treatment on the same
plans to assess variability. If the first plans cannot apply, retain the failures
and make at most two generic backend/prompt revisions with new freezes before
reassessing. Do not tune prompts to hidden assertions. Stop before the active $50
allowance is exhausted. The user reset that allowance on 2026-10-16; the previous
ledger remains archived with $29.2873046 exposure. Do not silently reset it again.

Select the best observed configuration with explicit quality and sample limits.
This is development on exposed cases, not proof of a global optimum or a production
end-to-end speedup. Production integration reuses the existing step owner's
reasoning and editor batch lifecycle; this runner measures owner reasoning explicitly.

## Reproduce

Resolve runtime paths under the adjacent experiment package. `CAMPAIGN_LEDGER` is
its active tracker. A plan replay retains the same frozen code:

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$BASE_RUN" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:off --strategy owner-query-writer \
  --optimization none --parser "$ACORN_MODULE"

node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$OPTIMIZED_RUN" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:off --strategy owner-query-writer \
  --optimization deterministic --freeze-from "$BASE_RUN" --plans-from "$BASE_RUN"
```

For contextual routing substitute `--optimization contextual`. The installed
Typesafe module can be selected with `JEV_TYPESAFE_MODULE`; credentials are resolved
by its library and are never copied into run artifacts.
