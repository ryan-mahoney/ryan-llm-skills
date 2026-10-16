# Matched changeset study

Status: retained preregistered design for the completed Mercury/Sol/DeepSeek campaign.
The next campaign selects Nemotron 3.5 Super VL in place of Mercury and includes six historical
workloads; see the [hard-campaign setup](README.md#hard-campaign-historical-workloads-with-nemotron).
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

## Hard phase: realistic spec-step workloads

Status: preregistered with its limits before any hard-phase model call. The `dev` and
`eval` phases, their corpus and their frozen results are unchanged.
Validation before any spend: two consecutive `validate --phase hard` runs passed all 12
rows (every gold passes visible and hidden checks; every initial fails hidden checks),
corpus hash `366438a6…`, about 7.5 minutes each.

The matched study used small tasks with settled contracts (trials of 15-20 seconds).
This phase asks whether the Sol result holds on realistic spec-step work: historical
changes of 30-1,200 lines, five of them in a 19,000-27,000-line extracted subtree that
the implementer must explore. Primary comparison: each selected model owns every role in its native-agent and
changeset arms. Models are `openai-codex/gpt-6.1-sol:low`,
`deepseek/deepseek-flash:off`, and `openrouter/nvidia/nemotron-3.5-super-vl:low`.

### Corpus

Six historical tasks from the `spec-waves` run and `main` ([hard.mjs](hard.mjs)). Each
starts from the real parent revision. Gold is the real later source; hidden acceptance is
the real later test files of the touched modules, which replace same-path files in a
private copy of the frozen candidate. The task text comes from the step card, review
findings or operator direction that the original owner received
([hard-specs](hard-specs)); it never contains gold code. Where the original fix went
through review rounds, the text states the final reviewed contract.

| Task | Family | Initial → fix | Context |
|---|---|---|---|
| hard-dependency-handoff | card-driven feature delivery | 7067f79 → 2b397d7 | discovery |
| hard-admission-overlap | concurrency fix with discovery | 9050066 → 7067f79 (two commits) | discovery |
| hard-wave-recovery | recovery/state machine | 6454af1 → b3bf6e4 (two commits) | discovery |
| hard-fallback-setup | cross-module fix | 4ad5e66 → 6c62bf2 | discovery |
| hard-lifecycle-extract | mechanical refactor | 8a7b6ba → 0cc1241 | discovery |
| hard-context-calibration | small-module fix | 7de432c → 60a06c9 | prepared |

The source tree is the relative-import closure of the hidden tests at both revisions,
not the whole repository. Pinned packages (chokidar 5.0.0, readdirp 5.1.1) are copied
from an operator-supplied `node_modules` after an exact version check and mounted
read-only at `/node_modules`; their hashes bind validation to the campaign. Hidden tests
run with `PI_WARDEN_ENABLED=1`, as in the original verification environment.

Excluded tests, each excluded for every arm and for validation:

- `wave runtime: composition …` (native kernel overlay): needs nested unprivileged
  user namespaces, which the study sandbox lacks. The portable fallback variants run.
- "writes no lock fields" and "repeated starts return the same run" in the
  fallback-setup and lifecycle-extract tasks: they fail at both the initial and gold
  revisions; the admission task's commits later fixed them.
- `wave workspaces: interrupted fallback publication …`: it rewrites the gold source
  text and checks a marker path the gold implementation chose, which the task text
  cannot fairly require.
- The refactor additionally requires the module boundary: `wave-lifecycle.mjs` defines
  the moved helpers, `runtime.mjs` no longer does and is at most 1,550 lines, it
  re-exports `environmentFacts`, the module does not import `runtime.mjs`, and the
  delegate `Runtime` methods remain.

`cli.mjs validate --phase hard` must show every gold candidate passing its visible and
hidden checks and every initial source failing hidden checks before any spend. Visible
checks are focused existing tests; test files are not protected, because real steps add
tests, and hidden versions overwrite them at grading.

### Limits

| Limit | dev/eval | hard | Reason |
|---|---:|---:|---|
| Implementation deadline per cell | 300 s | 1,200 s | Original Sol-medium owners took 10-15 minutes on these steps. |
| Terminal grading deadline | inside cell | 300 s, separate | The runtime test file alone takes about 60 s in the sandbox. |
| Model calls per cell | 32 | 96 | Original owners used about 37 calls with editor delegation. |
| Output tokens per call | 16,000 | 32,000 | A changeset plan for feature delivery carries all edits. |
| Per-call deadline | 120 s | 300 s | 32,000 output tokens at observed Sol rates. |
| Command deadline | 30 s | 180 s | Focused runtime tests take 30-60 s. |

Capped time-to-success assigns 1,500 s to unsuccessful cells. The cell and grading
deadlines are separate so that a long hidden suite cannot consume implementation time;
grading still runs after an implementation timeout for diagnosis, and the cell remains
`timed-out`.

### Hard-phase harness inputs

These apply to every arm identically. Whole-tree review inputs do not fit a request for a
multi-megabyte tree, so the reviewer receives the task, unified diffs of changed files
(at most 200 KB) and the last 20,000 characters of visible-check output. Repair feedback
uses the same truncation. A changeset repair on a discovery task receives the file tree
and diffs and uses the same read-only discovery tools as initial planning. Neither arm
has compaction. Each model's configured context ceiling applies equally to its two
arms; a context overflow remains a failure of that cell. Nemotron's study definition
uses the advertised top-provider ceiling of 262,144 tokens.

### Arms

Primary: `agent` and `changeset`, each selected model in every role, two repetitions,
balanced randomized order, one cell at a time: 6 tasks × 3 models × 2 arms × 2 repeats
= 72 cells. The fresh campaign uses seed `changeset-hard-nemotron-20261016-v1`.
Nemotron gets a development-only compatibility pilot before this matrix. No hard-task
outputs guide prompt tuning or repairs. Failures and provider errors remain recorded.

Exploratory, never evidence of a pure architectural gain: `changeset-mixed`. Sol plans,
reviews, repairs and executes `involved` leaves; `openrouter/nvidia/nemotron-3.5-super-vl:low`
executes only `simple` leaves; both share one call limit and the ledger. It runs as a
separate 12-cell campaign after the primary matrix if the retained $50 ledger allows,
in a run directory and manifest labeled
exploratory, and its results are reported apart from the primary comparison.

### Limits of this phase

Six tasks from one repository and one spec run are a purposive sample. The original
owners used Sol medium with editor delegation; both Sol arms here use Sol low; the other models use the selectors above. The extracted
closure omits unrelated repository code, so discovery is narrower than in the full
checkout. Gold passing and initial failing validate these oracles against two states, not
against every alternative correct implementation.

### Integrated harness corrections before the new freeze

The implementation timer stops before separately budgeted terminal grading. A focused
regression case crosses the implementation deadline during successful grading and must
remain accepted. Native prompts describe the mounted dependencies and task-specific
protected-file list consistently. Reports use the hard phase's 1,500-second failure cap
and distinguish descriptive mixed-routing output from matched comparisons. Nemotron's
paid model definition and public price metadata are frozen with the study source.

The earlier validation observation above belongs to the originating workload branch.
The integrated checkout must produce its own current corpus/dependency validation before
starting the new primary campaign. No study run changes the production spec workflow.
