---
name: epic-end-to-end
description: "Implement an epic across an explicit list of planned spec packages in dependency order, resuming each through reviews, evidence, PR publication and authorized merge, then updating downstream plans from feedback. Use for running several related specs without routine handoffs; a single package uses spec-end-to-end."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Epic End To End

Own the sequence across packages. Use [spec-end-to-end](../spec-end-to-end/SKILL.md)
for each package; it owns implementation, independent reviews, fixes, evidence,
work tour and publication. A package's final response is an epic handoff: reconcile
it and continue to the next eligible package in the same run. Do not stop to ask
whether to continue after a completed package.

## Standing defaults

Invoking this skill with `EPIC` or `PACKAGES` requests the full epic loop by default:
resume existing planned work → implement → review → publish → merge → reassess
remaining packages. The operator need not repeat these instructions:

- Resolve dependency order and prerequisite status against current code and merged
  PRs, using the record's array order to break ties among eligible packages.
- Preserve completed work and resume each package at its first unfinished
  obligation. Refresh missing or stale preparation through `spec-write`.
- Complete each package's reviews and evidence, publish its PR, and merge it under
  repository policy before starting work that requires that merged result.
- Evaluate downstream packages against implementation and review feedback; update
  affected plans through `spec-write` while preserving agreed behavior and acceptance.
- Continue across routine handoffs without asking for confirmation. Surface only
  unresolved consequential decisions, missing authority or concrete blockers.

These are the user-selected defaults for this skill. Invocation authorizes ordinary
task-owned commits, safe pushes, PR creation/update and merges for the listed
packages into their resolved target branches. Explicit narrower directions such as
“publication only,” “do not merge,” “draft only,” or “local only” override the defaults.
Specifying a model or package list does not authorize unrelated work. Deployment,
live imports/migrations, service installation, destructive resets and unlisted PR
merges remain outside this default authority.

## Invocation and authority

```text
/epic-end-to-end

DEFAULT_OWNER: meta/muse-spark-1.3-contributor:xhigh from openrouter
STRONG_OWNER: gpt-6.1-sol:medium from openai-codex
EDITOR_AGENT: deepseek-flash:max from deepseek
REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex
SCOUT_AGENT: gpt-6-luna:low from openai-codex
FINAL_REVIEWER: gpt-6.1-sol:xhigh from openai-codex
WORKSPACE: transitops   # optional when run from a repository in exactly one kit
EPIC: adj
PACKAGES:   # optional when the record exists
- transitops/adj1-first-feature
- transitops/adj2-second-feature
```

`EPIC: <slug>` (preferred) names an existing record in the workspace's epics (see
[Spec Location](../spec-end-to-end/references/spec-location.md#epics)); its `packages` are the
membership boundary. `PACKAGES` takes `workspace/slug` references, package folders or
files inside them, all in one workspace; a leftover singular `PACKAGE` placeholder does not replace that
list. See [One epic record](#one-epic-record-existing-package-ledgers) for how the
two combine.
Honor explicit branch/base, worktree, publication/readiness and model overrides.
Apply the standing defaults unless the invocation explicitly narrows them. A stated
endpoint of “through PR publication” is publication-only; omitted workflow prose
uses the full merge-and-reassess loop. Record effective authority once and carry it
through the package handoffs without asking again.

Carry the exact run-wide selectors into every package, including resumptions and
fixes where the owning skill uses them. Normalize `MODEL:thinking from PROVIDER`
to `PROVIDER/MODEL:thinking` once, preserving every slash and suffix. In particular,
DEFAULT_OWNER, STRONG_OWNER, EDITOR_AGENT (alias EDITOR_MODEL), REVIEW_AGENT,
SCOUT_AGENT and FINAL_REVIEWER remain separate roles. FINAL_REVIEWER enables the
existing optional final review for each package; it does not replace step reviews.
Reuse recorded owner/editor assignments for interrupted work, and apply explicit
new user overrides through the owning workflow. Never silently substitute a model.

## Resolve the sequence once

1. Run the first step of [Spec Location](../spec-end-to-end/references/spec-location.md):
   `resolve` for the workspace (when no `WORKSPACE` is given), `epics --workspace W` for the
   record and its members, and `check` on each member's folder. Apply
   [Workspace Handoff](../spec-end-to-end/references/workspace-handoff.md). Read applicable
   instructions, the workspace project context and each package's context, spec, preparation
   outcome, dependency notes and existing completion/publication receipts. Read and write
   spec files only in the package folders; run code and checks in the selected target worktrees.
2. Deduplicate package references while retaining the user's order. Read only
   enough artifacts to identify dependencies, readiness, ownership and next action;
   do not replay architecture, inspect every step card, or run broad baselines.
3. Build the dependency order from the record's `requires`. Read the packages'
   artifacts for explicit contracts/prerequisites only to write the record
   initially. A lower number or shared prefix is not a dependency. Array order in
   the record breaks ties among eligible packages. If the user explicitly requires an
   order that conflicts with a prerequisite, surface that conflict rather than
   silently choosing one. Detect cycles before dispatching affected packages.
4. For each edge record the producer, the contract required, where it must exist
   (source tree, artifact, service or merged base), and the evidence that satisfies
   it. Check current source and receipts: an old “not implemented” note is not
   proof that a producer remains absent. A PR URL or worker exit alone is not
   proof that the consumer's dependency is usable.
5. Missing planning goes to `spec-write` through the normal spec workflow, within
   the package's existing intent. Correct stale preparation through that owner;
   don't hand-edit immutable cards during execution. An explicit merged-base,
   live-service or backup prerequisite cannot be replaced by local code merely
   because stacking would make progress easier. Route a genuine spec correction
   using sourced facts; unresolved authority or consequential intent stays blocked.

The ready queue contains packages with satisfied prerequisites, not simply the
next list entry. Serial execution is the default. When the earliest package is
blocked, continue a listed independent package if its contracts permit it. Leave
blocked packages and their acceptance obligations visible. If an unlisted producer
is already available, consume its verified output; otherwise report its exact
missing prerequisite without expanding the epic.

## One epic record, existing package ledgers

The record is `epic.json` in the workspace's `epics/<slug>/` folder (the `record` path that
`epics --workspace W` prints), alongside this skill's `run.md`. `epic.json`'s schema, derived member
status and naming rules are defined in [Spec epics](../../docs/spec-epics.md); its members are
package slugs of the one workspace. Both files live in workspace storage, never in a checkout.

- `EPIC` without `PACKAGES`: read the existing record; stop if it is missing or invalid.
- `PACKAGES` without a record: write `epic.json` first. The slug is the explicit
  `EPIC` value, else the members' shared name prefix; with neither, refuse to guess
  and ask. Take `requires` from the packages' own dependency statements. Attach each member
  with `spec-location scope <member> --epic <slug>` and write the record at the `locations.epic`
  it then reports.
- Both: the record's membership must equal the list. Otherwise stop with the exact
  difference; never merge the two lists silently.

Update `epic.json` atomically (temp file plus rename) and only as follows: set
`state` to `active` on first dispatch and to `complete` when every member has its
requested outcome; set `abandoned` only on explicit user direction; add or change
a member `note` when a member is superseded or folded, with the user's direction.
Never rewrite membership, order or `requires`, and never copy derived status into
the record. Membership or dependency changes are operator edits.

`run.md` owns only cross-package coordination that the record and package files
cannot derive:

- Original request, exact models, authority and the effective tie order if it
  differs from the record.
- Satisfaction evidence for each `requires` edge and explicit external blockers.
- Per package: pending/running/blocked/complete, and per target its checkout, branch, explicit PR base
  and pinned predecessor SHA, existing workflow ID, requested outcome, final commit,
  merge commit and time, and evidence/tour references. Keep reviewed PR HEAD
  separate from the merge commit. PR URL and merge state are derivable by sentinel
  but remain here as handoff inputs.
- Current package, pending handoff and next eligible action; consequential
  decisions and holds that affect the epic.

Update `run.md` atomically at material handoffs, before dispatch and before returning for
a real blocker. Reuse the package's own managed ledger and receipts for step
progress, worker IDs, reviews and retry budgets; do not copy them into this record
or create an epic-shaped spec_dispatch assignment. Do not add a daemon, scheduler,
new runtime tool or parallel writer merely to sequence existing workflows.

On resume reconcile this record against package receipts, Git and published heads.
Do not redispatch a recorded running package until its owning workflow has resolved
the existing worker. A stale running entry is uncertainty, not permission for
a replacement. Reuse completed packages whose requested outcome remains valid;
route missing reviews/evidence/publication to their existing owner rather than
reimplementing them. No fresh budget or identity resets on resume.

## Merge each package before its dependents

In the merge-authorized mode, default to one PR per package target into the recorded
integration branch, ordinarily the repository default branch. A package is merged
when every target's PR is merged. `spec-end-to-end`
ends at publication; this epic coordinator owns the additional merge handoff.
Do not change the single-package workflow into an automatic merge workflow.

1. Require the package's ready publication receipt, remote HEAD equal to its
   reviewed/evidenced candidate, completed enabled final review, no unresolved
   applicable findings, and the intended repository/base. Reuse valid evidence;
   an early draft is not this handoff. Reconcile base changes and new actionable
   review feedback through the owning workflow before merging.
2. Use repository merge policy and the allowed merge method. Merge only the exact
   validated head, for example `gh pr merge <number> --repo <owner/repo>
   --match-head-commit <validated-sha> <repository-allowed-method>`. Never use
   `--admin`, bypass protections, invent approvals or disable required checks.
   Confirm the base still matches the recorded target immediately before the
   request. If the head changed, stop and reconcile the new commits and evidence.
3. Read the returned disposition: accepted auto-merge or merge-queue enrollment is
   **merge-pending**, not merged. If normal merge is waiting on checks, use
   platform auto-merge/queue only when it preserves the validated candidate and
   repository rules. Otherwise leave merge pending. Do not blindly retry a rejected
   merge or enqueue a moving unreviewed branch. No branch deletion is required.
4. Verify authoritative PR `MERGED` state, reviewed head, actual merge commit and
   destination; fetch the target and establish that merge commit is present before
   unlocking code dependents. A squash merge has a different SHA from the PR head;
   retain both and use the actual merged target as the downstream implementation
   base. Reconcile an already-merged PR on resume instead of issuing another merge.
5. Required CI and repository reviews cannot be bypassed. Publication still reads
   CI once under the existing policy; the epic's added gate is confirmed merge,
   not a second local broad suite. Do not diagnose CI unless authorized. Prefer
   native merge notifications when available. Without them, inspect PR merge state
   at independent-package handoffs or bounded intervals (30–60 seconds, at most
   15 minutes per pending merge episode); do not repeatedly fetch CI logs/status.
   Preserve the wait deadline on resume. At expiry, record merge-pending as a
   blocker, continue independent work, and report the external condition. No
   unattended guarantee overrides a required human review or unavailable wake path.

Start the next package from the fetched merged integration base. Reuse assigned
branches/worktrees, reconciling existing work through the owning safe Git workflow;
never recreate or reset them blindly. For fan-in, verify every required producer
is included. Across repositories, check the actual consumed artifact/version,
checkout or service: merging a producer does not deploy or install it.

When merge is not authorized, use publication-only mode. Dependent packages in the
same repository can form a linear PR stack from pinned validated predecessor
heads; pass the predecessor branch as the explicit base through dispatch, review,
tour and publication. Verify all fan-in ancestry. Existing explicit merged-base
requirements still block until actually satisfied; a stack is no substitute.
Do not rewrite existing PR relationships without reconciling their intent.

If earlier inputs move, hold affected running work safely and re-establish only
invalidated evidence. Never relabel old evidence with new SHAs. Use specified
integration gates and focused checks when later work changes earlier contracts;
repair known regressions before epic completion. Per-package success does not
claim all earlier features were retested against the final integration tree.

## Reassess remaining packages from feedback

After each completed package and confirmed merge (or publication in the explicitly
limited mode), evaluate every not-yet-started listed package for affected contracts.
Use the merged diff, implementation learnings, resolved review findings, final-review
report, evidence limitations and user directions as inputs. A suggestion is not
an approved requirement; distinguish a verified implementation fact from a product
change. Record source paths/PR links and revisions for material conclusions.

Compare those facts with downstream assumptions, targets, dependency notes,
acceptance, hazards and planned gates. Examples: a planned producer now exists;
a public function name changed; a concurrency defect discovered upstream requires
a downstream regression scenario; a helper was already implemented and should be
reused. Reorder eligible work when verified dependencies change. Do not rewrite
unaffected packages just because a predecessor merged.

For material drift, invoke `spec-write` on the affected package with a
bounded correction: source feedback, intended behavior to preserve, concrete stale
assumptions and available producer evidence. Let it update the spec, affected cards,
index, preparation and evidence plan consistently. Retain the prior planning
revision through the owning workflow's history/backup convention, and record the
before/after references and why in the epic record. Do not change an active worker's
prepared inputs; route its feedback through the existing owner and stop dependent
work at a safe boundary if re-preparation is necessary.

Automatically resolve implementation-plan corrections inside the agreed epic
scope. Surface a consequential question only when feedback changes user-visible
intent, expands membership, weakens acceptance, changes data preservation, or
needs new authority. Preserve blocked obligations and prior failure evidence;
never delete a difficult gate to manufacture readiness. Reassess evidence
applicability and readiness after changes, then continue without a routine approval
request. A later feedback event can reopen an earlier assumption, but it cannot
reset exhausted implementation/review budgets. At each handoff process one bounded
feedback pass; return to it only for a material new fact, not an endless replan loop.

## Run each eligible package through its owning workflow

Call `spec-end-to-end` with a concrete handoff containing `package_ref` and `package_dir`,
the targets' checkout/branch/base, pinned dependency inputs, exact model roles,
existing authority, requested readiness and existing workflow/next obligation.
In managed Pi use its prepared startup/checkpoint path; keep native workers and
sentinel workflow registration bound to that package. Remain the top-level
coordinator unless the user explicitly requested another coordinator. Do not spawn
one coordinator per package or reconstruct dispatch/review internals here.

Consume the returned completion/evidence/publication records. Require the package's
final `spec_sentinel_checkpoint` at `state: complete` (see spec-end-to-end's Completion);
without it the sentinel still shows the package as current, and this epic's derived member
status stays `in-progress`. Within authorized
publication, early drafts and subsequent pushes follow `spec-pr`; final ready
status requires the existing package evidence, review/fix and enabled final review
contracts. CI results stay operator-owned under
[Verification and Review](../../rules/verification-and-review.md). Do not poll CI
or make a routine human acknowledgment the transition to the next package.
In merge-authorized mode continue into the merge and feedback handoffs above; a
publication receipt alone does not complete that package.

When preparation or implementation needs an ordinary technical choice, resolve it
from the package's context and existing contracts and continue. When it needs an
unresolved consequential decision or additional operational authority, record the
specific blocker and continue only independent authorized packages. Do not weaken
acceptance or replace a real required integration with a mock to force completion.
Preserve the owning skill's finite retry/review limits; another package or epic
resume never resets an exhausted budget.

When a worker is active, use native completion events or the harness's blocking
wait and then resume coordination. No shell polling or silent idle completion.
Skills supply instructions, not a wake mechanism: this workflow needs a live Pi
session and its existing worker event path. Closing Pi requires an explicit later
resume. If the harness cannot wait/wake, record the pending worker handoff and
state the limitation instead of promising unattended continuation.

An explicit epic pause stops new dispatches and routes holds/cancellation through
the owning workflow; never kill a process by guessed PID. A package-scoped hold
blocks its dependents, while unrelated work may continue unless the user says to
pause the epic. Consume package inbox directions at the existing handoffs.

## Completion and reporting

Finish only when every listed package has its requested outcome (including
confirmed merge when authorized/requested), downstream feedback is reconciled, dependency
inputs remain valid, and no required review/evidence or integration gap is known.
A draft satisfies completion only when draft is the requested final outcome.
Live deployment or import prerequisites remain separately pending when outside
that requested outcome; do not relabel them as observed or quietly drop them.

Report `complete`, `blocked` or `paused`, the epic record path (from `locations.epic`), and a concise table
of packages, outcome, branch/base and PR URL per target. For incomplete runs, name the exact
missing dependency/decision, affected packages and next action. Routine successful
handoffs get short progress updates; never end the epic at the first package's PR.
