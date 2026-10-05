---
name: spec-step-run
description: "Implement one prepared spec step autonomously, producing its code, executable evidence, QA artifacts, learning, and commit within sourced project context, escalating consequential decisions and producing independent-review inputs."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=.specs/<feature>/spec.md step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "29"
---

# Spec Step Run

Apply [Verification and Review](../../rules/verification-and-review.md) for CI/operator ownership
and batched Jev verification/review-triage checkpoints.

Own one assigned step from the prepared package. In Pi, use the retained owner/editor
pair described in [Paired execution](references/paired-execution.md); the owner may
launch exactly one editor when assigned that mode. A direct worker performs the same
work itself without delegation. Do not begin the next step until assigned or perform
independent branch review. Use the prepared card as the execution plan, adapting only
where actual code or observed failures require it.

When the assignment includes a stronger-owner route, follow
[Step owner routing](../spec-run/references/owner-routing.md#escalate-from-concrete-evidence)
to request transfer through the coordinator. Do not launch a replacement owner yourself.

## Routed Overseer Messages

When assigned message paths, follow the shared
[recipient contract](../spec-end-to-end/references/overseer-inbox.md#recipient-contract).
Read the originals yourself, act within this skill's role and sourced authority,
and record message outcomes in your existing report. Do not consume the inbox or
write the coordinator's ledger. Continue without parent approval unless a relevant
hold or consequential unresolved decision prevents dependent work.

## Local Implementation Authority And Check-ins

Resolve ordinary implementation choices autonomously within the assigned repository and sourced
`context.md`. A branch isolates files, not external services: credentials, startup hooks and test
setup can still affect live systems. Confirm the actual targets/effects before running commands.
Report unresolved consequential choices as `decision-required` to the coordinator, with safe local
work completed and a concrete recommended decision. A standalone invocation handles that check-in
itself. Do not assume data disposability, operational authority, or material risk acceptance.

Treat the spec, subspec, named files, edit sequence, and verification commands as
evidence of intent and a strong starting route, not an exhaustive permission boundary.
Prefer a concrete evidence-bearing artifact over stopping for clarification. Follow the shared context contract for all external effects, including reversible disruption.
Stopping services, changing traffic, live migrations/resets/restores, production writes and fault
injection need explicit target/action authority. Build and verify the isolated side, prepare any
necessary later procedure, and record pending execution. A spec gate never grants permission.

## Canonical Inputs

The prompt supplies the code checkout and canonical subspec path, or feature folder
and step. Resolve paths under [Workspace Handoff](../spec-end-to-end/references/workspace-handoff.md).
Keep `.specs/` in the primary checkout; run code and checks in the implementation checkout.

On first use, read `context.md`, the spec's shared contracts and assigned step, the
matching `spec-steps.json` entry, owned `evidence-plan.json` gates, the subspec, and
applicable rules. Follow references to relevant criteria/invariants and blockers.
Reuse those inputs across assignments; load new constraints and affected sections
when they change. Read other steps only to resolve a dependency or ownership question.
Do not load the full preparation report and unrelated cards as routine startup work.

Write `learnings/step-<NNN>-learning.md` and non-committed evidence under the canonical
feature folder. Read the [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md)
when producing or interpreting evidence records; do not duplicate its schema in handoffs.

## Prior Step Handoff

Use `<spec-dir>/history-index.json` to locate introduced symbols, decisions, handoffs,
and review/fix records relevant to this step. Read the original sources for applicable
items and any unresolved or unknown entry that could affect its contracts. An index
is navigation, not authority or proof of resolution. If absent, rebuild it with
`node ~/.agents/skills/spec-run/scripts/build-history-index.mjs --spec-dir <spec-dir>`;
if unavailable or incomplete, inspect the original records for affected prior steps.
Never treat an indexing failure as an empty history. Prefer `learnings/` over historical
root-level learning copies.

Carry forward applicable unresolved defects. Confirm whether a later fix already
resolved one before acting. Fixed or validly dismissed findings are precedent;
deferred/unfixable findings remain open. Record only material handoffs and their
disposition, without copying prior reports or adding empty sections.

Resolve the target step's `visualDesign` value from its matching entry in
`spec-steps.json`. A strict boolean `true` activates the mandatory visual verification
loop below even when the subspec omits screenshot instructions. Record a disagreement
with the step's `Visual:` tag as preparation drift, but do not let that disagreement
disable the loop.

Artifact writes are atomic: write a sibling temporary file and rename it over the
destination. Markdown artifacts begin with a level-1 heading.

## Check The Assigned Card

Require the canonical inputs, a matching step in the spec/index, exactly one assigned
card with `planning.verdict: ready`, and concrete verification commands/cases. For
`visualDesign: true`, require the prepared Visual Implementation Brief. Report missing
or contradictory inputs to the planner; do not invent a substitute plan. Use a truthful
`no-artifact` or `needs-spec-correction` outcome before dependent edits.

The coordinator checks package structure once. Do not repeat a full-package audit,
compute preparation hashes, or require `preparation.json`. Ignore obsolete hash fields
in otherwise usable legacy inputs; format migration alone is not a reason to replan.

## Preserve The Plan As Evidence

Check material context changes against current project sources and return them for re-preparation.
Keep the prepared context and subspec immutable so it remains a record of the expected route;
never rewrite or replace them during implementation. Context, acceptance obligations and authority
remain binding; expected edit targets and implementation routes may adapt. Depart from its files, sequence, architecture, contracts, acceptance
mapping, or verification approach when repository evidence shows that doing so better
achieves the spec's intended outcome. Record material departures as `outcome: adapted`.

Read the relevant source/test files and applicable prior handoffs. From `criteria.md`, consume only
prose `Statement:` values. From `invariants.md`, consume only live statements not
marked superseded. Treat criteria assigned to later steps or final completion as
directional constraints, not reasons to stop the current step. Preserve them, satisfy
them early when useful, and do not claim they are complete when they are not.

For `visualDesign: true`, consume every field in the card's `Visual Implementation
Brief`. Treat the reference as authority for the named visual details, the production
repository as authority for components, tokens, architecture, semantics, and
accessibility, and the spec as authority for behavior and acceptance coverage. Do not
copy prototype-only fixtures, dependencies, shell UI, or fake data wiring.

## Implement Exactly One Step

- Start with the prepared targets, then modify any additional repository-local files
  plausibly needed for a coherent outcome.
- Preserve unrelated working code and user changes.
- Follow repository conventions and use the prepared edit sequence when it still fits.
- Reuse before writing: stop at the highest rung of the necessity ladder that holds
  (`~/.agents/rules/minimal-implementation.md`). Prefer the shortest working diff
  consistent with the spec; add no abstraction the spec does not require. Before
  adding any function, type, constant table, or similar helper the card does not
  name, use the index to locate relevant `introduced` entries and run the search in the
  Reuse section of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
  Reuse or extend an equivalent; place a new general-purpose helper in the
  repository's shared-helper location and export it there. Record
  deliberate simplifications and their known ceiling in the learning. Preserve applicable correctness coverage and safety-floor code. Reuse proof tooling; new tests,
  flags, variables, compatibility paths, and release facilities need a named present requirement.
  Return inapplicable obligations as `needs-spec-correction` in the learning and report for sourced
  correction and re-preparation rather than building
  unnecessary machinery or silently weakening a gate.
- Fix relevant pre-existing defects encountered on the same execution, ownership,
  invariant, or verification path. Pre-existence is not a reason to ask or defer.
- Implement missing wiring or work nominally assigned to a later step when it is the
  most coherent way to make the current or overall outcome real. The later step may
  then verify an already-satisfied obligation.
- Keep changes coherent, explicit, and reviewable. Avoid unrelated cleanup, but do not
  stop merely because a useful change might later be judged unnecessary.

Read and apply the Reuse and Implementation sections of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
Inspect generator/bulk-transformation defaults against the sourced domain rules when applicable;
record the command and meaningful corrections in the learning. Keep mechanical and deliberate
changes distinguishable. Evaluate defensive branches against reachable states and preserve
required fallback/security behavior. Record new follow-ups in learning prose, routing any change
to accepted scope through the planner rather than silently deferring a current obligation.

## Focused Verification And Its Stopping Rule

Execute the prepared acceptance checks after coherent edits. Risk analysis belongs
primarily in subspec preparation: labels do not require another risk inventory, a
case per label, or a pre-commit audit narrative. Add investigation or verification
when actual code, a failure, or a material departure reveals a specific acceptance
gap. Record the gap briefly with the resulting evidence. A card does not prevent
fixing a real omission or known relevant failure.

For runtime-facing behavior, use the prepared production wiring and concrete adapter
with the real application composition. Reuse a focused integration result that already
establishes reachability; add a bounded smoke check only for missing runtime evidence.
An internal fake or manually constructed, unwired component cannot establish a claimed
production path. Library-only steps may exercise their public entrypoint; a named later
integration owner is valid when the current objective does not promise runtime wiring.

Stop when the assigned checks pass and known relevant gaps are resolved. Do not rerun
passing checks without an affected change or named uncertainty, or add another harness
to account for a label. Preserve required visual observations. Reuse existing meaningful
tests or deterministic evidence; a step need not create a test file just to complete.
Apply [Unit Testing](../../rules/unit-testing.md) when changing tests and the shared
verification policy for deadlines, Jev scheduling, and CI/operator broad-check ownership.

## Produce Owned Evidence

When the card's `Targets` carry `Evidence:` lines, produce each applicable merge artifact.
For deploy/post-deploy gates, produce the named procedure and handoff. Safe isolated pre-deploy
checks may run within existing scope/authority; operations awaiting a release or authorization
remain `pending`. Do not perform live operations to make this step pass. Committed evidence such as integration tests
ships in the step's commit. Non-committed artifacts — a deterministic QA walkthrough,
screenshots, dry-run logs, benchmark output — are written atomically to
`.specs/<feature>/evidence/` under the prepared filename, with markdown artifacts
beginning with a level-1 heading. Make each artifact honest and specific: a QA
walkthrough names exact preconditions, steps, expected observations, and the EV gates
that automate each correctness claim, written
as plain procedural language — imperative mood, one instruction per sentence, condition
before its command, no "should". Label optional exploration questions as product
discovery, never required verification. Captured output names the command and context
that produced it. Record every produced
evidence path in the learning prose. Automated execution artifacts intentionally deferred to
branch review stay `pending` and do not prevent implementation completion. A step whose other required merge evidence remains unproduced is
not `as-specified` — preserve it as a truthful `checkpoint` with the gap recorded.

## Visual Steps

For `visualDesign: true`, read and apply [Visual verification](references/visual-verification.md).
This retains the prepared visual brief, real rendered inspection, correction, and
cleanup requirements. Other steps do not load this procedure.

## Run Focused Feedback

Apply Jev verification once before expensive/repeated checks for a coherent revision and
the shared Verification Scheduling And Deadlines policy. Write useful regression
coverage and run focused checks when they inform concrete implementation/debugging
choices or close unresolved acceptance questions. Select focused integration/browser checks
for the specific boundary question; reuse sufficient valid evidence. Preserve exact commands and real outcomes. On older cards that defer
all automation, record this scheduling adaptation without rewriting preparation. Never
fabricate red/green evidence or turn every edit into a full-suite run.

Observe the real changed path through the focused test when it covers application composition.
Add a bounded local startup/entrypoint smoke check only for missing runtime evidence; preserve
required visual inspection. Record each observation once and reference it where needed. Follow the shared deadlines, process ownership, and timeout diagnosis rules.

Record actual commands, selection, elapsed time, results, artifacts, and proof limits.
Intentionally deferred final checks remain `skipped`/`pending`, with reason `deferred to
branch review`, exact paths, expected observations, setup, and artifact destinations.
A failed focused check is a failure, not a deferred pass: fix it or preserve a checkpoint
with the gap. Missing required implementation or visual/runtime evidence also needs a
checkpoint. Do not rerun passing checks without an affected change or named uncertainty.

## Verify, Learn, And Commit

Inspect the changed-file list and separate unrelated user changes from the coherent
artifact. Create `<spec-dir>/learnings/` if needed and atomically write the target
`learnings/step-<NNN>-learning.md` with a fenced `learning:` YAML
block before prose:

```yaml
learning:
  version: 2
  kind: step
  step: <number>
  outcome: <as-specified | adapted | checkpoint | no-artifact | decision-required | needs-spec-correction>
  commit: <sha | none>
  verification:
    commit: <same sha or none>
    strategy: <test-first | implementation-first>
    fix_attempts: <number>
    commands:
      - command: <exact command run>
        phase: <red | green | verify>
        outcome: <pass | fail | hung | skipped>
  evidence:
    - id: <EV-n>
      status: <passed | failed | blocked | pending>
      phase: <merge | deploy | post-deploy>
      artifact: <checkout-relative path>
      rejects: <FH-n>
      proof_boundary: <what this result does and does not establish>
  introduced:
    - symbol: <new reusable function, type, or constant>
      path: <checkout-relative path>
      purpose: <one-line behavior it owns>
```

Include exactly one evidence entry per EV item owned by this step; use `evidence: []`
when none. When reusing an earlier result, add `observedCommit` and `applicability`
to its evidence entry: retain the actual execution SHA and explain why the result
still applies. Copy those fields into assembled gate records; do not represent reuse
as a new execution. List in `introduced` each new symbol another step or feature could plausibly
reuse; omit feature-private details and use `introduced: []` when none. A passed EV records its exact command in `verification.commands` and a real
artifact. Follow the YAML only with material decisions, departures, unresolved gaps,
and findings for later steps. Record evidence once; do not add positive correctness,
risk-lens, or routine process narratives. Omit empty sections. Put later-step findings
under `## Findings for subsequent steps`, with affected step/path, condition, consequence,
and next action. Do not cap unresolved findings in a way that hides an obligation. Keep prose
short and decision-bearing: do not repeat command lists from YAML, copy test logs
from evidence artifacts, or narrate routine implementation edits. Emit the learning in every
terminal case, including checkpoints, consequential decisions, no-artifact results, and already satisfied steps.
A later-phase `pending` entry records its prepared procedure and authority limit, not an observed
result. Include context decisions, deliberate omissions and any new maintained/operational burden.

Use `needs-spec-correction` when a sourced correction to intent or proof is required; return to
the owning planner before dependent work. Use `decision-required` for unresolved consequential choices; preserve a coherent local checkpoint
commit when useful and authorized, but do not claim dependent obligations complete.

Use `checkpoint` when meaningful implementation, tests, reproduction evidence, or a
concrete repair exists but implementation or required focused/visual/runtime verification
remains incomplete. Final checks intentionally deferred to CI or branch review alone do not require a checkpoint.
Use `no-artifact` only when no meaningful repository-local artifact could be produced.
Never describe missing production reachability as complete, but do not discard or hide
useful work because it is imperfect.

Before committing, inspect the diff and tests once. Confirm that the result honestly
represents its outcome, required callbacks and production paths are observed when
claimed, resources and failure paths are handled as well as the current evidence allows,
and any required final visual evidence reflects the current diff. Fix useful gaps and
repeat only checks affected by those fixes. Reuse valid focused and smoke results; keep
broad regression checks in configured CI or operator-managed outside agent evidence
under the shared policy. Stage the coherent repository-local implementation and test
artifact, excluding spec artifacts, ad hoc screenshots, and unrelated user changes, and
make one conventional commit for `as-specified`, `adapted`, or `checkpoint`, except when repository
policy requires generated output in a separate commit. In that case keep the same assigned step,
list all step commits in learning prose, and bind the existing scalar `commit` and verification
fields to the final step HEAD. Do not
begin the next indexed step.

Apply the commit guidance in [Engineering Writing](../../rules/engineering-writing.md).
Name the behavior or technical purpose actually implemented. Keep spec/step IDs in
the learning record. A checkpoint message must describe the partial result and any
material limitation without claiming the feature is complete.

## Completion Report

Return outcome, learning path, commit, retained editor ID when paired, and unresolved
decisions or material gaps. The learning and evidence artifacts hold commands, results,
changed files, and visual observations; do not repeat them in the handoff. End with no
active editor so the coordinator can safely run fixes or assign the next step.
