# Reducing repeated workflow work

Use deterministic helpers for facts and mechanical transformations, Jev for bounded
scheduling/triage advice, and the assigned owner/reviewer for engineering decisions.
Do not add a helper call when its answer is already available and applicable.

| Work | Existing or new mechanism | When to use |
|---|---|---|
| Canonical package/worktree paths | `skills/spec-end-to-end/scripts/resolve-spec-path.mjs` | Resolve the package once; reuse the handoff. |
| Prior learning/review navigation | `skills/spec-run/scripts/build-history-index.mjs` | Build once initially and after changed learning/review/fix artifacts. |
| Git state and explicit revision ranges | `scripts/spec-facts/cli.mjs git` | Replace repeated status/file-list/range collection. |
| Large command output | Managed command excerpts; `scripts/spec-facts/cli.mjs log` elsewhere | Preserve raw logs; inspect missing ranges rather than rerun. |
| Evidence-plan schema | `skills/spec-work-tour/scripts/validate-evidence-plan.mjs` | Validate a new or changed plan; schema validity is not behavioral evidence. |
| CI facts | `scripts/verification/ci.mjs` | Read configured CI at the relevant publication boundary. |
| Work-tour rendering | `skills/spec-work-tour/scripts/render-work-tour.mjs` | Render sourced evidence; do not ask a model to recreate the renderer. |
| Process completion, exclusive writer, cancellation | `pi/extensions/spec-runtime` | Runtime owns these facts; no model polling or inferred completion. |
| Verification/review scheduling | Jev CLI/MCP; managed owner `spec_advice` | One batch at the shared policy checkpoints; reuse applicable advice. |
| Jev effectiveness | `scripts/jev/cli.mjs report` | Inspect observed calls and uncertainty, without a service request. |

The [fact helpers](../scripts/spec-facts/README.md) and [Jev contract](../scripts/jev/README.md)
document their inputs and limits. An owner calls `spec_advice` directly with `task` and
version-1 `input`; its assigned checkout is fixed by the runtime. This removes shell
quoting, temporary input files and editor handoffs solely to ask Jev. The runtime
excludes editor/check activity while collecting Jev context. Coordinators and reviewers
retain the existing CLI/MCP route and reuse the implementation/fix owner's checkpoint.

Jev needs the actual change and the decision to make: acceptance obligations, concrete
candidate checks or actionable findings, evidence with its original revision and scope,
and broad-suite ownership. Supply `base_revision` for committed work. An empty clean
checkout without a base cannot explain the change. Truncated, redacted or missing context
remains uncertain; do not lower safeguards or repeatedly ask the same question to obtain
a confident answer. Context reason codes distinguish these cases for later tuning.
Uncertain/unavailable advice falls back to the owner under the existing policy.

## Optional clerical model

Pi's `spec-clerk` profile uses `openrouter/inception/mercury-2.5:high`, with only `read`
and no nested workers. A coordinator may invoke it through the installed `subagent`
tool with `agent: spec-clerk`, `context: fresh`, `async: false`, `timeoutMs: 60000`,
the code checkout as `cwd`, and a small explicit source packet. Example task:

```text
Draft a PR summary in at most 1200 characters from these approved facts: [facts].
Preserve these unresolved limitations: [limitations].
Return the draft only. No repository exploration or additional claims.
```

Use this for enough prose transformation to offset a handoff, outside the step's edit
loop. Do not send raw repositories or large transcripts. A deterministic renderer owns
formatting that has a fixed template; the clerk handles optional language compression.
The caller assesses the draft before publication. One attempt, no automatic model
substitution or repair conversation: if it fails, draft directly. It never chooses Git
actions, verification scope, fixes or readiness. No new required model selector or
startup availability probe is added. Live quality and net savings remain unmeasured.

## Candidate experiment: shared source memory

A future oracle could retrieve source-backed answers from a small persistent store,
then dispatch a scout for a missing answer. Store the question, paths/symbols, exact
supporting excerpts, checkout/revision and explicit uncertainty. Dirty-file changes
must invalidate affected facts; a matching commit alone is insufficient. Keep answers
about source facts separate from engineering decisions. A small model could phrase a
retrieved answer; the scout supplies new evidence. This is not enabled yet: compare
repeated reads avoided, stale-answer frequency, caller rechecking, latency and cost
before adding another default agent or a large retained context.

Step fixes use the installed `spec-step-fixer` write-capable profile, preserving the
assigned model and both native Pi and provider command/patch tools. The owner can
dispatch the first settled bounded transformation before discovering every later
step detail; owner decisions, exclusive writes and checks after editor return still apply.

The local Warden adapter exempts only named non-executable spec/report metadata
from code-verification invalidation. Evidence scripts, fixtures, configuration and
unknown paths remain protected; existing failed checks are retained. Run
`node scripts/verification/install-warden.mjs` after a Warden upgrade. It refuses
unfamiliar classifier signatures and only affects subsequently loaded sessions.
Metrics distinguish session-bound PR submission, structured coordinator completion
claims and activity after completion; none establishes independent acceptance.

## Upfront step difficulty: bounded Jev advice

Normal preparation now classifies remaining implementation judgment rather than file
count. A direct mechanical precedent is easy; bounded adaptation with settled contracts
is medium; consequential design, concurrency or recovery judgment, including choices
focused tests can miss, is hard. The final `Complexity:` tag remains authoritative and
`spec-steps.json` mirrors it. Initial tiers set grounding budgets; refining them keeps
completed grounding. A configured `STRONG_OWNER` handles hard steps upfront.

The installed `pi-typesafe` 0.9.1 typed API and its
[authoritative API documentation](https://github.com/DevMortimer/pi-typesafe/blob/main/docs/api.md)
provide `ask`, Choice/Noul questions, a persisted usage ledger, explicit timeout and
bounded request configuration. The
[package README](https://github.com/DevMortimer/pi-typesafe)
recommends independent narrow questions, batching and a no-match choice; it cautions
against tasks requiring reasoning across steps. These support an advisory rubric
application to already grounded facts, rather than delegating architecture to Jev.
The adapter uses default TypeSafe model `jev-latest`; actual model IDs are returned
when the service succeeds. No alternative backend or model was tested.

`step-difficulty` submits up to eight compact prepared steps in one request with two
questions each: sufficient context and easy/medium/hard/unclear. Planner tiers stay
local to reduce anchoring. The shared five-second deadline, one-attempt policy and
usage caps apply. No Git snapshot, diff or extra repository exploration is collected.
Per-step raw distributions expose ambiguity; 0.8/0.2 thresholds only govern abstention.
They have not been calibrated against downstream implementation quality. Advice can
raise the planner tier, never automatically lower it. The planner can independently
correct an overestimate from grounded evidence. An unavailable response ends further
advisory requests in that preparation invocation; planner judgment handles remaining
steps. No extra classification stage, report or dispatch reassessment is required.

Observed on 2026-10-05: one authorized synthetic batch containing a mechanical rename,
bounded handler adaptation and subtle lease-transfer case returned `budget` in 229 ms.
No service judgment or model ID was obtained; the caps were preserved with no retry.
This establishes a working budget fallback, **not** predictive usefulness, accuracy,
model latency or savings. Eighteen focused adapter tests passed in 5.83 seconds, including
existing verification/triage contracts, real offline MCP transport, no repository reads,
independent batch uncertainty, planner floor, malformed answers, budget fallback and
private-fact exclusion from the enum-only ledger. An offline verification checkpoint
returned planner fallback (128 ms; current unrelated diff exceeded excerpt bounds).
Broad testing remains operator-managed outside this evidence. Future actual review/fix
outcomes can inform evaluation; passing checks alone do not establish decision quality.
