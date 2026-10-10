# Observing Pi spec runs

The managed runtime records each assignment in the canonical feature package:

| Path below the package | Purpose |
|---|---|
| `runtime/run.json` | Latest assignment and actual lifecycle state |
| `runtime/runs/<id>.json` | Individual assignment record and worker session locations |
| `runtime/events.jsonl` | Append-only timestamped lifecycle events |
| `runtime/sessions/<pair-id>/` | Retained owner/editor session files |
| `runtime/runs/<id>-activity/{owner,editor}.json` | Bounded live activity snapshots for the monitor |
| `runtime/runs/<id>-editor-configuration.json` | Diagnosed model configuration failure that blocks identical editor retries |
| `runtime/progress.json` | Derived worker/handoff facts, stage decisions and artifact locations |
| `runtime/stages/<stage>.json` | Coordinator decisions recorded by `spec_checkpoint` |

Runtime facts track execution; `spec_complete` records the owner's handoff and
`spec_checkpoint` records coordinator stage judgments. Canonical review/fix artifacts
still own independent findings. Process completion alone does not establish acceptance
or ready publication. Checkpoint aliases share completion guards; `publication-draft`
records draft progress without claiming ready publication. After human input, older
stage decisions are marked for reconciliation without automatically releasing holds.

## Live Pi monitor

The runtime monitor shows the current step's elapsed time and separate owner/editor
activity. The owner line summarizes its visible assignment or response; the editor
line identifies its current tool and file. Waiting for the editor or an owner answer
is distinct from working. The idle duration means time since the last observed event,
not proof that a process is stuck or has stopped.

Activity comes from local runtime events. Updating durations requires no model calls
or agent status polling. Hidden reasoning, source contents and full shell commands
are not displayed. Provider errors remain visible separately from later activity so
a resumed worker is not mistaken for an uninterrupted successful run.

See the [runtime monitor instructions](../pi/extensions/spec-runtime/README.md) for
attaching and hiding the widget. Attaching a monitor does not acquire writer ownership
or authorize cancelling another session's workers. Restarting the owning coordinator
cancels its managed run; let it finish before restarting to load extension changes,
or use a separate Pi session for read-only observation.

In a fresh Pi session, attach to an existing run with:

```text
/spec-monitor /absolute/primary-repo/.specs/feature/
```

Use `/spec-monitor off` to hide it. The attachment follows that run only; normal
dispatch attaches to each new run automatically. Older live runs use bounded
incremental stream reads, with file modification time as approximate activity time.

Find recent managed runs without knowing a package path:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs runs --limit 10
node ~/.agents/scripts/spec-observe/cli.mjs report --package /absolute/repo/.specs/feature
```

The first command reads the compact index under `~/.pi/agent/spec-runtime/`.
Legacy Pi runs live under `~/.pi/agent/sessions/`. Nested worker paths are recorded in
session metadata and tool results; do not infer relationships solely from modification
times or similarly named directories. The [observer CLI](../scripts/spec-observe/README.md)
discovers sessions and reports timings, repeated calls and provider failures without
executing commands from transcripts. Use its package lookup for managed runs and its
legacy discovery for older sessions. Missing cost or timing information stays unknown.

## Workspace sentinel status

For a bounded cross-repository status view, use the `spec-sentinel` skill or run
`node ~/.agents/scripts/spec-observe/cli.mjs sentinel status [--package PATH]
[--format text|json] [--agent-dir PATH]`. In Pi, `/spec-sentinel add
/absolute/primary` writes one read-only enrollment record per root at
`<agentDir>/spec-sentinel/<workspace-key>/enrollments/<sha256(common dir)>.json`
(mode `0600`, `{ version, root, common, enrolled_at }`); nothing else writes it, and
managed index pointers never enroll a repository. Status reports identity, execution,
activity hints, coverage (`complete|partial|stale|unavailable`) and factual
conditions; missing or replaced sources stay unknown or stale.

Connected Pi sessions are the host: invalidation is coalesced at 250 ms and status
reconciles every 15 s, and closing a session stops it so the next one reports the
gap as unknown. Authority stays read-only — no continuation, cancellation, diagnosis
or recovery, no transcript or model reads, and no acceptance claim from completion or
silence.

## Guarded recovery

Observation and activation are separate. Status, enrollment and retained disk files
never arm recovery; only a direct live `/spec-sentinel enable` grant for this coordinator
session, canonical package, workflow and checkout can do so, and a fresh session always
starts disarmed. When opt-in recovery is armed, inspect retained outcomes under
`runtime/sentinel/<workflow-id>/`: `verification-incidents.json` (repeated-failure
generations), `diagnoses/<incident-id>.json` (bounded advisory attempts), and
`intents/<id>.json` plus `effect-slots/`/`diagnostic-slots/` (reserved capacity and the
exact applied/blocked/unknown state). A `blocked` or `unknown` intent retains the writer
reservation and is never replayed automatically; it requires explicit coordinator or
human reconciliation before any later attempt. Do not treat a disk PID from another
process as an owned handle, and never delete locks or transfer an owner to recover.
Sentinel cancellation and would-cancel notices are local UI-only; they add no model turn
or Sentinel custom message.

## Workflow metrics

For an aggregate report of the current coordinator session, run:

```text
/spec-metrics /absolute/primary-repo/.specs/feature/
```

The [metrics CLI](../scripts/spec-observe/README.md#workflow-metrics) works without
restarting Pi and supports earlier sessions and all recorded resumptions. It reports
elapsed observations, step attempts, model/tool calls by role, model response time,
recognized test submissions, reported cost, and Mercury/clerk usage. Parallel times
overlap; unfinished work, missing pricing and incomplete logs stay explicit.

## Curated gym runs

Replay one curated scenario against an explicitly selected model:

```bash
node scripts/spec-gym/cli.mjs run --skill spec-step-run --scenario <id> --model provider/model
```

Compare two models on the same scenario and frozen inputs:

```bash
node scripts/spec-gym/cli.mjs run --skill spec-step-run --scenario <id> --model provider/a --model provider/b
```

Interpretation limits: one curated workload per run; the report makes no general
model ranking and names no winner; `unknown` cost means the provider did not price
the calls, not zero; a harness or provider failure (`blocked`, `invalid`,
`timed-out`) is not a skill result. Live model comparison remains unproven until the
authorized pilot runs (`.specs/super1-spec-gym/evidence/pilot.md`).

## Install and resume


1. Install `pi-intercom@0.16.1` and configure managed child extensions under the
   [runtime setup](../pi/extensions/spec-runtime/README.md). Run `~/.agents/sync.sh`
   after the runtime and skills are updated.
2. Let the existing run finish or terminate its known workers through its own harness.
   Restarting the top-level UI alone does not prove that detached legacy workers stopped.
3. Restart Pi to load `spec_dispatch` and `spec_editor`. Use the
   [default prompt](../README.md#default-pi-prompt), naming an existing implementation
   checkout when resuming it. Preserve its code and accepted commits.
4. Read the runtime ledger or observer report to locate the current assignment and logs.
   A retained lock after uncertain cancellation requires diagnosis before replacement.

The extension manages its own workers. It does not adopt or stop older `pi-subagents`
processes. It launches one step assignment; `spec-run` continues to own difficulty
routing, independent reviews, fixes and later publication stages.

Owner/editor clarification uses pi-intercom's scoped extension channel. `spec_question`
pauses the editor's work and returns the question to the owner through `spec_editor`.
The owner's `spec_answer` lets that same editor continue. Writer ownership remains
held during the exchange. The runtime rejects a second editor launch while one is
waiting; unanswered questions stay failures or checkpoints, never accepted decisions.

## Controlled improvement

The useful idea from [autoresearch](https://github.com/karpathy/autoresearch) is a bounded
experiment followed by measurement and a deliberate keep/discard decision. Spec execution
needs several measures because a fast run that loses code or skips acceptance is a failure.

Observe live runs read-only. Keep a baseline and vary one intervention between comparable
runs: for example editor instructions, owner model, or an editing recovery strategy.
Record the task scope, models, runtime revision and intervention alongside:

- time to owner dispatch, first edit and accepted completion;
- reported cost, input/output/cache usage and missing pricing;
- repeated reads, status polling, edit failures, retries and provider timeouts;
- review findings, repair work and unresolved acceptance gaps.

Use matched prepared tasks and starting revisions for a stronger comparison. Ordinary
production runs supply useful observations but do not isolate a change's causal effect.
Keep acceptance obligations fixed, inspect regressions, and retain required review.
Make workflow changes between runs; do not quietly change a running worker's instructions.
Use the existing performance ledger for decisions rather than a new report per step.

An assistant can inspect these files during an active observation task. The persistent
files make later analysis possible; they do not create an always-on assistant or schedule
future model calls. Read compact reports first and open exact transcript excerpts only
when an observed failure needs diagnosis.

## Prepared startup and connection observations

Use `spec_dispatch action=startup` for a prepared package. It selects the first card
on a fresh package, uses its recorded difficulty (`hard` selects the supplied
`strong_owner_model`), builds a missing history index, and dispatches through the
existing exclusive writer runtime. `owner_override` takes precedence. No model
availability probes or fresh difficulty judgment are needed. The existing `start`
action remains available for an explicitly reconciled assignment.

Pending inbox messages return `needs_intake`. Existing runtime progress returns its
receipt and next obligation; legacy artifacts return `needs_reconciliation`. The
coordinator resolves those once and supplies the next explicit step or retry ID.
Neither process completion nor an artifact filename proves acceptance or closes reviews.
Prepared startup reuses preparation validation; it checks required paths and ordered
index shape, not the semantic correctness of the plan. Preparation changes invalidate
that assumption and return to the preparation stage.

`/spec-metrics` now reports startup model/tool/read/shell counts, session-to-first-owner
time, owner-to-editor time, editor-to-first-successful-checkout-edit time, and separate
connection/timeout counts. JSON also contains dispatch-to-owner setup duration. First
edit means a successful native `write`/`edit` outside `.specs`; shell writes are unknown.
The first user message is a request-time proxy and can overstate startup in a reused
session. Missing timestamps stay unknown. These are observations, not quality verdicts.

Transport errors do not reclassify step difficulty. Preserve work and selected models;
allow one coordinator continuation after terminal failure and confirmed lease release,
then report a persistent connection blocker. Provider-internal retries remain outside
these metrics. No new short silence timeout kills a thinking worker. Reload or restart
Pi between runs to load the extension changes.
