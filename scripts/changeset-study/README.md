# End-to-end changeset study

This harness compares the changeset runtime with a native Pi coding-agent loop on
the same tasks and models. Read [PROTOCOL.md](PROTOCOL.md) before interpreting results.
The earlier [executor findings](../changeset-research/FINDINGS.md) remain separate.
The completed [matched findings](FINDINGS.md) explain the measured result and its limits;
[results.json](results.json) retains the compact campaign evidence.

The newer [hard-workload findings](HARD-FINDINGS.md) cover native Sol versus Sol with
Nemotron editors on six historical tasks: complete delivery was **4/6 versus 0/6**.
See the [results table](hard-workflow-results.md), [raw summary](hard-workflow-results.json)
and [timing chart](hard-workflow-timing.svg). The HTML below remains the earlier
small-workload study; its figures are not results from the Nemotron comparison.

The subsequent [Sol-only development](SOL-ONLY-FINDINGS.md) compares bounded patches,
direct plans, source-range moves and candidate-test feedback on three of those
historical cases. See [every attempt](sol-only-results.md), the
[stage chart](sol-only-timing.svg) and the [development protocol](ITERATION-PROTOCOL.md).
The final strategy delivered all three twice, with 28.5–32.7% less elapsed time
against the previous native Sol references. These are adaptive development results;
the report retains failed attempts and known gaps in the original acceptance tests.

The [Sol owner / DeepSeek editor study](OWNER-EDITOR-FINDINGS.md) then delegated
every write, including repairs, to DeepSeek V4.1 Flash through its native provider.
Three configurations delivered 2/3, 1/3 and 0/3 tasks; none improved on the successful
Sol-only runs. See the [results](owner-editor-results.md) and
[owner/editor protocol](OWNER-EDITOR-PROTOCOL.md) for roles, settings and retained failures.

The current [three-role optimizer study](OPTIMIZER-FINDINGS.md) separates a DeepSeek
implementation owner, Sol query planner and DeepSeek writers. Deterministic grouping
halved writer calls on calibration; no treatment completed all three cases. Jev
selected the same plans as fixed policy. Through run 15, bounded source lookup
enabled completed writing for both larger cases in run 09, but downstream checks
failed. Fresh-owner run 11 exposed catalog harness limits; root-aware run 12 completed
application in two cases and full delivery in one. No configuration completed
application or delivery across all three. Matched optimized/unoptimized writer
replays in 13/14 each completed one case. Low-reasoning writers in 15 completed
two application cases but only one delivery, with substantial time/output overhead.
Run 16 is testing off-to-low application recovery; its results are pending. See the [offline results visual](optimized-results.html),
[measurements](optimized-results.md), [JSON evidence](optimized-results.json) and
[comparison protocol](OPTIMIZER-PROTOCOL.md). This research is still in progress.

Three divergent approaches are prepared separately for later experiments:

- [DeepSeek-only executable changesets](divergent/deepseek-direct/PROTOCOL.md)
  remove the Sol query and delegated-writer stages, retaining a separate DeepSeek
  boundary review, candidate checks and one batch repair. The runner pins its inputs
  and uses the existing shared ledger; it has passed offline preparation tests only.
- [Apply-writer prototype](divergent/apply-writer/README.md) accepts complete-file
  output from an injected transport and verifies unchanged source outside one
  explicitly assigned range. It has passed offline contract tests; no apply provider
  is configured or measured.

- [Provenance compiler prototype](divergent/provenance-compiler/README.md) turns
  eligible assignments into deterministic edits using hash-bound source slices and
  verbatim fenced code from the owner brief. It leaves other assignments with their
  writers. The initial prototype supports independent operations only and has passed
  offline contract checks; it is not connected to a live planner or dispatcher.

These prototypes do not alter the active three-role treatment or establish a
performance result. Their live comparisons remain queued behind the current goal.

## Read the explanation

- [Offline HTML visual](visual.html): interactive dependency walkthrough, performance
  and acceptance charts, and the proposed integration path. Download/open the HTML
  in a browser; GitHub's source view does not render it as a page.
- [Process description](PROCESS.md): planning, scheduling, staged file state,
  verification, repair and publication limits.
- [Integration notes](INTEGRATION.md): runtime seams and an opt-in rollout into
  `spec-end-to-end`. This integration is proposed, not implemented.

The earlier `visual.html` includes compiled Tailwind CSS, JavaScript and Matplotlib SVG figures.
It makes no network requests and needs no server. Its companion-document links work
when the repository files remain alongside it. The figures are also available as
standalone SVGs in [visual/](visual/).

Rebuild the visual from the committed results (Node, npm, uv; the first build needs
network access to fetch the pinned build tools):

```sh
node scripts/changeset-study/visual/build.mjs
```

Edit `visual/template.html` and `visual/styles.css`, then rebuild; do not hand-edit
the generated `visual.html`. The builder uses Tailwind 3.4.17 and Matplotlib 3.11.2
without adding project dependencies. The charts derive from `results.json`; the
prose describes this frozen campaign and must be reviewed if the dataset changes.

## Run the study

### Three-role optimizer reporting

The reporter reads retained runs without model calls. Rebuild the new offline
visual from its JSON; the template is `optimized-visual.html`:

```sh
node scripts/changeset-study/optimized-report.mjs "$OPTIMIZER_RUNS" "$REPORT_PREFIX"
node scripts/changeset-study/optimized-visual.mjs "$REPORT_PREFIX.json" "$VISUAL_OUTPUT"
```

Actual usage counts new calls. Allocated usage adds inherited owner/query work,
or only owner work for a brief reuse. Application completion and downstream
acceptance remain separate; faster incomplete runs are not ranked as winners.

### Sol owner / DeepSeek editor

Use the [owner/editor protocol](OWNER-EDITOR-PROTOCOL.md). `owner-editor` accepts
ordinary delegated instructions; `owner-editor-contracts` additionally requires
implementation, boundary and verification arrays in each packet. Both require an
explicit `--editor-model`. Generate the comparison from retained external runs:

```sh
node scripts/changeset-study/owner-editor-report.mjs "$OWNER_EDITOR_RUNS" \
  scripts/changeset-study/sol-only-results.json "$REPORT_PREFIX"
```

The reporter reads required posthoc audits, verifies candidate identity and routing,
and reports costs/tokens as unknown when a call lacks complete accounting. It does
not perform inference or change frozen trial results.

### Sol-only development

Use the completed hard workflow as `PREVIOUS_WORKFLOW_RUN`, a fresh external
directory as `NEW_ITERATION_DIRECTORY`, and the existing `CAMPAIGN_LEDGER`.
`ACORN_MODULE` points to an Acorn ESM module; the measured checked strategy froze
version 8.8.1. To repeat an existing strategy exactly, replace `--parser` with
`--freeze-from "$PROMISING_ITERATION"`.

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$NEW_ITERATION_DIRECTORY" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --strategy boundary-review --parser "$ACORN_MODULE"
node scripts/changeset-study/iteration-report.mjs "$ITERATIONS_ROOT" "$REPORT_PREFIX"
uv run --with matplotlib==3.11.2 python scripts/changeset-study/iteration-plot.py \
  "$REPORT_PREFIX.json" "$FIGURE_PREFIX"
```

The reporter reads `posthoc-audits.json` from `ITERATIONS_ROOT` when present and
binds each audit to its candidate hash. The published [audit results](sol-only-audits.json)
retain the final campaign's required path-boundary diagnostic. Reproduce a single
diagnostic after candidate freeze with:

```sh
node scripts/changeset-study/path-audit.mjs "$CANDIDATE_JSON" "$ACORN_MODULE" "$AUDIT_OUTPUT"
```

### Hard campaign: historical workloads with Nemotron

Nemotron 3.5 Super VL replaced Mercury in the expanded campaign. The selected models
are `deepseek/deepseek-flash:off`, `openai-codex/gpt-6.1-sol:low`, and
`openrouter/nvidia/nemotron-3.5-super-vl:low`. The Nemotron selector uses the
[OpenRouter model ID](https://openrouter.ai/nvidia/nemotron-3.5-super-vl/providers)
and retains the previous third model's `low` reasoning setting.

The six historical workloads from `changeset-hard-workloads` are integrated.
The original 72-cell matrix was reduced during execution at the operator's request.
The completed comparison has **12 trials**: native Sol versus Sol planning/reviewing
with Nemotron handling simple edits, once each on all six tasks. Prior observations
are retained; one eligible completed native trial is reused. The
[protocol amendment](PROTOCOL.md#current-scope-sol-with-nemotron) records the scope
change and the limits on interpretation. Frozen workers, prompts, tasks, SDK and
grading remain unchanged.

To prepare and run that workflow comparison from the original frozen hard campaign:

```sh
node scripts/changeset-study/workflow.mjs prepare \
  --source "$ORIGINAL_HARD_RUN" --output "$WORKFLOW_RUN" \
  --model openai-codex/gpt-6.1-sol:low \
  --simple-model openrouter/nvidia/nemotron-3.5-super-vl:low
node scripts/changeset-study/workflow.mjs execute \
  --run "$WORKFLOW_RUN" --ledger "$CAMPAIGN_LEDGER"
node scripts/changeset-study/workflow-report.mjs \
  "$WORKFLOW_RUN" "$REPORT_PREFIX" "$ORIGINAL_HARD_RUN"
uv run --with matplotlib==3.11.2 python scripts/changeset-study/workflow-plot.py \
  "$REPORT_PREFIX.json" "$FIGURE_PREFIX"
```

Stop the original scheduler before executing the reduced run, and let any current
worker finish. Only one study trial runs at a time. The `execute` command can resume
after completed trials; an interrupted trial requires explicit accounting recovery.
Use `workflow-report.mjs` for this comparison; `report.mjs` handles the earlier
single-model matched arms and separate mixed-only campaigns.

`model-catalog.mjs` registers the exact paid Nemotron model inside the study runtime
using public OpenRouter metadata observed on 2026-10-16; global model configuration
and credentials are unchanged. Validate its native-tool and structured-output paths
on development data before the hard campaign.

Use a new run directory, preserve the existing $50 campaign ledger, and retain the
Sol-at-DeepSeek-rates cost policy. Compare both workflows on the same expanded corpus.
The completed Mercury results, protocol, charts and
HTML visual remain historical evidence; they are not Nemotron results.

Requirements: Node 22, the configured managed Pi SDK and authorized provider models,
Linux bubblewrap, Python 3, and Git history containing the two historical fixtures.
No network access is available to model-generated commands; the only dependencies
are the hard phase's pinned packages, mounted read-only.

Use an external run directory and the existing campaign ledger. Paths below are shell
variables supplied by the operator, not repository locations:

```sh
node scripts/changeset-study/cli.mjs validate --phase dev --root "$STUDY_ROOT"
node scripts/changeset-study/cli.mjs run --phase dev --root "$STUDY_ROOT" \
  --ledger "$CAMPAIGN_LEDGER" --repeat 1 --model deepseek/deepseek-flash:off

node scripts/changeset-study/cli.mjs validate --phase eval --root "$STUDY_ROOT"
node scripts/changeset-study/cli.mjs run --phase eval --root "$STUDY_ROOT" \
  --ledger "$CAMPAIGN_LEDGER" --repeat 2 \
  --model deepseek/deepseek-flash:off \
  --model openai-codex/gpt-6.1-sol:low \
  --model openrouter/nvidia/nemotron-3.5-super-vl:low

node scripts/changeset-study/report.mjs "$RUN_DIRECTORY" "$REPORT_PREFIX"

# Hard phase (realistic spec-step workloads; see PROTOCOL.md "Hard phase").
# NODE_MODULES supplies chokidar 5.0.0 and readdirp 5.1.1, for example the
# spec-runtime install; it is copied, version-checked and mounted read-only.
node scripts/changeset-study/cli.mjs validate --phase hard --root "$STUDY_ROOT" \
  --node-modules "$NODE_MODULES"
node scripts/changeset-study/cli.mjs run --phase hard --root "$STUDY_ROOT" \
  --node-modules "$NODE_MODULES" --ledger "$CAMPAIGN_LEDGER" --repeat 2 \
  --model openai-codex/gpt-6.1-sol:low \
  --model deepseek/deepseek-flash:off \
  --model openrouter/nvidia/nemotron-3.5-super-vl:low
# Exploratory mixed routing, run separately after the primary matrix:
node scripts/changeset-study/cli.mjs run --phase hard --root "$STUDY_ROOT" \
  --node-modules "$NODE_MODULES" --ledger "$CAMPAIGN_LEDGER" --repeat 2 \
  --model openai-codex/gpt-6.1-sol:low --arm changeset-mixed \
  --simple-model openrouter/nvidia/nemotron-3.5-super-vl:low

# A separately labeled coverage audit of already frozen candidates:
node scripts/changeset-study/posthoc.mjs "$RUN_DIRECTORY" "$AUDIT_DIRECTORY"
node scripts/changeset-study/report.mjs "$RUN_DIRECTORY" "$REPORT_PREFIX" \
  "$AUDIT_DIRECTORY/results.json"
uv run --with matplotlib==3.11.2 python scripts/changeset-study/plot.py \
  "$REPORT_PREFIX.json" "$FIGURE_PREFIX"
```

The runner freezes source, prompts, task bytes and the schedule before inference.
It pins and fingerprints the SDK. Each cell has a new candidate directory; shell
commands see only that directory and read-only system binaries. The planner gets
read-only discovery tools on the historical cases. Native edit supports multiple
replacements; bash can batch any number of edits or checks. No per-file loop is imposed.

The baseline uses Pi's native Agent core, standard system prompt and coding tools.
It excludes personal extensions, context files, skills, compaction and proactive cache
warming. This is one specified conventional harness, not every coding product.

Hidden tests mount only after the candidate freezes. A completion marker prevents
an early process exit from being counted as a successful test run. Tool access is
confined to the candidate, and symlinks are refused by native file tools. This setup
is intended for curated coding experiments, not hostile-code security evaluation.

Each run retains requests, model responses, tool transcripts, reservations, receipts,
drafts, final candidates, review feedback and final grading. Unknown usage remains
unknown, and outstanding budget reservations remain charged against the cap. A worker
crash recovers whatever accounting was already persisted.

Focused harness checks:

```sh
node --test scripts/changeset-study/accounting.test.mjs scripts/changeset-study/sandbox.test.mjs scripts/changeset-study/cell.test.mjs
```

No broad repository test result or CI pass is implied by this study.
