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
an upgrade. Identical selectors share one session and offer no model promotion. Editor, review, and review-fix roles
keep their existing assignments. Launch errors follow the existing setup-error policy,
not the difficulty-escalation route.

## Select at dispatch

Use the prepared card, relevant indexed history, and known blockers. Default to the
ordinary owner for settled implementation routes and established repository patterns.
Choose the stronger owner when consequential reasoning remains during execution:
unresolved cross-component contracts, concurrency or recovery semantics, security or
data-integrity choices within existing authority, or unfamiliar integration without a
reliable precedent. Planning may already have resolved these difficulties. Step length,
file count, or a risk label alone does not justify upgrading.

Record the selected model and a short reason with the step's existing ledger entry.
On resumption, preserve the step's recorded owner and promotion state; do not reclassify
interrupted work back to the default owner or reset its promotion allowance.
Do not score the whole package, reread all source to classify a step, dispatch a
classifier, or write a separate difficulty report. Explicit overrides support known
hard steps without requiring new card fields or rewriting prepared specs.

## Retain pairs and transfer work

In Pi, lazily create one `spec-step-owner` session per selected model, each with its
own retained `spec-step-editor`. Resume an inactive eligible matching session; otherwise
create a fresh matching session under the existing retention rules. Do not transfer a
nested editor between owners or launch idle pairs as preparation. Run steps sequentially
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
inactive before the next owner writes. Preserve useful work and valid check results;
do not reset the checkout, replay implementation, or mark the step complete on transfer.

The coordinator resumes or launches the assigned stronger owner, passing that handoff.
Allow one automatic promotion per step and keep the stronger owner through completion;
do not bounce between models. If it remains stuck, use normal checkpoint, blocker, or
decision handling. Model promotion adds no retry budget, verification gates, or review
rounds. Both owners follow the same acceptance requirements and stopping rules.
