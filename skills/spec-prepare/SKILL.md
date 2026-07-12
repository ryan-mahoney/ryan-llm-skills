---
name: spec-prepare
description: This skill should be used when the user asks to "prepare a spec", "review and prepare the implementation plan", "make this spec implementation-ready", or "prepare spec". Reviews and corrects spec.md, derives prose guardrails and live invariants, writes difficulty-routed execution cards, and atomically publishes preparation.json only when the complete package is current.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[feature-slug or spec path]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "12"
---

# Spec Prepare

> **`.specs/` is standalone working state and is often gitignored.** Read and write its files directly; do not depend on git history to recover them. Diffing repository code while grounding the spec remains allowed.

Prepare the complete, immutable implementation package for a spec. This is the sole stage between spec writing and implementation. It combines code-grounded spec review, step-index reconciliation, prose guardrail and invariant derivation, and per-step subspec planning.

Preparation is one visible workflow stage owned by one capable preparation agent. That agent writes the shared artifacts and, by default, every step subspec. A `spec-subspec-write` leaf is an exceptional deep-planning fallback, not a mandatory pass for every step; when used, it may write only its assigned subspec. Never let a fallback leaf edit shared state.

## Non-Interactive Operation

Run to completion without user interaction. Resolve underspecified details from the repository, existing conventions, critique, and spec intent. Record genuinely indeterminate decisions as open questions in `spec.md`; a blocking ambiguity stops preparation without publishing a manifest.

Do not implement production code or write to GitHub issues.

## Canonical Inputs and Outputs

Resolve the spec folder from an explicit `.specs/<feature>/spec.md` or `.specs/<feature>/` argument, then the `Spec folder:` footer or conversation context. If exactly one candidate exists, use it; stop on ambiguity rather than choosing the most recently modified folder.

Keep the complete prepared package flat in that folder:

- `spec.md` — canonical spec.
- `spec-steps.json` — derived machine step index.
- `spec-prepare.md` — preparation report.
- `criteria.md` and `invariants.md` — optional prose guardrails.
- `step-<NNN>-subspec.md` — immutable execution cards.
- `preparation.json` — validity manifest, published last.

Use relative filenames and checkout-relative `.specs/<feature>/...` paths inside artifacts. Do not persist machine-specific absolute paths. Step numbers are zero-padded to at least three digits.

Write every Markdown artifact atomically and begin it with a level-1 heading. Write machine JSON atomically with a trailing newline. A temporary file must be in the destination directory and renamed over the final destination.

## Preparation Order

Perform these transformations in exactly this order. They are deliberately sequential because later outputs bind earlier decisions.

### 1. Resolve and invalidate

1. Resolve the spec folder and confirm `spec.md` is readable.
2. Read sibling `proposal.md` and `critique.md` when present.
3. **Invalidate first:** remove `preparation.json` before editing any preparation artifact or launching a subagent. A missing manifest is already invalidated. Any other removal error stops the run.
4. Do not restore or retain the old manifest on any failure.

### 2. Review and correct the spec

Ground the review in repository code. Read every existing file, type, function, API, pattern reference, and test named by the spec; new paths must be plausible beside verified precedent. Verify that critique Must Address recommendations landed or have explicit rationale.

Correct only substantive defects:

- Missing or non-substantive required sections.
- Ambiguous behavior, shapes, defaults, ordering, error handling, or side effects.
- Architecture that conflicts with real repository patterns.
- Missing acceptance coverage or non-automatable criteria.
- Steps that are not deterministic, minimal, self-contained, forward-only, or dependency ordered.
- Non-flat step numbering, mismatched `Covers:` tags, or incorrect complexity/visual flags.
- Steps large enough that independent concerns can be implemented and verified separately without a compatibility shim.

Preserve intent and voice. Do not restyle a sound spec. Re-running preparation against unchanged inputs must converge without churn.

### 3. Reconcile the step index

`spec.md` is canonical. Rewrite `spec-steps.json` to contain exactly one entry per final implementation step, in ascending order, using the current strict step-index schema. Each entry's number, name, description, difficulty, and visual-design flag must match the Markdown step. The top-level `spec` path must equal the checkout-relative path in the `Spec folder:` footer.

### 4. Derive prose guardrails and invariants

Walk Architecture, Notes, and Implementation Steps for normative statements that constrain ownership, placement, layering, negative boundaries, or licensed deviations from precedent. Do not restate acceptance criteria that tests already own and do not invent constraints.

When at least one implementation guardrail exists, atomically write `criteria.md` with:

- The spec source and SHA-256 generation hash.
- One stable heading per property.
- A `Statement:` field containing the implementation property in prose.
- A `Source:` field quoting or precisely locating the normative spec sentence.
- Optional `Applies to:` paths or steps when this narrows ownership.

`criteria.md` is implementer guidance, not an audit program. It must contain no shell commands, grep recipes, expected search-hit sets, executable verdict instructions, audit modes, or audit result schema.

When cross-step or cross-phase ownership constraints exist, atomically update `invariants.md`. Keep established live entries, append new entries with their source and establishing step/phase, and retain a superseded entry only when a later spec explicitly licenses its replacement. Preparation and final review consume only live, non-superseded entries.

If no criteria or invariants apply, ensure the corresponding artifact is absent and bind it as `null` in the final manifest. Removal happens before subspec planning so the final file set is unambiguous.

### 5. Write difficulty-routed execution cards

Use each `spec-steps.json` entry's existing `difficulty` as the default preparation budget. Process the steps in ascending order in the same preparation invocation and write one canonical `step-<NNN>-subspec.md` execution card per step:

| Difficulty | Grounding budget | Card depth |
|---|---|---|
| `easy` | Verify named paths, modified public shapes, and an exact focused command. Do not survey callers or search for precedent unless a target is missing. | Minimal |
| `medium` | Read named symbols, their immediate integration seam, and the existing target test or nearest test file. | Grounded |
| `hard` | Inspect the relevant cross-module contracts, consequential callers/callees, and test architecture. | Detailed |

Difficulty bounds effort; it does not require delegation. A hard but explicit propagation can still be planned directly. Deepen any card only when repository evidence exposes a missing target, new public or ownership boundary, ambiguous acceptance behavior, unavailable focused verifier, architecture conflict, concurrency or migration risk, destructive data change, security boundary, or uncertain external runtime contract.

Every card must contain strict `planning` and `verification` blocks matching the compact contract in `spec-subspec-write`. The parent validates hashes, step numbers, filenames, concrete targets, focused commands, and observable cases mechanically. It does not create a second prose copy of the verification contract or semantically re-judge an equivalent planner's work.

Correct locally resolvable problems directly. Accumulate spec corrections discovered while producing cards, update the spec/index/guardrails once, then regenerate only cards whose inputs or required behavior changed. A missing field or stale private symbol is a repair, not a blocker.

Use `spec-subspec-write` only when an escalation trigger remains unresolved after the bounded grounding above. The fallback leaf must return a compact card or identify the exact genuine blocker; the parent still owns all shared artifacts. Stop without publishing only for a required product decision, unavailable dependency, or irreconcilable spec/repository contract that cannot be resolved from local evidence.

### 6. Validate the complete package

After the last step, reread every final artifact. Confirm:

- The current spec hash equals every subspec's `planning.spec_sha256`.
- Step numbers are exactly the ascending `spec-steps.json` numbers.
- There is exactly one canonical subspec per indexed step and no unexpected canonical step number.
- Every planning verdict is `ready`.
- Every verification contract has concrete focused commands and observable cases.
- Criteria contain prose `Statement` properties only.
- The report, spec, index, optional criteria/invariants, and all subspecs are final before manifest hashing begins.

### 7. Write the report and publish last

Atomically write `spec-prepare.md` on every run. Include:

- Spec path and whether it changed.
- Review changes and rationale, or an unchanged verdict.
- Step-index reconciliation.
- Guardrails and invariant counts.
- One row per step with difficulty, card depth, subspec path, verification strategy, and focused commands.
- Corrections/reruns and open blockers.
- Overall outcome: `prepared` or `blocked`.

If blocked, stop after the report. Never publish a partial or failure manifest.

Only for a completely valid package, compute SHA-256 over the final file bytes and atomically publish strict version 1 `preparation.json` **as the last write**:

```json
{
  "version": 1,
  "preparedAt": "canonical ISO 8601 timestamp",
  "specSha256": "64 lowercase hex characters",
  "stepIndexSha256": "64 lowercase hex characters",
  "reportSha256": "64 lowercase hex characters",
  "criteriaSha256": null,
  "invariantsSha256": null,
  "steps": [
    {
      "step": 1,
      "subspec": {
        "file": "step-001-subspec.md",
        "sha256": "64 lowercase hex characters"
      }
    }
  ]
}
```

Use a hash string instead of `null` when the optional artifact exists. Include exactly one `steps` entry per indexed step. No keys beyond this schema are allowed. Validate all bindings immediately before rename; a changed or missing binding stops publication.

## Exceptional Deep-Planning Fallback

When an escalation trigger requires a `spec-subspec-write` leaf, its prompt must say, in substance:

- Plan only the assigned step and write only the assigned subspec.
- Read `spec-subspec-write` fully and obey it.
- Do not spawn or delegate to another agent.
- Read only the named targets, immediate callers/callees, existing test precedent, AGENTS test guidance, and bounded new-code precedent allowed by the leaf skill.
- Return one of `ready`, `needs-spec-correction`, or `blocked`; never silently improvise around a spec/code mismatch.
- Do not implement code or modify shared preparation artifacts.

Do not use fallback delegation for routine grounding, formatting, or validation work the preparation agent can complete directly.

## Output

Report the canonical paths for `spec.md`, `spec-prepare.md`, `spec-steps.json`, optional `criteria.md`/`invariants.md`, each step subspec, and `preparation.json`. State whether the spec changed, which corrections were applied, which testing strategies were selected, and whether the final manifest was published.

Do not add attribution footers or co-author trailers.
