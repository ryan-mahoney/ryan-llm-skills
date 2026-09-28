---
name: spec-message
description: "Send a one-way direction, information update, or hold request to an existing spec-end-to-end run during implementation or review through its feature inbox. Use when asked to message a spec orchestrator, steer a running spec, or send an overseer instruction."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# Spec Message

Deliver one message to an existing spec orchestrator. Read and follow the
[Overseer Inbox protocol](../spec-end-to-end/references/overseer-inbox.md), including
its authority, atomic delivery, and duplicate-handling rules. This skill sends a
message; the coordinator routes it and the addressed recipient interprets and acts on it.

## Resolve the recipient

Use the feature or run named by the caller. Apply
[Workspace Handoff](../spec-end-to-end/references/workspace-handoff.md) to resolve
the canonical package in the primary repository, even when invoked from a worktree:

```bash
node ~/.agents/skills/spec-end-to-end/scripts/resolve-spec-path.mjs .specs/<feature>/
```

Read the run's existing stage ledger or coordinator handoff for its run ID, mailbox
paths, current stage, and designated overseer/delegated scope. Do not guess the run
from modification times. If the target is ambiguous, ask for the feature or run;
if the ledger location is unclear, locate it in the canonical package or ask for
the coordinator's handoff. Do not invent a ledger filename or run ID.

Confirm the inbox belongs to that feature and run and is an existing directory,
not a symlink to another location. If the mailbox has not been initialized, report
that the coordinator must load the updated end-to-end skill and initialize it.
Do not start a new run, create a substitute mailbox, or edit coordinator records.
Messages are sent only during implementation or review. If the run is still planning
or has already finished, report that state instead of delivering to an inactive phase.

## Compose the message

Use the caller's requested content and context. Select `direction` for a requested
change, `information` for facts to consider, and `hold` for a request to stop
dependent work at the next safe boundary. If consequential content is unclear,
ask for that content before delivery; resolve routine wording without confirmation.

Write a self-contained body stating the concrete direction or fact, why it matters,
and any applicable stage, revision, or supporting source. Preserve the caller's
scope and uncertainty. For corrections or hold releases, name the earlier message
being superseded. Do not claim a hold immediately cancels a running action.

Select `audience` from `coordinator`, `implementation`, `step-NNN`, `review`, or
`fix` using the caller's target; default to `coordinator` when no recipient is named.
Validate named step IDs against the package index. Use one audience per message;
route cross-stage directions and run-wide holds to `coordinator`. There is no
planning audience. Do not infer the intended recipient from whichever worker happens
to be active.

Populate `id`, `run`, `sender`, `audience`, and `kind` as specified by the protocol. Use a fresh
UTC timestamp plus random suffix for the ID. Identify the actual sender, or clearly
identify a relay of the user's request; never impersonate a designated overseer.
An overseer can send messages within its established assignment without requesting
permission for each delivery. Sending does not grant new operational authority.

## Deliver and verify

Recheck the run ID and implementation/review phase before delivery. Write UTF-8 content to an exclusively created
temporary file inside the inbox, close it, then atomically rename it to `<id>.md`.
Use filesystem APIs or a literal file-writing tool so message text is never
interpreted as shell code. Do not overwrite an inbox or processed entry. On a
collision, generate a new ID before initial delivery; when retrying an uncertain
delivery, reconcile the original ID and exact content with the inbox, processed
folder, and ledger instead of generating a duplicate request.

Verify the final file matches the intended content. If the coordinator has already
consumed it, verify the archived original or matching receipt instead. If delivery
cannot be confirmed, report `unconfirmed` with the message ID; do not blindly resend.
Remove only temporary files created by this attempt. Never move a message into
`processed/`, write a receipt, or change a spec on behalf of the recipient.

Return the delivery status, feature/run, message ID, audience, kind, and absolute inbox file
path. Report `delivered` only after verification; delivery is not acceptance or
completion. This is one-way delivery: do not wait for acknowledgment, poll for
action, or automatically launch/resume/interrupt another agent. A stopped recipient
needs a separate harness resume request; a running recipient reads at its next
mailbox checkpoint.

Example invocation:

```text
$spec-message .specs/export-format/ — Tell the reviewer to check that empty input
preserves the documented CSV header order.
```
