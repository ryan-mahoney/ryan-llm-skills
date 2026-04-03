---
name: form-modernizer
description: "Modernize an existing form through multi-phase analysis, redesign, TypeScript typing, and visual verification. Use when: 'modernize this form', 'redesign this form', 'form audit', 'improve this form'."
argument-hint: "<FormComponentPath> [--skip-screenshots] [--edit-only]"
---

# Form Modernizer

Compound, multi-step skill that fundamentally rethinks an existing React Final Form sidebar form — not surface-level polish, but structural redesign. Challenges every field's existence, mode visibility, and grouping. Produces a TypeScript contract, design-system-aligned implementation, and pixel-accurate Playwright screenshots for visual review.

The skill begins by creating an isolated worktree and opening it in a new VSCode window, so all modernization work happens on a dedicated branch without touching the main working tree.

**Operating principle:** Do the work autonomously. Do not pause for user approval at intermediate steps — proceed through all phases, take screenshots, review them, fix issues, and present the finished result.

## Arguments

- `formPath` — path to the form component file (e.g., `app/components/forms/OfferForm.js`)
- `--skip-screenshots` — skip the Playwright visual verification phases (useful when Playwright is not set up)
- `--edit-only` — only produce analysis and recommendations without modifying code

## Before Starting

1. **Verify the form exists.** Read the file at `formPath`. If it does not exist, stop and tell the user.
2. **Identify the form's sidebar registration.** Grep for the form component name in `app/libraries/nodejs-manager/src/manager/SidebarSingleton.js` to confirm it is wired into the sidebar system.
3. **Derive the form name.** Extract the component name from the file (e.g., `OfferForm` from `OfferForm.js`). Derive a kebab-case slug (e.g., `offer-form`). This slug is used for branch names, screenshot filenames, and contract file names throughout all phases.

---

## Phase 1 — Branch + Worktree + VSCode

Create an isolated worktree so the modernization work happens on a dedicated branch.

1. **Derive the branch name.** Use the pattern `modernize/{formNameKebab}` (e.g., `modernize/offer-form`).

2. **Extract the repository name** from `git remote get-url origin` (last path segment, strip `.git` suffix).

3. **Check for existing worktree/branch** (enables re-entry after a crashed run):
   - If `~/.worktrees/<repo-name>/modernize-{formNameKebab}` already exists, reuse it and skip to step 6.
   - If branch `modernize/{formNameKebab}` exists but no worktree, run:
     `git worktree add ~/.worktrees/<repo-name>/modernize-{formNameKebab} modernize/{formNameKebab}`
   - If neither exists, create both from the latest remote main:
     ```bash
     git fetch origin
     mkdir -p ~/.worktrees/<repo-name>
     git worktree add ~/.worktrees/<repo-name>/modernize-{formNameKebab} -b modernize/{formNameKebab} origin/main
     # CRITICAL: unset upstream so `git push` doesn't push to main
     git -C ~/.worktrees/<repo-name>/modernize-{formNameKebab} branch --unset-upstream
     ```

4. **Record the absolute worktree path.** All subsequent phases operate from this path. The `formPath` argument is relative to the repo root and remains valid in the worktree.

5. **Copy environment files** from the original repository root into the worktree:

   ```bash
   cp .env ~/.worktrees/<repo-name>/modernize-{formNameKebab}/.env
   ```

   If `.env` does not exist in the source repo, skip without failing.

6. **Color-code the VSCode window.** Use a consistent teal accent (`#0d7377`) for all form modernization worktrees. Write `.vscode/settings.json` in the worktree:
   - If no `.vscode/settings.json` exists, write:
     ```json
     {
       "workbench.colorCustomizations": {
         "titleBar.activeBackground": "#0d7377",
         "titleBar.activeForeground": "#ffffff",
         "statusBar.background": "#0d7377",
         "statusBar.foreground": "#ffffff"
       }
     }
     ```
   - If `.vscode/settings.json` already exists, merge via `jq`:
     ```bash
     jq --arg bg "#0d7377" \
       '.["workbench.colorCustomizations"] = {"titleBar.activeBackground": $bg, "titleBar.activeForeground": "#ffffff", "statusBar.background": $bg, "statusBar.foreground": "#ffffff"}' \
       .vscode/settings.json > /tmp/vscode-settings-tmp.json && mv /tmp/vscode-settings-tmp.json .vscode/settings.json
     ```
   - If `jq` is not available, write the file from scratch (color settings only).

7. **Write a continuation hook** so the new VSCode window's Claude Code session automatically picks up from Phase 2.

   Create `<worktree-path>/.claude/hooks/continue.sh`:

   ```bash
   #!/bin/bash
   cat <<'PROMPT'
   # Continue Form Modernization — {FormName}

   This worktree was created by the form-modernizer skill for `{formPath}`.
   The branch is `modernize/{formNameKebab}`.

   Pick up from Phase 2 of `~/.agents/skills/form-modernizer/SKILL.md`.

   Before proceeding, load design rules:
   - `~/.agents/rules/form-design.md`
   - `~/.agents/rules/functionalist-design.md``
   - `~/.agents/rules/cta-design.md`
   - `docs/engineering-standards.md`

   Then execute Phase 2 (Playwright setup if needed), Phase 3 (parallel analysis), Phase 4 (design decisions), Phase 5 (implementation), Phase 6 (visual verification), and Phase 7 (final verification) in order.

   Arguments: {formPath} {any flags passed}
   PROMPT
   ```

   Make it executable: `chmod +x <worktree-path>/.claude/hooks/continue.sh`

   Write `<worktree-path>/.claude/settings.json` (merge with existing if present):

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "startup",
           "hooks": [
             {
               "type": "command",
               "command": ".claude/hooks/continue.sh",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

8. **Open the worktree in a new VSCode window:**

   ```bash
   code --new-window ~/.worktrees/<repo-name>/modernize-{formNameKebab}
   ```

9. **STOP.** Report the worktree path, branch name, and form being modernized to the user. The new VSCode window's Claude Code session will receive the continuation prompt via the SessionStart hook — the user just needs to type "go".

---

## Phase 2 — Form Harness & Playwright Infrastructure (one-time setup)

Skip this phase if `--skip-screenshots` is passed or if `app/test/screenshots/harness/serve.js` already exists.

**Do NOT screenshot the live app.** The form harness renders components in isolation — no auth, no backend, pixel-accurate CSS via the project's real Tailwind build.

### 2a. Install Playwright

```bash
bun add -d @playwright/test
bunx playwright install chromium
```

### 2b. Create the screenshot config

Write `playwright.screenshot.config.js` at the repo root:

```javascript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./app/test/screenshots",
  testMatch: "*.screenshot.js",
  use: {
    baseURL: "http://localhost:3333",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "form-screenshots",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
  outputDir: "./tmp/form-screenshots",
});
```

### 2c. Create the form harness

The harness has four files in `app/test/screenshots/harness/`:

**`harness.css`** — Tailwind entry point using the project's real config:

```css
@import "tailwindcss";
@config "../../../../tailwind.config.js";
@plugin "@tailwindcss/forms";
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
```

**`mock-api.js`** — Stub API functions with realistic mock data. Export every function the form imports from `app/components/api.js`. Return plausible payloads so the form renders fully populated.

**`entry.jsx`** — React entry point that:

1. Imports `StateContext` from `app/store` and provides mock values (`pageRefresher: async () => {}`, etc.)
2. Imports the form component
3. Wraps it in `<Dialog.Root open={true}>` + `<Dialog.Portal>` + `<Dialog.Content>` (required by Radix `Dialog.Title` in `FormSidebarHeader`)
4. Reads `?mode=new` or `?mode=edit` from the URL to switch between add/edit mode with sample data
5. Renders at 480px width to match sidebar dimensions

**`serve.js`** — Bun script that:

1. Bundles `entry.jsx` via `Bun.build()` with `external: ["html2canvas"]`
2. Compiles CSS via `bunx @tailwindcss/cli -i harness.css -o tmp/form-harness/harness.css`
3. Serves an HTML page that loads the compiled CSS and JS bundle
4. Uses an `importmap` to stub `html2canvas` in the browser
5. Runs on port 3333 (configurable via `HARNESS_PORT`)

### 2d. Ensure gitignore coverage

`tmp/` is already in `.gitignore`. Verify with: `grep -q "^tmp/" .gitignore`.

---

## Phase 3 — Parallel Analysis (Sub-Agents)

Launch three sub-agents in parallel. Each agent receives the form file contents and design rules.

### Sub-Agent A: Form & User Analysis

**Prompt pattern:**

> Read `{formPath}`. Analyze:
>
> 1. **Who uses this form?** Identify the user persona (admin, hiring manager, recruiter, candidate, etc.) based on the route it appears on and the data it collects.
> 2. **What is the form's goal?** Single sentence: what outcome does submitting this form produce?
> 3. **Field inventory.** List every `<Field>` or input, noting: field name, current component type, current label, whether it has validation, current order.
> 4. **Add vs Edit behavior.** Does the form handle both create and edit? Check for `initialValues` and conditional rendering based on `id` presence.
> 5. **Current validation rules.** Extract the `validationRules` or `requiredFields` object.
> 6. **Current initialValues logic.** How are defaults set?
>
> Also read any context file that prepares data for this form (check the controller/context that serves the page containing this sidebar).
>
> Output a structured analysis document. Do not modify any files.

### Sub-Agent B: API & Type Analysis

**Prompt pattern:**

> Read `{formPath}` and identify the API function it calls on submit (the second argument to `onSubmitHelper`).
>
> 1. Find that function in `app/components/api.js` — note the HTTP method and endpoint path.
> 2. Find the backend route for that endpoint in `app/routes/backend-routes.js`.
> 3. Find the controller handler. Read the controller to understand what fields it expects, validates, and passes to the context.
> 4. Find the context function. Read it to understand the database model and which fields are persisted.
> 5. Find the model. Read the relevant model file to understand the database column names and types.
>
> Produce:
>
> - A list of all fields the API accepts (with types inferred from usage)
> - Which fields are required server-side
> - Any fields the form does NOT currently expose but the API supports
> - Any fields the form exposes that the API ignores
>
> Do not modify any files.

### Sub-Agent C: Accessibility & Design Audit

**Prompt pattern:**

> Read `{formPath}` and the design rules in `~/.agents/rules/form-design.md`, `~/.agents/rules/functionalist-design.md`, and `~/.agents/rules/cta-design.md`.
>
> Also read the design system reference at `docs/design/design-system.md`. For form work, the key files are:
>
> - `docs/design/system/patterns/form-drawer.html` — canonical form drawer layout, button styles, footer alignment
> - `docs/design/system/patterns/form-controls.html` — input styling, label typography, error states
> - `docs/design/system/patterns/accordion.html` — accordion button + panel border pattern
> - `docs/design/system/color.md` — color roles (brand-600 for primary actions, gray-400 for borders, etc.)
> - `docs/design/system/typography.md` — label sizes (text-sm font-medium text-gray-700), heading weights
>
> Audit the form AND the shared library components it uses:
>
> 1. **Accessibility:**
>    - Every input has a programmatic label (via `<label>` or `aria-label`)
>    - Focus management: does the sidebar use `DelayedFocusTrap`?
>    - Tab order follows visual order
>    - Error messages are associated with fields via `aria-describedby` or equivalent
>    - Form works without mouse (keyboard-operable)
>    - Required fields are communicated to assistive tech
> 2. **Design system alignment (check both the form AND the shared components it uses):**
>    - Read `FormSidebarHeader`, `FormSidebarFooter`, `FieldWrapper`, `AccordionPanel` source code
>    - Compare their Tailwind classes against the design system patterns (form-drawer.html, form-controls.html, accordion.html)
>    - Check: primary button color (should be `bg-brand-600` not `bg-indigo-600`), footer layout (`justify-end gap-3`), label size (`text-sm text-gray-700`), input borders (`border-gray-400`), focus rings (`ring-brand-100`), accordion borders (`border-gray-400` with connected panel)
>    - Button labels follow CTA guide (Verb + Noun, sentence case, 1-3 words)
>    - Flag misalignments in shared components — these are fixable in the modernization branch
> 3. **Inline help text opportunities:**
>    - Fields where the label alone is ambiguous
>    - Fields with non-obvious format expectations
>    - Fields where a wrong choice has significant consequences
>    - Avoid help text on fields in side-by-side grids (causes vertical misalignment)
>
> Produce a grouped checklist of findings, split into form-level and shared-component-level issues. Do not modify any files.

---

## Phase 4 — Design Decisions (Sequential)

After all Phase 3 agents complete, synthesize their outputs into a modernization plan. **Do not wait for approval — proceed to implementation.**

### 4a. Structural Redesign

The goal is a fundamental rethink, not surface polish. Question every field:

| Decision                    | Criteria                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remove field**            | API ignores it, or it duplicates another field                                                                                                                                                  |
| **Add mode: show or hide?** | Add mode should collect the **minimum** needed to create the entity. All other fields belong in edit mode only. If only one field is required, add mode may be just that field + a save button. |
| **Required**                | Server requires it, OR leaving it blank produces a broken record                                                                                                                                |
| **Order**                   | Group related fields; put the most important / identifying field first; put optional fields last                                                                                                |
| **Inline help**             | Add a `note` prop to `FieldWrapper` where Sub-Agent C identified ambiguity. Do NOT add notes that duplicate section headings or are obvious from the label.                                     |

### 4b. Grouping & Layout

- Identify logical groups (e.g., "Identification", "Configuration", "Scheduling")
- Edit-only fields go inside collapsible `AccordionPanel` groups — they are hidden entirely in add mode
- Single-column layout unless tightly coupled fields (e.g., date posted / deadline, min years / preferred years) warrant side-by-side via `grid grid-cols-2 gap-x-4`
- Accordion panels use connected borders: button `rounded-t-lg` when open, panel `border border-gray-400 border-t-0 rounded-b-lg p-4`
- Fields inside accordion panels use `padding=""` on FieldWrapper; the panel's `p-4` and `flex flex-col gap-4` handle spacing

### 4c. Shared Component Fixes

If Sub-Agent C identified misalignments in shared library components (FormSidebarFooter, FormSidebarHeader, FieldWrapper, AccordionPanel, inputTextClasses), include those fixes in the plan. These are app-wide improvements that happen to be caught during form modernization.

### 4d. Record Plan

Output the modernization plan as a markdown table for reference:

```
| # | Field | Label | Type | Required | Group | Add/Edit/Both | Help Text | Change |
```

---

## Phase 5 — Implementation (Parallel Sub-Agents)

Proceed immediately after Phase 4.

### Sub-Agent D: TypeScript Contract

**Prompt pattern:**

> Create a TypeScript contract file for the `{FormName}` form following the pattern in `app/components/apps/sales-admin/discount-codes/discount-code-form.contract.ts`.
>
> Based on the approved field plan and API analysis, produce:
>
> 1. **`{FormName}FormValues` interface** — all fields the form UI works with. UI-only fields (like toggle states) use `?` optional. Fields from the server use their DB types.
> 2. **`{FormName}Changeset` interface** — the shape sent to the API. Required fields are non-optional. Strips any UI-only fields.
> 3. **`normalize{FormName}InitialValues` function** — normalizes server data for edit mode (e.g., converting arrays to display strings). **Critical: do NOT add fields that aren't present in the input.** Adding fields to initialValues that aren't rendered in the form causes `sanitizeEmptyValues` in `onSubmitHelper` to send `null` values to the API, overriding server defaults.
> 4. **`to{FormName}Changeset` function** — transforms FormValues into Changeset, with assertion for required fields.
> 5. **Validation helpers** (if the form has conditional validation like the discount code form's type selection).
>
> Write the contract file adjacent to the form component: `{formDir}/{formNameKebab}.contract.ts`
> Write the contract test in the mirror location: `app/test/{mirrorPath}/{formNameKebab}.contract.test.js`
>
> Follow `docs/engineering-standards.md`: fail fast, explicit assertions, simple over clever.

### Sub-Agent E: Form Component Modernization

**Prompt pattern:**

> Modernize `{formPath}` according to the approved plan.
>
> **Field changes:**
> {Insert the approved field plan table here}
>
> **Implementation rules:**
>
> - Use React Final Form `<Field>` components with inputs from `app/libraries/nodejs-manager/src/final-form/`
> - Wrap every field in `FieldWrapper` with: `fieldName`, `labelText`, `required` (boolean), `note` (for help text), `stacked={true}` (sidebar forms are always stacked)
> - Use `FormSidebarHeader` with the entity name and `FormSidebarFooter` with the save/update pattern
> - Import and call `normalizeInitialValues` from the new contract file for `initialValues`
> - Import and call `toChangeset` from the contract file inside the submit handler, before calling the API
> - For collapsible groups, wrap in `AccordionPanel` from `app/components/common/AccordionPanel.js`
> - For add-only vs edit-only fields, conditionally render based on `!!initialValues?.id`
> - Button labels must follow CTA guide: "Save {entity}" for create, "Update {entity}" for edit
> - Validation rules must match the contract's required fields
> - Use `DelayedFocusTrap` wrapper for accessibility
>
> **Design system rules:**
>
> - Single-column layout
> - Tailwind design tokens only (brand, teal, isabel from tailwind.config.js)
> - No decoration, shadows, or rounded corners that don't serve function
> - High contrast (WCAG AA minimum)
>
> Do NOT change the form's API function, sidebar registration, or external interface (props).

### Sub-Agent F: Accessibility Fixes

**Prompt pattern:**

> Review the modernized form (after Sub-Agent E completes) and fix any remaining accessibility issues:
>
> 1. Ensure `DelayedFocusTrap` wraps the sidebar content
> 2. Ensure `FormErrors` component is present and renders above form fields
> 3. Ensure every `<Field>` has an associated `<label>` via `FieldWrapper`
> 4. Ensure required fields have `aria-required="true"` on the input
> 5. Ensure error messages use `aria-describedby` linkage
> 6. Ensure the form has `role="form"` and an accessible name
> 7. Test tab order matches visual order (top to bottom, left to right)
> 8. Ensure `FormSidebarHeader` uses `useDialogTitle={true}` for screen reader announcement
>
> Make minimal, targeted fixes. Do not restructure the form.

**Note:** Sub-Agent F depends on Sub-Agent E completing first. Run D and E in parallel, then F after E.

---

## Phase 6 — Visual Verification (Sequential)

Skip this phase if `--skip-screenshots` is passed.

Screenshots use the **form harness** (Phase 2), not the live app. No auth, no backend dependency — pixel-accurate CSS from the project's real Tailwind build.

### 6a. Write Screenshot Tests

Create `app/test/screenshots/{formNameKebab}.screenshot.js` with tests for each mode:

```javascript
import { test } from "@playwright/test";
import { join } from "path";

const SCREENSHOT_DIR = join(process.cwd(), "tmp", "form-screenshots");
const HARNESS_URL = "http://localhost:3333";

test("capture {FormName} — new mode", async ({ page }) => {
  await page.goto(`${HARNESS_URL}?mode=new`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-new.png"),
  });
});

test("capture {FormName} — edit mode", async ({ page }) => {
  await page.goto(`${HARNESS_URL}?mode=edit`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-edit.png"),
  });
});

test("capture {FormName} — edit mode expanded", async ({ page }) => {
  await page.goto(`${HARNESS_URL}?mode=edit`);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.waitForTimeout(1000);
  // Expand all accordion sections
  const buttons = page.locator('[role="dialog"] button[data-headlessui-state]');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    await buttons.nth(i).click();
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);
  // Remove fixed height to capture full content
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    dialog.style.position = "static";
    dialog.style.height = "auto";
    dialog.style.overflow = "visible";
  });
  await page.waitForTimeout(300);
  const dialog = page.locator('[role="dialog"]');
  await dialog.screenshot({
    path: join(SCREENSHOT_DIR, "{formNameKebab}-edit-expanded.png"),
  });
});
```

### 6b. Capture & Review Loop

1. Start the harness: `bun app/test/screenshots/harness/serve.js &`
2. Capture: `bunx playwright test --config playwright.screenshot.config.js`
3. **Read every screenshot** and evaluate against the design system:

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

4. **Fix every issue found** — update the component, rebuild the harness, recapture, and re-review
5. **Repeat until clean.** No iteration limit — keep going until the screenshots match the design system

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
- **normalizeInitialValues:** Only transform fields already present in the input. Never inject new fields — they would be sent as `null` by `sanitizeEmptyValues` on submit.
- **Screenshots:** Use the form harness (port 3333), not the live app. Output to `tmp/form-screenshots/`. Never commit screenshots.
- **Form harness:** Lives in `app/test/screenshots/harness/`. Uses `Bun.build()` for JS + `@tailwindcss/cli` for CSS. Renders forms in a Radix `Dialog` wrapper with mock `StateContext`. No auth, no backend.
- **Design tokens:** Only use colors from `tailwind.config.js` (brand, teal, isabel). No arbitrary hex values.
- **Button labels:** Follow CTA guide — "Save {entity}" for create, "Update {entity}" for edit. Sentence case, 1-3 words.
- **Labels:** Sentence case, concise nouns, always visible (never placeholder-only).
- **Help text:** Use the `note` prop on `FieldWrapper`, not tooltips or placeholder text. Do not add notes that duplicate section headings. Avoid notes on fields in side-by-side grids (causes vertical misalignment).
- **Accordion panels:** Use `AccordionPanel` from `app/components/common/AccordionPanel.js`. Expanded panels get `className="border border-gray-400 border-t-0 rounded-b-lg p-4 flex flex-col gap-4"` on `DisclosurePanel`. Fields inside use `padding=""` on FieldWrapper.
- **Add mode:** Should be minimal — only required fields + save button. All optional/configuration fields belong in edit-only accordion sections wrapped in `{id !== "new" && (...)}`.
- **Worktrees:** All work happens in `~/.worktrees/<repo-name>/modernize-{formNameKebab}`. Never modify the main working tree after Phase 1.
- **Branch naming:** `modernize/{formNameKebab}` (e.g., `modernize/offer-form`).
- **No new dependencies** beyond Playwright (dev only) — uses existing Final Form inputs, `FieldWrapper`, `FormSidebarHeader/Footer`, `AccordionPanel`, `DelayedFocusTrap`.
- **No mocha/chai.** Contract tests use `bun:test`.
- **Autonomy:** Do not pause for user approval between phases. Proceed through analysis, implementation, screenshots, and fixes. Present the finished result.
