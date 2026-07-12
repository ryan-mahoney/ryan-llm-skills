---
name: spec-prepare
description: This skill should be used when the user asks to "prepare a spec", "review and prepare the implementation plan", "make this spec implementation-ready", or "prepare spec". Reviews and corrects spec.md, derives prose guardrails and live invariants, plans every implementation step through sequential spec-subspec-write subagents, and atomically publishes preparation.json only when the complete package is current.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[feature-slug or spec path]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "10"
---

# Spec Prepare

> **Spec artifacts live in the feature document folder — outside the git checkout.** Read and write them directly at the absolute paths in the **Canonical spec artifact paths** stanza. Do not use git commands to read, compare, or recover artifact files. Diffing repository code while grounding the spec remains allowed.

Prepare the complete, immutable implementation package for a spec. This is the sole stage between spec writing and implementation. It combines code-grounded spec review, step-index reconciliation, prose guardrail and invariant derivation, and per-step subspec planning.

Preparation is one visible workflow stage but an internally ordered coordinator. The parent preparation agent is the only writer of shared artifacts: `spec.md`, `spec-steps.json`, `criteria.md`, `invariants.md`, `spec-prepare.md`, and `preparation.json`. Each step subagent may write only the one step-subspec path assigned to it. Never let subagents concurrently edit shared state.

## Non-Interactive Operation

Run to completion without user interaction. Resolve underspecified details from the repository, existing conventions, critique, and spec intent. Record genuinely indeterminate decisions as open questions in `spec.md`; a blocking ambiguity stops preparation without publishing a manifest.

Do not implement production code or write to GitHub issues.

## Canonical Inputs and Outputs

Use the exact absolute paths from the **Canonical spec artifact paths** stanza:

- `spec` — canonical `spec.md`.
- `artifactsRoot` — flat human artifact folder.
- `specPrepare` — `spec-prepare.md` preparation report.
- `criteria` — `criteria.md` prose guardrails, when the spec establishes them.
- `invariants` — `invariants.md` live cross-step or cross-phase constraints, when applicable.
- `machineStateRoot` and `step index (machine JSON)` — canonical `spec-steps.json`.
- `preparation manifest (machine JSON)` — canonical `.restory/spec/preparation.json`.

Step subspecs are the canonical `step-<NNN>-subspec.md` files in `artifactsRoot`, with step numbers zero-padded to at least three digits. Do not derive alternate folders or legacy names.

Write every Markdown artifact atomically and begin it with a level-1 heading. Write machine JSON atomically with a trailing newline. A temporary file must be in the destination directory and renamed over the final destination.

## Preparation Order

Perform these transformations in exactly this order. They are deliberately sequential because later outputs bind earlier decisions.

### 1. Resolve and invalidate

1. Resolve all injected canonical paths and confirm `spec.md` is readable.
2. Read `proposal.md` and `critique.md` from `artifactsRoot` when present.
3. **Invalidate first:** remove the canonical preparation manifest before editing any preparation artifact or launching a subagent. A missing manifest is already invalidated. Any other removal error stops the run.
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

`spec.md` is canonical. Rewrite `spec-steps.json` to contain exactly one entry per final implementation step, in ascending order, using the current strict step-index schema. Each entry's number, name, description, difficulty, and visual-design flag must match the Markdown step. The top-level `spec` path must equal the injected absolute spec path.

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

### 5. Plan every step sequentially

Invoke exactly one `spec-subspec-write` subagent for each indexed step, in ascending step order. The preparation stage's selected model is inherited by every planning subagent; there is no separate model selector.

Strict orchestration rules:

1. Never run two step-planning subagents concurrently.
2. Give the subagent the full current spec, exact step marker, canonical spec hash, canonical output path, applicable rules, and relevant prior prepared-step findings.
3. The subagent is a leaf: it must not delegate or spawn another subagent.
4. The subagent owns only its assigned `step-<NNN>-subspec.md`. The parent owns all shared artifacts and is the only agent allowed to renumber steps or alter the spec/index/guardrails/invariants/report/manifest.
5. After each subagent returns, read and validate the complete subspec before advancing. A file existing is not success.

Every result must contain strict `planning` and `verification` blocks matching the `spec-subspec-write` contract. Validate exact keys and types, the current lowercase SHA-256 spec hash, the assigned step number, the expected output filename, the verdict, and the complete Test Contract.

Handle the planning verdict before dispatching another step:

- `ready` — accept only when both strict blocks and the human Test Contract are complete and mutually consistent; then advance.
- `needs-spec-correction` — do not advance. Reconcile the reported mismatch into `spec.md`, rewrite `spec-steps.json`, regenerate guardrails/invariants when affected, compute the new spec hash, discard every already-written subspec invalidated by the correction, and rerun the same logical step against the corrected generation. If renumbering changes its number, use the new indexed number.
- `blocked` — stop immediately. Preserve the subspec as diagnostic evidence, write the failure into `spec-prepare.md`, and do not write `preparation.json`.

Any missing, malformed, mismatched, or incomplete contract is `blocked`. In particular, reject a `ready` subspec whose verification omits focused commands, test files, behavioral cases, precedent, setup, runner hazards, stop conditions, or a bounded fix-attempt limit.

### 6. Validate the complete package

After the last step, reread every final artifact. Confirm:

- The current spec hash equals every subspec's `planning.spec_sha256`.
- Step numbers are exactly the ascending `spec-steps.json` numbers.
- There is exactly one canonical subspec per indexed step and no unexpected canonical step number.
- Every planning verdict is `ready`.
- Every verification contract is valid and has a matching human Test Contract.
- Criteria contain prose `Statement` properties only.
- The report, spec, index, optional criteria/invariants, and all subspecs are final before manifest hashing begins.

### 7. Write the report and publish last

Atomically write `spec-prepare.md` on every run. Include:

- Spec path and whether it changed.
- Review changes and rationale, or an unchanged verdict.
- Step-index reconciliation.
- Guardrails and invariant counts.
- One row per step with planning verdict, subspec path, verification strategy, and focused commands.
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

## Subagent Prompt Requirements

Each sequential leaf prompt must say, in substance:

- Plan only the assigned step and write only the assigned subspec.
- Read `spec-subspec-write` fully and obey it.
- Do not spawn or delegate to another agent.
- Read only the named targets, immediate callers/callees, existing test precedent, AGENTS test guidance, and bounded new-code precedent allowed by the leaf skill.
- Return one of `ready`, `needs-spec-correction`, or `blocked`; never silently improvise around a spec/code mismatch.
- Do not implement code or modify shared preparation artifacts.

Do not dispatch the next prompt until the parent has validated and reconciled the current result.

## Output

Report the canonical paths for `spec.md`, `spec-prepare.md`, `spec-steps.json`, optional `criteria.md`/`invariants.md`, each step subspec, and `preparation.json`. State whether the spec changed, which corrections were applied, which testing strategies were selected, and whether the final manifest was published.

Do not add attribution footers or co-author trailers.
