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
architecture → optional critique → spec → preparation → workspace setup
→ step implementation → independent branch refinement → work tour → PR publication
```

`spec-run` ends after step execution and pre-audit evidence assembly. `spec-branch-refine` ends with
a proven audit. `spec-work-tour` produces the final JSON/HTML verdict. The orchestrator invokes
each stage separately; callers using the individual skills must make those handoffs themselves.
See [the evidence audit guide](reviews.md) for artifact paths and proof requirements.

For a design-led change, run the design-spec authoring skills first, then pass the resulting spec
package to `spec-end-to-end`. A proposal alone uses the architecture entry route.

## Resume And Completion

```text
/spec-end-to-end resume .specs/results-export/ through PR publication
```

The agent resumes at the earliest incomplete, stale, or invalid stage. A current artifact is reused;
a filename's existence alone does not prove that it is current. Preparation hashes, audit verdicts,
and evidence revisions must still match their inputs and the implemented commit.

If work moves to a worktree, the complete destination `.specs/<feature>/` package becomes canonical.
Keep logs, captures, and other referenced files with it. The source copy is an inert handoff copy.

An implementation step may return a truthful checkpoint with unresolved findings when its skill
permits that outcome. Final refinement must resolve blocking evidence before publication. A failed
required gate cannot be converted into a successful stage to keep the run moving.

Completion means a published PR URL with evidence bound to the published HEAD. Local commits,
passing tests, a ready tour, or a pushed branch alone do not complete the run. `spec-pr` does not
merge the PR. Pending remote checks can leave a published PR not yet deployable; failed required
checks invalidate readiness and must be addressed.

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
