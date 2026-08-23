---
name: specops-run-spec
description: Implement a SpecOps implementation spec as sequential commits with owned executable evidence, converge contract/integration/drift gates, and emit a commit-bound HTML architecture, proof, QA, and deployment tour.
disable-model-invocation: true
argument-hint: "[spec-file]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# SpecOps Run Spec

Implement every step from a SpecOps implementation spec and establish deploy readiness without relying on human review or required manual QA. Read [the shared executable-evidence contract](../spec-work-tour/references/executable-evidence.md).

Each step produces one coherent commit plus its owned EV gate results. After implementation, independently converge conformance, contract, real-seam integration, and behavioral-drift evidence. Every completed run emits a browser-ready work tour.

## Inputs And Evidence Package

Resolve an explicit implementation spec path. If omitted, infer exactly one matching `docs/specops/specs/*.md`; stop on ambiguity. Require:

- the implementation spec;
- sibling `<spec-basename>.evidence.json`, valid under `validate-evidence-plan.mjs`;
- its source analysis spec and latest conformance verdict;
- repository standards and `AGENTS.md`.

Use `docs/specops/evidence/<spec-slug>/` for run artifacts:

```text
docs/specops/evidence/<spec-slug>/
├── run-manifest.json
├── steps/step-<NNN>.json
├── gates/<EV-id>.*
├── conformance.*
├── integration.*
├── drift.*
├── blockers.json
├── work-tour.json
└── work-tour.html
```

Write atomically. Do not store secrets, production data, or sensitive captures. Confirm the working tree is clean before starting; unrelated changes would corrupt commit/evidence provenance.

## Validate Intent Before Code

1. Run the shared evidence-plan validator.
2. Confirm every acceptance criterion and material analysis invariant maps AC → CL → FH → EV.
3. Confirm every EV item has exactly one owner step and every step's `Evidence:` tags match.
4. Require the latest `specops-spec-conformance` result to have no material deferred decision and to bind current spec/analysis hashes.
5. Reassess posture against current repository reality. If risk increased, strengthen the plan through `specops-make-spec`/conformance before implementation. Never weaken it to accommodate missing tooling.

Any mismatch blocks code generation; regenerate the spec/evidence plan rather than improvising untraceable proof.

## Execute Sequentially

Process implementation steps in order. Keep steps separate unless adjacent steps share one indivisible contract and the evidence plan already assigns the same gates to that group. Never group across contracts, I/O, production wiring, migrations, security, or deployment boundaries.

For each step, delegate when the harness supports it; otherwise implement directly. The worker receives exact step text, source analysis claims, CL/FH/EV obligations, prior step results, repository standards, and this contract. Require it to:

1. Inspect the actual source and production composition before editing.
2. Implement the smallest coherent outcome, adapting only when repository evidence demands it.
3. Produce every owned gate using its exact command/environment/artifact, including real production composition and negative paths where specified.
4. For UI work, render and inspect required states/viewports/interactions, run accessibility gates, and retain sanitized QA captures/scenarios.
5. Record an honest proof boundary for every gate and never call an unavailable, red, or stale gate passed.
6. Return files, adaptations, commands/outcomes, artifacts, rejected hypotheses, QA inputs, and blockers without staging or committing.

Allow one evidence-directed fix pass when implementation or a required gate fails. If still incomplete, preserve useful local diagnosis but do not commit a partial deploy candidate; write the blocker and stop.

Inspect the diff, stage only the coherent step, and conventional-commit:

```text
type(scope): outcome (spec: <basename> step <N>)
```

After the commit, write `steps/step-<NNN>.json` bound to its full SHA with changed files, AC/CL/FH/EV IDs, exact commands/outcomes, artifacts, environments, proof boundaries, adaptations, and QA inputs. Confirm the tree is clean before the next step.

## Converge Independent Evidence

After all steps:

1. Run `specops-contract-tests` for contract gates in the evidence plan. Required tests must execute and pass.
2. Run `specops-integration-test` for normative live-path gates. Missing seams/infrastructure or failures block convergence.
3. Run `specops-implementation-drift` against the original analysis. It must bind current HEAD, have zero Critical/Important corrections, and show all required related EV gates passed. Cosmetic differences remain advisory.
4. Re-run `specops-spec-conformance` when implementation discoveries changed spec or evidence meaning.
5. Re-run affected gates after every correction. Repeat bounded correction/evidence cycles while each iteration makes material progress; default cap 10.

An implementer cannot self-approve a residual risk. Acceptance is valid only when the prepared evidence plan already records the bounded decision and the independent drift/conformance evidence confirms its boundary. At the cap or no progress, set the run blocked.

## Assemble The Work Tour

Write standard version 1 `work-tour.json` in the evidence folder, using the schema in `spec-work-tour`. It must include:

- exact HEAD/base and final ready/blocked verdict;
- original behavior/problem and before/after architecture/data flow;
- step commits and changed files;
- every AC/CL/FH/EV result with command, environment, artifact, rejected failure, observed result, proof boundary, and SHA;
- conformance, contract, integration, and drift verdicts as independent audit evidence;
- deterministic QA entrypoints, fixtures, scenarios, expected results, automated coverage, and visual captures;
- migrations, configuration, observability, compatibility, rollback/forward-fix, residual risks, and gaps.

Render it:

```bash
node ~/.agents/skills/spec-work-tour/scripts/render-work-tour.mjs \
  docs/specops/evidence/<slug>/work-tour.json \
  docs/specops/evidence/<slug>/work-tour.html
```

Open and inspect the HTML at desktop and narrow widths. Sample its claims/gates back to source artifacts. A ready verdict requires all required claims proven, all gates passed at exact HEAD, no gaps/blockers, converged drift, and a deploy-safe operational case. The renderer validates shape, not truth.

Write `run-manifest.json` last with spec/analysis/evidence-plan hashes, base/HEAD, step commits, gate artifact hashes, independent verdict paths/hashes, tour hashes, and final verdict. Any later code, test, spec, config, migration, dependency, or deploy change invalidates the manifest and tour.

## Report

Report step/commit outcomes; AC/CL/FH/EV counts and gaps; contract/integration/drift/conformance verdicts; correction iterations; QA scenario/capture counts; exact work-tour HTML/JSON paths and commit; deployment verdict, blockers, and residual risks.

Do not open or merge a PR, add attribution, or describe a blocked run as complete.
