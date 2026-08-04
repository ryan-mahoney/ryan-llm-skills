---
name: form-modernizer
description: "Modernize an existing form through multi-phase analysis, redesign, TypeScript typing, and visual verification. Use when: 'modernize this form', 'redesign this form', 'form audit', 'improve this form'."
argument-hint: "<FormComponentPath> [--skip-screenshots] [--edit-only]"
disable-model-invocation: true
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# Form Modernizer

Compound, multi-step skill that fundamentally rethinks an existing React Final Form sidebar form — not surface-level polish, but structural redesign. Challenges every field's existence, mode visibility, and grouping. Produces a TypeScript contract, design-system-aligned implementation, and pixel-accurate Playwright screenshots for visual review.

The skill begins by creating an isolated worktree and opening it in a new VSCode window, so all modernization work happens on a dedicated branch without touching the main working tree.

**Operating principle:** Do the work autonomously. Do not pause for user approval at intermediate steps. Complete all phases. Then present the finished result. (This is the only statement of the autonomy rule; the phases do not restate it.)

## Arguments

- `formPath` — path to the form component file (e.g., `app/components/forms/OfferForm.js`)
- `--skip-screenshots` — skip the Playwright visual verification phases (useful when Playwright is not set up)
- `--edit-only` — produce the analysis and modernization plan, then stop at the end of Phase 4. No code changes.

## Before Starting

1. **Verify the form exists.** Read the file at `formPath`. If it does not exist, report `out of scope: <formPath> not found` and stop.
2. **Verify the form is in scope.** Grep for the form component name in `app/libraries/nodejs-manager/src/manager/SidebarSingleton.js` to verify it is wired into the sidebar system. If the component is not registered there, or does not use React Final Form, report `out of scope: <formPath>` and stop.
3. **Derive the form name.** Extract the component name from the file (e.g., `OfferForm` from `OfferForm.js`). Derive a kebab-case slug (e.g., `offer-form`). This slug is used for branch names, screenshot filenames, and contract file names throughout all phases.

---

## Phase 1 — Branch + Worktree + VSCode

Initial invocation only — the continuation session starts at Phase 2. Follow `references/worktree-setup.md` — 9 steps: branch name, worktree reuse-or-create, `.env` copy, VSCode teal accent, continuation hook, settings merge, open the new window, STOP report. The phase ends with a hard STOP: the new VSCode window's Claude Code session picks up from Phase 2 via the SessionStart hook.

---

## Phase 2 — Form Harness & Playwright Infrastructure (one-time per repo)

If `--skip-screenshots` is passed, or if `app/test/screenshots/harness/serve.js` already exists, skip to Phase 3. Otherwise follow `references/harness-setup.md` — Playwright install, `playwright.screenshot.config.js`, the four harness files (`harness.css`, `mock-api.js`, `entry.jsx`, `serve.js`), and gitignore verification.

---

## Phase 3 — Parallel Analysis (Sub-Agents)

Launch three sub-agents in parallel, with the prompt patterns from `references/subagent-prompts.md`:

- **Sub-Agent A — Form & User Analysis**: persona, form goal, field inventory, add/edit behavior, validation and initialValues logic.
- **Sub-Agent B — API & Type Analysis**: traces submit → API function → route → controller → context → model; reports accepted, required, missing, and ignored fields.
- **Sub-Agent C — Accessibility & Design Audit**: audits the form and the shared components it uses against the design rules and design-system patterns.

Each returns an analysis document; none modifies files.

---

## Phase 4 — Design Decisions (Sequential)

After all Phase 3 agents complete, synthesize their outputs into a modernization plan.

If Phase 3 shows the form already meets the criteria below, report `no changes needed: <formPath>`, cite the evidence, and stop.

### 4a. Structural Redesign

The goal is a fundamental rethink, not surface polish. Question every field:

| Decision                    | Criteria                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove field**            | API ignores it, or it duplicates another field                                                                                                                                                 |
| **Add mode: show or hide?** | Add mode collects only the **minimum** needed to create the entity. All other fields belong in edit mode only. If only one field is required, add mode can be that field and a save button.     |
| **Required**                | Server requires it, OR leaving it blank produces a broken record                                                                                                                               |
| **Order**                   | Group related fields; put the most important / identifying field first; put optional fields last                                                                                               |
| **Inline help**             | Where Sub-Agent C identified ambiguity, add a `note` prop to `FieldWrapper` — see the Help text convention.                                                                                    |

### 4b. Grouping & Layout

- Identify logical groups (e.g., "Identification", "Configuration", "Scheduling")
- Edit-only fields go inside collapsible `AccordionPanel` groups — they are hidden entirely in add mode
- Single-column layout; tightly coupled fields (e.g., date posted / deadline, min years / preferred years) can sit side-by-side via `grid grid-cols-2 gap-x-4`
- Accordion panels follow the Accordion panels convention: connected borders, panel `p-4`, `padding=""` on inner FieldWrappers

### 4c. Shared Component Fixes

If Sub-Agent C identified misalignments in shared library components (FormSidebarFooter, FormSidebarHeader, FieldWrapper, AccordionPanel, inputTextClasses), include those fixes in the plan. These are app-wide improvements that happen to be caught during form modernization.

### 4d. Record Plan

Output the modernization plan as a markdown table for reference:

```
| # | Field | Label | Type | Required | Group | Add/Edit/Both | Help Text | Change |
```

If `--edit-only` was passed, present the modernization plan and stop. Phases 5–7 modify code and must not run.

---

## Phase 5 — Implementation (Parallel Sub-Agents)

Launch sub-agents with the prompt patterns from `references/subagent-prompts.md`:

- **Sub-Agent D — TypeScript Contract**: writes `{formDir}/{formNameKebab}.contract.ts` and its mirror test in `app/test/`.
- **Sub-Agent E — Form Component Modernization**: applies the approved field plan to `{formPath}`.
- **Sub-Agent F — Accessibility Fixes**: minimal, targeted fixes after E completes.

Run D and E in parallel, then F after E.

---

## Phase 6 — Visual Verification (Sequential)

If `--skip-screenshots` is passed, skip this phase.

Screenshots use the **form harness** (Phase 2), never the live app — see the Screenshots convention.

### 6a. Write Screenshot Tests

Write `app/test/screenshots/{formNameKebab}.screenshot.js` from the four-test template in `references/screenshot-tests.md` — new, edit, edit-expanded, narrow (320px). Keep the viewport override inside the narrow test; a second Playwright project would run every test twice and overwrite screenshot files.

### 6b. Capture & Review Loop

0. Establish your eyes with the sibling `see` skill before the first capture.
   `host-vision` means read the PNGs directly; `codex-relay` means every visual
   judgement below comes from a `codex-see` question about the PNG; `source-only`
   means you cannot verify this form visually — say so plainly in the final
   report instead of implying the screenshots were reviewed.
1. Start the harness: `bun app/test/screenshots/harness/serve.js &`
2. Capture: `bunx playwright test --config playwright.screenshot.config.js`
3. **Read every screenshot** and evaluate against the checklist below.
4. Fix each issue in the component.
5. Rebuild the harness.
6. Recapture the screenshots.
7. Review the new screenshots.
8. **Repeat until clean.** No iteration limit — keep going until the screenshots match the design system.

**Checklist:**

- Fields aligned? No ragged edges from inconsistent widths
- Accordion panels have connected borders (button + panel form one visual unit)?
- Side-by-side fields vertically aligned (no `note` causing offset)?
- Spacing consistent? No field touching the footer
- Footer right-aligned with `gap-3` between Cancel and primary button?
- Primary button is `brand-600`, not `indigo-600`?
- Labels are `text-sm text-gray-700`?
- Input borders are `gray-400`, no shadows?
- Help text is `text-sm text-gray-500`?
- Single-column layout (except tightly coupled grid pairs)?
- At 320px: no horizontal scrolling, no clipped labels or inputs, side-by-side
  pairs stacked rather than crushed, footer actions still reachable and tappable?
  `form-design.md` requires the form to work at 320px, so a desktop-only pass is
  an incomplete verification.

---

## Phase 7 — Final Verification

### 7a. Contract Test

Run the contract tests to verify the TypeScript types:

```bash
bun test app/test/{mirrorPath}/{formNameKebab}.contract.test.js
```

### 7b. Lint Check

```bash
bunx eslint {formPath} {contractPath}
```

### 7c. Summary

Present to the user:

1. **Files created/modified** — list with brief description of changes
2. **Field changes** — before/after comparison table
3. **Type coverage** — what the contract file covers
4. **Accessibility improvements** — what was fixed
5. **Design alignment** — what was corrected
6. **Screenshot** — reference the final screenshot location in `tmp/form-screenshots/`
7. **Next steps** — remind the user they can commit and open a PR from the worktree branch

---

## Conventions

- **Form library:** React Final Form. Do not introduce other form libraries.
- **Validation:** validate.js rules object. Do not switch to Yup/Zod.
- **Submission:** Always use `onSubmitHelper(rules, apiFunction, callback, initialValues)` from `app/libraries/nodejs-manager/src/final-form/utilities.js`. Be aware that `sanitizeEmptyValues` iterates over keys in `initialValues` — any key present in initialValues but absent from form values becomes `null` in the API payload.
- **Contract files:** Place adjacent to the form component as `{name}.contract.ts`. Tests mirror in `app/test/`.
- **Contract pattern:** Follow `app/components/apps/sales-admin/discount-codes/discount-code-form.contract.ts` exactly: `FormValues` interface, `Changeset` interface, `normalize*` function, `to*Changeset` function.
- **normalizeInitialValues:** Only transform fields already present in the input. Never inject new fields — see the Submission convention for why (`sanitizeEmptyValues` sends them as `null`).
- **Screenshots:** Use the form harness (port 3333), not the live app. Output to `tmp/form-screenshots/`. Never commit screenshots.
- **Form harness:** Lives in `app/test/screenshots/harness/`. Uses `Bun.build()` for JS + `@tailwindcss/cli` for CSS. Renders forms in a Radix `Dialog` wrapper with mock `StateContext`. No auth, no backend.
- **Design tokens:** Only use colors from `tailwind.config.js` (brand, teal, isabel). No arbitrary hex values.
- **Button labels:** Follow CTA guide — "Save {entity}" for create, "Update {entity}" for edit. Sentence case, 1-3 words.
- **Labels:** Sentence case, concise nouns, always visible (never placeholder-only).
- **Help text:** Use the `note` prop on `FieldWrapper`, not tooltips or placeholder text. Do not add notes that duplicate section headings. Avoid notes on fields in side-by-side grids (causes vertical misalignment).
- **Accordion panels:** Use `AccordionPanel` from `app/components/common/AccordionPanel.js`. Expanded panels get `className="border border-gray-400 border-t-0 rounded-b-lg p-4 flex flex-col gap-4"` on `DisclosurePanel`. Fields inside use `padding=""` on FieldWrapper.
- **Add mode:** Keep add mode minimal per the Phase 4a criteria. Optional/configuration fields belong in edit-only accordion sections wrapped in `{id !== "new" && (...)}`.
- **Worktrees:** All work happens in `~/.worktrees/<repo-name>/modernize-{formNameKebab}`. Never modify the main working tree after Phase 1.
- **Branch naming:** `modernize/{formNameKebab}` (e.g., `modernize/offer-form`).
- **No new dependencies** beyond Playwright (dev only) — uses existing Final Form inputs, `FieldWrapper`, `FormSidebarHeader/Footer`, `AccordionPanel`, `DelayedFocusTrap`.
- **No mocha/chai.** Contract tests use `bun:test`.

## References

- `references/worktree-setup.md` — Phase 1's nine worktree/VSCode/hook steps. Open it on the initial invocation only.
- `references/harness-setup.md` — Phase 2's Playwright config and four harness files. Open it when the harness does not exist yet.
- `references/subagent-prompts.md` — the six sub-agent prompt patterns (A–F). Open it at Phase 3 and Phase 5.
- `references/screenshot-tests.md` — the four-test screenshot template. Open it at Phase 6a.
