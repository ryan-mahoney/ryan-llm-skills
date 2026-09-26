# End-to-End Spec Workflow

Use `spec-end-to-end` to take a feature goal or existing `.specs/<feature>/` package through a
published pull request. The top-level agent owns the sequence and checks each stage's handoff.
The individual skills remain the authority for their execution and evidence requirements.

## Start A Run

Install the `spec-skills` bundle, or sync this repository's skills into your harness. Start in the
target Git repository with its normal development and verification tools available. PR publication
also needs an authenticated GitHub CLI and permission to push a feature branch and create a PR.

Give the agent the desired behavior, trigger, observable result, and constraints:

```text
/spec-end-to-end add CSV export for the current filtered results. Preserve existing
permissions, support an empty result set, and use a worktree.
```

In harnesses that do not expose slash commands, ask the agent to use the `spec-end-to-end` skill in
plain language. Explicit worktree, branch, base-branch, critique, and named-agent directives apply
throughout the run.

The sequence is:

```text
project context and consequential decisions → architecture → optional critique → spec → preparation → workspace setup
→ step implementation → independent branch refinement → work tour → PR publication
```

`spec-run` ends after step execution and pre-audit evidence assembly. `spec-branch-refine` ends with
a proven audit. `spec-work-tour` produces the final JSON/HTML verdict. The orchestrator invokes
each stage separately; callers using the individual skills must make those handoffs themselves.
See [the evidence audit guide](reviews.md) for artifact paths and proof requirements.

## Run Planning Skills Individually

The individual skills remain valid entry points. No separate context skill is required for new specs.

```text
/spec-architect-initial describe the feature
/spec-architect-critics .specs/results-export/proposal.md
/spec-write .specs/results-export/
/spec-prepare .specs/results-export/
```

The critique is optional. `spec-architect-initial` establishes project context before architecture.
Later stages reuse that context and ask only about unresolved consequential decisions.

After preparation, start implementation with this request:

```text
Use spec-end-to-end for .specs/results-export/. Planning and preparation are complete;
resume from implementation through PR publication.
```

The orchestrator checks the package and reuses valid planning artifacts. It refreshes only stale or incomplete stages.
Direct `spec-run` requires a current prepared package and reports stale preparation instead of repairing it.

## Context, Scope, And Operational Authority

The standalone workflow reads `.specs/project-context.md` in the primary repository and
AGENTS-linked policy sources, then writes a `.specs/<feature>/context.md` snapshot there. On first use,
it establishes only the consequential missing facts with the user and records decisions for reuse.
See the [shared context contract and template](../skills/spec-end-to-end/references/project-context.md).
A maturity label alone is insufficient: identify users, valuable/disposable data, compatibility,
scale, release process, configuration policy, safe verification targets and authority separately.

Specs are agent instructions. People review evidence tours and make consequential product or
operational decisions; nobody is expected to catch assumptions in a spec or bugs in a diff.
Routine implementation choices stay autonomous. Missing data-preservation, compatibility, release,
cost, authority or material-risk decisions return to the coordinator as `decision-required`.
Headless runs preserve the decision and complete independent work; they do not assume permission.

Prefer the minimum sustainable implementation and least invasive sufficient proof. Existing tests,
shared gates, disposable verifiers and deterministic inspections are legitimate when they reject
credible failures. Remove inapplicable obligations with sourced rationale and re-prepare. Do not
weaken a real assertion to obtain a pass or expand verification after its material gaps are closed.
Flags, environment variables, historical migration machinery and release facilities need a present
project requirement. Confirmed disposable fixtures can use fresh-setup proof; valuable data still
needs preservation even in a developer-only project.

Merge readiness, deployment readiness, deployment authorization and post-deployment observations
are separate. The workflow ends at PR publication. Pending later-phase checks do not force live
execution, and a passing verdict does not authorize it. Stopping services or changing traffic can
be reversible and still require explicit authority. A local app/worktree may connect to production;
inspect targets and setup/teardown effects before running commands or copying environment files.

For a design-led change, run the design-spec authoring skills first, then pass the resulting spec
package to `spec-end-to-end`. A proposal alone uses the architecture entry route.

## Engineering Decisions Across Stages

The [engineering decision contract](../skills/spec-work-tour/references/standalone-engineering-decisions.md)
adds specific requirements to the existing standalone stages. It uses the current artifacts and schemas.

| Stage | Required result |
|---|---|
| Architecture | Material domain rules with sources, examples or counterexamples, and enforcement owners. |
| Specification | Rules linked to acceptance criteria and evidence. Explicit limits for the delivered slice. |
| Preparation | Concrete cases at the owning boundary, including exact endpoints and relevant default paths. |
| Implementation | Generated choices checked against domain rules. Observed results without test-only prerequisites. |
| Independent review | Concrete challenges to assumptions, with evidence and a recorded resolution. |
| Tour and PR | Important decisions, proof limits, and actionable follow-up destinations. |

Architecture resolves questions about identity, absence, ordering, ownership, and failure visibility from the request and repository.
Only unresolved choices that materially affect the result require user input. These questions do not form a mandatory questionnaire.

For example, adjacent report windows can require an exclusive end timestamp.
An event at the shared endpoint must belong to exactly one window.
The spec records that rule, and a focused regression observes the endpoint behavior.
The size of the code change does not determine the evidence needed.

Preparation places proof at the boundary that owns the behavior.
A database-generated value needs a database assertion. A mocked repository cannot establish that calculation.
Runtime evidence also covers ordinary startup or invocation.
New test overrides need a default-path case, and fixtures cannot supply internal wiring that normal execution lacks.
An existing composition test can cover this case without another harness or a live deployment.

Implementation checks generated defaults, required fields, identifiers, relationships, query scope, and public operations against the domain rules.
When repository policy requires separate generated commits, the same step owns both generated and deliberate changes.
The learning lists every step commit and binds its scalar commit fields to the final step HEAD.

### Deferred Work

The spec Notes record each deferred item with:

- The unsupported behavior and its current observable result.
- The source that permits this scope limit or accepts the residual risk.
- A later step, package, existing issue, or local brief with completion criteria.
- A revisit condition and responsible role, when known.

Temporary duplication also needs a removal condition. A permanent omission needs a reason, not a fictitious follow-up.
An unmet current acceptance criterion remains a blocker. A follow-up issue does not satisfy it.

The workflow does not create external issues without authorization.
For local briefs, the tour explains the consequential limitation and next action directly.
The PR includes them only when needed to assess the change; it does not copy the full brief or cite local spec paths.
Workers report new scope decisions through their learnings. Changes to accepted scope return to preparation before dependent work continues.

## Writing For Reviewers

Follow [Engineering Writing](../rules/engineering-writing.md) for PRs, commits, and tours.
Explain the problem and resulting behavior in plain engineering language. Keep workflow IDs,
audit history, and command inventories in supporting records. Link only material readers can
access. Tours use ordinary headings such as “What changed,” “Verification,” and “Deployment,”
with the summary visible at the top. Proposals and specs keep accurate implementation detail;
they do not inherit the brevity expected of a small PR description.

## Transition Existing Unimplemented Specs

Use `spec-upgrade` when you have specs written under an older workflow and want to update them
before starting implementation. Select one, several, or all pending specs explicitly:

```text
/spec-upgrade .specs/results-export/
/spec-upgrade .specs/results-export/ .specs/saved-searches/
/spec-upgrade all pending specs in this repository
```

It establishes shared project context once, checks each selected plan for unjustified complexity,
preserves requested behavior, and runs the writing/preparation stages needed to produce current
packages. It preserves original planning files before replacement. Consequential unknowns prompt
a check-in; partially implemented packages are flagged rather than reset. Its final report explains
material changes and identifies which packages are ready to implement. It does not implement,
commit, or publish anything.

Then invoke `spec-end-to-end` for a ready package when you want implementation to begin. This is
an optional transition skill; new specs use the ordinary sequence above.

## Resume And Completion

```text
/spec-end-to-end resume .specs/results-export/ through PR publication
```

The agent resumes at the earliest incomplete, stale, or invalid stage. A current artifact is reused;
a filename's existence alone does not prove that it is current. Context source freshness, preparation hashes, audit verdicts,
and evidence revisions must still match their inputs and the implemented commit.

Equivalent existing prose and evidence satisfy the engineering decision contract.
Missing headings alone do not require a rewrite. Missing or contradicted behavior and proof return to the owning stage for correction.

If code moves to a worktree, `.specs/<feature>/` stays in the primary repository. All spec reads
and writes, including logs, captures, reviews, and tours, use that canonical folder. Never copy it
into the worktree or use a tracked worktree copy. Run code, Git, builds, and tests in the worktree,
passing the canonical output paths explicitly. The shared workspace handoff includes a path resolver.

An implementation step may return a truthful checkpoint with unresolved findings when its skill
permits that outcome. Final refinement must resolve blocking evidence before publication. A failed
required gate cannot be converted into a successful stage to keep the run moving.

Completion means a published PR URL with evidence bound to the published HEAD. Local commits,
passing tests, a ready tour, or a pushed branch alone do not complete the run. `spec-pr` does not
merge the PR. Pending remote checks leave platform merge readiness pending; failed required
merge checks invalidate merge readiness and must be addressed.

## Goal Mode And Compact Delegation

A harness goal can keep the run active across turns. Keep its objective short and point it at the
canonical package. Store changing progress in the stage ledger and evidence artifacts. After
continuation or compaction, the agent checks that ledger against the files and current Git state.

Delegation follows user directives and the owning skill's policy. To request a stage coordinator:

```text
Use spec-end-to-end for .specs/results-export/ through PR publication. Delegate
spec-run to deepseek-flash and have it dispatch each prepared step sequentially
to a dedicated deepseek-flash worker. Keep work in the selected checkout.
```

Use agent names configured in your harness. The delegated coordinator needs permission and depth
to launch its workers. Otherwise the top-level agent retains stage coordination and dispatches
the required workers directly.

Workers keep detailed investigation, implementation, test output, and local repair in their own
assignments. Their conversational handoff is about 200 words, expanded when mandatory report
fields or material issues require it. Full required reports remain in canonical artifacts. The
parent checks the handoff contract and evidence rather than duplicating the worker's execution.
Required independent audits and integration verification still run.

Reuse a worker for follow-up within its assignment. Each prepared step still gets a dedicated
worker, and independent reviewers remain separate from implementers. The `spec-step-run` skill
prohibits further delegation by step workers.

## OpenCode Nested Delegation

OpenCode 1.18.30 supports `subagent_depth: 2` for one additional level:

```text
Primary orchestrator
└── Stage coordinator
    └── Step worker
```

Merge the following settings into your existing `~/.config/opencode/opencode.jsonc` or
`opencode.json`. Preserve existing providers, plugins, and agent fields. This example assumes that
`deepseek-flash` and `qwen-flash` are already configured subagents with usable provider/model IDs:

```json
{
  "subagent_depth": 2,
  "agent": {
    "deepseek-flash": {
      "permission": {
        "task": {
          "*": "deny",
          "deepseek-flash": "allow",
          "qwen-flash": "allow"
        }
      }
    }
  }
}
```

The depth setting caps nesting. The agent's Task permission selects which workers it can launch.
It enables that arrangement; the delegation prompt and skills decide when to use it. No extra
plugin is needed for nested Task calls. See OpenCode's [depth configuration](https://opencode.ai/docs/config/#subagent-depth)
and [Task permissions](https://opencode.ai/docs/agents/#task-permissions).

Restart OpenCode before the next run to load the configuration. Restart the server too if the
client connects to a persistent server. Start fresh delegated tasks rather than relying on old
child sessions to acquire changed permissions. Inspect the resolved settings locally with
`opencode debug config` and `opencode debug agent deepseek-flash`; configuration output can include
credentials, so share only the relevant depth and permission fields.

If delegation fails, check the resolved depth, the coordinator's Task permission, exact agent
names, and provider access. Project or managed configuration can override global settings.
`sync.sh` synchronizes skills and guidance; it does not edit OpenCode runtime configuration.
