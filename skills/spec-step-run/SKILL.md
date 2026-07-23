---
name: spec-step-run
description: Implement one prepared spec step autonomously in its disposable branch/worktree, treating the subspec as a launchpad, producing and committing the strongest reviewable artifact possible without asking the user questions.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=.specs/<feature>/spec.md step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "18"
---

# Spec Step Run

Implement one step from the prepared package. This is a leaf implementation skill:
do not spawn subagents, deliberately run the next indexed step, or perform the final
branch review. Work to the intended outcome even when repository evidence shows that
the prepared route is incomplete or wrong.

## No-Question, Artifact-First Authority

Do not ask the user questions. The assigned branch and worktree are disposable review
environments; all reversible repository-local changes are pre-authorized. Resolve
ambiguity with best engineering judgment, implement the most plausible coherent
interpretation, and record assumptions in the learning.

Treat the spec, subspec, named files, edit sequence, and verification commands as
evidence of intent and a strong starting route, not an exhaustive permission boundary.
Prefer a concrete reviewable artifact over stopping for clarification. Do not perform
irreversible external actions such as publishing, modifying production data, spending
money, sending messages, or force-pushing shared branches; build and verify the local
side, use a safe local substitute when practical, and record the remaining external act.

## Canonical Inputs

The prompt must identify the resolved `.specs/<feature>/` folder and target step. Read `spec.md`, `spec-steps.json`, `spec-prepare.md`, `preparation.json`, optional criteria/invariants/blockers, the target `step-<NNN>-subspec.md`, and prior step learnings from that folder. Write the target `step-<NNN>-learning.md` there.

Resolve the target step's `visualDesign` value from its matching entry in
`spec-steps.json`. A strict boolean `true` activates the mandatory visual verification
loop below even when the subspec omits screenshot instructions. Record a disagreement
with the step's `Visual:` tag as preparation drift, but do not let that disagreement
disable the loop.

Artifact writes are atomic: write a sibling temporary file and rename it over the
destination. Markdown artifacts begin with a level-1 heading.

## Inspect Current Preparation

Before reading production code, validate sibling `preparation.json` using the
strict version 1 contract. Recompute the SHA-256 binding for `spec.md`,
`spec-steps.json`, `spec-prepare.md`, every declared subspec, and optional
`criteria.md`/`invariants.md`. Check and record whether:

- every bound file exists and matches its lowercase SHA-256 hash;
- the requested step exists in both `spec.md` and `spec-steps.json`;
- the manifest binds exactly one subspec for the requested step;
- that subspec's strict `planning` block has the same spec hash and step number and
  has `verdict: ready`;
- its strict `verification` block is complete.
- for `visualDesign: true`, the card records `Visual reference: <path | none>` and a
  complete `Visual Implementation Brief` whose screenshot plan uses Playwright only.

Treat missing, invalid, stale, or incomplete preparation as evidence to record, not an
automatic implementation stop. Do not repair the manifest, spec, step index, criteria,
invariants, preparation report, or subspec. When the target outcome can still be
resolved from the readable spec, subspec, prompt, repository, and prior learnings,
continue and report the preparation drift. Return `no-artifact` only when the intended
step cannot be identified or a mechanical failure makes meaningful repository-local
work impossible.

## Preserve The Plan As Evidence

Keep the prepared subspec immutable so it remains a record of the expected route;
never rewrite or replace it during implementation. Its contents do not limit the
implementation. Depart from its files, sequence, architecture, contracts, acceptance
mapping, or verification approach when repository evidence shows that doing so better
achieves the spec's intended outcome. Record material departures as `outcome: adapted`.

Read the full spec, the target subspec, applicable rules, relevant source/test files,
prior step learnings, and unresolved findings. From `criteria.md`, consume only
prose `Statement:` values. From `invariants.md`, consume only live statements not
marked superseded. Treat criteria assigned to later steps or final completion as
directional constraints, not reasons to stop the current step. Preserve them, satisfy
them early when useful, and do not claim they are complete when they are not.

For `visualDesign: true`, consume every field in the card's `Visual Implementation
Brief`. Treat the reference as authority for the named visual details, the production
repository as authority for components, tokens, architecture, semantics, and
accessibility, and the spec as authority for behavior and acceptance coverage. Do not
copy prototype-only fixtures, dependencies, shell UI, or fake data wiring.

## Implement Exactly One Step

- Start with the prepared targets, then modify any additional repository-local files
  plausibly needed for a coherent outcome.
- Preserve unrelated working code and user changes.
- Follow repository conventions and use the prepared edit sequence when it still fits.
- Fix relevant pre-existing defects encountered on the same execution, ownership,
  invariant, or verification path. Pre-existence is not a reason to ask or defer.
- Implement missing wiring or work nominally assigned to a later step when it is the
  most coherent way to make the current or overall outcome real. The later step may
  then verify an already-satisfied obligation.
- Keep changes coherent, explicit, and reviewable. Avoid unrelated cleanup, but do not
  stop merely because a useful change might later be judged unnecessary.

## Prove Production Reachability

An injected interface is not implementation evidence by itself. Fakes may replace only true external boundaries such as an editor/runtime API, child-process spawning, filesystem, clock, or network. Do not substitute a test-only internal interface for the concrete production adapter that connects the feature to the running system.

For a step that promises runtime- or user-observable behavior, trace one complete path before declaring success:

1. The actual runtime entrypoint or composition owner creates or registers the new behavior.
2. Every required internal injected interface has a concrete production implementation.
3. The downstream command, API, schema, or protocol exists and the concrete adapter uses its real contract.
4. At least one prepared focused test traverses that production composition, faking only the final external boundary.
5. The promised result is reachable and observable without manually constructing an otherwise-unwired internal controller, provider, service, or node.

Use the card's `Production wiring` and `Concrete adapter` targets when present. If a required link is absent, fake-only, deferred, or outside the prepared targets, implement or repair the smallest coherent production path rather than stopping. Green unit tests over an unreachable abstraction do not satisfy the step; preserve an honest checkpoint if the path cannot be completed.

A deliberately library-only precursor may omit runtime reachability only when its prepared acceptance coverage is non-runtime and a named later step explicitly owns integration. Record that bounded handoff; do not apply it to a step whose own objective promises reachable behavior.

## Expand Risk-Directed Verification During Execution

Read the prepared card's `Risk lenses` and `Live invariants` lines. Use them to strengthen assertions, add adversarial cases, add or update the nearest relevant tests, and run additional focused commands when that work materially improves confidence in the outcome. They guide vigilance; they are not scope limits or a demand to build abstractions merely to satisfy a label.

Before implementation, privately map each applicable label to the smallest useful boundary checks:

- `persistence-integrity` — corrupt-but-well-shaped input, mismatched metadata/hash/bytes, and restore/read validation.
- `atomic-publication` — failure immediately before and after irreversible boundaries; the prior committed state remains usable.
- `concurrency`, `lease-or-refcount`, `idempotency` — two owners/readers, stale ownership, duplicate retry/release, and repeated-call behavior.
- `cancellation` — cancellation before work, with zero loop iterations or a full cache hit, between batches, and before irreversible commit.
- `resource-budget` — total owned work, including cached or reused work, unless the spec explicitly defines a delta-only limit.
- `progress-observer` — the external observer receives ordered events and exactly one terminal outcome; an internal event array alone is insufficient.
- `filesystem-snapshot` — hashes, manifests, and derived output describe the same bytes when files may change during processing.
- `cross-step-contract` — reuse established stores, registries, path constructors, ownership, and public shapes rather than introducing private replacements.
- `external-runtime`, `security-boundary` — verify the prepared injected boundary, fail-closed behavior, and prohibited side effects.

For each prepared verification case, ensure at least one assertion observes the promised result and, when relevant, the mutation that must not occur. Use risk labels as prompts for engineering judgment: act on credible risks in the final diff and briefly dismiss irrelevant labels, but do not manufacture abstractions or tests solely to account for every label. Do not add a broad suite or a second test harness without a concrete reason.

## Render, Inspect, And Correct Visual Steps

When the target entry in `spec-steps.json` has `visualDesign: true`, treat seeing the
rendered result as required implementation work, not optional final polish:

1. Before editing, inspect any named visual reference and the applicable local design
   system and design/UX rules. Read the installed `uishot` skill completely and resolve
   its bundled launcher before the first capture. Open static reference images directly.
   For an executable reference or an existing production view reachable by URL, use
   `uishot` to capture the relevant page, region, states, and viewport sizes before
   editing so the implementation loop begins with observed pixels rather than inference.
2. Use `uishot` as the default Playwright-backed observation runner for the real changed
   UI, including when the repository has its own Playwright suite. A local app, Storybook,
   or component preview may serve the production component with its real styles. Run
   `uishot` from the worktree root, run its setup command when required, and keep its
   browser warm throughout the correction loop. `uishot` satisfies the Playwright-only
   screenshot requirement; do not classify it as a generic browser screenshot fallback.
3. Use the repository's Playwright configuration and tests for capabilities that improve
   the evidence: durable assertions, existing authentication or data fixtures, and
   interaction-driven states that `uishot` cannot create directly, such as hover, drag,
   form entry, or opening a transient surface. When those tests can establish a stable
   URL or server-side state, capture the resulting view with `uishot`; otherwise capture
   in the repository's Playwright context and inspect that image. Create a temporary raw
   Playwright runner only when neither route can produce the required state. Do not add a
   lasting Playwright dependency solely for disposable observation, and do not use
   Cypress or a non-Playwright screenshot method as a fallback.
4. Capture the smallest representative set that proves the visual outcome: at least the
   primary changed view, plus any viewport, interaction, or non-ideal state materially
   affected by the step or named acceptance criteria. Use `--wait-for`, `--wait-text`,
   or `--selector` to pin `uishot` to meaningful content, and react to its readiness,
   console-error, broken-image, and failed-request output. Reveal menus, dialogs,
   validation, focus, overflow, or responsive behavior when those are part of the
   change. When the reference is executable, capture reference and production at
   matching states and viewport sizes.
5. Open and inspect every screenshot with an image-viewing capability. Do not infer
   correctness from a successful capture command, DOM assertions, or snapshot bytes.
   Compare against the visual reference when one exists and assess hierarchy, alignment,
   spacing, typography, color and contrast, clipping, overflow, layering, content states,
   responsive behavior, and obvious interaction affordances under the project's design
   posture. Confirm the image actually contains the changed UI and is not an error,
   login, loading, blank, or stale page.
6. Fix credible defects, rerun affected behavior checks, recapture, and inspect again.
   Continue while an iteration yields new evidence or improvement. Capture and inspect
   at least one final image after the last visual code change; never call an image final
   when it predates the current implementation.

Use existing Playwright visual regression assertions when they help, but do not treat
baseline acceptance as a substitute for looking at the rendered pixels. Keep ad hoc
screenshots out of the commit unless the repository explicitly tracks Playwright visual
baselines, retain the final images as worktree-local review evidence, and terminate any
server or watcher started for capture. If the first `uishot` capture launched its warm
browser, stop it after the final capture and confirm `uishot status` reports it stopped;
preserve a browser that was already running. Record the cleanup commands and outcomes.

If `uishot` and the repository's Playwright path cannot render the UI, or screenshots
cannot be opened after practical local diagnosis, record the exact attempts and preserve
the result as `checkpoint`; passing non-visual tests does not make a `visualDesign: true`
step complete. Count visual correction cycles in `fix_attempts`. In the learning prose,
record the exact `uishot` and repository Playwright commands, target route or harness,
viewport and state coverage, screenshot paths, readiness and console evidence, what the
inspection found, corrections made, and the final visual assessment.

## Execute And Extend The Verification Contract

The subspec's strict `verification` block is the mandatory verification baseline, not
the maximum permitted verification:

1. Follow its `strategy` exactly. For `test-first`, run the declared focused command
   at the red point, confirm the declared expected-red behavior, implement, then run
   the same command green. For `implementation-first`, implement before running it.
2. Run every usable prepared command. Do not substitute an easier command merely to
   obtain green output. Add focused commands, repository-required shards, typechecks,
   or builds when needed for changed or newly discovered work. Do not run an unfiltered
   full suite merely as ritual or as a substitute for focused evidence.
3. Apply any non-obvious setup and hazards recorded in the card.
   If a command hangs, terminate the process promptly, record the hang as a failed
   attempt, and diagnose only within this step.
4. Continue diagnosing and correcting while each attempt is producing new evidence or
   meaningful progress. Do not repeat an unchanged failing approach, weaken assertions,
   or skip a required case merely to obtain green output. If the result remains
   incomplete, preserve it as a truthful checkpoint rather than asking or discarding it.

For a new test file, an initial missing-file or missing-module failure may establish the bootstrap red point, but write the risk-directed cases before production implementation and confirm the resulting red evidence represents the unimplemented behavior whenever the harness can run that skeleton.

Record the red/green sequence, exact commands, outcomes, hang termination, and
fix-attempt count in the step learning. When a prepared command is stale or cannot run,
use the nearest credible repository-specific verifier and record both the discrepancy
and the replacement evidence.

## Verify, Learn, And Commit

Inspect the changed-file list and separate unrelated user changes from the coherent
artifact. Atomically write the target step learning with a fenced `learning:` YAML
block before prose:

```yaml
learning:
  version: 1
  kind: step
  step: <number>
  outcome: <as-specified | adapted | checkpoint | no-artifact>
  commit: <sha | none>
  verification:
    commit: <same sha or none>
    strategy: <test-first | implementation-first>
    fix_attempts: <number>
    commands:
      - command: <exact command run>
        phase: <red | green | verify>
        outcome: <pass | fail | hung | skipped>
```

Follow it with the step reference/Covers tags, outcome, assumptions and material
departures, a concise risk-audit and production-reachability summary covering the
declared labels/invariants, at most five concrete findings for later steps, at most
five discrepancies/risks, and the verification summary. Emit the learning in every
terminal case, including checkpoints, no-artifact results, and already satisfied steps.

Use `checkpoint` when meaningful implementation, tests, reproduction evidence, or a
concrete repair exists but the intended outcome or verification remains incomplete.
Use `no-artifact` only when no meaningful repository-local artifact could be produced.
Never describe missing production reachability as complete, but do not discard or hide
useful work because it is imperfect.

Before committing, inspect the diff and tests once. Confirm that the result honestly
represents its outcome, required callbacks and production paths are observed when
claimed, resources and failure paths are handled as well as the current evidence allows,
and any required final visual evidence reflects the current diff. Fix useful gaps and
rerun relevant commands. Stage the coherent repository-local implementation and test
artifact, excluding spec artifacts, ad hoc screenshots, and unrelated user changes, and
make one conventional commit for `as-specified`, `adapted`, or `checkpoint`. Do not
begin the next indexed step.

## Completion Report

Report the spec and step, preserved subspec path, learning path/outcome, commit hash,
changed files, every exact verification command and result, fix attempts, and any
remaining finding or risk. For `visualDesign: true`, also report the inspected screenshot
paths, exact `uishot` and repository Playwright commands, covered viewports/states,
visual correction cycles, and final assessment or the reason rendered verification
remained incomplete.
