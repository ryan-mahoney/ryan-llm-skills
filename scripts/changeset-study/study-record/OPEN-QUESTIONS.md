# Open questions and how to run them

Where the work stopped on 2026-10-17. Commands assume `export ASDF_NODEJS_VERSION=22.15.0` and these bases:

```sh
runtime="$(node ~/.agents/scripts/spec-location/cli.mjs locate agent-tooling/changeset-execution-poc | jq -r .runtime)"
parser="$runtime/combined-dispatch/02-revised-combined/frozen/scripts/changeset-study/parser/acorn.mjs"
reference="$runtime/hard-nemotron-20261016/sol-nemotron-workflow"
```

## 1. Can the default owner (DeepSeek) plan the writes for non-hard steps?

Untested on medium or easy steps: every task in the study is hard class. A stress test above the medium tier runs DeepSeek as the single-agent planner on the three hard tasks:

```sh
node scripts/changeset-study/iterate.mjs --source "$reference" --output "$runtime/stacked-optimization/<new>" \
  --ledger "$runtime/budget.json" --strategy focused-dispatch --dispatch-profile optimized-lean \
  --strong-owner-model deepseek/deepseek-flash:max --editor-model deepseek/deepseek-flash:off --parser "$parser"
```

Pass criterion for the planner: the plan validates and every packet applies. Hidden grading is the secondary signal.

Result of two runs (`e2e11-single-deepseek`, `e2e12-single-deepseek`), DeepSeek only: on the hard tasks DeepSeek is not a viable planner. Planning took 647 and 774 s per three tasks against Sol's 180–330 s, with 39–45 planner calls and 141,000–183,000 planner output tokens (reasoning at `:max`), and the plans carried errors Sol's did not: a test packet anchored on a comment the planner meant to insert itself, a packet declaring a read of the new file without an excerpt, a first packet whose writer failed syntax twice. Calibration, the simplest task, delivered in the second run (90.6 s, 3 calls) once a fidelity-gate false positive from the first run was fixed. The DeepSeek plans also exposed two gate assumptions that Sol's plans had masked: a quoted removal target after an unrelated "append" cue, and reference excerpts seeded into a new file; both are fixed (`a062542`, `89a7941`).

What this settles: `strong_owner_model` must plan hard steps. What it does not settle: whether `owner_model` can plan medium or easy steps, which still needs a task set of that class. The signal from calibration suggests it may, at a cost in planning time that this harness should measure before the policy is fixed.

## 2. Writer-attributable scoring beyond run18

The lean writers were scored against Sol writing the same packets on one plan. A second fixed plan with its own Sol writer control would show whether the match holds. Use `divergent/stacked-optimization/run.mjs` with a new `--reference` campaign.

## 3. Seam patches on moves

The seed is correct by construction; the writer's seams land first try about 60 percent of the time and the low-reasoning retry recovers most of the rest at 30–60 s. A planner-emitted layout (which excerpt goes inside which wrapper) would make most seam work deterministic. This changes the packet contract.

## 4. Handoff's test-file chain

Three sequential appends to one test file are the critical path (7–12 s each). Concurrent append-only packets composed deterministically need the planner to declare appends.

## 5. Planner repair round

`optimized-lean-repair` moved handoff's acceptance tests once in two runs at Sol usage equal to or above native. Not recommended; the richer anchor diagnostics (`11b56f2`) landed after the second run and have not been measured with it.
