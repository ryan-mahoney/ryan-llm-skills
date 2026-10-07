# Step owner routing

Use this policy when a run supplies a stronger step owner or explicit step assignments.
The coordinator selects the owner; the owner retains engineering and acceptance
responsibility. This policy adds no planning stage or implementation reviewer.

## Assignments

- `DEFAULT_OWNER` selects the ordinary implementation owner. `IMPLEMENT_AGENT` remains
  its legacy alias; an explicit `DEFAULT_OWNER` takes precedence. Otherwise retain the
  run's existing owner assignment or profile/settings default.
- `STRONG_OWNER` optionally selects an owner for difficult implementation and escalation.
  The user designates this role; do not infer it from provider, price, or model name.
- Explicit per-step owner assignments override automatic selection and stay pinned
  unless the user authorizes escalation or changes the assignment.

Record exact provider/model/thinking selectors in the existing ledger and pass them on
launch. Omitted `STRONG_OWNER` preserves single-owner behavior; do not discover or invent
an upgrade. Identical selectors share one session and offer no model promotion. Editor and independent review roles keep their existing assignments. Review-fix work defaults to the relevant step's recorded implementation owner, including a promoted stronger owner; an explicit fixer override takes precedence. Do not revert review fixes to the ordinary owner merely because implementation has ended. Launch errors follow the existing setup-error policy,
not the difficulty-escalation route.

## Select at dispatch

Use the prepared canonical `Complexity:` tier (`difficulty` in `spec-steps.json`) for upfront selection. With `STRONG_OWNER` available, route `hard` to that owner from the start; settled `easy` and `medium` steps use the ordinary owner unless explicit assignments or known concrete difficulties warrant the stronger owner. User assignments stay pinned. Preparation already assesses remaining judgment from its compact grounded facts; do not repeat classification, call Jev at dispatch, gather new source merely to classify, or create a separate report. Existing prepared packages remain usable; a known consequential difficulty can justify the stronger owner without re-preparing or adding fields.

Record the selected model and a short reason with the step's existing ledger entry.
On resumption, preserve the recorded owner and promotion state; do not reclassify
interrupted work back to the default owner or reset its promotion allowance.
The stronger owner is available proactively for consequential design, contract,
concurrency or recovery judgment and poor choices that focused tests may miss.
At preparation, judge remaining atomicity, cross-process ownership, check/use races, lifetime identity across cancellation/restart, recovery after partial failure, and hidden coupling with substantial consequences that focused tests may miss. When those choices remain consequential, select the stronger owner upfront; a settled mechanical application of verified precedent need not be hard. Reuse the existing grounded difficulty and Jev batch, without a classifier, probe, or dispatch-time delay. Do not require a test failure before choosing it. Missing authority retains the
existing planning-blocker route.

## Retain pairs and transfer work

In Pi, lazily create one `spec-step-owner` session per selected model, each with its
own retained editor disk session through `spec_dispatch` and `spec_editor`. Reuse
matching inactive sessions through that runtime. Do not transfer an editor between
owners or launch idle pairs as preparation. Run steps sequentially
and keep only one code writer active, including between-step review fixers.
Reuse a pair only while both owner and editor model/tool contracts still match the
assignment; a changed editor contract requires replacing that inactive editor.

Each assignment carries the current card, history index, intervening commits since that
pair last ran, and unresolved work. Refresh affected source, including the current diff
on a mid-step transfer. A retained session's memory does not supersede those artifacts.
Harnesses using direct implementation workers apply the same selection and transfer
policy without adding an editor; where model dispatch is unavailable, surface the
capability mismatch instead of claiming to have switched models.

## Escalate from concrete evidence

Tell the ordinary owner whether the stronger assignment is available. It requests
transfer when a concrete engineering difficulty exceeds the prepared route, or a repair
attempt leaves the same failure unresolved without a new evidence-backed diagnosis.
A first test failure, slow command, or environment/setup problem alone is not a trigger.
Missing authority and contradictory requirements keep their existing decision/spec
correction routes; a stronger model cannot settle them by assumption.

Before transfer, have the current owner finish or stop its editor and return an honest
existing outcome (`checkpoint`, or `no-artifact` if appropriate), the current revision
and working changes, its editor ID, and the unresolved question with diagnostic paths.
Retain these in existing learning/ledger records. Confirm both the owner and editor are
terminated or completed before the next owner writes; a failed or unknown runtime
cancellation retains the checkout lock and blocks replacement. Preserve useful work and valid check results;
do not reset the checkout, replay implementation, or mark the step complete on transfer.

The coordinator resumes or launches the assigned stronger owner, passing that handoff.
Allow one automatic promotion per step and keep the stronger owner through completion;
do not bounce between models. If it remains stuck, use normal checkpoint, blocker, or
decision handling. Model promotion adds no retry budget, verification gates, or review
rounds. Both owners follow the same acceptance requirements and stopping rules.
