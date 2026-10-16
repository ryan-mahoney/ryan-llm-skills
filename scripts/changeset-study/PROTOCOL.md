# Matched changeset study

Status: retained preregistered design for the completed Mercury/Sol/DeepSeek campaign.
The next campaign selects Nemotron 3.5 Super VL in place of Mercury and awaits more
complex cases; see the [next-campaign setup](README.md#next-campaign-awaiting-more-complex-cases).
Its corpus and execution limits must be settled and frozen before execution.
The original treatment definitions below remain the record of the completed study.

The question is whether compiling a task into a changeset reduces time and resources
to an accepted implementation compared with an ordinary tool-using coding agent.
The earlier executor-only experiments cannot answer this question.

## Treatments and fairness

The conventional arm uses the installed Pi agent loop, its standard coding prompt,
and native read, bash, edit and write tools. It may batch edits, run scripts, inspect
files and iterate freely. No per-file loop is imposed. Ambient personal instructions,
skills and extensions are excluded from both arms.

The changeset arm uses the existing planner schema, transactional in-memory workspace,
deterministic transforms and up to four concurrent one-shot editors. There are no
per-editor repair conversations. A batch-level repair is allowed.

Primary comparisons use the SAME provider/model/reasoning selector for every role in
both arms: deepseek/deepseek-flash:off, openai-codex/gpt-6.1-sol:low, and
openrouter/inception/mercury-2.5:low. Mixed-model routing is a separate exploratory
experiment, never evidence of a pure architectural gain.

Each pair receives identical task text, initial source and visible tests. Prepared
workloads give both arms the source snapshot. Discovery workloads give both the file
tree and task; the changeset planner gets read-only tools for discovery. Hidden
acceptance code is inaccessible to tools and is run only after the final candidate
is frozen. Hidden results never enter repair feedback. Both arms get a fresh impact
reviewer, visible-check feedback and at most one common repair opportunity, followed
by a final review. The conventional arm may additionally iterate within its normal
tool conversation. Protected visible tests must remain byte-identical.

Each cell has 300 seconds, 32 model calls, 16,000 output tokens per call and a
120-second call deadline. Limits include planning, editors, review and repair.
Commands run in an isolated filesystem/network namespace with a 30-second deadline.
All cells share the existing $50 reservation ledger. No hidden unmetered retries.
Sol cost comparisons use the operator-selected DeepSeek equivalent rates; original
catalog estimates and token counts are retained. Neither estimate is an invoice.

## Corpus and iteration

The prior seven workloads are development data. New development workloads may be
used to improve either arm or diagnose harness defects. Evaluate gold implementations
and reject the initial incorrect implementation before spending on each new task.

Freeze source, prompts, protocol and corpus before each evaluation campaign. Use
at least eight workload families covering mechanical migration, independent edits,
dependent edits, shared-file edits, algorithms, compatibility fixes and repository
discovery. Include actual historical repository fixes with their source revisions.
Record whether each task is synthetic or historical. Small extracted modules are
not equivalent to full production repository work.

Use two repetitions per task and model, with balanced randomized arm order from a
recorded seed. Run one cell at a time; concurrency occurs only inside a treatment.
Keep every outcome, transcript, receipt, source hash and time measurement. A pilot
or failed experiment cannot disappear from the record. Any harness correction
invalidates affected comparisons; retain and label them, then rerun both arms.

After evaluation feedback is inspected, those tasks become development data. Further
candidate tuning needs a new untouched evaluation set for confirmatory claims.
Stop at the budget cap or after a frozen matched campaign answers the scoped question,
including a negative or inconclusive answer. Do not keep searching for favorable tasks.

## Outcomes

Primary outcomes: terminal hidden-test acceptance and total wall time from cell
initialization through final grading. Record first-draft visible acceptance separately.
Reviewer approval and protocol failures are reported separately; a reviewer cannot
overrule the external acceptance score. Review inputs are identical across arms.
Secondary outcomes: stage time, input/output/cache tokens, model calls, native tool
calls by name, batch repair rate, deterministic operations, peak editor concurrency,
catalog and equivalent cost. Tool calls are not filesystem syscalls: bash can batch.

Report failure and timeout counts alongside timing. Successful matched pairs support
conditional speed ratios only. Also report capped time-to-success, assigning the full
300-second budget to unsuccessful cells, and cost spent per accepted outcome. Never
represent a quick failure as a quick solution. Distinguish provider/infrastructure
errors from behavior failures without silently removing either.

Aggregate repetitions within a task before estimating uncertainty. Use a seeded task
cluster bootstrap for 95% intervals; report task count and all per-task results. The
corpus is purposive, not a random sample of software engineering. Small intervals do
not justify universal claims. A positive result requires maintained acceptance and a
time advantage on this frozen corpus; contrary cases remain part of the conclusion.

No claim of general proof follows from one corpus, a model review or passing tests.
