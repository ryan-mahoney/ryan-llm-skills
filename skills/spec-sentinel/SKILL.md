---
name: spec-sentinel
description: "Read-only workspace status for spec runs across enrolled repositories: bounded receipts, activity, coverage and factual conditions. Use for 'workspace status', 'sentinel status', 'enrolled repositories', or 'is any spec run stuck'. Observation only; it never starts, stops, changes or messages a worker."
argument-hint: "[status | add /absolute/primary | inspect ID | off]"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec sentinel workspace status

Report what is actually recorded about spec runs in enrolled repositories. Every
fact comes from bounded runtime receipts and role snapshots. Status is read-only:
no transcript, metrics, model call, raw command, lease token or cost is read.

## Commands (Pi)

- `/spec-sentinel status` — print a read-only workspace snapshot. This is also the
  default when the command is invoked without arguments.
- `/spec-sentinel add /absolute/primary` — validate a primary checkout, write one
  enrollment record, and grant read observation only. Enrollment never grants any
  ability to start, stop, change or message a worker.
- `/spec-sentinel inspect ID` — show one observed run or condition, matched by
  assignment id, workflow id, package path, package name, or condition id/kind.
- `/spec-sentinel off` — hide the widget and status text and stop this session's
  watchers and timers. It never stops, changes or messages a worker.

## Commands (CLI, no Pi session)

```bash
node ~/.agents/scripts/spec-observe/cli.mjs sentinel status [--package PATH] [--format text|json] [--agent-dir PATH]
```

- Text output is the default; `--format json` prints the snapshot object.
- Without `--package`, the command reads the enrolled workspace for
  `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) and the current
  `PI_INTERCOM_SCOPE_ID` scope. With `--package PATH`, only that package is
  observed and no enrollment is read.
- Empty enrollment prints the instruction to add a root in Pi.
- The existing `list|runs|report|metrics` commands are unchanged.

## Enrollment

- One record per root at
  `<agentDir>/spec-sentinel/<workspace-key>/enrollments/<sha256(common dir)>.json`,
  mode `0600`, containing `{ version, root, common, enrolled_at }`.
- Only the direct `/spec-sentinel add` command writes this record. Nothing else in
  this skill or its reader writes state.
- At most 20 roots are recorded; beyond that the command reports the limit.
- A `.specs` copy in a linked worktree is rejected: it is not a canonical package.
- Managed-index pointers and packages dispatched in a session are observation
  candidates only. Reading a pointer or dispatching a step never enrolls a
  repository.

## What status shows

Repository common directory, canonical package, checkout, workflow id, assignment
id, coordinator session, execution state, obligation, a bounded activity hint,
coverage and factual conditions such as `reconciliation-pending`, `quiet-activity`,
unknown activity, or a lease mismatch. Coverage is `complete|partial|stale|unavailable`
with explicit omission reasons and a bounded byte count. Missing, oversized or
replaced sources stay unknown or stale; they are never reported as healthy.

## Interpretation limits

- Completion, process exit and silence are never acceptance, liveness or recovery
  authority. `reconciliation-pending` means review remains outstanding.
- Quiet activity and elapsed startup time are informational facts only. Do not
  describe a run as spinning, stuck, accepted or recovered from status alone.
- No transcript, metrics, model call, raw command body, lease token or cost is read
  or shown; missing usage stays unknown and is never reported as zero cost.
- No cross-package dependency edges are inferred.

## Host lifetime

Connected Pi sessions are the host. The observer coalesces directory invalidation
at 250 ms and reconciles every 15 seconds. Closing the session stops it; the next
session reports the unobserved interval as unknown. There is no daemon and no
collection while no session is open.

## Authority

This skill grants no continuation, cancellation, diagnosis or recovery. It writes
no product state beyond the single enrollment record created by an explicit
`add` command. Observation never establishes accepted work.
