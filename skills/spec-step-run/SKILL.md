---
name: spec-step-run
description: "Implement one prepared spec step autonomously, producing its code, executable evidence, QA artifacts, learning, and commit within sourced project context, escalating consequential decisions and producing independent-review inputs."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=.specs/<feature>/spec.md step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "22"
---

# Spec Step Run

Implement one step from the prepared package. This is a leaf implementation skill:
do not spawn subagents, deliberately run the next indexed step, or perform the final
branch evidence audit. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Work to the intended outcome even when repository evidence shows that
the prepared route is incomplete or wrong.

## Local Implementation Authority And Check-ins

Resolve ordinary implementation choices autonomously within the assigned repository and sourced
`context.md`. A branch isolates files, not external services: credentials, startup hooks and test
setup can still affect live systems. Confirm the actual targets/effects before running commands.
Report unresolved consequential choices as `decision-required` to the coordinator, with safe local
work completed and a concrete recommended decision. A standalone invocation handles that check-in
itself. Do not assume data disposability, operational authority, or material risk acceptance.

Treat the spec, subspec, named files, edit sequence, and verification commands as
evidence of intent and a strong starting route, not an exhaustive permission boundary.
Prefer a concrete evidence-bearing artifact over stopping for clarification. Follow the shared context contract for all external effects, including reversible disruption.
Stopping services, changing traffic, live migrations/resets/restores, production writes and fault
injection need explicit target/action authority. Build and verify the isolated side, prepare any
necessary later procedure, and record pending execution. A spec gate never grants permission.

## Canonical Inputs

The prompt must identify the resolved `.specs/<feature>/` folder and target step. Read `context.md`, `spec.md`, `spec-steps.json`, `evidence-plan.json`, `spec-prepare.md`, `preparation.json`, optional criteria/invariants/blockers, the target `step-<NNN>-subspec.md`, and prior step learnings. Write the target `step-<NNN>-learning.md` there.

Resolve the target step's `visualDesign` value from its matching entry in
`spec-steps.json`. A strict boolean `true` activates the mandatory visual verification
loop below even when the subspec omits screenshot instructions. Record a disagreement
with the step's `Visual:` tag as preparation drift, but do not let that disagreement
disable the loop.

Artifact writes are atomic: write a sibling temporary file and rename it over the
destination. Markdown artifacts begin with a level-1 heading.

## Inspect Current Preparation

Before reading production code, validate sibling `preparation.json` using the
strict version 3 contract. Recompute the SHA-256 binding for `context.md`, `spec.md`,
`spec-steps.json`, `evidence-plan.json`, `spec-prepare.md`, every declared subspec, and optional
`criteria.md`/`invariants.md`. Check and record whether:

- every bound file exists and matches its lowercase SHA-256 hash;
- the evidence plan is version 2 and its context path/hash names this package's snapshot and matches `contextSha256`;
- the requested step exists in both `spec.md` and `spec-steps.json`;
- the manifest binds exactly one subspec for the requested step;
- that subspec's strict `planning` block has the same spec hash and step number and
  has `verdict: ready`;
- its strict `verification` block is complete.
- for `visualDesign: true`, the card records `Visual reference: <path | none>` and a
  complete `Visual Implementation Brief` whose screenshot plan uses Playwright only.

Missing, invalid, stale, or incomplete preparation is a provenance failure. Write a
`no-artifact` learning naming the mismatched binding and stop this step without editing
production code. Do not repair shared preparation artifacts here; rerun `spec-prepare`.
This gate prevents implementation and evidence from silently targeting different intent.

## Preserve The Plan As Evidence

Check material context changes against current project sources and return them for re-preparation.
Keep the prepared context and subspec immutable so it remains a record of the expected route;
never rewrite or replace them during implementation. Context, acceptance obligations and authority
remain binding; expected edit targets and implementation routes may adapt. Depart from its files, sequence, architecture, contracts, acceptance
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
- Reuse before writing: stop at the highest rung of the necessity ladder that holds
  (`~/.agents/rules/minimal-implementation.md`). Prefer the shortest working diff
  consistent with the spec; add no abstraction the spec does not require. Record
  deliberate simplifications and their known ceiling in the learning. Preserve applicable correctness coverage and safety-floor code. Reuse proof tooling; new tests,
  flags, variables, compatibility paths, and release facilities need a named present requirement.
  Return inapplicable obligations as `needs-spec-correction` in the learning and report for sourced
  correction and re-preparation rather than building
  unnecessary machinery or silently weakening a gate.
- Fix relevant pre-existing defects encountered on the same execution, ownership,
  invariant, or verification path. Pre-existence is not a reason to ask or defer.
- Implement missing wiring or work nominally assigned to a later step when it is the
  most coherent way to make the current or overall outcome real. The later step may
  then verify an already-satisfied obligation.
- Keep changes coherent, explicit, and reviewable. Avoid unrelated cleanup, but do not
  stop merely because a useful change might later be judged unnecessary.

Read and apply the Implementation section of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
Inspect generator/bulk-transformation defaults against the sourced domain rules when applicable;
record the command and meaningful corrections in the learning. Keep mechanical and deliberate
changes distinguishable. Evaluate defensive branches against reachable states and preserve
required fallback/security behavior. Record new follow-ups in learning prose, routing any change
to accepted scope through the planner rather than silently deferring a current obligation.

## Prove Application Reachability In Isolation

Here, production wiring means actual application composition, not the live deployment. For a
library-only deliverable, exercise its public exported entrypoint and real implementation; an
unrequested consuming application is not a required proof target. Preserve promised application
integration when it is actually part of the requested outcome.
An injected interface is not implementation evidence by itself. Fakes may replace only true external boundaries such as an editor/runtime API, child-process spawning, filesystem, clock, or network. Do not substitute a test-only internal interface for the concrete production adapter that connects the feature to the running system.

For a step that promises runtime- or user-observable behavior, trace one complete path before declaring success:

1. The actual runtime entrypoint or composition owner creates or registers the new behavior.
2. Every required internal injected interface has a concrete production implementation.
3. The downstream command, API, schema, or protocol exists and the concrete adapter uses its real contract.
4. At least one prepared focused test traverses that production composition, faking only the final external boundary.
5. The promised result is reachable and observable without manually constructing an otherwise-unwired internal controller, provider, service, or node.
6. The path works with ordinary startup/invocation prerequisites. Exercise the default path of
   new test hooks/overrides and remove relevant test-only private assigns, preloads, registrations,
   or initialization absent in normal use. Retain safe fixtures/external substitutes; never target
   live services for this check. Reuse the same gate when it already establishes this behavior.

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

## Produce Owned Evidence

When the card's `Targets` carry `Evidence:` lines, produce each applicable merge artifact.
For deploy/post-deploy gates, produce the named procedure and handoff. Safe isolated pre-deploy
checks may run within existing scope/authority; operations awaiting a release or authorization
remain `pending`. Do not perform live operations to make this step pass. Committed evidence such as integration tests
ships in the step's commit. Non-committed artifacts — a deterministic QA walkthrough,
screenshots, dry-run logs, benchmark output — are written atomically to
`.specs/<feature>/evidence/` under the prepared filename, with markdown artifacts
beginning with a level-1 heading. Make each artifact honest and specific: a QA
walkthrough names exact preconditions, steps, expected observations, and the EV gates
that automate each correctness claim, written
as plain procedural language — imperative mood, one instruction per sentence, condition
before its command, no "should". Label optional exploration questions as product
discovery, never required verification. Captured output names the command and context
that produced it. Record every produced
evidence path in the learning prose. A step whose required merge evidence remains unproduced is
not `as-specified` — preserve it as a truthful `checkpoint` with the gap recorded.

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
5. Inspect every screenshot through the eyes established by the `see` skill: view the
   image directly under `host-vision`, or relay it through `see`'s `codex-see` under
   `codex-relay`. Establish that mode once, before the first inspection, instead of
   assuming the model running this step can view images — one that cannot will
   describe a screenshot it never saw. Do not infer correctness from a successful
   capture command, DOM assertions, or snapshot bytes.
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
baselines, retain the final inspected images under `.specs/<feature>/evidence/` so they
survive as merge evidence, and terminate any server or watcher started for capture. If the first `uishot` capture launched its warm
browser, stop it after the final capture and confirm `uishot status` reports it stopped;
preserve a browser that was already running. Record the cleanup commands and outcomes.

If `uishot` and the repository's Playwright path cannot render the UI, or screenshots
can be neither viewed directly nor relayed through `see` after practical local
diagnosis, record the exact attempts and preserve
the result as `checkpoint`; passing non-visual tests does not make a `visualDesign: true`
step complete. Count visual correction cycles in `fix_attempts`. In the learning prose,
record the exact `uishot` and repository Playwright commands, target route or harness,
viewport and state coverage, screenshot paths, readiness and console evidence, what the
inspection found, corrections made, and the final visual assessment.

The final captures and deterministic scenario/setup notes are QA-tour inputs. Preserve
them under `.specs/<feature>/evidence/` with sensitive data removed. Rendered evidence
does not replace behavioral, data, policy, or production-reachability gates.

## Execute And Extend The Verification Contract

The subspec's strict `verification` block is the applicable merge verification baseline. Verify
targets, effects and authority before execution. Add checks only for a named material uncertainty;
stop when applicable claims are supported. Pending later-phase gates are not missing merge proof:

1. Follow its `strategy` exactly. For `test-first`, run the declared focused command
   at the red point, confirm the declared expected-red behavior, implement, then run
   the same command green. For `implementation-first`, implement before running it.
2. Run every applicable, safe and authorized merge command. Do not substitute an easier command merely to
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
  version: 2
  kind: step
  step: <number>
  outcome: <as-specified | adapted | checkpoint | no-artifact | decision-required | needs-spec-correction>
  commit: <sha | none>
  verification:
    commit: <same sha or none>
    strategy: <test-first | implementation-first>
    fix_attempts: <number>
    commands:
      - command: <exact command run>
        phase: <red | green | verify>
        outcome: <pass | fail | hung | skipped>
  evidence:
    - id: <EV-n>
      status: <passed | failed | blocked | pending>
      phase: <merge | deploy | post-deploy>
      artifact: <checkout-relative path>
      rejects: <FH-n>
      proof_boundary: <what this result does and does not establish>
```

Include exactly one evidence entry per EV item owned by this step; use `evidence: []`
when none. A passed EV records its exact command in `verification.commands` and a real
artifact. Follow the YAML with the step reference/Covers tags, outcome, assumptions and material
departures, a concise risk-audit and production-reachability summary covering the
declared labels/invariants, at most five concrete findings for later steps, at most
five discrepancies/risks, and the verification summary. Emit the learning in every
terminal case, including checkpoints, consequential decisions, no-artifact results, and already satisfied steps.
A later-phase `pending` entry records its prepared procedure and authority limit, not an observed
result. Include context decisions, deliberate omissions and any new maintained/operational burden.

Use `needs-spec-correction` when a sourced correction to intent or proof is required; return to
the owning planner before dependent work. Use `decision-required` for unresolved consequential choices; preserve a coherent local checkpoint
commit when useful and authorized, but do not claim dependent obligations complete.

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
make one conventional commit for `as-specified`, `adapted`, or `checkpoint`, except when repository
policy requires generated output in a separate commit. In that case keep the same assigned step,
list all step commits in learning prose, and bind the existing scalar `commit` and verification
fields to the final step HEAD. Do not
begin the next indexed step.

## Completion Report

Report the spec and step, preserved subspec path, learning path/outcome, commit hash,
changed files, every exact verification command and result, fix attempts, produced
evidence paths for any owned `Evidence:` lines, and any remaining finding or risk. For `visualDesign: true`, also report the inspected screenshot
paths, exact `uishot` and repository Playwright commands, covered viewports/states,
visual correction cycles, and final assessment or the reason rendered verification
remained incomplete.
