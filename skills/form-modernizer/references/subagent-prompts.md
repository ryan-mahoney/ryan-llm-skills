# Sub-Agent Prompt Patterns

Phase 3 launches A, B, and C in parallel; each receives the form file contents and design rules, returns an analysis document, and modifies nothing. Phase 5 launches D and E in parallel, then F after E completes.

## Sub-Agent A: Form & User Analysis

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
> Also read the context file that prepares data for this form: find the page route in `app/routes/backend-routes.js`, then its controller, then the context function the controller calls.
>
> Output a structured analysis document. Do not modify any files.

## Sub-Agent B: API & Type Analysis

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
> If a list is empty, write `none`. Do not modify any files.

## Sub-Agent C: Accessibility & Design Audit

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
>    - Read the source of `FormSidebarHeader`, `FormSidebarFooter`, and `FieldWrapper` in `app/libraries/nodejs-manager/src/final-form/`, and `AccordionPanel` at `app/components/common/AccordionPanel.js`
>    - Compare their Tailwind classes against the design system patterns (form-drawer.html, form-controls.html, accordion.html)
>    - Check: primary button color (must be `bg-brand-600`, not `bg-indigo-600`), footer layout (`justify-end gap-3`), label size (`text-sm text-gray-700`), input borders (`border-gray-400`), focus rings (`ring-brand-100`), accordion borders (`border-gray-400` with connected panel)
>    - Button labels follow CTA guide (Verb + Noun, sentence case, 1-3 words)
>    - Flag misalignments in shared components — these are fixable in the modernization branch
> 3. **Inline help text opportunities:**
>    - Fields where the label alone is ambiguous
>    - Fields with non-obvious format expectations
>    - Fields where a wrong choice has significant consequences
>    - Avoid help text on fields in side-by-side grids (causes vertical misalignment)
>
> Produce a grouped checklist of findings, split into form-level and shared-component-level issues. If a category has no issues, report `clean` for that category. Do not report an issue you cannot tie to a specific line or class. Do not modify any files.

## Sub-Agent D: TypeScript Contract

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

## Sub-Agent E: Form Component Modernization

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

## Sub-Agent F: Accessibility Fixes

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
> If an item is already satisfied, leave it unchanged. Make minimal, targeted fixes. Do not restructure the form.
