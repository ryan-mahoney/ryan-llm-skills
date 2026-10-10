# Evidence locations and source owners

Verified against this repository's observer/runtime code and installed Pi session
documentation on 2026-10-10. Use this map to avoid rediscovery; inspect the named
implementation if a version or returned shape differs. These are locations and
navigation hints, not a guarantee that every historical run produced every file.

`PACKAGE` means the absolute canonical primary-checkout `.specs/<feature>` folder.
`CHECKOUT` means the recorded implementation checkout. `AGENT_DIR` defaults to
`~/.pi/agent`; Pi can override it with `PI_CODING_AGENT_DIR` or SDK configuration.
The shared skills, runtime, and scripts live under `~/.agents/`; installed skill
directories in other harnesses may be symlinked mirrors.

## Locate the package and sessions

Prefer a supplied package. Otherwise list compact managed pointers:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs runs --limit 10
```

The index is `AGENT_DIR/spec-runtime/<run-id>.json`, with `run_id`, `package`,
`manifest`, and `parent_session`. To select an explicit run ID, read that pointer
directly; it may be outside the latest ten results. `runs --index-root PATH`
overrides the index location. In the current CLI, `runs` and legacy session
discovery use home defaults, so pass overrides explicitly for a custom agent dir.
Do not treat index mtime ordering as proof of the intended run.

For legacy or unmanaged runs without package receipts:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs list --limit 10 --cwd /absolute/recorded/cwd
node ~/.agents/scripts/spec-observe/cli.mjs report --session SESSION_ID
```

`--cwd` is optional and matches the root session header exactly; Pi may have been
opened in the primary repository or its parent rather than the worktree. Use
`--sessions-root PATH` for another session directory. Follow recorded package paths
and worker links from the selected transcript. If legacy discovery cannot find an
external worker, inspect the exact path returned by its launch, not every project.

## Canonical package artifacts

Paths in this table are relative to `PACKAGE` unless stated otherwise.

| Location | What it establishes / how to use it |
|---|---|
| `../project-context.md`; `context.md` | Shared project authority and feature snapshot. The current shared file may have changed since the run. |
| `proposal.md`, optional `critique.md` | Architecture rationale and known concerns; open when diagnosing planning or contract gaps. |
| `spec.md`, `evidence-plan.json` | Intended behavior, acceptance, claim/failure/gate relationships, proof boundaries and phases. |
| `spec-steps.json`, `step-NNN-subspec.md`, `spec-prepare.md` | Prepared order, difficulty, ownership, grounding and readiness; compare with actual dispatch/departures. Older preparation artifacts may differ. |
| `history-index.json` | Generated navigation into canonical learning/review/fix records; its presence/status is not approval. Read originals to resolve findings. |
| `runtime/progress.json` | Generated ledger: attempts, handoffs, verification counts, coordinator stages, artifact locations. It can lag or report refresh errors. |
| `runtime/stages/<stage>.json` | Latest `spec_checkpoint` judgment for a stage, decisions, artifact references and next action. Overwritten snapshots are not full stage history. |
| `learnings/step-NNN-learning.md` | Outcome, implementation decisions/departures, introduced symbols, handoffs, evidence and gaps. Legacy `step-NNN-learning.md` may be at the package root. |
| `reviews/step-NNN-review.md`, `reviews/step-NNN-fix.md` | Original reviewed range, finding signatures, dispositions, fixes and remaining limitations. Reconcile against later revisions. |
| `reviews/branch-N-review.md`, `reviews/branch-N-fix.md`, `reviews/refinement-completion.md` | Optional branch refinement. Its absence is normal unless selected/required; current default is step review/fix completion. |
| `merge-evidence.json`, `merge-evidence.md` | Assembled gate results, original execution revisions/applicability, review/fix completion, current commit, gaps. |
| `work-tour.json`, `work-tour.html` | Final presented verdict and supporting evidence. Check bound commit and limitations against the actual result. |
| `pr-rebase-log.md`, `pr-message.md`, `pr-url.json` | Base reconciliation, submitted prose, publication URL/revision. Receipt versions differ: inspect fields; publication is not merge or acceptance. |
| `blockers.md`, `inbox/*.md`, `processed/*.md` | Blockers and original overseer instructions/holds. Correlate delivery/outcome receipts with pauses; file arrival alone is not acknowledgment. |
| Evidence/QA/log/image paths named by gates and learnings | Actual proof and capture inputs. Directory names are package-specific; follow references instead of assuming a fixed `evidence/` layout. |
| Existing handwritten stage/experiment/performance records | Historical decisions, baselines and interventions. No universal filename is prescribed; use recorded links and a bounded package listing. |

Use `rg --files --hidden --no-ignore "$spec_package"` when a package inventory is
needed: `.specs/` is commonly ignored. Read selected files, not every artifact.
Set `spec_package` to the resolved canonical path first.

## Managed assignment evidence

| Location below `PACKAGE` | What it records |
|---|---|
| `runtime/run.json` | Latest assignment only; not the complete execution. |
| `runtime/runs/<id>.json` | Assignment manifest: `id`, `assignment_id`, optional `workflow_id`, `step`, `primary`, `checkout`, model selectors, session paths, state and timestamps. Newer receipts also have `attempt_kind`, `routing_reason`, `session_scope`, and environment observations. |
| `runtime/assignments/<sha256>.json` | Persistent retry/idempotency lookup: assignment key, run ID and launch contract. Use the stored mapping; do not equate its filename with a session ID. |
| `runtime/events.jsonl` | Append-only events keyed by `run_id`: worker/editor starts/results, questions, completion, deadlines, cancellations. Filter by the selected run IDs. |
| `runtime/sessions/<pair>/owner.jsonl`, `editor.jsonl` | Retained native Pi conversations; actual paths come from manifests. A file can span several steps/attempts. |
| `runtime/runs/<id>-completion.json` | Structured `spec_complete` submission and learning materialization. Preserves per-attempt details even when the canonical step learning has been superseded. |
| `runtime/runs/<id>-verification.json` | `receipts[]` with command, before/after revision and dirty flag, outcome, exit/error, timestamps/duration, raw artifact and summary path. A dirty flag is not a content digest. |
| `runtime/runs/<id>-verification-<receipt-id>.md` | Mechanical command-execution summary. Gate meaning/applicability belongs to the owner's evidence assessment. |
| `runtime/runs/<id>-command-<uuid>.log` | Raw managed stdout/stderr. Older runs may use `<id>-commands.log`; use returned `full_output_path` or receipt `artifact`. |
| `runtime/runs/<id>-*.jsonl`, `*.stderr`, `<id>-server-*.log` | Native process streams, launch/provider diagnostics and optional verification server logs. Use concrete recorded paths; streams can duplicate persisted session messages. |
| `runtime/runs/<id>-scout-<uuid>.txt` | Full scout answer referenced by `spec_scout` results. Child timing/model evidence comes from its linked session. |
| `runtime/runs/<id>-editor-configuration.json` | Diagnosed editor configuration failure and blocked identical retries. |
| `runtime/runs/<id>-activity/{owner,editor}.json` | Latest bounded activity snapshot; useful context, not a historical timeline or proof of liveness. |
| `runtime/runs/<id>-processes/*.json` | Managed process-group lifecycle records. Historical PIDs are not owned live handles. |
| `runtime/package.lock/lease.json`; manifest `lock` path | Exclusive writer reservations; the checkout lease normally lives at its Git dir's `spec-runtime.lock/lease.json`. Inspect only for a relevant contention failure, never delete/modify. Do not reproduce lease tokens. |

Not every JSON in `runtime/runs/` is a manifest. Filter for actual assignment
identity/step/state fields; verification/completion sidecars are different records.
One package can contain several workflow IDs, and legacy assignments can lack one.

## Sentinel and Jev telemetry

- `PACKAGE/runtime/sentinel/<workflow-id>/checkpoint.json` binds coordinator,
  checkout, obligation/revisions, workers and inbox outcomes. It is separate from
  `runtime/stages/`. A `reconcile:<assignment-id>` obligation means pending work.
- The same Sentinel directory can contain `verification-incidents.json`,
  `diagnoses/<incident-id>.json`, `intents/<id>.json`, `effect-slots/`,
  `diagnostic-slots/`, `shadow/`, and `authority/`. Inspect for a specific recovery,
  abstention or repeated-failure question. Legacy incident storage can be directly
  under `runtime/sentinel/`. Retained records do not arm recovery.
- `AGENT_DIR/spec-sentinel/<workspace-key>/observers/<observer-id>.json` contains
  bounded observation exports. They are snapshots, not a complete event archive.
  `PACKAGE/sentinel-completion.json` records an operator's lifecycle override;
  `sentinel-merge.json` may hold merge-reconciliation evidence. Neither replaces
  step acceptance records. A cold, scoped status read is available with
  `node ~/.agents/scripts/spec-observe/cli.mjs sentinel status --package PATH --format json`.
- `~/.agents/scripts/jev/state/decisions.jsonl` and its retained rotated log hold
  enum/hash-only advisory telemetry; `state/usage.json` holds the shared budget.
  `JEV_STATE_DIR` can override the directory. Full inputs/results belong to the
  caller's transcript/evidence; the ledger cannot reconstruct supplied code or findings.
  Use `node ~/.agents/scripts/jev/cli.mjs report --repo /absolute/checkout --since YYYY-MM-DD`.
  Repository filtering uses the **exact original checkout path**, and retained
  history is bounded. Reported recommendations do not prove they were followed
  or measure savings. Do not call a new judgment to measure an old one.

## Code outcome and process-change targets

Use the recorded base/result SHAs, original review ranges, and rebase log. For an
existing checkout the fact helper is read-only:

```bash
node ~/.agents/scripts/spec-facts/cli.mjs git --repo /absolute/checkout --base BASE_SHA --head RESULT_SHA
node ~/.agents/scripts/spec-facts/cli.mjs log --file /absolute/command.log
```

The Git helper compares explicit endpoints, not an automatically chosen merge
base. Current dirty status is a separate observation from a historical run. Inspect
scoped diffs with external diff/text conversion disabled. Do not fetch/rebase,
re-run gates, or poll CI merely to write a retrospective; use retained evidence
and identify what is unavailable.

When proposing a correction, locate its actual owner under `~/.agents/`:

| Suspected mechanism | Sources to inspect |
|---|---|
| Startup, continuation, stage ownership, inbox handling | `skills/spec-end-to-end/SKILL.md`, its `references/`; `pi/extensions/spec-runtime/startup.mjs` |
| Step scheduling, difficulty, review/fix sequencing | `skills/spec-run/SKILL.md`, `references/owner-routing.md`; `skills/spec-branch-review/`, `skills/spec-branch-fix/` |
| Owner/editor packets, excessive discovery or small edit loops | `skills/spec-step-run/`; `pi/agents/spec-step-owner.md`, `spec-step-editor.md`, `spec-stage-reviewer.md`, `spec-step-fixer.md` |
| Dispatch, retained sessions, writer lease, process/command handling | `pi/extensions/spec-runtime/runtime.mjs`, `index.ts`, `communication.mjs`, `scout.mjs`, `search.mjs` |
| Structured completion, verification receipts, generated progress | `pi/extensions/spec-runtime/completion.mjs`; `skills/spec-run/scripts/build-history-index.mjs` |
| Watcher, Sentinel decisions, monitor/recovery | `pi/extensions/spec-runtime/spec-watcher.mjs`, `sentinel.mjs`, `monitor.mjs`, related Sentinel modules |
| Metric/discovery limits or misclassification | `scripts/spec-observe/{cli,core,metrics}.mjs`, `README.md`; `pi/extensions/spec-runtime/metrics.mjs` |
| Check selection, Jev uncertainty, Warden verification invalidation | `rules/verification-and-review.md`, `rules/unit-testing.md`, `scripts/jev/`, `scripts/verification/` |
| Planning, final evidence, tours, publication | `skills/spec-write/`, `skills/spec-subspec-write/`, `skills/spec-work-tour/`, `skills/spec-pr/` |

Consult `docs/spec-coding-process-improvements.md`, `docs/spec-workflow-efficiency.md`,
`docs/spec-runtime-observation.md`, and `pi/extensions/spec-runtime/README.md` for
existing interventions and their measured limits. Check source/history before
recommending something these already implement. Preserve run-era/current-version
uncertainty when no retained version or loaded prompt establishes it.
