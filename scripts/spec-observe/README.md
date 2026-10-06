# Observe spec runs

This read-only CLI finds Pi sessions and measures orchestration without sending model
requests, executing logged commands, changing workers, or printing prompts and source
contents. Node.js is the only dependency.

## Workflow metrics

```bash
node ~/.agents/scripts/spec-observe/cli.mjs metrics --package /absolute/repo/.specs/feature --format text
node ~/.agents/scripts/spec-observe/cli.mjs metrics --package /absolute/repo/.specs/feature --all-sessions
```

In Pi, `/spec-metrics /absolute/repo/.specs/feature` displays the same summary without
a model turn. Restart or reload an idle observer session to load the new command;
the CLI works immediately while an existing implementation continues. Do not restart
the owning coordinator merely to observe: its shutdown cancels managed workers.

The default is the latest recorded coordinator session. `--session ID|PATH` selects
an earlier coordinator; `--all-sessions` covers recorded resumptions. JSON is the
default output and can be redirected to a snapshot file for later comparison.
These reports reuse native Pi transcripts and runtime events; no new model requests,
background polling or logging of hidden reasoning is introduced.

Reports distinguish:

- **Observed process span:** first coordinator user message through last observed
  activity across selected workers, including human pauses. Time through the snapshot
  is separate; completion is never inferred from a quiet or exited agent.
- **Step attempts:** actual runtime start/end, recorded state, first-editor delay and
  editor assignments. Retried steps remain separate; review/fix work outside managed
  dispatch is not invented as step time.
- **Role/model calls:** persisted assistant responses (including errors) and tool
  submissions counted separately. Retained sessions are filtered to selected run
  windows. Async reviewers/scouts are discovered under linked session paths.
- **Model response time:** native message start through persistence, including provider
  and network time. Timing coverage is explicit. This is not total agent runtime.
  Tool submission-to-result waits are upper bounds and include queueing; delegation
  waits are separate. Parallel times overlap, so do not sum them into elapsed time.
- **Tests:** shell-tool submissions containing recognized runners, plus the number of
  recognized commands inside them. This is a heuristic, not individual test-case counts
  or proof every conditional command started. Custom wrappers may be missed. Reading
  test files, mentioning commands in quoted prose, and polling an existing command
  are not counted as fresh tests.
- **Cost/tokens:** provider-reported values and coverage, not billing totals. Missing
  pricing stays unknown; a reported zero can mean the model was unpriced.
- **Mercury/clerk use:** actual model response counts, not configured availability.

Missing, partial and bounded transcripts remain explicit coverage gaps. No acceptance
verdict, causal performance claim or model assignment is changed by telemetry.

Focused checks: `node --test scripts/spec-observe/metrics.test.mjs scripts/spec-observe/core.test.mjs`

Find recent managed runs without knowing their package or reading transcripts:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs runs --limit 10
```

This reads the small pointer index in `~/.pi/agent/spec-runtime`, newest file update
first, and returns each run ID, package, manifest, and parent session path. Use
`--index-root PATH` for another installation. Index reads are capped at 64 KiB per
record and 1,000 candidates; the output reports truncation or malformed records.

For a managed run, use its canonical package from that list. The runtime records parent, owner, and
editor session paths, so future observation does not need manually pasted nested paths:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs report --package /absolute/repo/.specs/feature
```

For older runs, discover root sessions from `~/.pi/agent/sessions`, then select a session
ID or absolute path. An optional exact `--cwd` selects the working directory recorded
in the root session header (often the directory where Pi was opened, not the worktree):

```bash
node ~/.agents/scripts/spec-observe/cli.mjs list --limit 10
node ~/.agents/scripts/spec-observe/cli.mjs report --session SESSION_ID
```

`--sessions-root PATH` supports an alternate Pi session directory. `--max-mb N` bounds
each transcript read (default 64 MiB); truncation and malformed/partially written lines
are reported. Discovery reads at most 64 KiB of each candidate header and does not follow
directory symlinks. It still enumerates the session directory; use `--package` for a
small, stable scope. Missing files during a live rotation can require another snapshot.

Reports include parent/worker links, explicit write-tool and dispatch-attempt timings,
tool/status counts, observed model changes, reported token/cost totals and categorized
provider errors. First child creation is measured separately from dispatch attempts.
The origin is the first user/custom message, falling back to session creation. A
resumed session therefore measures its recorded history, not automatically its newest
goal. Managed records expose each run's start/finish timestamps and state separately.
Managed event files also supply per-run event counts, editor-start latency and each
editor assignment's start/finish/duration within that run, even when session files are
reused. A missing finish stays unknown. Runtime records remain reportable before any
session header exists, including failed launches. These per-run event metrics are the
comparison source; transcript totals describe the retained session history. Event
reads are bounded to their first 4 MiB and explicitly report truncation.

These are transcript observations, not proof of process liveness or successful edits.
Shell writes are not inferred; the first write tool might create a process note rather
than code. Reported zero cost may mean an unpriced model; missing cost stays `null`.
Cached tokens are repeated input across requests, and reasoning can overlap output.
Do not sum token categories or equate their total to unique context. Free-form errors,
results, shell commands and prompts stay in their original logs. Reports do contain
local paths, session IDs and model names; review before sharing outside the project.

## Compare interventions

Keep a baseline report and a report after one intervention in the existing local
experiment ledger. Record the package/step, revision, models, environment warmth,
intervention, first-dispatch/first-write latency, step duration, status-call count,
provider errors, reported cost coverage, and independent review/acceptance outcome.
Compare equivalent work; separate provider timeouts from orchestration overhead.
Lower latency without preserved acceptance and review quality is not an improvement.

Observation is passive and opt-in. Take a snapshot at dispatch, step completion, and
review completion, or at a finite agreed interval while actively observing a run.
This command does not install a background listener, and a chat session cannot promise
to monitor future runs after it ends. Do not repeatedly read full transcripts when
runtime events or compact snapshots answer the question. Propose the next intervention
after a completed comparison; do not rewrite instructions or steer live workers merely
because a metric worsened. Never use production work as an uncontrolled optimization
loop or relax required review/testing to improve measured speed.

Focused parser/discovery checks:

```bash
node --test scripts/spec-observe/core.test.mjs
```

Metrics recognize native `subagent-spec-clerk-<uuid>-<number>` session names as
clerk work. They report PR submission only from `pr-url.json` with schema version 1,
kind `pr_submission`, `url`, actual `submitted_at`, canonical `package`, and the selected
coordinator's exact `parent_session`. Legacy or differently bound receipts remain
unmeasured. Coordinator completion is reported separately from the existing fenced
`outcome: published` summary with matching `spec-folder`, an HTTPS PR URL and
`blocker: none` in a normal final text response. This records a claim, not independent
acceptance. Thinking, worker exits and informal completion prose never create a
milestone. Time after the first matching completion report is subsequent activity;
observed span and snapshot time remain available and include pauses.

Literal `bash`/`sh`/`zsh`/`dash -c` wrappers (including `bash -lc`) are inspected without
executing them, to a maximum nesting depth of four. Dynamic shell bodies remain unknown.
`test_command_calls` counts submissions containing recognized test runners;
`test_command_results` counts corresponding tool replies, `test_command_failures` counts
reported tool/command failures, and `test_commands_with_exit` counts structured exits.
These are command-level observations: conditionals, setup failures and wrappers can
prevent the actual suite from starting. Neither a returned reply nor a zero outer exit
code establishes that tests passed. Raw logs remain the evidence for that judgment.
