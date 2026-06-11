---
name: spec-criteria
description: This skill should be used when the user asks to "compile review criteria", "generate spec criteria", "compile the conformance checklist", "build guardrails from the spec", or "spec criteria". Compiles a frozen spec's normative prose into an executable conformance checklist at .specs/<slug>/criteria/, blind to any implementation of that spec, and accumulates cross-phase ownership invariants in .specs/<slug>/invariants.md.
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
---

# Spec Criteria

Compile a reviewed, frozen spec into a conformance checklist that `spec-audit` can execute after implementation. Acceptance criteria are already verified by tests; this skill captures everything tests structurally cannot see: ownership directives ("validation stays store-owned"), negative constraints ("no parser definitions in appServer.ts"), and licensed deviations from precedent ("mirror X, except these deltas"). A behaviorally-silent violation of these passes every test — the checklist is the only artifact that can catch it.

Run this after `spec-review` passes and before `spec-run`. The same checklist may be injected into implementer prompts as guardrails; for negative constraints, teaching to the test is the point.

## Resolve the Spec

Resolve the spec target in this order:

1. If `$ARGUMENTS` is a path to a markdown file, use that file.
2. If `$ARGUMENTS` names a folder under `.specs/`, use `.specs/<feature-slug>/spec.md`.
3. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and use the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md`.
4. If no argument is provided, use the most recently modified `.specs/*/spec.md`.

If no local spec can be resolved, stop and report the missing input. Local `spec.md` is canonical; GitHub issues are optional mirrors.

Capture the phase when one exists: a `(phase N)` marker in the spec footer, a "Phase N of M" line in the body, or a phase number in the issue title. Phased specs write `criteria/phase-<n>.md`; unphased specs write `criteria.md`.

## Blindness Rule

This skill is one half of an epistemic firewall. Criteria compiled while reading the implementation get anchored by the implementation — the compiler will harmonize spec and code instead of pinning the spec. Therefore:

- Compile only from spec artifacts (`spec.md`, `proposal.md`, `critique.md`, `invariants.md`) and from pre-existing precedent code the spec cites.
- Never read the implementation of this spec: no branch diff, no file the spec marks `(new)`, no commits referencing this spec or its issue. If implementation already exists when this skill runs, do not open it; record `compiled blind: implementation existed but was not read` in the criteria header.
- Reading precedent code is required, not forbidden: when the spec says "mirror `server/skillStore.ts`" or cites `appServer.ts` line ranges, read those files — at the baseline the spec references — because diff targets cannot be compiled without them. Precedent is pre-existing code; the firewall applies only to code written to satisfy this spec.

## Classify Every Normative Statement

Walk Architecture, Design decisions, Notes, and Implementation Steps sentence by sentence. A statement is normative when it constrains the implementation: "stays", "only", "no", "must not", "exactly", "lives in", "owned by", "intentionally differ", "unlike", "do not", "instead of". Restated acceptance criteria and purely descriptive prose are not separate criteria.

Assign each normative statement exactly one verification mode:

- **T — Tested.** The behavior is pinned by an acceptance criterion and its tests. Record the statement and its AC mapping in the T register; compile no check. CI owns it. Excluding T items is what keeps the audit sharp — most of the spec is T, and re-auditing it dilutes the rest.
- **G — Greppable tripwire.** Ownership or negative constraints expressible as a symbol, literal, or import allowlist. Compile to a concrete search command with an exact expected hit set. Duplication tripwires belong here: any rule, pattern constant, or error-message literal the spec assigns to one owner becomes "this symbol is referenced only in these files".
- **D — Precedent-diff.** "Mirror X, except these deltas." Compile to a diff target (the precedent file or block, with its location) plus the licensed-delta list, enumerated exhaustively from the spec with a quote per delta. At audit time, any divergence between the new code and the precedent that is not on the list is a finding — so compile the list completely; a missed delta produces a false positive at audit, which is the safe failure direction.
- **S — Structural judgment.** Absence or placement claims that need a careful read rather than a grep: "no parser definitions in this file", "handlers contain no domain validation", "this module stays pure". Compile to a yes/no question plus the exact files to read.
- **X — Cross-phase invariant.** Ownership boundaries that outlive this phase: where a category of logic lives, which layer owns a decision, what a later phase must not relocate. Compile a G or S check for the current phase **and** append the invariant to the ledger (below).

When a statement fits two modes, prefer the cheaper deterministic one (G over D over S) and note the residual judgment in the S question only if the grep cannot carry it alone.

## Compile the Checklist

Write `.specs/<feature-slug>/criteria/phase-<n>.md` (or `criteria.md`). Structure:

1. A header recording: spec source and phase, baseline commit (`git rev-parse HEAD` at compile time), the blindness statement, and counts per mode.
2. One block per compiled criterion:

```markdown
### C-3 (G) — slug validation stays store-owned
Source: §4 Architecture — "Once the slug is decoded, slug validation stays store-owned: OutputStyleValidationError maps to 422."
Check: rg -n "OUTPUT_STYLE_SLUG_PATTERN|OUTPUT_STYLE_SLUG_MAX_LENGTH" server/appServer.ts
Expect: no matches outside import statements.
Violation means: slug validation duplicated at the route layer instead of delegated to the store.
```

3. For D criteria, the block carries the precedent location and the licensed-delta table:

```markdown
### C-7 (D) — routes mirror the /skill-files block
Source: §2 — "mirroring the landed /skill-files surface".
Diff target: server/appServer.ts /skill-files route block (≈ lines 1500–1660 at baseline).
Licensed deltas (each quoted from the spec):
| Delta | Quote |
| --- | --- |
| GET/:slug, POST, PUT return { style } envelope | "output-style GET /:slug, POST, and PUT return { style }" |
| POST returns 200, not 201 | "POST returns status 200, not 201" |
| DELETE returns 204 with no body | "DELETE returns new Response(null, { status: 204 })" |
Any other divergence from the precedent block is a violation.
```

4. A **T register**: the skipped tested statements, each with its AC mapping, so the auditor never re-derives what tests already own.

Quality bar: every G check must be runnable verbatim; every D check must name a findable diff target; every S check must pose a question answerable yes/no from named files. A criterion the auditor cannot execute mechanically or answer decisively is a compilation defect — rewrite it.

## Update the Invariants Ledger

Append every X-mode invariant to `.specs/<feature-slug>/invariants.md`, creating the file on first use. Per entry: the invariant statement, the establishing phase, the source quote, and a suggested check (G command or S question). The ledger is append-only across phases: never delete or rewrite earlier entries; if a later spec genuinely supersedes one, mark it `superseded by phase <n>` with the licensing quote and leave the original text intact.

The ledger exists because phase boundaries are where ownership violations happen: a constraint established in phase 1 ("validation lives in the store") is most at risk during phase 2, whose own spec may only mention it in passing. `spec-audit` checks the entire ledger on every phase, not just the current phase's criteria.

## Discipline

- Recompiling against an unchanged `spec.md` should reproduce the same checklist. If `spec.md` changed since the last compile, recompile fully and overwrite; note the new baseline commit.
- Do not invent constraints the spec does not state. The checklist pins the spec, not your preferences; a missing constraint is spec feedback for `spec-review`, not something to smuggle in here.
- Do not compile criteria for other phases' scope, except via the ledger.

## Report

Summarize in conversation: criteria counts per mode, ledger entries added, T-register size, and the paths written.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
