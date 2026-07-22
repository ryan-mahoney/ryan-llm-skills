---
name: spec-subspec-write
description: This skill should be used when the user asks to "write a subspec", "plan this step", "write a step plan", or "detail step N" for one implementation step in a prepared spec, or when spec-prepare escalates a genuinely uncertain step. Produces a compact, code-grounded execution card with strict planning and verification contracts.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[step-number] [.specs/<feature>/spec.md]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "17"
---

# Spec Subspec Write

Produce a compact, code-grounded execution card for exactly one step of a reviewed spec. The parent `spec.md` owns the objective, rationale, public contracts, and acceptance coverage; do not copy them into a second plan. This skill is normally a deep-planning fallback because `spec-prepare` writes routine cards directly.

## Leaf-Agent Boundary and Ownership

This skill is a leaf planning task. Do not spawn, delegate to, or coordinate another subagent.

Write only the assigned **step subspec**. This invocation owns exactly one canonical `step-<NNN>-subspec.md`. Never edit `spec.md`, `spec-steps.json`, `criteria.md`, `invariants.md`, `spec-prepare.md`, `preparation.json`, another step's subspec, or production/test code.

The parent `spec-prepare` agent is the only writer of shared preparation artifacts and the only authority that may correct or renumber the spec. Report a mismatch through the planning verdict; do not improvise a new design.

## Canonical Paths and Inputs

Require the resolved `.specs/<feature>/spec.md`, step number, and current lowercase SHA-256 spec hash. Write only sibling `step-<NNN>-subspec.md`. If any input is missing or multiple spec folders match, return `blocked`; never guess by modification time.

Write the complete Markdown body to a temporary file in the destination directory, then rename it over the final path. The file begins with a level-1 heading.

## Resolve and Ground the Step

Read the full spec, then isolate the assigned numbered step including its objective, files, contracts, tests, `Covers:`, `Complexity:`, and `Visual:` tags. Confirm that the injected step number exists and that the current spec bytes match the injected hash.

Ground only the unresolved risk that caused escalation:

- Read every exact target file the step names.
- Read current definitions of modified/called symbols and only consequential immediate callers/callees.
- For a step that promises runtime- or user-observable behavior, read the actual entrypoint/composition owner and the concrete production adapter for each internal injected interface.
- Read the existing test file or nearest repository test precedent for the behavior.
- Read repository `AGENTS.md` test rules and directly referenced guidance only when they affect the target verifier or setup.
- Read applicable rule paths injected by the parent.
- For a `Visual: yes` step, resolve the exact `Visual reference: <file path>` selected
  by the parent, or its explicit `none` result. Inspect the production surface,
  applicable design rules, design-system primitives/tokens, closest production
  precedent, and existing Playwright configuration or nearest Playwright test.
- When a visual reference exists, inspect its entry file and local assets. Render HTML
  or application prototypes with Playwright to identify the relevant page, component,
  visible heading or stable selector, states, interactions, and viewports. Playwright
  is the only browser automation and screenshot tool for this workflow.

Do not survey unrelated modules or re-derive architecture.

Treat a prototype as authority for visual intent, the production repository as authority
for components, tokens, architecture, semantics, and accessibility, and the spec as
authority for behavior and acceptance coverage. Do not copy prototype-only fixtures,
dependencies, shell UI, or fake data wiring into production.

### Bounded new-code checks

When the step creates a function, helper, file, or new test harness:

1. Search with the available repository-search tools for an equivalent by exact likely symbols/literals and behavior keywords. Reuse or extend an equivalent when found; if the spec mandates duplication, return `needs-spec-correction`.
2. Read one model file of the same kind only when the new shape is not already fixed by the spec or an adjacent target.
3. For runtime behavior of a third-party/platform API, confirm semantics from installed source/types or official documentation. If it cannot be confirmed, name the assumption and return `blocked` when correctness depends on it.

These are bounded lookups, not a repository survey.

## Planning Verdicts

Choose exactly one:

- `ready` — the step fits the current code, every required runtime path has named production wiring and a concrete adapter, and the subspec contains a complete actionable edit plan and verification contract.
- `needs-spec-correction` — repository grounding shows that intent, acceptance coverage, prerequisites, step boundaries/order, named contracts, or target paths in the parent spec must change. State the exact correction; do not edit the parent.
- `blocked` — a required input, decision, dependency, or verifiable runtime contract is missing and cannot be resolved locally.

Prefer `ready` whenever repository evidence supports a coherent executable interpretation. Record assumptions and the best route instead of making the implementation worker ask for permission. A material difference should become `needs-spec-correction` only when the parent must update shared intent or sequencing; use `blocked` only when no meaningful implementation artifact could be planned from the available outcome and repository.

For `Visual: yes`, use `needs-spec-correction` when the canonical step description does
not name the user-visible surface and outcome, the exact reference and relevant region or
states when one exists, or the production precedent when none exists. Also use it when
multiple reference variants exist and the parent spec does not select one.

## Strict Planning Block

Immediately after the H1 and a one-sentence objective, emit this YAML block with exactly these keys:

```yaml
planning:
  version: 2
  spec_sha256: <64 lowercase hexadecimal characters matching current spec bytes>
  step: <integer >= 1 matching the assigned step>
  output_file: <canonical step-NNN-subspec.md basename>
  verdict: <ready | needs-spec-correction | blocked>
```

No extra keys are allowed. The output basename and zero-padded number must match the canonical path. A hash, number, filename, or verdict mismatch makes the result invalid.

## Strict Verification Block

Emit this second YAML block with exactly these keys and types:

```yaml
verification:
  strategy: <test-first | implementation-first>
  commands:
    - <exact focused command>
  test_files:
    - <repository-relative test file>
  cases:
    - <observable behavior and expected result>
```

No extra keys are allowed. For a `ready` verdict, every list must be non-empty and each command/test path must be concrete. The shared `spec-step-run` policy owns execution-time adaptation, additional verification, hang handling, and checkpoint behavior; do not turn this card into a permission whitelist.

For `needs-spec-correction` or `blocked`, keep the exact block shape. Use the narrowest prospective verification known; when none can be determined, use one explanatory item in each list. The parent will not publish this result as ready.

### Select the strategy deliberately

Use `test-first` for:

- New observable behavior or state transitions.
- Parsers, validation, reducers, and error contracts.
- Bug fixes that need a failing regression.
- UI state/accessibility behavior that can be verified without brittle markup snapshots.

Use `implementation-first` for:

- Mechanical renames, moves, and contract propagation.
- Deletion of retired surfaces, followed by focused absence/regression checks.
- Wiring changes whose focused test cannot compile until the contract is propagated.

Do not force red-first ceremony onto mechanical work. Conversely, do not choose implementation-first merely to avoid writing a useful behavioral test.

### Focused commands only

Every ready plan names exact commands scoped to the changed behavior: a test file, test-name filter, targeted typecheck/build command, or similarly bounded verifier. Never emit an unfiltered full-suite command such as bare `bun test` or `bun run test`. Do not replace repository-specific commands with a generic command.

For a `Visual: yes` step, name an exact focused Playwright command and repository-relative
Playwright test file when Playwright already exists or the step owns the smallest required
setup. Storybook may be the served render target, but Playwright must drive the browser and
capture every screenshot; do not plan Cypress or another screenshot mechanism.

For a step that promises runtime- or user-observable behavior, include at least one case that starts at the actual production entrypoint/composition, crosses the concrete internal adapter, and observes the promised result. Fakes may replace the final external boundary, but a test that manually constructs the new controller/provider/service behind an interface with no production implementation is not sufficient. A deliberately library-only precursor may defer wiring only when its own acceptance coverage is non-runtime and a named later step explicitly owns integration.

Do not write complete routine test bodies in the subspec. A minimal harness skeleton is allowed only when fake-timer ordering, fixture construction, or a non-obvious mock boundary is itself the key planning risk; justify that skeleton in Setup.

## Compact Human Sections

After the two machine blocks, include only:

### Targets

Name each file, symbol or public shape, and add/change/remove action. Include reuse-search or external-behavior evidence only when it resolved the escalated risk.

Treat these as the best expected starting targets, not an exhaustive list of files the implementation worker may touch.

For every `Visual: yes` step, include this exact target line using the same
checkout-relative entry-file path as `spec.md`, or `none` when preparation found no
prototype or reference design:

```txt
Visual reference: .specs/<feature>/<prototype-or-visual-references>/<entry-file>
```

When no reference exists, use this line instead:

```txt
Visual reference: none
```

Never replace a concrete reference with instructions to recreate, reinterpret, or newly
prototype the design.

For runtime-facing work, include these exact target lines:

```txt
Production wiring: <runtime entrypoint or composition owner path/symbol>
Concrete adapter: <production implementation path/symbol for internal injected interfaces | none — direct production call>
```

If either required target is absent and the step cannot own it without changing protected scope, use `needs-spec-correction` or `blocked`; do not defer it as a later risk.

### Visual Implementation Brief

Include this section only for `Visual: yes`, after `Targets` and before `Edit Sequence`,
using these exact fields:

```txt
Relevant reference: <page/route plus visible heading, stable selector, states, and interactions | none>
Reference authority: <what must match; what prototype-only shell, fixtures, or dependencies to ignore>
Production surface: <route and component path/symbol>
Reuse: <existing components, tokens, and closest production precedent>
Behavior mapping: <prototype fixtures/interactions to real data, state, actions, and focus behavior>
UX obligations: <relevant loading/empty/error/partial states, feedback, keyboard/a11y, and responsive behavior>
Viewports: <named viewport sizes that expose the intended layout>
Playwright plan: <existing config/test, server or Storybook target, route/fixture, selectors, and screenshot paths>
```

Make every value concrete and step-specific; use `none` only when genuinely inapplicable.
The Playwright plan must cover the smallest representative set of states and viewports and
must render both executable reference and production UI when a runnable reference exists.

### Edit Sequence

Give a short ordered launch sequence. Each item names a file, symbol, and operation. Inline only new or changed public shapes; reference existing code rather than transcribing it. The implementation worker may depart from this route when repository evidence supports a more complete outcome.

For `Visual: yes`, begin by opening the selected reference or production precedent and
its relevant region, then map it to the named production components and behavior before
editing. End with the focused Playwright capture-and-inspection loop.

### Setup and Hazards

Include only non-obvious fixture, dependency-injection, timer, mock, runner, migration, or external-runtime details needed by the implementor. Write `None` when no special handling applies. State which true external boundary may be faked; an internal adapter required for production reachability must remain concrete.

When criteria or cross-step ownership apply, include concise lines for `Establish now:`, `Preserve:`, and `Later/final:`. A named later owner is a handoff, not a reason for the current worker to stop or ask; the worker may satisfy it early when that produces a more coherent implementation.

For medium or hard steps, end this section with the exact lines below, using only context already required to ground the step:

```txt
Risk lenses: <comma-separated labels | none>
Live invariants: <comma-separated invariant IDs | none>
```

Use only these risk labels: `persistence-integrity`, `atomic-publication`, `concurrency`, `lease-or-refcount`, `idempotency`, `cancellation`, `resource-budget`, `progress-observer`, `filesystem-snapshot`, `cross-step-contract`, `external-runtime`, and `security-boundary`. List only live invariants the step establishes, consumes, or can violate. Do not add repository searches or broaden the plan solely to classify risk; these labels route execution-time verification and do not create new behavior.

### Correction or Blocker

For `ready`, omit this section. Otherwise state the exact parent-spec correction or genuine blocking decision/evidence. Do not propose unrelated redesign.

Do not mirror the verification YAML in prose, repeat `Covers:` tags, or add empty prior-context and open-question sections.

## Footer

End with exactly:

```txt
Subspec: .specs/<feature>/step-<NNN>-subspec.md (step <step-number>)
```

## Output

Write the subspec, then report its path, step, planning verdict, verification
strategy/commands, visual-reference and Playwright-plan summary when applicable, and any
correction or blocker. Do not implement the step.

Do not add attribution footers or co-author trailers.
