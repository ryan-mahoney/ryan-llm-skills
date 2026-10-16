# End-to-end changeset study

This harness compares the changeset runtime with a native Pi coding-agent loop on
the same tasks and models. Read [PROTOCOL.md](PROTOCOL.md) before interpreting results.
The earlier [executor findings](../changeset-research/FINDINGS.md) remain separate.
The completed [matched findings](FINDINGS.md) explain the measured result and its limits;
[results.json](results.json) retains the compact campaign evidence.

Requirements: Node 22, the configured managed Pi SDK and authorized provider models,
Linux bubblewrap, Python 3, and Git history containing the two historical fixtures.
No dependencies or network access are available to model-generated commands.

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
  --model openrouter/inception/mercury-2.5:low

node scripts/changeset-study/report.mjs "$RUN_DIRECTORY" "$REPORT_PREFIX"

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
node --test scripts/changeset-study/accounting.test.mjs scripts/changeset-study/sandbox.test.mjs
```

No broad repository test result or CI pass is implied by this study.
