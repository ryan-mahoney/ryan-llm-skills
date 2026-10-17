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

Pass criterion for the planner: the plan validates and every packet applies. Hidden grading is the secondary signal. `e2e11-single-deepseek` is the first such run; its result belongs here. A real answer needs an easy- or medium-class task set, which the harness does not have.

## 2. Writer-attributable scoring beyond run18

The lean writers were scored against Sol writing the same packets on one plan. A second fixed plan with its own Sol writer control would show whether the match holds. Use `divergent/stacked-optimization/run.mjs` with a new `--reference` campaign.

## 3. Seam patches on moves

The seed is correct by construction; the writer's seams land first try about 60 percent of the time and the low-reasoning retry recovers most of the rest at 30–60 s. A planner-emitted layout (which excerpt goes inside which wrapper) would make most seam work deterministic. This changes the packet contract.

## 4. Handoff's test-file chain

Three sequential appends to one test file are the critical path (7–12 s each). Concurrent append-only packets composed deterministically need the planner to declare appends.

## 5. Planner repair round

`optimized-lean-repair` moved handoff's acceptance tests once in two runs at Sol usage equal to or above native. Not recommended; the richer anchor diagnostics (`11b56f2`) landed after the second run and have not been measured with it.
