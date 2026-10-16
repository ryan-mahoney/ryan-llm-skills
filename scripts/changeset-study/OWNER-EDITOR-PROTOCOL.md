# Sol owner and DeepSeek editor

Evaluate whether a Sol owner can delegate changeset implementation to DeepSeek
while retaining the delivery and efficiency of the successful Sol-only strategy.
The owner discovers source, settles behavior and interfaces, assigns file ownership
and dependencies, reviews the integrated candidate, and plans at most one repair.
DeepSeek writes every initial and repair operation. Independent operations may run
concurrently; overlapping files serialize against updated staged content.

## Frozen setup

- Owner: `openai-codex/gpt-6.1-sol:low`.
- Editor: `deepseek/deepseek-flash:low`, the configured DeepSeek V4.1 Flash model
  served directly by DeepSeek. The [provider model table](https://api-docs.deepseek.com/quick_start/pricing/)
  identifies this API name. Full local model metadata is frozen with each run.
- Cases: unchanged context calibration, dependency handoff and lifecycle extraction
  from the historical native comparison. No candidate reuse or copied solutions.
- Strategy: `owner-editor`. Every operation must be `simple` or `involved`, with
  instructions instead of owner-authored executable edits. Both route to DeepSeek.
  Editors receive the original task and declared current files, without tools or
  a private repair loop. They emit exact replacements or source-range operations.
- Retain candidate-owned test selection, unchanged-helper review context, boundary
  review guidance, original visible and external checks, deadlines and shared call
  ceiling. Terminal checks run after candidate freeze and never feed model repairs.
- Require the existing posthoc dirty-path diagnostic for dependency handoff before
  counting a delivered run as qualified. Fixture incompatibility is investigated,
  not silently treated as a candidate pass or failure.

This differs from the older mixed routing trial: both simple and involved edits,
including repairs, go to the editor. The owner cannot silently implement the task
with deterministic operations. Engine primitives still apply the editor's output
deterministically; source-range moves avoid regenerating unchanged method bodies.

## Comparison and stopping

Start with all three cases once. Retain every attempt. If they fully deliver,
repeat the exact frozen strategy once to assess reliability. If an attempt fails,
inspect the failure and consider a bounded generic revision without changing the
task or relaxing acceptance. Stop after a reliable comparison, an actionable
negative result, or the existing cumulative $50 campaign guard. A negative result
is a valid outcome; spending the full allowance is not a requirement.

Compare with both native Sol (474.96 seconds, 28 calls, 514,714 tokens) and the
two successful Sol-only changeset runs (319.74/339.55 seconds, 16/17 calls,
328,670/340,136 tokens). Report delivery before efficiency. A performance win
requires all three audited deliveries, lower summed time and equivalent cost,
and a geometric mean paired speed ratio above one against the named comparator.
Call counts and tokens include both roles, planning, reviews and repairs. Include
owner/editor breakdowns so offloading is measurable. Full timing includes grading.

Use the existing Sol-at-DeepSeek comparison tariff; DeepSeek uses the installed
catalog tariff, currently equal to the provider's peak rates. These estimates are
not invoices. The cumulative guard conservatively retains prior unknown charges
and subscription catalog estimates. Starting exposure is $16.093791662, with four
older unknown reservations and no active reservations. Development work outside
trial model calls is excluded from trial totals.

These are exposed development cases and historical controls under potentially
different provider conditions. A positive result would support this workflow on
these cases, not establish general model rankings or production integration.
An all-Sol owner/editor control would be needed to isolate model substitution from
the added handoff architecture.

## Run

Variables below identify locally resolved runtime locations outside the checkout.
The existing adjacent spec package owns run storage and the shared budget ledger.

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$NEW_ITERATION_DIRECTORY" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:low --strategy owner-editor \
  --parser "$ACORN_MODULE"
```

For a repeat, add `--freeze-from "$FIRST_ITERATION"`. It copies the original
frozen code and parser, and verifies selectors and model metadata. Do not modify
frozen runs or recycle an output directory.
