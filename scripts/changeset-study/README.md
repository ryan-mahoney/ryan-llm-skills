# End-to-end changeset study

This harness compares the changeset runtime with a native Pi coding-agent loop on
the same tasks and models. Read [PROTOCOL.md](PROTOCOL.md) before interpreting results.
The earlier [executor findings](../changeset-research/FINDINGS.md) remain separate.
The completed [matched findings](FINDINGS.md) explain the measured result and its limits;
[results.json](results.json) retains the compact campaign evidence.

## Read the explanation

- [Offline HTML visual](visual.html): interactive dependency walkthrough, performance
  and acceptance charts, and the proposed integration path. Download/open the HTML
  in a browser; GitHub's source view does not render it as a page.
- [Process description](PROCESS.md): planning, scheduling, staged file state,
  verification, repair and publication limits.
- [Integration notes](INTEGRATION.md): runtime seams and an opt-in rollout into
  `spec-end-to-end`. This integration is proposed, not implemented.

The HTML includes compiled Tailwind CSS, JavaScript and Matplotlib SVG figures.
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

### Hard campaign: historical workloads with Nemotron

Nemotron 3.5 Super VL replaces Mercury in the next comparison. The selected models
are `deepseek/deepseek-flash:off`, `openai-codex/gpt-6.1-sol:low`, and
`openrouter/nvidia/nemotron-3.5-super-vl:low`. The Nemotron selector uses the
[OpenRouter model ID](https://openrouter.ai/nvidia/nemotron-3.5-super-vl/providers)
and retains the previous third model's `low` reasoning setting.

The six historical workloads from `changeset-hard-workloads` are integrated.
The original 72-cell matrix was reduced during execution at the operator's request.
The active comparison has **12 trials**: native Sol versus Sol planning/reviewing
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
```

Stop the original scheduler before executing the reduced run, and let any current
worker finish. Only one study trial runs at a time. The `execute` command can resume
after completed trials; an interrupted trial requires explicit accounting recovery.

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
