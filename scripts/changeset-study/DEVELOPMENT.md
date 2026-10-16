# Development and evaluation separation

The original changeset PoC used seven synthetic workloads to develop transactional
execution, routing and repair. Those cases are development data for this study;
their previous holdout label does not carry forward.

## Development iterations

| Iteration | Workload and observation | Decision |
|---|---|---|
| Native-agent integration pilot | One clamp task, three models, both arms: five of six candidates passed hidden checks. The Mercury changeset candidate failed; malformed JSON was retained. | Confirm native tools work on every authorized provider. Keep the failure. This sample cannot establish performance. |
| Independent source audit | Identified asymmetric review input, reviewer veto of primary acceptance, lost accounting after crashes, unbound gold validation and mutable SDK selection. | Make external tests authoritative, provide identical reviewer input, recover receipts, hash validation inputs, and pin/fingerprint the SDK. |
| Corrected integration pilot | The same development task, six cells: all six candidates passed. | Proceed to a frozen evaluation, without selecting a provider or workload based on this pilot's timing. |
| Grader completion check | A successful process exit can otherwise bypass assertions. | Require a hidden-grader completion marker; retain a regression test. |

The evaluation then freezes eight new task families, two repetitions, three models
and both arms: 96 cells. Neither implementation nor task inputs change during this
campaign. Report formatting and aggregation can be corrected without changing
recorded observations; such corrections must preserve all cells and the preregistered
outcome definitions.

## Evidence and limitations

The focused isolation, early-exit and failed-worker-accounting checks passed locally.
Every evaluation reference implementation passed both visible and hidden checks;
every initial implementation failed hidden checks. This validates these oracles
against two meaningful states, not against every possible incorrect implementation.

Jev verification and review-triage checkpoints returned an unavailable fallback because
of its daily advisory budget and excerpt limits. Main-agent judgment preserved all
acceptance obligations. The independent source review was a separately metered Sol
call. No broad test-suite or CI result is claimed.

Runtime storage retains both development campaigns, the source review and all frozen
evaluation artifacts. The campaign manifest records the exact source and SDK bytes;
the compact results are intended for review alongside the implementation and protocol.

## Stopping rule

Complete the fixed matrix before assessing the architectural result. Spending less
than $50 is permitted: a negative, mixed or scoped positive result can answer this
study's question. Do not spend the remaining allowance searching for a favorable
subset or repeatedly tuning against the evaluation cases.

## Completed campaign and evidence review

All 96 trials completed. A subsequent contract-coverage audit found six additional
regressions missed by the original grader; both the frozen and post-hoc outcomes
are retained. No candidate was retuned or rerun after evaluation feedback.

The final independent evidence review supported the bounded Sol conclusion and
requested failure-adjusted efficiency metrics for the supplemental outcomes. Those
metrics now accompany the original results. Two producer-level concerns were already
handled by the parent runner: it reconstructs accounting from receipts and reservations,
and independently labels processes beyond the deadline as timed out. These parent
corrections are present in the frozen observations; no trial was replaced.

An independent arithmetic reconciliation checked all 96 records, arm totals,
supplemental acceptance counts and cost-per-acceptance calculations. The focused
harness checks remain applicable to unchanged execution code. The study stops with
a scoped positive result for Sol and weaker reliability results for the other models,
well below the authorized spending cap.

## Hard-workload campaign preparation

The six historical workloads from `changeset-hard-workloads` were integrated for
a new campaign with Sol, native DeepSeek and Nemotron 3.5 Super VL. The completed
small-corpus results remain separate. Before any hard-phase inference, the harness
was corrected to stop the implementation timer before separately budgeted grading,
describe mounted dependencies consistently, and report the hard failure cap and
exploratory arm correctly. Five focused sandbox, accounting and deadline checks
passed; the deadline regression took about 1.75 seconds.

Nemotron's development-only clamp pilot passed both arms: native agent 8.75 seconds
and six calls; changeset 30.89 seconds and four calls. The changeset's initial plan
was malformed JSON and the single permitted repair succeeded. No prompt was tuned
using this result. These two trials establish basic provider/tool compatibility,
not comparative performance. They consumed about $0.005 in catalog estimates.

The new primary matrix is 72 cells (six tasks, three models, two arms, two repeats).
A separate 12-cell Sol/Nemotron mixed-routing matrix follows only if the existing
$50 ledger allows. It must not be pooled with the primary matched comparison.
