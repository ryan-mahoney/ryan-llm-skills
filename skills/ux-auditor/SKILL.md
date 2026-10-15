---
name: ux-auditor
description: Exhaustively audit a top-level UI implementation component against an HTML prototype and produce a grouped markdown checklist of corrections. Use when a user asks for UI parity review, visual QA, design implementation audit, pixel-level drift detection, or behavior/style mismatch analysis between prototype HTML and shipped component code. Uses the Luna relay for visual inspection without loading screenshots into the audit session.
disable-model-invocation: true
license: MIT
metadata:
  version: "2"
---

# UX Auditor

Audit an implemented UI against a prototype with element-by-element rigor.
Produce a correction-first checklist that is grouped, actionable, and explicit
about current vs expected behavior.

Read `references/audit-spec.md` in this skill directory before reporting. It
holds the deviation taxonomy, severity scale, output format, and design-system
uncertainty rules, and it is the canonical audit lens.

## Required Arguments

Require exactly two arguments in `$ARGUMENTS`:
1. Path to the HTML prototype file.
2. Path to the top-level implementation component file.

Use this format:
`$ARGUMENTS="<prototype-html-path> <top-level-component-path>"`

If either argument is missing or unreadable, stop and ask for the missing path.
A running-app URL or pre-captured screenshot paths may be appended after the two
required arguments; use them for the visual passes.

## Step 0: Inspect through Luna

Follow the sibling `see` skill's Luna relay policy, including when the host supports
vision. Keep screenshots out of the audit session. Ask your own visual questions,
retain the text observations and uncertainty, and make the audit judgment yourself.
Use `codex-relay` in `Visual evidence:`; if inspection is unavailable, use
`source-only` and state the gap. `see` owns explicit direct-viewing exceptions.

## Audit Workflow

1. Read inputs and gather rendering context (no vision needed).
- Read the prototype HTML.
- Read the top-level component.
- Read directly related style sources (CSS/SCSS modules, styled components,
  Tailwind class composition, design tokens, and immediate child components that
  materially affect output).
- Identify interactive states and responsive breakpoints present in either source.

2. Obtain screenshots.
- Prototype: capture the prototype HTML via `file://<absolute-path>`.
- Implementation: capture the running app URL if provided by the user.
- Use the sibling `uishot` skill for capture when available; otherwise use any
  available screenshot tooling, or ask the user for a URL or image paths.
- If no screenshots can be obtained at all, drop to `source-only` and state in
  the summary that visual verification was not performed.

3. Build a full prototype inventory before judging implementation.
- Walk the prototype HTML from page shell to leaf elements.
- Run an inventory pass on the prototype screenshot and merge it with the source
  inventory.
- Inventory text, iconography, hierarchy, spacing relationships, dimensions,
  alignment, and behavior cues.

4. Compare each prototype element against implementation.
- Run a comparison pass over prototype screenshot vs implementation screenshot,
  and cross-check every reported difference against the source code.
- Evaluate every element across every taxonomy category in
  `references/audit-spec.md`.
- For states a static capture cannot show (hover, focus, animation), audit from
  source code and say so in the evidence.
- Record only concrete deviations with evidence from both prototype and
  implementation. Use targeted follow-up questions to resolve anything the
  comparison pass left vague.

5. Resolve uncertainty through design-system guidance, per the rules in
   `references/audit-spec.md`.

6. Produce a grouped markdown checklist framed as corrections.
- Group findings by page area first (for example Header, Hero, Form, Table, Footer).
- Inside each area, group by deviation category.
- Each checklist item must be phrased as a corrective action, starting with
  `Correct ...`.
- Include severity and proof for every item.

## Correction Loop

When the user asks you to fix the deviations, not just report them:

1. Apply one grouped set of corrections in source.
2. Re-capture the implementation screenshot.
3. Run a verification pass naming the exact properties that changed.
4. Repeat until verification reports equivalence, or record the residual gap as
   an unresolved item.

Never declare a visual fix verified without a fresh look at a fresh capture. In
`source-only` mode you cannot verify a visual fix at all — say that plainly
instead of implying it was checked.
