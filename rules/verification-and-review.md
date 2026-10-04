# Verification and Review

Apply during implementation, test execution, review fixes, and PR publication across
agent harnesses. Repository requirements and explicit user instructions take precedence.
This guide changes execution timing and triage, not acceptance scope or retained protection.

## Focused feedback and CI

Use focused local checks when they inform a concrete implementation decision, debugging,
or an unresolved behavioral acceptance question. Batch coherent edits before expensive checks.
Inspect command expansion and selectors; a filtered command can still start a broad suite.
Configured CI owns broad regression, coverage, and repository-wide static suites. Do not
repeat them locally. Without CI, broad testing remains operator-managed and outside the
agent's recorded evidence. Its absence does not require a local full-suite run, adding CI,
or blocking work completion. Do not treat a local result as CI or claim an unseen pass.
An explicit user request can authorize a broad local diagnostic; record its actual local
scope, result, and finite deadline. Known relevant failures and unresolved acceptance,
security, tenant-isolation, and retained-data obligations still require resolution.
The repository owns commands, setup, risk constraints, and required configured CI names;
explicit user direction overrides older local full-suite completion rules.

Within user-authorized publication scope, push a coherent checkpoint and open or update a
draft PR after the first meaningful implementation checkpoint so CI runs while work continues.
Do not wait for final local regression or a ready tour to publish a draft. Push subsequent
coherent commits in useful batches. A draft exposes actual progress and remaining gaps;
it does not certify readiness, authorize merge/deployment, or permit publishing secrets.
If publication is outside scope, retain the checkpoint locally. Complete the authorized work
and record actual focused evidence at the final local revision. Broad operator testing remains
outside that evidence; do not create a remote-publication or broad local-test prerequisite.

Before declaring a published candidate merge-ready or changing a draft to ready, close unresolved
acceptance and actionable review gaps and, when configured, confirm all required relevant
CI checks pass on the final pushed commit. Record the exact SHA, check/run URL, result, and scope in existing
evidence. Pending, unavailable, stale, cancelled, or failing checks are not passes. Diagnose
known relevant failures; do not classify them away to obtain green output. If no CI is
configured, state that broad testing is operator-managed and outside recorded evidence;
this alone does not block completion or ready status. A configured project-required remote
check that is unavailable still blocks remote readiness; local evidence does not waive it. Reuse valid focused results with their original revision and an applicability assessment; never
relabel an earlier execution as one on the final commit.

## Jev checkpoints

Jev supplies advisory scheduling and review triage. Call it at two decision points:

1. **Verification:** before expensive verification or repeating checks, after a coherent
   revision when the proposed checks and existing evidence can be assessed together.
2. **Review triage:** when an actionable review findings set arrives, before choosing fixes,
   dismissals, deferrals, or additional verification.

Batch once per meaningful revision or findings set, not once per command, edit, or finding.
The implementation/fix owner calls the checkpoint; coordinators reuse that result rather
than duplicating it. A materially changed plan or new findings set can warrant another call.
Jev owns the reusable questions. Supply concise, factual input covering the change/revision,
acceptance obligations, available evidence and CI state, proposed checks or review findings,
and known relevant failures. Keep sensitive data out of input and retained output.

```bash
node ~/.agents/scripts/jev/cli.mjs verification --repo /absolute/checkout --input /path/input.json
node ~/.agents/scripts/jev/cli.mjs review-triage --repo /absolute/checkout --input /path/input.json
node ~/.agents/scripts/jev/cli.mjs status
```

Use the [CLI input contract](../scripts/jev/README.md): JSON starts with
`"schema_version": 1`. Set `policy.broad_suite_owner` to `ci` for configured CI or `operator`
for operator-managed broad testing outside agent evidence. The tool must not invent CI or
turn missing CI into a broad local-run requirement.
Use `change_summary`, `acceptance_criteria`, `mandatory_gates`, `focused_checks`,
`planned_ci_checks`, `evidence`, and `findings` as applicable. Resolve mandatory gates
from current authority; do not retain a superseded local broad-suite rule as a requirement. For committed changes, supply
`base_revision` for the intended comparison so the tool sees the checkpoint's actual diff. Include
planned CI coverage so the advice can identify obligations CI will not exercise, and preserve
observed revisions so earlier evidence is not silently treated as current. Summarize coherent
finding groups within the tool's input bounds while considering every original finding.
Retain useful advice in existing learning/review evidence; no separate report is required.
`--offline` collects local facts and returns the fallback without a model call. If the tool/model is
unavailable, uncertain, or gives unusable advice, continue without waiting or escalating
solely for Jev: the main agent applies this same focused/CI scheduling policy and evaluates
findings against the sourced requirements, diff, and evidence. Record the fallback briefly.

Jev cannot certify a check passed, waive acceptance, approve residual risk, or replace an
independent audit. It cannot dismiss a real security, tenant-isolation, retained-data, or
known relevant failure to save time. Improve weak evidence for valuable behavior; do not
delete tests or weaken assertions merely to reduce verification cost. Preserve the existing
[Unit Testing Guide](unit-testing.md) and the workflow's authority and completion rules.
