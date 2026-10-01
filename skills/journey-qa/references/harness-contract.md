# Harness contract

`journey-qa` drives a real stack through `bin/ux-qa`, a resident Playwright driver
and a set of run files. This file is the single definition of that surface: the
subcommands, their flags, the exit codes, and the schema of every run file. It is
written here so that skill prose, prompts and harness tests all read one contract,
and it is the only file permitted to restate these formats.

The harness that implements this contract lives in the application repository:
`bin/ux-qa`, `bin/lib/browser-stack.sh` and `assets/qa/`. When the harness and
this file disagree, the harness is the code of record and this file is corrected
in the same change.

Two neighbouring formats are defined elsewhere and are deliberately absent here:

- the `## 10. Test scenario` page syntax, in
  `document-journey/references/journey-page-template.md`;
- the rating bands and the rating vocabulary, in `scripts/rating.mjs`. No file
  outside that module and its tests states a threshold number.

## C-2 `bin/ux-qa`

A bash launcher in the style of the repository's existing browser-stack scripts.
It runs from the repository root and, before starting anything, sets
`MIX_ENV=test`, `MIX_TEST_PARTITION=${MIX_TEST_PARTITION:-_uxqa}` and
`ELIXIR_ERL_OPTIONS=${ELIXIR_ERL_OPTIONS:-+S 4}`, and unsets
`GTFS_PLANNER_TEST_DATABASE_URL` and `DATABASE_URL` so an inherited database
variable can never redirect a run.

```txt
bin/ux-qa up <JRNY-###/slug> [--headed]
bin/ux-qa step   --run DIR <action> [target flags] [--intent T] [--expect T]
bin/ux-qa note   --run DIR [--about N|last] --observed T [--confusion none|mild|blocked]
bin/ux-qa finish --run DIR --claim done|gave-up [--reason T] [--eyes host-vision|relayed-vision|source-only]
bin/ux-qa report --run DIR
bin/ux-qa down   --run DIR [--record]
bin/ux-qa replay [<JRNY-###[/slug>] ...] [--trail FILE] [--headed]
bin/ux-qa selfcheck [<JRNY-###[/slug>] ...]
```

- `up` starts the stack and prints two lines: `run: <dir>` and `brief: <path>`.
- `down` runs the scenario's check, writes `result.json` and stops only the
  processes this run owns. `--record` additionally writes the replay trail, and
  only when the check passed.
- `replay` builds a fresh stack per scenario and exits 1 on drift or a failed
  check. With no scenario IDs it replays every recorded trail. `--trail` names a
  file directly and is accepted only with a single scenario.
- `selfcheck` runs both legs per scenario: the no-op leg must fail the check and
  the authored reference-trail leg must pass it. No IDs means every reference
  trail. The reference leg keeps its captures in its run folder, so the capture
  root still holds the recorded exploration's captures.

`assets/qa/drive.mjs` exposes the subcommands the launcher calls: `scenario`
(print a scenario as JSON), `init`, `set-pid`, `open`, `close`, `finalize` (write
`result.json` from the check's exit code), `record` and `replay`. Every one of
them except `open` is a thin client that writes one JSON line to the driver
socket and prints the reply.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success: the check passed, the replay held, or the selfcheck legs both behaved. |
| 1 | The check failed, replay drifted, a selfcheck leg failed, or a `step` was rejected or not `ok`. |
| 2 | Harness error: missing JDK, jar, Chromium or `pg_tmp`, an unreachable server, or a check that crashed. |

Exit 2 is never a failed journey. `down` maps it to a run that is not rated.

### What `up` starts, in order

1. The database, always its own throwaway `pg_tmp` on loopback.
2. Assets, built once per invocation.
3. The seed named by the scenario's `Seed` key (`UX_QA_SEED`).
4. `<run>/baseline.json`.
5. The Phoenix server in the background with `BROWSER_E2E=true`,
   `UX_QA_REAL_VALIDATOR=true`, `PHX_SERVER=true`, `PORT=<free port>` and
   `JAVA_PATH=<resolved>`, recording its pid in the run's session file and its
   log in the run directory, then waiting on `/health` for up to 180 s.
6. The resident driver.

### What `down` guarantees

`down` stops only the pids recorded in the session file and ignores a pid that is
already gone. A second `down` prints the stored result and exits with the stored
status instead of re-running the check, so a crashed caller can still clean up
and still read the outcome.

## C-3 Run directory and `session.json`

The run directory is

```txt
<primary>/.specs/ux-qa/runs/<YYYYMMDDTHHMMSSZ>-<JRNY-###>-<slug>/
```

where `<primary>` is `dirname "$(git rev-parse --path-format=absolute
--git-common-dir)"`. A run started from a worktree therefore writes its output
under the primary checkout and nothing inside the worktree.

`session.json` in that directory:

```txt
{run, scenario, port, socket, dbUrl, pids:{phoenix, driver}, commit, dirty, startedAt, maxSteps:80, javaPath}
```

`socket` is `<os.tmpdir()>/ux-qa-<8 hex characters of sha256(run dir)>.sock`. A
socket inside the run directory would exceed the 104-byte limit for a Unix
socket path, so the hash of the run directory names it instead. `maxSteps` is the
attempt cap the step executor enforces; the harness never raises it per run.

## C-4 Resident driver protocol

`drive.mjs open` spawns `driver.mjs` detached. The driver launches Chromium at
1280×800, creates one context and one page, signs in the scenario's account,
writes `brief.md`, listens on the socket and appends every record to
`steps.jsonl`. The sign-in is logged as a `setup` record and is never a scored
step.

Console, page-error, failed-request, response-status-400-or-worse, dialog and
download events are buffered continuously by `events.mjs` and drained into the
next command's record, so an event that arrives between two commands is still
attributed to a step.

### Action vocabulary

```txt
click   --role R --name N | --text T
fill    --label L --value V
select  --label L --option O
upload  --role R --name N --file F | --text T --file F
press   --key K
goto    --path P
back
scroll  --dy N
look
wait    --text T [--timeout S]
```

`upload` targets the control the operator sees, for example the text "Choose a
.zip file". `F` must name a file listed in the scenario's `Files` key. After every
action the driver waits for the LiveView to be connected and not pending, then
for a short DOM-quiet window. `upload` waits for `data-phx-upload-ref` on the
chooser's input, sets the file, confirms the file name appears in the page, and
retries up to three times before recording `ok:false`. A download triggered by
an action is saved under `<run>/downloads/`.

### Observation printed per step

URL, page title, `h1`–`h3` text, visible `role=alert|status` text, the focused
element as role and name, a trimmed `ariaSnapshot` of `body` marked when
truncated, download names, the console error count with the first three
messages, and the screenshot path `<run>/captures/s<NNN>.png`.

## C-5 `steps.jsonl`

One JSON object per line, appended in execution order:

```txt
{kind:"setup", run, t, action:"sign-in", ok}
{kind:"step", run, n, t, action, target, intent, expected, urlBefore, urlAfter, ok, rejected, error, ms, capture, consoleErrors, httpErrors, alerts, downloads}
{kind:"note", about, observed, confusion:"none|mild|blocked"}
{kind:"finish", claim:"done|gave-up", reason, eyes}
```

`n` counts every step attempt, including rejected ones, so a rejected attempt
still advances the numbering. An attempt above the cap is rejected.
`rejected` is `false` when the attempt was executed and the reason string when it
was not.

## C-6 `result.json`

```txt
{
  run, scenario, status,
  check: {id, pass, observations},
  claim, reason, eyes, referenceActions,
  proxies: {
    actions, observations, scrolls, wrongTries, rejected, backtracks,
    errorsSeen: {banners, httpErrors, consoleErrors, failedActions, total},
    endedInError, actionsToEntryRoute, elapsedSeconds
  },
  stubExclusions: ["/map/tiles/", "/map/buildings"],
  commit, dirty, startedAt, finishedAt
}
```

`status` is `completed`, `not-completed` or `harness-error`. `check.pass` is
`true`, `false`, or `null`, and `null` occurs exactly when the status is
`harness-error`. A check prints `{id, pass, observations}` and exits 0 for a pass,
1 for a fail and 2 for a crash; `down` maps those exits to `completed`/`true`,
`not-completed`/`false` and `harness-error`/`null`.

`claim` and `reason` record what the tester said about the run. They are never
read by the check.

`endedInError` is true when the last executed step is not `ok` or shows an alert.
`actionsToEntryRoute` counts ok actions before the first step whose `urlAfter`
matches the scenario's Entry route, and is null when that route is never reached.

`stubExclusions` lists the request path prefixes the harness ignores when it
counts errors, so a reader can tell a product error from stubbed externals.

## C-7 Trail

Trails live under `replays/` for recorded runs and `reference-trails/` for the
authored positive controls. Both share one shape:

```txt
{scenario, recordedFrom, commit, steps:[{action, role?, name?, text?, label?, value?, option?, file?, key?, path?, timeout?}]}
```

Replay executes the steps through the same driver code path as a live run, needs
no `intent` or `expect` value, and writes each step's capture to the capture root
described in `uishot/references/capture-root.md`; `drive.mjs replay --local`
writes them to `<run>/captures/` instead, which is how `selfcheck` replays a
reference trail. The first failing step ends the
replay with exit 1, naming the step and its error and saving a screenshot; a
replay never silently re-explores.

## C-8 `baseline.json`

```txt
{capturedAt, versions:[{id, name}], workingVersionId, signatures:[<trip signature string>…]}
```

The baseline is captured by `up` before the tester acts, so every check compares
against a known starting state. `workingVersionId` is the seeded version when the
seed is `sample-feed` and `null` when it is `blank`. A trip signature is
`route_id | service_id | direction_id | [(stop_id, arrival_s, departure_s)…]` in
stop-sequence order, with times in seconds since midnight; trip ids are not part
of the signature. The import check treats a version absent from `versions` as new
and compares the latest such version.

## C-9 `review.json`

Written by the reviewer, not by the harness, and read strictly: an unknown or
missing key is an error.

```txt
{
  run, eyes,
  steps: [{n, q1, q2, q3, q4, captures: [name], note}],
  screens: [{
    route, screen,
    heuristics: {H1: {score, evidence, capture}, …, H10},
    states: {seen: [], notExercised: []},
    verify: []
  }],
  journey: {attribution, decidingStep},
  findings: [{id, severity, kind, step, capture, statement, consequence}]
}
```

`q1`–`q4` are 0–2. `q3` may be `null` where an action carried no expectation;
a null is not scored and is never counted as 0. A heuristic score is 0–3 or the
string `n/a`, and a heuristic appears on a deck only as a cited finding, never as
an aggregate. `attribution` is `product`, `tester` or `harness` when the run is
`not-completed`, and null otherwise; `decidingStep` names the step that decided
it. `severity` is `critical`, `high`, `medium`, `low` or `info`.

The reviewer writes no bands and no rating; the rating comes from the module
that owns the thresholds.

## Changing this contract

A change to a command, a flag, an exit code, a file name or a schema key lands
here first, then in the harness, then in the skill prose that depends on it. Keep
one definition of each format: if a second file starts restating one, delete the
restatement and point it at this file.
