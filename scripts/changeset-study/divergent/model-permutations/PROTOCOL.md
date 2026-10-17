# Four model permutations on the original three tasks

This is a separate development campaign. Each arm gets the unchanged run 03 task,
source, dependencies, protected files, visible checks and terminal oracle. There
is one trial per arm per task, with no added cases or repeats. No failed candidate
or behavioral feedback from an earlier campaign supplies model instructions.

| Arm | Implementation design and plan | Writes |
| --- | --- | --- |
| `muse-self` | OpenRouter Muse Spark 1.3 Contributor, high | Muse emits executable deterministic edits itself; no separate writer |
| `muse-deepseek` | Same Muse high, fresh delegated plan | Native DeepSeek Flash, off |
| `sol-muse` | OpenAI Codex Sol 6.1, low | OpenRouter Muse high |
| `sol-mimo` | Exact same retained Sol plan as `sol-muse` | PrimaLabs MiMo-V2.6-Pro, requested medium |

Selectors are fixed in `policy.mjs`. Muse is
`openrouter/meta/muse-spark-1.3-contributor:high`; it is not the ordinary-priced
Spark 1.3 model. PrimaLabs is
`primalabs/primalabs-ai/MiMo-V2.6-Pro:medium`, not OpenRouter's Xiaomi model.
The user authorized its configured mapping: the SDK sends
`chat_template_kwargs: {thinking:true}`. It does **not** send a distinct medium
effort value. This limitation remains part of every interpretation of that arm.
Muse sends `reasoning:{effort:'high'}`. Synthetic transport tests verify both
actual pinned SDK payloads, including requested `max_tokens:32000`.

## Planning and writing boundaries

All three fresh planning modes use direct plan-only JSON completion, never a
native coding-agent system prompt. They get the original complete task, visible
check, protected paths, file tree and a deterministic catalog of frozen source.
One optional source-request batch resolves up to eight path/symbol/literal/tail
or small-whole-file reads with at most 64,000 source characters. There is no shell,
write tool, temporary-file workflow or original-task-hidden-from-planner trick.
The same source and lookup API apply to Muse self, Muse delegated and Sol delegated
planning. Catalog bound is 64 KiB and the complete serialized Client context bound
is 160 KiB for every planning request, including followups/corrections. Oversized
requests fail rather than truncate. Initial actual-task contexts were measured
offline at 11,652/73,956/32,757 bytes for executable plans and
15,691/77,995/36,796 bytes for delegated plans.

The planner owns implementation decisions and completeness. Planning allows at
most three requests: initial, optional single source lookup followup and one shared
format-or-plan-validation correction. No hidden feedback is available. Muse self
must return executable deterministic operations. Delegated plans must use the
existing focused single-file assignment/context contract and declare dependencies;
all writes go to the selected writer. There is no extra DeepSeek owner.

The two Sol arms consume identical retained `plan.json` bytes per task. Actual Sol
preparation is paid once and retained in `preparation/sol-delegated/`; the full
preparation elapsed time, calls, token categories and receipt cost are allocated
to each route for end-to-end comparison. Do not sum those allocations as actual
campaign spending. Muse self and Muse delegated use fresh plans because their
output representations differ; that distinction is predeclared.

Execution reuses the existing deterministic engine, source-range transforms,
focused packet builder/compaction, concurrency 4 and local writer retry. The
existing same-selector writer policy permits at most two local attempts and has
legacy eligibility for some nonterminal model/transport errors as well as local
format/application/syntax failures. No reasoning escalation or new repair loop is
added. There are no model calls after writing, no outer model review and no second
batch repair. Candidate visible/changed tests and a separate terminal oracle judge
outcomes. Handoff also requires the candidate-hash-bound existing path audit.
Application, visible checks, terminal acceptance and audited delivery stay separate.
`writing_elapsed_ms` measures engine execution through candidate materialization and
retention; `checks_elapsed_ms` and `hidden_elapsed_ms` retain executable-check and
terminal-grade time separately. Total worker/process elapsed remains available.

## Limits, accounting and freeze

Each original task has a 20-minute implementation allowance, 96 calls, 32,000 requested
output tokens per call, 5-minute per-call timeout, 3-minute command cap and separate
5-minute terminal grading allowance. Preparation process elapsed and calls are
subtracted before execution; sharing a plan does not grant either route more time
or calls. The writer preserves the 32k delivered source-context cap and current
preflight. The Sol subscription adapter's unenforced output limit remains a known
provider difference; its conservative global budget reservation is unchanged.

Use the existing canonical shared schema 1 / $50 donor ledger. Never create/reset it
or hash mutable settlements. The campaign stops issuing new requests after its
own retained charged/unknown exposure reaches $15; concurrent campaigns' entries do
not consume that incremental allotment, but all share the global $50 guard. The
incremental stop does not silently serialize writer operations or relax the global
reservation guard to make a request fit. Unknown costs retain their reservations.

Preparation snapshots exact source/task identities, full SDK `node_modules`,
dependency mounts, Node hash, parser and study/engine/skill code. Selected model
metadata is frozen from the source03 pins plus the dated public model metadata.
Worker runtime paths are pinned internally to the snapshot, and model metadata
uses an in-memory registry without global configuration writes. Credentials use
existing provider authentication. PrimaLabs forwards an existing configuration
credential selector only when present; otherwise normal SDK credential resolution
uses the existing provider store. Credential material is never retained in artifacts.

```sh
node scripts/changeset-study/divergent/model-permutations/runner.mjs prepare \
  --source "$RUN03" --output "$NEW_RUN" --ledger "$SHARED_LEDGER" \
  --parser "$ACORN_MODULE" --sdk "$PINNED_SDK_ROOT"
node "$NEW_RUN/frozen/scripts/changeset-study/divergent/model-permutations/runner.mjs" \
  run --output "$NEW_RUN"
```

Code must be reviewed/committed before the paid freeze. Root coordinates live
execution after the specialized-model campaign finishes; the existing user goal,
models and budget authorize this research without another user approval. The
exclusive `started.json` permits one execution only. Retain all planning responses,
lookups, plans, jobs, writer attempts, candidates, checks, grading, path audits and
usage/receipt accounting, including failures. No live inference has run at the time
this protocol was written. Focused offline checks establish mechanics only.

Public metadata sources are in `metadata.json`. Muse prices are $0.10 input/$0.20
output/$0.002 cache read per million tokens, context 1,048,576 and advertised output
943,718 (requested output remains 32k). PrimaLabs' official 2026-10-05 rate card lists
$0.435/$0.87/$0.0036 per million, context 1,048,576; its 65,536 output ceiling comes
from local configured metadata, not a public graded-effort guarantee. SDK-derived
receipt costs are not independently verified invoices. Do not infer speed or
quality from provider marketing claims. Historical native/main-route comparisons
are descriptive unless their task, boundaries and success criteria actually match.

## Separately frozen MiMo credential resume

The first frozen twelve-row campaign required an explicit PrimaLabs `config.apiKey`
field and therefore blocked that writer before inference when the key instead lived
in the SDK credential store. Preserve those original zero-call harness outcomes.
The reviewed fix makes that configuration field optional and leaves model metadata,
reasoning mapping, task/source, writer prompts, limits and local retry policy unchanged.
A boolean-only local SDK check confirmed the exact model and credential availability;
it made no provider request and exposed no credential value.

After the original campaign terminates, `prepare-resume` creates a separate freeze:

```sh
node scripts/changeset-study/divergent/model-permutations/runner.mjs prepare-resume \
  --resume-from "$ORIGINAL_RUN" --source "$RUN03" --output "$RESUME_RUN" \
  --ledger "$SHARED_LEDGER" --parser "$ACORN_MODULE" --sdk "$PINNED_SDK_ROOT"
node "$RESUME_RUN/frozen/scripts/changeset-study/divergent/model-permutations/runner.mjs" \
  run --output "$RESUME_RUN"
```

The original manifest/results and exact copied Sol preparation artifacts are pinned
and rechecked before every cell. Only `sol-mimo` executes. Its original attempts must
have been zero-call credential blocks; no successful vendor call is repeated. A
missing/failed original Sol plan remains untested and cannot trigger new planning.
All original Sol preparation artifacts, including failed preparation costs, remain
inherited and fully allocated to the route. They are excluded from the resume's
actual request directories and incremental spending. The shared ledger's old charges
are never reset, copied into new reservations or counted twice as actual spending.
Writing and grading begin from original source, not any prior writer's candidate.
