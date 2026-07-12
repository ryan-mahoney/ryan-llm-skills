---
name: spec-subspec-write
description: This skill should be used when the user asks to "write a subspec", "plan this step", "write a step plan", or "detail step N" for one implementation step in a prepared spec. Produces the uniquely owned, code-grounded step subspec with strict planning and verification contracts for spec-prepare to validate before implementation.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[step-number] [spec path (optional when the paths stanza is present)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "10"
---

# Spec Subspec Write

Produce a minimal, code-grounded implementation plan for exactly one step of a reviewed spec. The parent `spec.md` owns what and why; this subspec commits to how and to the focused verification contract that implementation must execute.

## Leaf-Agent Boundary and Ownership

This skill is a leaf planning task. Do not spawn, delegate to, or coordinate another subagent.

Write only the assigned **step subspec**. `spec-subspec-write` is the unique owner of initial subspec creation, and this invocation owns exactly one canonical `step-<NNN>-subspec.md`. Never edit `spec.md`, `spec-steps.json`, `criteria.md`, `invariants.md`, `spec-prepare.md`, `preparation.json`, another step's subspec, or production/test code.

The parent `spec-prepare` agent is the only writer of shared preparation artifacts and the only authority that may correct or renumber the spec. Report a mismatch through the planning verdict; do not improvise a new design.

## Canonical Paths and Inputs

Use the exact absolute paths in the **Canonical spec artifact paths** stanza:

- Read the injected `spec` path.
- Use the injected step marker and current spec SHA-256 generation.
- Write only the injected `step subspec` path in `artifactsRoot`.

When invoked standalone, the caller must supply the absolute spec and subspec paths, step number, and current lowercase SHA-256 spec hash. If any is missing, return `blocked`; never guess paths or derive a legacy folder convention.

Write the complete Markdown body to a temporary file in the destination directory, then rename it over the final path. The file begins with a level-1 heading.

## Resolve and Ground the Step

Read the full spec, then isolate the assigned numbered step including its objective, files, contracts, tests, `Covers:`, `Complexity:`, and `Visual:` tags. Confirm that the injected step number exists and that the current spec bytes match the injected hash.

Ground narrowly:

- Read every exact target file the step names.
- Read current definitions of modified/called symbols and their immediate callers/callees.
- Read the existing test file or nearest repository test precedent for the behavior.
- Read repository `AGENTS.md` test rules and any directly referenced test guidance; extract applicable runner hazards into the Test Contract.
- Read applicable rule paths injected by the parent.

Do not survey unrelated modules or re-derive architecture.

### Bounded new-code checks

When the step creates a function, helper, file, or new test harness:

1. Search with the available repository-search tools for an equivalent by exact likely symbols/literals and behavior keywords. Reuse or extend an equivalent when found; if the spec mandates duplication, return `needs-spec-correction`.
2. Read one model file of the same kind and match its naming, layout, imports, error style, and test setup.
3. For runtime behavior of a third-party/platform API, confirm semantics from installed source/types or official documentation. If it cannot be confirmed, name the assumption and return `blocked` when correctness depends on it.

These are bounded lookups, not a repository survey.

## Planning Verdicts

Choose exactly one:

- `ready` — the step fits the current code and the subspec contains a complete actionable edit plan and verification contract.
- `needs-spec-correction` — repository grounding shows that intent, acceptance coverage, prerequisites, step boundaries/order, named contracts, or target paths in the parent spec must change. State the exact correction; do not edit the parent.
- `blocked` — a required input, decision, dependency, or verifiable runtime contract is missing and cannot be resolved locally.

A mechanical difference that does not alter intent or acceptance coverage may be reflected in a `ready` edit sequence. A material difference must never be silently adapted.

## Strict Planning Block

Immediately after the H1 and a one-sentence objective, emit this YAML block with exactly these keys:

```yaml
planning:
  version: 1
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
  precedent:
    - <test file and named pattern followed>
  setup:
    - <fixture, dependency-injection seam, timer/mock setup, or "none">
  hazards:
    - <applicable repository runner hazard, or "none identified">
  expected_red: <true | false>
  max_fix_attempts: <1 | 2>
  stop_conditions:
    - <bounded halt condition>
```

No extra keys are allowed. For a `ready` verdict, every list must be non-empty, each command/test path must be concrete, `max_fix_attempts` must be 1 or 2, and the block must agree with the human Test Contract. `expected_red` must be `true` for test-first and `false` for implementation-first.

For `needs-spec-correction` or `blocked`, keep the exact block shape. Use the narrowest prospective verification known; when none can be determined, use a single explanatory list item and an exact stop condition. The parent will not publish this result as ready.

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

Do not write complete routine test bodies in the subspec. A minimal harness skeleton is allowed only when fake-timer ordering, fixture construction, or a non-obvious mock boundary is itself the key planning risk; justify that skeleton in Setup.

Set `max_fix_attempts` to at most 2. Stop conditions must require terminating a hanging focused command and blocking after the declared attempt limit instead of weakening assertions, skipping required tests, or broadening into unrelated modules.

## Required Human Sections

Keep the plan concise. Every section is required.

### 1. Step Reference

State the step number, one-line objective, and copied `Covers:` tags.

### 2. Targets

Name current files, symbols, signatures, bounded reuse-search results, model file, external behavior source, and any contradiction discovered.

### 3. Edit Sequence

Give an ordered concrete sequence. Each item names a file, symbol, and add/change/remove operation. Inline only new or changed public shapes; reference existing code rather than transcribing it.

### 4. Test Contract

Mirror the strict verification block in readable form. Include:

- Strategy and why it fits this step.
- Exact focused commands and target test files.
- Behavioral cases with expected results and acceptance-criterion mapping.
- Repository test precedent followed.
- Fixture, dependency-injection, timer, mock, or harness setup.
- Applicable AGENTS/test-guide runner hazards.
- Expected red state when test-first.
- Maximum fix attempts and explicit hang/failure stop conditions.

The YAML block is machine-readable; this section carries the repository-grounded rationale. They must not disagree.

### 5. Spec Correction or Blocker

For `ready`, write `None`. Otherwise state the exact parent-spec correction or blocking decision/evidence. Do not propose unrelated redesign.

### 6. Prior-Step Context

Copy only injected prior-step learnings relevant to these targets. Write `None` when there are none.

### 7. Open Questions & Stop Conditions

List risks and explicit halt conditions. A hard blocker must be plainly labeled.

## Footer

End with exactly:

```txt
Subspec: <absolute step subspec path> (step <step-number>)
```

## Output

Write the subspec, then report its path, step, planning verdict, verification strategy/commands, and any correction or blocker. Do not implement the step.

Do not add attribution footers or co-author trailers.
