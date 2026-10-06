# Overseer Inbox

Receive one-way overseer messages during implementation and review, never during
planning. The mailbox is a workflow protocol, not a background service: file
arrival cannot wake a stopped session or interrupt a tool call. A stopped recipient
needs a separate harness resume request.

## Location and ownership

Before implementation, create `inbox/` and `processed/` in the canonical
`.specs/<feature>/` folder in the primary repository. Report their absolute paths
and record a unique run ID in the existing stage ledger. Keep the ID on continuation;
use a new ID for a new run. Never use a worktree copy.

The top-level coordinator alone consumes inbox files, archives originals, and
writes intake receipts in the stage ledger. Stage coordinators route references;
addressed workers read and interpret the original messages themselves. Workers do
not scan or move inbox files, write intake receipts, or change the top-level ledger.
They record action outcomes in their own existing learning, review, or fix report.

Record any designated overseer and delegated decision scope in the ledger. A sender
name is not proof of authority. Messages can guide authorized work, but cannot
supersede user instructions, grant authority, bypass gates, or dictate a review
verdict. Resolve consequential conflicts under the existing context contract.

## Sending and audiences

Use [spec-message](../../spec-message/SKILL.md) to resolve an existing run and verify
delivery. Send one UTF-8 Markdown file per message with a unique timestamp/random ID.
Write a sibling temporary file and atomically rename it to `<id>.md` when complete.
Never overwrite or edit delivered messages; corrections name what they supersede.

```markdown
---
id: 20260928T150000Z-a71c
run: <run ID reported by the coordinator>
sender: <overseer identity>
audience: step-003
kind: direction
---

Check empty input in the export handler before completing this step. It must retain
its documented output shape when no rows match.
```

Use one audience per message:

| Audience | Recipient |
| --- | --- |
| `coordinator` | Run-wide scheduling, holds, or cross-stage decisions; default when omitted. |
| `implementation` | Implementation stage owner, which applies the direction within its role or forwards it to the relevant step worker. |
| `step-NNN` | The indexed implementation step, such as `step-003`. |
| `review` | Active or next independent branch reviewer. |
| `fix` | Active or next branch-fix worker. |

Use separate messages for independent audiences. For a direction that spans several
workers, address the coordinator; it records each required recipient and tracks
outcomes separately. A worker that needs another owner routes that need back rather
than silently expanding its assignment.

Use `kind: direction`, `information`, or `hold`. State the concrete request or fact,
rationale, and any stage/revision conditions. A hold stops the recipient's dependent
work at a safe boundary; a run-wide or publication hold belongs to `coordinator`.
A later direction can release a hold within existing authority. Holds do not undo
completed effects. There is no planning audience. A message that reveals a scope or
proof change can still trigger the existing `needs-spec-correction` escalation;
that does not authorize editing immutable preparation in place.

## Checkpoints and routing

The parent checks on entry to implementation, resume during implementation/review,
stage handoffs, and available worker-wait wakeups. Use bounded waits of at most
60 seconds when supported. Check again and reconcile pending messages before
publication and final completion. Do not poll worker progress just to check files.
Do not add planning checkpoints or install watchers/continuation hooks.

Stage coordinators continue steps and review iterations without parent approval.
The parent forwards an archived path and message ID through the existing agent
channel to the active stage coordinator or addressed worker. Send the original
reference, not a rewritten technical brief. Track the actual recipient. For a future
recipient, retain a pending route and include the path in its dispatch. If the stage
coordinator owns dispatch, forward that pending route to it. It reports routing and
outcomes back at its normal handoff; it does not wait for permission at each step.

If live messaging is unavailable, deliver at the next normal handoff and record the
delay. Do not steal the worker's task or require per-step acknowledgment to simulate
instant delivery. If the addressed step or review has already finished, keep the
message unresolved and route it to the stage owner to determine required follow-up;
never silently drop it or replay a completed step. Extra review requires remaining
budget or an explicit decision; a message does not reset the review cap.

## Intake and archive

At a checkpoint, read the available complete `.md` batch in filename order. Ignore
temporary files and symlinks. Resolve conflicts through authority and explicit
supersession, not timestamps alone. Later arrivals wait for the next checkpoint.

1. Validate ID, run, sender, audience, and kind. Record malformed, wrong-run, or
   invalid-audience messages as rejected or `decision-required`, with a reason.
   Do not infer technical applicability on the worker's behalf.
2. Durably record ID, content hash, audience, intake result (`routed`, `rejected`,
   or `decision-required`), archived path, actual/pending recipients, and outstanding
   outcomes in the existing ledger. `routed` can have delivery pending; it means
   intake has assigned a route, not that a worker received or accepted it.
3. Move the unchanged original into `processed/` without overwriting an existing
   entry, then forward its stable archived path. Archive before forwarding so
   recipients never depend on a disappearing inbox path.

In managed Pi, each `spec_checkpoint` projects every retained original by ID, hash and
outcome; it reads only and never moves, edits or archives files. Archiving an original
into `processed/` never releases a hold. A hold is released only when the matching later
`kind: direction` original explicitly names the held ID and the checkpoint supplies the
hold item's `release_source_id` referencing that direction's ID. Both the hold item's
and the direction item's outcomes and hashes must be applied/bound: the hold's applied
outcome and hash, and the direction's applied outcome and hash, must all match their
observed originals. Malformed sources, hash mismatches, symlinks and missing retained
history stay blocking/unknown; archiving or a later timestamp never makes them healthy.

`processed/` means intake recorded, not action complete. Pending delivery and action
remain visible in the ledger even after archiving. Only the parent updates those
records from recipient reports.

## Recipient contract

Read routed messages at the next safe opportunity after notification or dispatch,
and reconcile known messages before committing or returning a final verdict. Finish
an indivisible operation safely first. A long tool call may delay action; do not
promise immediate cancellation. No periodic inbox scanning or idle acknowledgment
is required of workers.

Assess the original message against prepared intent, current artifacts, and authority.
Apply relevant directions within the assigned role; a reviewer investigates and
records evidence, never edits code or accepts a requested verdict. Report each ID
as `applied`, `not-applicable`, `held`, `decision-required`, or
`needs-spec-correction`, with the reason and result/evidence path in the worker's
existing report. Return unresolved holds or consequential decisions promptly; keep
independent authorized work moving. Technical interpretation belongs to the recipient,
not the parent. Escalate conflicts or missing prepared requirements rather than
asking the parent to reconstruct the subspec.

The parent records reported outcomes and resolves routing or run-wide decisions.
It checks the outcome and referenced record without redoing the technical work.
Unresolved relevant messages prevent publication/completion; an intake receipt or
successful delivery cannot discharge them. A final scan cannot retract an external
action already in flight: record late steering and the actual outcome honestly.

## Recovery

On resume, reconcile inbox/archive files, receipts, pending routes, recipient reports,
and worker state. A receipt with its file still in the inbox needs archiving, not
new intake. An identical ID/hash is a duplicate; different content under the same ID
is a conflict. Preserve conflicting files without overwriting history. Reconstruct
missing receipts from the archived original and existing reports before routing.
Do not repeat a completed action simply because its message is redelivered; verify
actual outcomes, especially commits or publication, before retrying. The protocol
does not provide exactly-once external effects.

Keep IDs and mailbox paths in orchestration records. Commits and PRs explain the
resulting behavior under the engineering-writing guidance.
