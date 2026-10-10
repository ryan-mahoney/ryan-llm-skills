# Spec coding process improvements

The spec workflow now reduces repeated preparation and coordination, retains implementation
context, and assigns editing, verification and review to explicit owners. The changes below
are implemented in the repository. They are intended to reduce avoidable work; elapsed-time,
cost and quality superiority have not been established by a controlled comparison.

## Preparation and startup

| Improvement | Current behavior | Constraint |
| --- | --- | --- |
| Remove preparation hashes | Preparation checks required inputs, consistent indexes, ready cards and evidence contracts without a fingerprint manifest. | Changed or contradictory preparation returns to its owning stage. Structural validity does not prove behavior. |
| Ground once | Prepared cards identify target symbols, contracts, focused checks and ownership. Execution reuses those decisions and expands only for an observed gap. | Repository policy, acceptance and genuine consequential decisions still apply. |
| Route difficulty upfront | Easy/medium use the default owner; hard uses configured `STRONG_OWNER`. An explicit owner override wins and interrupted work preserves its recorded owner. | Difficulty describes remaining judgment, not file count or a test failure. |
| Bounded difficulty advice | Preparation submits up to eight grounded cards to Jev in one batch. Advice can raise the planner tier, with per-card uncertainty and immediate unavailable fallback. | No extra repository discovery, dispatch reassessment or automatic lowering. Thresholds are uncalibrated abstention heuristics. |
| Mechanical prepared entry | `spec_dispatch action=startup` selects a fresh package's first prepared card, resolves canonical paths, routes the owner, creates/reuses a checkout, builds a missing history index and dispatches. | Pending inbox messages require intake. Existing runtime or legacy progress requires reconciliation; process completion never means acceptance. |
| Short startup prompt | The example contains the invocation, publication outcome, package and complete model assignment section. Standing behavior lives in `spec-end-to-end`. | Add genuine run-specific exceptions; explicit selectors and authority take precedence. |

Startup does not pre-read later-stage procedures, enumerate available models or run baseline
broad checks. The coordinator loads review, assembly, tour and publication guidance when those
stages become relevant. Shared context remains in the primary checkout's `.specs`; code and
checks run in the selected checkout. Resume preserves completed work and starts with the first
unfinished obligation, including outstanding review or repair.

See [end-to-end entry](../skills/spec-end-to-end/SKILL.md),
[preparation](../skills/spec-write/references/prepare-package.md) and
[owner routing](../skills/spec-run/references/owner-routing.md).

## Implementation and lifecycle

The managed Pi runtime retains native owner/editor disk sessions across related steps. Each
model pair has its own retained sessions. Retention saves rediscovery opportunities; workers
still refresh affected source after external fixes, compaction or an anchor mismatch.

The owner chooses behavior and architecture, reads decisive source directly, and sends a
bounded `Change / Edits / Preserve / Return` packet. The editor reads current source while
editing and chooses local implementation details. Related edits can be batched; the first
settled transformation need not wait for exhaustive discovery of the entire step. This removes
routine source-reading relays and whole-file completion reports. It does not delegate open-ended
architecture or repair-until-green work.

The editor writes implementation and assigned test code. The owner runs necessary focused
checks through `spec_verify` after editor return, diagnoses failures and assesses the diff.
Commit is a separate editor assignment after that assessment. `spec_question` and `spec_answer`
carry a concrete decision over pi-intercom while the same editor retains its writer reservation.
There is no replacement writer during the exchange.

Package and checkout leases exclude other managed implementation writers. Detached process
groups are registered before a stdin gate opens. Cancellation revokes the lease, terminates
registered groups with bounded TERM/KILL attempts and releases ownership only after termination
is confirmed. A different coordinator cannot kill a stale PID from a historical record. Unknown
cleanup retains ownership and requires recovery; leases are coordination controls for managed
workers, not a sandbox against arbitrary external processes.

`spec_verify.server` owns a foreground server from readiness through capture and cleanup.
It accepts loopback HTTP(S) readiness, refuses an already responding endpoint, and does not
hand the writer back while its server survives. Commands preserve pipeline failures, including
literal nested Bash wrappers. Raw logs remain available behind bounded diagnostic excerpts.
Observed dependency/build/configuration paths inform setup without claiming compatibility or
authorizing shared writable output.

Review corrected two lifecycle defects: editor abort now escalates termination and returns a
fatal receipt even if stdout remains open; surviving editor descendants and streamed fatal
command receipts request coordinator cancellation. Monitor directory notifications now handle
coalesced events and schedule one bounded refresh per event-loop turn. A reproduced concurrent
completion-watcher failure was resolved with this change, rather than accepted because an
isolated invocation passed.

See [runtime contract](../pi/extensions/spec-runtime/README.md),
[paired execution](../skills/spec-step-run/references/paired-execution.md) and
[owner profile](../pi/agents/spec-step-owner.md).

## Verification, review and reusable ownership

Focused local feedback answers concrete implementation and acceptance questions. Configured
CI owns broad regression and static suites; without CI, broad testing remains operator-managed
outside recorded evidence. Missing CI does not create a new local full-suite prerequisite.
Known relevant failures and retained-data/security obligations still require resolution.
Reused results retain their actual observed revision, scope and applicability to the candidate.

The implementation/fix owner batches Jev calls at verification and actionable review-triage
checkpoints. Managed owners use structured `spec_advice`, avoiding temporary JSON files and
editor handoffs. The CLI/MCP route remains available for other roles. Advice is bounded,
conservative and optional when unavailable; it never establishes a pass or waives acceptance.
Local reports aggregate observed advice/fallback calls without claiming savings.

Independent reviews cover each completed step at fixed revisions while later implementation
continues. Findings have one compact representation with stable identities, concrete impact,
reviewed range and material limitations. Fixers run between implementation assignments through
a dedicated profile that retains both native Pi and provider adapter write tools. Finish the
last step's review/fix cycle, including the bounded final fix review over the trailing
fix range. There is no automatic final whole-branch review; explicitly
requested branch refinement remains available.

Helper, shared-value and component ownership flows from preparation into cards and editor
packets. Step reviews make bounded searches in the fixed reviewed tree to detect confirmed
same-contract duplication. Local composition and deliberately different contracts are not
duplicates. The history index navigates original learnings, ownership and review records; it
does not replace those sources with another specification.

The local Warden adapter exempts only named non-executable workflow metadata from verification
invalidation. Evidence scripts, fixtures, configuration, unknown paths and symlink escapes
remain protected. Failed checks remain in the evidence history. Portable bundles now include
the runtime, profiles and shared dependencies, enumerate nested helper files in their manifest,
and describe step review completion consistently with the installed workflow.

See [verification policy](../rules/verification-and-review.md),
[Jev contract](../scripts/jev/README.md), [review guidance](reviews.md) and
[engineering ownership](../skills/spec-work-tour/references/standalone-engineering-decisions.md).

## Deterministic helpers and optional delegation

Git status/ranges, history indexes, log excerpts, lifecycle records, transcript metrics and
HTML rendering use deterministic helpers. Reuse applicable outputs instead of rebuilding
them in prompts or asking another model to recollect facts. Compact handoffs carry paths,
outcomes and unresolved decisions; details remain in canonical records.

Optional Luna scouting answers one bounded source question with exact supporting sites and
unknowns. It owns discovery, not architecture, repair, checks or a review verdict. Direct reads
remain the default for a known small region. Optional Mercury clerical work transforms a small
approved fact packet into prose with fresh context and a one-minute deadline; its caller
assesses the draft before use. Neither adds a required startup probe or fallback model switch.
Configured model identifiers are editable technical settings, not evidence of comparative
model quality.

The coordinator continues through authorized publication using completion events and the
existing stage ledger. A goal loop is optional. Stage completion, a commit or a generated tour
is a handoff, not the final requested outcome. Skill instructions cannot keep a closed session
alive; absence of a wake mechanism requires a resumable checkpoint. Ordinary publication
authority comes from a request to continue through PR publication. Further PR review, merge
and deployment remain separate operator/organization decisions.

See [fact helpers](../scripts/spec-facts/README.md),
[efficiency mechanisms](spec-workflow-efficiency.md) and
[observation guide](spec-runtime-observation.md).

## Observations and evidence limits

Observed prepared startup reached owner dispatch in roughly 29 and 34 seconds in two cases,
compared with earlier observed startup intervals of roughly four to seven minutes. These were
different tasks and run conditions; they do not establish a causal speedup. Owner preparation
still took roughly sixteen and eight minutes in separate observed cases. Poor connections
confounded some timings, so transport errors are recorded separately from engineering difficulty.
An historical transcript with literal shell wrappers now reports five test-command submissions,
five returned results, two command failures and five structured exit codes that were previously
missed. These are command observations, not suite-pass counts.

Focused review checks exercised runtime cancellation, server cleanup, prepared entry, intercom,
monitor updates, scoped scouting, deterministic facts, transcript parsing, Jev fallbacks,
Warden state and work-tour review labels. The concurrent runtime batch initially reproduced
the completion watcher failure; it passed after the fix. Live model quality, real billing totals,
all platform/process behavior, end-to-end publication and broad regression were not established
by those local checks. Offline Jev checkpoints used the documented owner fallback and did not
obtain service judgments.

Future comparisons should use matched prepared tasks, starting revisions, model selectors and
environment warmth. Measure time through accepted completion, cost coverage, repeated reads,
repair work and independent findings together. Change one intervention between runs; do not
change active workers' instructions to improve a live metric. Sentinel supervision and shared
source-memory ideas remain proposals, not shipped capabilities of this runtime.


## Runtime-owned process records

Managed Pi assignments now submit `spec_complete` instead of hand-authoring their learning.
The tool preserves recorded command outcomes/revisions and asks the owner only for material
judgments, reusable symbols and evidence applicability. Missing structured handoffs remain visible
separately from worker exit; process leases still release after confirmed termination. Independent
review/fix remains responsible for correctness.

Runtime events and artifact arrivals refresh `runtime/progress.json` and the history index.
Coordinators use `spec_checkpoint` for stage decisions and next actions, without another handwritten
ledger. State-derived context reminders survive compaction without polling models or generating
extra turns. These changes address an observed missing-learning/index-refresh failure; they do not
establish compaction as its cause or guarantee all semantic process judgments are correct.

## Corrections from recent implementation runs

Managed workers now receive separate provider, complete model ID and reasoning settings.
The runtime rejects a different resolved model before the worker makes an API request.
An editor failure with an explicit model/provider configuration diagnosis is retained for
that assignment; identical retries return the original cause for coordinator action.
Ordinary network failures and an unexplained HTTP status do not trigger that block.
This prevents repeated known configuration failures without probing model inventories or
silently switching assignments. Fixer launches must explicitly select the reviewed step's
recorded effective owner, unless the user supplies a fix-model override.

Checkpoint skill aliases use the same stage completion guards as canonical names. Artifact
references accept canonical, package-relative and repository-relative `.specs` paths while
preserving confinement and existence checks. Draft publication remains distinct from ready
publication. New human input marks earlier stage decisions for reconciliation; it does not
release a hold or imply approval. Expected future session files are not evidence.

Verification guidance reuses maintained fixtures and the existing managed server lifecycle.
A journey checks its relevant seeded/application state before expensive interactions; HTTP
success alone does not establish live-worker readiness. A setup failure sends diagnosis to
the first failing boundary instead of repeating an unchanged whole journey. Shared-helper
changes also account for existing callers and modes that a new test does not reach, including
identity and lifecycle protections already owned by a central helper.

Known dependency gaps remain explicit obligations. Coordinators may advance already-prepared
independent work while preserving step identities and deferring gates whose real producer is
unavailable. Preparation and its existing batched Jev advice now name atomicity, cross-process
ownership, cancellation/restart identity and partial-failure recovery as possible sources of
remaining hard judgment. This strengthens upfront routing without adding dispatch-time
classification or treating every concurrency-related edit as hard.

These corrections address observed failure patterns. Focused synthetic runtime checks and
instruction changes do not establish a measured reduction in live duration, cost or defects;
subsequent runs still need comparison against their actual obligations and environment.
