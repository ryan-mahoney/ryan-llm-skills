# Refuse serial writer admission across the whole admission window

`Runtime.start` in `pi/extensions/spec-runtime/runtime.mjs` admits one serial writer
per package. Admission is asynchronous: between entering `start()` and inspecting the
package's latest run record (`runtime/run.json`), the request awaits input resolution
and the ownership registry's `inspectClaims`. Two regressions and one reviewed defect
follow from that.

## Regressions in runtime.test.mjs

The operator reported both tests passing on the main branch and failing on this branch
(the first depends on timing, so it may pass in a given run):

- "repeated starts return the same run before and after completion; a second
  coordinator cannot take its writer lease" fails with "Missing expected rejection":
  a second coordinator is no longer refused the writer lease. A run can reach a
  terminal state while the distinct request is being resolved, and that request is
  then admitted although the prior run occupied the package during its admission.
- "start creates the target worktree on the target branch, records it in
  locations.json and the run index, and writes no lock fields" fails because
  `runtime/` now keeps `events.jsonl.lock` and `progress.lock`.

Fix the production cause; do not weaken assertions. The two lock files are `flock`
targets for the event append and the progress refresh: unlinking them would let a
waiter hold the old inode while a new writer locks a fresh file. If they are
persistent by design, show that design in the code and narrow only that assertion
to the test's original intent (no writer-claim lock files), with the reason recorded.

## Overlap rule (reviewed defect)

An earlier fix attempt (not present in this source) compared
`priorStarted <= enteredAt && priorFinished > enteredAt`.
A review reproduced a false admission: a request entered `start()`, waited in
`inspectClaims`, and meanwhile a distinct run started after its entry and completed
before the wait returned. That lifetime overlaps admission, yet the request launched.

Replace the one-sided test with an explicit rule. This request's admission window is
`[enteredAt, inspectedAt]`, both read from the local clock (`Date`): `enteredAt` when
`start()` is entered and `inspectedAt` when the prior record is inspected. A caller's
`dispatch_requested_at` is metadata only and never enters the comparison. A prior run
of a distinct assignment overlaps when it started at or before `inspectedAt` and had
not finished before `enteredAt`:

| Prior started | Prior finished | Outcome |
|---|---|---|
| before entry | before entry | admit |
| before entry | during admission | refuse |
| before entry | still active | refuse (existing behavior) |
| during admission | during admission | refuse |
| during admission | still active | refuse |

- Equality counts as overlap: a prior whose `finished_at` equals `enteredAt` refuses.
- A terminal prior whose `started_at` or `finished_at` is missing, null or unparseable
  has an unknown lifetime and refuses (fail closed).
- An active-state prior (`running`, `cancelling`, `blocked`) with a live coordinator
  refuses as today. With a dead coordinator it is marked stale only when its lifetime
  is known; an unknown lifetime refuses instead.
- Every refusal uses the existing `refusalError` with code `run-active`, launches no
  process and leaves `runtime/run.json` byte-identical.
- The same assignment still returns the same run (idempotent, unchanged), and a
  genuinely later distinct assignment is admitted.

Add one deterministic test per refusing row that the existing tests do not cover.
`Runtime` accepts an injected `ownership` object; delaying its `inspectClaims` and
using a fake `Date` clock (`t.mock.timers.enable({ apis: ['Date'] })`) reproduces the
interleavings without sleeps. Gate: the whole `runtime.test.mjs` file.
