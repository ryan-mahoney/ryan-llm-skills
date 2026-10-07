---
name: spec-sentinel
description: "Read-only workspace status for spec runs across automatically discovered repositories: bounded receipts, activity, coverage and factual conditions. Use for 'workspace status', 'sentinel status', 'discover repositories', or 'is any spec run stuck'. Observation only; it never starts, stops, changes or messages a worker."
argument-hint: "[status | root /absolute/search-folder | inspect ID | enable /absolute/policy.json | disable | off]"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# Spec sentinel workspace status

Report what is actually recorded about spec runs in discovered repositories. Every
fact comes from bounded runtime receipts and role snapshots. Status is read-only:
no transcript, metrics, model call, raw command, lease token or cost is read.

## Commands (Pi)

Sentinel stays dormant on startup and reload: no discovery, watches, timers,
widgets or notifications. Explicit `status` (including the bare command), `root`,
`add` or `inspect` starts observation for this session. Saved settings do not enable it.
After `off`, status and inspect remain one-shot reads without restarting observation.

- `/spec-sentinel status` — print a read-only workspace snapshot. This is also the
  default when the command is invoked without arguments.
- `/spec-sentinel root ~/Projects` — optionally save a different search folder.
  The default is `~/Documents`; no repository registration is required.
- `/spec-sentinel add /absolute/primary` — optionally pin an extra primary outside
  the search tree; existing enrollment records remain supported.
- `/spec-sentinel inspect ID` — show one observed run or condition, matched by
  assignment id, workflow id, package path, package name, or condition id/kind.
- `/spec-sentinel enable /absolute/policy.json` — arm a live, session-local scoped
  authority for this coordinator session from a validated policy file. Only this
  native command arms it; a fresh session, reload, checkpoint or copied file never does.
- `/spec-sentinel disable` — revoke the live authority synchronously, leaving
  observation active, and report any persistence failure.
- `/spec-sentinel off` — revoke the live authority first, then hide the widget and
  status text and stop this session's watchers and timers. It never stops, changes or
  messages a worker.

## Commands (CLI, no Pi session)

```bash
node ~/.agents/scripts/spec-observe/cli.mjs sentinel status [--root PATH | --package PATH] [--format text|json] [--agent-dir PATH]
```

- Text output is the default; `--format json` prints the snapshot object.
- Without `--package`, discover repositories beneath the saved root (default
  `~/Documents`) and use the managed run index plus optional legacy enrollments.
  `--root PATH` overrides the search folder for that CLI call without saving it.
  `--package PATH` skips repository discovery and observes that package plus existing
  managed-index candidates.
- The existing `list|runs|report|metrics` commands are unchanged.

## Automatic discovery

Discovery descends through grouping folders and through repositories to find nested
repositories. Candidates have `.git` and `.specs`; the existing reader validates primary
checkout/package identity, so worktree copies are never accepted as canonical specs.
Hidden children, dependency/build/cache folders and directory symlinks are skipped.
The root can itself be a repository. The saved setting is
`<agentDir>/spec-sentinel/discovery.json`, shared across workspace scopes; changing it
never changes intervention authority.

The managed run index and runtime receipts supply frequent activity updates, including
indexed work outside the search folder. Chokidar watches only canonical `.specs`
trees recursively, with symlink following disabled. Repository roots, source trees
and the Pi index receive no watches. A 15-second bounded reconciliation reads the
index and handles missed events. Repository discovery is cached for five minutes
per Pi session, with at most eight directory levels, 2,000 directories, 20,000 entries,
and a two-second cooperative scan budget. Scan limits and unreadable locations produce
explicit partial/unavailable coverage. The existing reader's repository/run/byte caps
still apply. No source or transcript is scanned and no model is called for discovery.

Existing explicit enrollments supplement discovery; they are no longer required.

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

Explicitly activated Pi sessions are the host. The observer coalesces directory invalidation
at 250 ms and reconciles every 15 seconds. Closing the session stops it; the next
session stays dormant until invoked and reports unobserved intervals as unknown. There is no daemon and no
collection while no session is open.

## Authority

This skill grants no continuation, cancellation, diagnosis or recovery by itself. It
writes no product state. The optional `root` and legacy `add` commands save only
local observation settings. Observation never establishes accepted work.

The optional `/spec-sentinel enable /absolute/policy.json` command arms a live,
session-local capability for this coordinator session only. It validates an absolute
regular non-symlink JSON policy of at most 16 KiB whose package, workflow, checkout
and native session match the retained checkpoint; `expires_at` must be a future exact
ISO-8601 UTC timestamp no later than eight hours; `max_effects`/`max_diagnostics` are
integers 0..2; actions are unique `continue`/`cancel`; `cancel` requires a diagnosis
selector and a nonzero diagnostic budget. Budgets are finite and retained per workflow
(two effect slots shared by continue/cancel, two diagnostic slots, at most one
continuation per obligation revision and one cancellation per incident generation, plus
at most one diagnosis per incident generation with a five-minute cooldown); re-enabling
never resets consumed capacity. A duplicate same-kind/subject reservation returns its retained
receipt without repeating the effect, and orphan/malformed/unfinished reservations stay
spent and fail closed as unknown across restarts. `/spec-sentinel disable` revokes
synchronously and reports a persistence failure while staying disarmed; `/spec-sentinel
off` revokes then hides observation.

## Continuation

In recover mode, a completed settlement with a ready open obligation, an exactly
reconciled native input revision, no UI prompt, no pending messages, a nonblocking
inbox, no nonterminal declared worker and an active permitting policy appends one
visible `spec-sentinel` custom message and requests exactly one additional model turn.
All guards are re-read immediately before a durable one-per-obligation reservation; a
second settlement or reissued checkpoint with the same obligation does not continue
again. An initial `canContinue === false` is not a veto. Shadow mode records one
would-continue observation (terminal `blocked`, reason `shadow-would-continue`) and adds
no message or turn. `requested` means proposed and `applied` means the requested turn
started; neither is acceptance, and ambiguous requests are never retried.

## Optional diagnosis

Diagnosis is optional and separately enabled. It runs only for a complete
repeated-failure incident with a complete fingerprint, using a bounded (at most 16 KiB)
tool-free packet of IDs, hashes, counts, waits and coverage, one active job per
coordinator, a five-minute cooldown, one attempt per incident generation and at most two
attempts per workflow.
Its output is advisory bounded JSON text labeled `note_verified: false`; it never grants
factual status, authority or a review verdict. Wrong or unknown fact IDs, malformed
output, timeout, unavailable delegation or a stale incident abstain without a fallback
model or retry.

## Guarded cancellation

Recover-mode cancellation is permitted only through a live, direct, scoped grant and
only for the current repeated-failure incident whose retained positive
`cancel-candidate` / `repeated-unchanged-failure` diagnosis matches the current complete
checkout digest, reconciled input, nonblocking inbox, checkpoint worker/checkout and the
exact original in-memory Runtime handle/lease, with the writer slot idle and effect
capacity remaining. A durable cancel intent is reserved immediately before the existing
`Runtime.cancel` entry; only confirmed process-group termination is `applied`. Failed or
unknown termination retains the writer reservation as blocked/unknown and is never
replayed. Shadow mode writes a terminal `shadow-would-cancel` observation and leaves the
worker alive. `disable`/`off` revokes future authority but cannot undo a cancellation
that already entered the Runtime. Status stays non-authoritative: enrollment, disk state,
model output or a copied file never arms recovery.
