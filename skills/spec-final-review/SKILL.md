---
name: spec-final-review
description: Review a completed branch or worktree for red flags, implementation concerns, and quick improvements; delegate selected edits to EDITOR_MODEL, verify them, and push within existing authority. Use for a final pre-merge sanity check or the FINAL_REVIEWER stage of spec-end-to-end.
metadata:
  version: "1"
---

# Spec Final Review

For new managed assignments, apply [Managed changeset writing](../spec-end-to-end/references/changeset-writing.md). STRONG_OWNER plans every code edit, including easy/medium steps and review fixes. Use the shared service for implementation, repairs, final review, formatting, and conflict resolution. Its managed tool and commit rules supersede direct-edit and ordinary-editor instructions below. Only already active legacy runs retain their recorded editing contract.

Give a completed implementation a fresh, whole-branch assessment. Start with this
question, rather than reconstructing the spec audit:

> Review the branch/worktree. Do you see any red flags? Do you have concerns about
> the implementation? Are there any quick opportunities for improvement?
> If changes are warranted, apply them with EDITOR_MODEL as a subagent and push
> the changes to the branch.

## Models and handoff

`FINAL_REVIEWER` owns assessment, engineering decisions, verification, and acceptance
of edits. Use a fresh session with its exact assigned model selector. `EDITOR_MODEL`
is the editing subagent; reuse the run's recorded editor when no separate override
is given (`EDITOR_AGENT` is the existing alias). With no recorded editor, Pi uses
`deepseek/deepseek-flash:low`; other harnesses use their editor default.
Record the effective selectors and pass them on every launch. Do not silently
substitute an explicitly assigned model after a launch failure.

Supply the checkout, the primary checkout (`targets[].primary` from the package's
`locations.json`), branch/base, the package ref and `package_dir` if present,
current HEAD, run constraints, and commit/push authority. Read applicable AGENTS.md
and [Verification and Review](../../rules/verification-and-review.md). Resolve the
actual comparison range and remote target; do not assume the base is `main`. All
implementation/review workers must have finished before this stage writes code.
Preserve unrelated dirty files. If they overlap the proposed edits or make the
reviewed revision ambiguous, report that concrete blocker.

In a managed Pi run, use `spec_stage` with `kind: final-review`, the prior drained
run ID, explicit FINAL_REVIEWER as `owner_model`, the recorded STRONG_OWNER and
EDITOR_MODEL, actual base, `reviews/final-review.md`, and the supplied skill/scope.
The runtime launches a fresh decision owner. It applies all edits through the shared
service, verifies, commits, and records the report through `spec_report`. The
coordinator performs any authorized push with `spec_git` after the stage drains.
Do not launch an ordinary `spec-final-editor` subagent. On another harness, require
the same service adapter; report a missing capability without direct editing.
Review-only assessment remains read-only. An active legacy run retains its recorded
launch contract until it drains.

## Assess and improve

For review-only invocations, return findings without dispatching edits, modifying
implementation, committing, or pushing. The workflow below applies repairs only
when the request authorizes them.

Inspect the branch diff and enough surrounding code/callers to assess the integrated
behavior. Follow the most consequential concerns: correctness, cross-step wiring,
failure paths, security/data boundaries, compatibility, unnecessary complexity,
and user experience where relevant. Use the spec, previous reviews, and evidence
to resolve intent or limitations, without letting their passing verdicts substitute
for your judgment. No quota of findings or exhaustive checklist is required.

Separate concrete red flags from uncertainties and optional improvements. Explain
the trigger, consequence, and supporting code for a concern. Select small changes
that materially improve the implementation and preserve accepted behavior. Keep
larger redesigns or new product scope as explicit follow-up. A real defect remains
unresolved until fixed or dismissed with evidence; do not defer it merely because
it is too large for a quick improvement. Ask only for a consequential missing decision.

For an actionable findings set, apply the Jev review-triage checkpoint once. Give
the managed service bounded Change / Edits / Preserve / Return requests with
inspected symbols and the chosen approach. STRONG_OWNER plans those writes and
EDITOR_MODEL returns scoped edits. The runtime applies them; the reviewer retains
verification and acceptance. Necessary test edits use the same service.

Inspect returned edits and run focused checks for the affected behavior. Apply
the verification/Jev policy before expensive or repeated checks, and load the
unit-testing guide when changing tests. Reuse valid evidence with its original SHA;
CI/operator broad testing remains outside this stage. Use applicable design/visual
guidance for UI edits. The reviewer retains verification and repair decisions.

Use one initial assessment and one assessment of the resulting fixes by default.
The latter checks the edits and affected integration paths, rather than restarting
whole-branch discovery. If it exposes further material problems, preserve coherent
work and report the unresolved findings at this budget; a larger budget requires
user direction. No-change is a valid successful result.

## Finish

Commit coherent task-owned fixes after checking the complete message against
[Engineering Writing](../../rules/engineering-writing.md). Commit and push only
within the invocation's authority: the supplied review/fix/push prompt and an
end-to-end publication run authorize them; review-only or local-only directions
take precedence. In a new managed run, return the report and commits after the stage
drains. The coordinator uses spec_git for any authorized safe push and verifies the
remote HEAD. Record that publication result with the report without rewriting its
reviewed ranges.
A rejected push needs ordinary reconciliation; never force-push over unknown work.
Do not merge or wait for CI. If publication is outside scope, finish locally and
report that limit without inventing a publication prerequisite.

With a spec package, keep a concise `reviews/final-review.md` in `package_dir`:
reviewed base/HEAD, exact model assignments, concerns and dispositions, changed
commits, actual focused evidence/revisions, resulting HEAD, push result, unresolved
findings, and outcome `complete` or `blocked`. Record that the same reviewer assessed
its delegated fixes. Record the assessment limit, assessments consumed, and remaining
allowance; preserve these across resume. Later material changes consume the remaining
allowance, and exhaustion requires user direction before additional assessment.
This is not a separate independent post-fix audit. Without a
package, return these facts concisely; no spec scaffolding is needed.

Refresh affected merge evidence after fixes, preserving original step-review SHAs
and linking this report as the assessment of the additional changes. Never relabel
step reviews as covering new commits. A previously generated tour is stale until
refreshed at final HEAD. If a separately requested branch-refinement result becomes
stale, respect that stage's existing budget and report the gap rather than resetting
it. The coordinator owns tour/PR refresh when called by spec-end-to-end.

Return outcome, report path if any, reviewed and final HEAD, changed commits,
verification limits, push status/remote HEAD, and unresolved concerns. A push or
exhausted budget does not make an unresolved red flag complete. A review-only outcome
means the requested assessment finished, not that reported concerns were repaired;
it cannot satisfy an end-to-end review/fix completion requirement.
