---
name: spec-subspec-write
description: This skill should be used when the user asks to "write a subspec", "plan this step", "write a step plan", or "detail step N" for a single implementation step that already exists in a reviewed spec. Creates a minimal, code-grounded implementation plan for one step at .specs/<slug>/subspecs/<step-number>-spec.md. spec-run and spec-step-run invoke this contract per step before coding.
disable-model-invocation: true
argument-hint: "[step-number] [feature-slug or spec path (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Spec Subspec Write

Produce a minimal, code-grounded implementation plan for a **single** step of an
already-reviewed spec. The parent `spec.md` decided *what* to do and *why*; this
subspec commits to *how* — the concrete edit sequence against the code as it
exists right now.

This is a planning pass, not an analysis pass. Do not re-survey the repository,
re-derive the architecture, or revisit decisions the parent spec already made.

## Output Contract

Write the completed subspec to:

```txt
.specs/<feature-slug>/subspecs/<step-number>-spec.md
```

Create the `subspecs/` folder if it does not exist. The file name uses the step's
number from the parent spec's Implementation Steps list (e.g. step 3 →
`3-spec.md`). For a step with no numeric id, use `step-<short-slug>-spec.md`, the
same naming `spec-step-run` and `spec-step-judge` expect. Overwrite an existing file
only after producing the complete body.

## Resolve Inputs

1. **Spec folder.** When an explicit spec path or step marker is supplied — as when
   `spec-step-run` follows this contract — use it exactly and never guess. For
   standalone manual use, resolve the same way `spec-run` does: a path or
   `.specs/<slug>/` folder in `$ARGUMENTS`, else the folder named in the
   conversation, else the most recently modified `.specs/*/spec.md`.
2. **Step.** Take the step number from `$ARGUMENTS`. Read `spec.md`, locate that
   numbered step in the Implementation Steps section, and capture its full text:
   what-to-do, why, signatures/contracts, tests, and `Covers:` tags.

If the spec folder or the named step cannot be resolved, stop and report the
missing input. Do not invent a step.

## Scoped Grounding (read narrowly)

Read **only** what this one step touches:

- The exact files the step names.
- For each symbol the step modifies or calls, its current definition and immediate
  neighbors — direct callers/callees and the test file that already covers it.

Do **not** read unrelated modules, walk the whole tree, or re-establish the broader
architecture. If the step names a file that does not exist and the parent spec does
not create it in an earlier step, that is a spec defect — record it under Open
Questions and stop rather than guessing.

The point of reading is to replace the parent step's abstract references ("modify
`parseConfig`") with concrete, current facts: real symbol names, real signatures,
the real insertion point, the real test file.

### New-code exception (reuse and nativeness)

When the step creates a new function, helper, or file, two bounded look-ups are in
scope despite the read-narrowly rule:

1. **Pre-existence check.** Before planning a new implementation, search the repo
   for an existing one — by likely symbol names and by behavior keywords. If an
   equivalent exists, plan to reuse or extend it and record it in Targets. If the
   parent spec explicitly mandates a new implementation anyway, record the conflict
   under Open Questions rather than silently duplicating.
2. **Model file.** Read one existing file of the same kind that the new code should
   structurally resemble — the file the parent spec names as a pattern reference,
   or the closest sibling if it names none. Match its layout, naming, imports, and
   error idioms in the Edit Sequence.

These are a few targeted searches and one or two extra file reads, not a repo
survey. The read-narrowly rule still governs everything else.

## Required Sections

Keep it minimal. Every section is required; use "N/A" only when genuinely empty.
Do **not** restate Problem, Goal, or Architecture — those live in `spec.md`.

### 1. Step Reference

The step number, a one-line restatement of the step's objective, and its `Covers:`
tags copied from the parent spec.

### 2. Targets

The files and symbols this step touches, **as they exist now**: file paths with the
real function/type names and current signatures. Note anything the step assumed that
the code contradicts.

When the step creates new code, also record the pre-existence check result — the
existing equivalent found, or the search terms that came up empty — and the model
file chosen.

### 3. Edit Sequence

An ordered list of concrete edits — the *how* the parent step left implicit. Each
entry names the file, the symbol, and the specific change (add/replace/remove), with
the new signature or shape in the project's language where an interface changes. Order
edits so the code compiles between steps where practical (types before use).

### 4. Test Plan

The specific test cases to add or adjust and the target test file. Test behavior and
failure modes, not implementation detail. Map back to the step's `Covers:` criteria.

### 5. Open Questions & Stop Conditions

Risks, ambiguities, and explicit halt conditions: spec/code mismatches, missing
prerequisites, anything that should stop implementation rather than be improvised.
If this list contains a hard blocker, say so plainly — the implementer should stop.

## Footer

End the file with a single locator line:

```txt
Subspec: .specs/<feature-slug>/subspecs/<step-number>-spec.md (step <step-number>)
```

## Output Steps

1. Write the body to `.specs/<feature-slug>/subspecs/<step-number>-spec.md`.
2. Report the subspec path, the step it covers, and any hard blocker found.

Do not implement the step. Do not add Co-Authored-By trailers, "Generated with"
footers, or any AI model attribution.
