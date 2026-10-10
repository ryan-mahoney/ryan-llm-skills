---
name: spec-gym
description: "Run one spec-* skill against a curated scenario with frozen inputs and compare explicitly selected models on the same workload. Use to replay a known scenario, validate the scenario library, or compare model behavior without touching live feature packages."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "list | validate [--write-index] | run --skill NAME --scenario ID --model provider/model[:thinking] [--model ...]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec Gym

Replay one curated scenario against one or more explicitly selected models. Every
cell runs in a fresh temporary Git repository and writes only under the run
directory; the scenario library and the gym checkout stay read-only. A gym run
never edits a skill or a scenario.

## Commands

Run the CLI from the gym repository:

```bash
node scripts/spec-gym/cli.mjs list
node scripts/spec-gym/cli.mjs validate
node scripts/spec-gym/cli.mjs run --skill <spec-skill> --scenario <id> --model <provider/model[:thinking]>
```

`list` prints every eligible `skills/spec-*` directory and its scenario rows, or
`no curated scenarios` when the skill has none. `validate` checks each scenario
against the contract and fails on a stale `scenarios.md`; `validate --write-index`
regenerates the index. Only one owner generates the index: never hand-edit
`scenarios.md`.

## Run a scenario

Select a ready scenario by id and pass one `--model` per cell:

```bash
node scripts/spec-gym/cli.mjs run --skill spec-step-run --scenario missing-required-context \
  --model provider/a --model provider/b
```

Options: `--repeat N` repeats every cell; `--timeout-ms N` records the run
fallback deadline in the manifest, while each scenario's required `timeout_ms` is
the effective cell deadline — inspect it before authorizing a run; `--root DIR`
overrides `tmp/spec-gym/`; `--pi PATH` selects the Pi executable;
`--editor-model`/`--scout-model` fix auxiliary selectors for managed-step cells;
`--child-extension PATH` (repeatable) passes managed child extensions. The
command refuses a draft scenario, a missing index, or an invalid selector before
it creates the run directory.

## Outcomes and labels

Each cell records an outcome: `passed` (every check passed), `failed` (a graded
check failed), `blocked` (an infrastructure or provider failure), `invalid`
(ambient-context or grader-read contamination), or `timed-out` (deadline exceeded).
The run-record `state` (`completed`, `failed`, `cancelled`, `blocked`) describes the
managed run; it is not the outcome.

The report label is `matched` only when cells share the skill hash, scenario id and
version, driver, roles, timeout, environment names and ambient context and differ
only in the tested model; anything else is `exploratory` with the differing fields
named. No run ranks or selects models.

## Cost and limits

A `cost_usd` of `null` means the provider did not price the calls; the report prints
`unknown`. It is never zero and never a free model. A managed cell whose owner is
priced but whose editor is not reports `unknown`, not the owner's partial cost.

A `managed-step` cell does not load `skills/spec-step-run/SKILL.md`: the runtime
starts the owner and editor with `--no-skills`, the `pi/agents/spec-step-owner.md`
and `spec-step-editor.md` profiles, and the prompt and tools in
`pi/extensions/spec-runtime/`. The manifest freezes those as `managed_sha256`;
compare it, not `skill_sha256`, when judging an instruction change across runs.

Temporary repositories isolate state; they are not an operating-system sandbox.
Admit only curated, trusted scenarios. The editor launched inside a managed owner
keeps the runtime's default flags; the gym sanitizes the environment and refuses
managed cells with ambient context files, but those are limits, not a sandbox.
Runs are retained under `tmp/spec-gym/<run-id>/`; the runner never deletes them.

See [scenario-contract.md](references/scenario-contract.md) for the curated scenario
format, ready rules and check semantics.
