# Reading Pi sessions and interpreting measurements

## Native storage and links

Native coordinator sessions normally live at:

```text
~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl
```

The managed owner/editor paths are in each assignment manifest and normally point
inside `PACKAGE/runtime/sessions/<pair>/`. Pair retention is package-wide by
default; `session_scope: step` separates sessions by step. Follow these paths,
`parent_session`/`parentSession`, and tool-returned child references. Reviewers,
fixers, scouts, clerks, and legacy subagents can live outside the package; the
metrics helper discovers descendants beneath linked session basenames. External
or missing children remain coverage gaps. Similar names, mtimes, or CWDs alone
do not establish parentage or role.

The installed Pi documentation `docs/session-format.md`, `docs/message-types.md`,
and `docs/sessions.md` is the native schema authority. Locate the installed package
from the real `pi` executable/package path rather than hardcoding a Homebrew root.
The installation inspected when this skill was created was
`@earendil-works/pi-coding-agent`; older installations may use another package name.

Pi native conversations were verified as JSONL, not SQLite. The local
`~/.pi/agent/pi-warden/holds.db` is separate extension state, not a coding-turn store.
If a user supplies an additional SQLite transcript archive, open the existing file
read-only, inspect `sqlite_schema`/table columns first, and establish its session,
entry, parent, timestamp, and import-coverage mapping before querying selected runs.
Never invent a schema/path or assume the archive contains every worker/resumption.

## Summary commands and their scopes

```bash
node ~/.agents/scripts/spec-observe/cli.mjs metrics --package /absolute/primary/.specs/FEATURE --all-sessions
node ~/.agents/scripts/spec-observe/cli.mjs metrics --package /absolute/primary/.specs/FEATURE --session SESSION_ID --format text
node ~/.agents/scripts/spec-observe/cli.mjs report --package /absolute/primary/.specs/FEATURE --session SESSION_ID
```

JSON is the metrics default. Select `--all-sessions` **or** `--session`, not both.
`report` selects one root and reports its retained conversation history; it is not
automatically restricted to a single attempt or the latest goal. `metrics` filters
retained owner/editor sessions to selected assignment windows, while coordinator
and some linked worker histories can include other work. Verify those boundaries
when a session served several packages or continued after reported completion.

Inspect the JSON coverage, discovery/read errors, malformed rows, bounded reads,
and limitations before interpreting totals. Default transcript reads are bounded
to 64 MiB per file; `--max-mb N` can raise that deliberately for a needed source.
Managed event reads take the first 4 MiB and report truncation; increasing
`--max-mb` does not raise that event bound. Use a targeted streaming read for an
omitted run/time range instead of treating missing late events as zero activity.

## Exact transcript inspection

Prefer a narrow interval around a suspected delay/failure and its preceding
assignment over a full transcript dump. Parse each JSONL line as data. First
project only entry ID, type, timestamp, role, provider/model, tool name/call ID,
error/stop status, and usage fields. Then read the relevant public assignment,
tool arguments/results, and response excerpts needed to explain the observation.
Do not emit raw reasoning blocks or unrelated conversations.

Useful native fields and relationships:

- A `type: session` header supplies `id`, `cwd`, creation `timestamp`, and optional
  `parentSession`. Entries have their own `id` and `parentId` tree relationships;
  session parentage and entry parentage are different concepts.
- `type: message` wraps `message`. Its `role` can be `user`, `assistant`,
  `toolResult`, or other version-specific roles. Assistant responses carry actual
  `provider`, `model`, `usage`, `stopReason` and, in newer versions, `thinkingLevel`.
  Configured defaults or a model-change entry do not prove which model answered.
- Assistant `content` can include `toolCall` blocks. Correlate their call `id`
  with `message.toolCallId` on `toolResult`, using the session as part of the key.
  A tool submission is not proof that a command ran successfully. Preserve
  `isError`, structured exit/signal/timeout fields and the original result.
- Entry `timestamp` is ISO text; nested `message.timestamp` is epoch milliseconds.
  The observer uses their interval as response latency where valid. Do not mix
  units, invent missing timing, or substitute file mtime for exact event time.
- `model_change`, `thinking_level_change`, `compaction`, `branch_summary`,
  `context_edit`, and `custom` entries explain context transitions. Newer system
  messages may retain prompt sections and tool changes, useful for establishing
  which instructions were loaded. Older files may lack them.

For an explanation of what a model saw, follow the relevant entry ancestry and
compaction/context changes, not the entire file as one linear prompt. For cost
or wasted-work analysis, abandoned branches can still represent real work; label
that accounting separately. Copies/forks can repeat earlier entries, so reconcile
inherited entry IDs/timestamps before summing. Stream JSONL under `runtime/runs/`
and native session JSONL can describe the same calls; choose one accounting source
and use the other for diagnostics, without adding both totals.

## Measurement limits that change recommendations

| Observation | Interpretation |
|---|---|
| Observed process span | First selected coordinator user message to last observed activity, including pauses. A reused session can begin before the selected task. |
| Dispatch/step duration | Receipt/event boundaries for an assignment. Reviews and fixes outside dispatch are additional work, potentially overlapping another step. |
| First checkout edit | Metrics recognize successful native `write`/`edit` outside `.specs`. Shell edits are not inferred; `report`'s first write-tool metric has a different, weaker meaning. |
| Model calls/response time | Persisted assistant responses, including errors, and observed latency with coverage. Provider-internal retries are not fully visible. This is not total agent runtime. |
| Tool/delegation waits | Submission-to-result upper bounds including queueing. Overlap means summed waits/latencies do not equal elapsed or recoverable time. |
| Repeated reads/status calls | A candidate source of overhead. Inspect changed content, compaction, role boundaries and waiting mechanism before declaring the repeats avoidable. |
| Recognized test submissions | A runner-detection heuristic, not test-case counts, complete suite coverage, or proof every conditional command started. Structured verification receipts are stronger evidence. |
| Failed test-command results | May be setup, timeout, shell, missing executable or assertion failures. Diagnose raw logs and receipts before classifying a code defect. |
| Reported tokens/cost | Provider-reported values with partial coverage, not billing totals. Zero can mean unpriced; cached input repeats and reasoning can overlap output. Do not sum categories into unique context. |
| Usage outside assistant messages | Newer Pi can record `usage`, compaction and branch-summary usage. The current observer's assistant-message aggregation may omit these; label totals as partial if they matter. |
| PR submission / coordinator completion milestone | Reported lifecycle events. They do not independently prove acceptance, CI pass, merge, or deployment. Later activity may be cleanup, unrelated work, or reopened obligations. |
| Quiet activity or retained running state | Last observed state; not proof of a stalled or live process. Missing events/telemetry remain unknown. |

To estimate an improvement, identify the intervals it could remove on the actual
critical path. Keep non-overlapping elapsed measurements separate from role/tool
effort. Compare against review findings, repair iterations and revision-bound
acceptance evidence. If the logs only show a plausible inefficiency, propose an
experiment and report savings as unmeasured.
