---
name: design-align
description: "Audit a React component tree against the FirstWho design system and recommend Tailwind CSS corrections. Use when asked to 'align to design system', 'design system audit', 'check design tokens', or 'fix styling to match design system'."
argument-hint: "<path-to-top-level-component>"
---

# Design-Align — Design System Compliance Audit

Audit a top-level React component and all of its children against the FirstWho design system (`docs/design/design-system.md`). Produce a grouped checklist of Tailwind CSS corrections, then apply approved changes.

## Arguments

- `component-path` — Path to the top-level React component file (e.g., `app/components/apps/jobs/jobs-list.js`). Relative to repo root.

## Before Starting

1. Confirm the file exists. If not, ask the user.
2. Read `docs/design/design-system.md` to verify the token reference is still current. If the index has changed materially, re-read the relevant sub-files before proceeding.
3. Read `tailwind.config.js` to confirm the custom `brand` and `teal` palettes are still registered.

## Steps

### 1. Collect the component tree

Read the top-level component file. Trace every locally imported child component (follow `import` statements for files under `app/components/`). Read each child file. Continue recursively until all leaf components are loaded.

Do NOT follow imports into:
- `node_modules/`
- `app/libraries/`
- `app/models/`, `app/controllers/`, `app/contexts/`

Build a flat list of `[file-path, file-content]` pairs for audit.

### 2. Audit each file against the design system rules

For every component file, scan the JSX for Tailwind classes (in `className` strings, template literals, and `clsx`/`cn` calls). Evaluate each class against the rules below. Record every violation as a finding.

---

#### 2A. Text color and size

**Color rules:**

| Context | Required | Forbidden |
|---------|----------|-----------|
| Page-title H1 | `text-brand-600` (or `text-gray-900` if directly below nav with no section bar) | Any other color for H1 |
| H2, H3, card titles | `text-gray-900` | `text-black`, arbitrary brand colors |
| Body text | `text-gray-700` | Anything lighter than `gray-700` for readable body |
| Muted / metadata | `text-gray-500` | Anything lighter than `gray-500` for visible text |
| Links / interactive | `text-teal-600` with `hover:text-teal-700` | `text-blue-*`, `underline` by default |
| Question text | `text-teal-600` + `font-serif` (Merriweather) | Other colors for question text |

**Size rules (Major Third scale):**

| Role | Class | Weight |
|------|-------|--------|
| Display | `text-4xl` (36px) | `font-bold` |
| Page heading H1 | `text-3xl` (30px) | `font-bold`, Merriweather |
| H2 | `text-2xl` (24px) | `font-semibold` |
| H3 / section heading | `text-xl` (20px) | `font-semibold` |
| Lead paragraph | `text-lg` (18px) | `font-normal` |
| Body | `text-base` (16px) | `font-normal` |
| Caption / metadata | `text-sm` (14px) | `font-medium` |
| Badge / overline | `text-xs` (12px) | `font-semibold`, uppercase, `tracking-wider` |

**Flag:** Any use of `text-black`, `text-white` on light backgrounds, colors not in the palette, or sizes outside the scale.

**Accessibility check:**
- Body text must have 7:1 contrast (AAA). `gray-900` and `gray-700` on white qualify.
- Interactive text must have 4.5:1 (AA). `teal-600` on white = 5.3:1, qualifies.
- `gray-500` on white = 4.8:1, acceptable only for non-essential metadata.
- Never use text lighter than `gray-500` for readable content.
- White on `amber-600` only passes for bold 14px+ or normal 18px+.

---

#### 2B. Padding and margins

**Spacing scale (4px base):**

| Token | Tailwind | Pixels |
|-------|----------|--------|
| space-1 | `p-1` / `m-1` | 4px |
| space-2 | `p-2` / `m-2` | 8px |
| space-3 | `p-3` / `m-3` | 12px |
| space-4 | `p-4` / `m-4` | 16px |
| space-5 | `p-5` / `m-5` | 20px |
| space-6 | `p-6` / `m-6` | 24px |
| space-8 | `p-8` / `m-8` | 32px |

**Key dimensions:**
- Card inner padding: `p-6` (24px) on all sides
- Page horizontal gutters: `px-6` to `px-8` (24–32px)
- Content max width: `max-w-[720px]` for main column (multi-column layouts only)
- Sidebar width: `w-[320px]`
- Nav height: `h-14` (56px)

**Flag:** Arbitrary spacing values (`p-[17px]`), padding/margins that don't align to the 4px scale, cards without `p-6`.

---

#### 2C. Button colors, styles, sizes

**Primary button:**
`bg-brand-600 text-white border border-brand-600 rounded-md text-sm font-medium py-2 px-4`
Hover: `hover:bg-brand-500`

**Secondary button:**
`bg-white text-gray-900 border border-gray-400 rounded-md text-sm font-medium py-2 px-4`

**Outline brand:**
`bg-white text-brand-600 border border-brand-600 rounded-md text-sm font-medium py-2 px-4`

**Ghost button:**
`bg-transparent text-gray-700 border border-transparent rounded-md text-sm font-medium py-2 px-4`

**Dark button (Finish Session style):**
`bg-brand-700 text-white border border-brand-700 rounded-md text-sm font-medium py-2 px-4`

**Small buttons (Previous/Next):**
`py-1 px-3 text-xs` with same border/color patterns.

**Common button base:**
`inline-flex items-center justify-center rounded-md font-medium font-sans cursor-pointer leading-normal`

**Flag:** Buttons using `rounded-lg` or `rounded-full` (should be `rounded-md` = 6px), wrong colors, missing border, `text-base` instead of `text-sm`, missing `font-medium`.

---

#### 2D. Border colors and shadows

**Borders:**
- Card borders: `border border-gray-200` (standard) or `border border-gray-400` per agent-rules for content containers
- Input/button borders: `border border-gray-400`
- Dividers: `border-gray-200` for subtle rules
- Border radius: `rounded-sm` (4px) for badges, `rounded-md` (6px) for buttons/inputs, `rounded-lg` (8px) for cards, `rounded-xl` (12px) for modals. Never beyond `rounded-xl` except `rounded-full` for pills/avatars.

**Shadows:**
- Cards: `shadow-card` only (custom: `0 1px 3px rgba(16,23,39,.06), 0 1px 2px rgba(16,23,39,.04)`)
- No `shadow-lg`, `shadow-xl`, or `shadow-2xl` on cards.
- `shadow-lg` reserved for modals/popovers only.

**Focus states:**
- Every interactive element: `focus:ring-3 focus:ring-brand-100 focus:border-brand-600`

**Flag:** `shadow-md`/`shadow-lg` on cards, missing focus rings on interactive elements, `rounded-2xl` or larger on non-pill elements, `border-gray-300` where `gray-200` or `gray-400` is specified.

---

#### 2E. Item separation

- Between cards/card groups: `gap-8` or `space-y-8` (32px)
- Between items within a card: `gap-4` or `space-y-4` (16px)
- Section breaks: `gap-12` or `space-y-12` (48px)
- List item padding: `py-3` (12px vertical)
- Horizontal dividers: `border-t border-gray-200`
- Interview section bars: `bg-brand-700` full-width bars

**Flag:** Inconsistent gap values within the same container, missing dividers between list items when expected, non-standard spacing tokens.

---

#### 2F. Surfaces

**Page background:** `bg-gray-50` always. Never `bg-white` for the page, never darker.

**Card surface:**
`bg-white border border-gray-200 rounded-lg p-6 shadow-card`
Per agent-rules, content containers use `border-gray-400`.

**Context bars:**
`bg-brand-700 text-white` for dark section bars.

**Flag:** Content sitting directly on `bg-gray-50` without a card wrapper, cards missing `bg-white`, cards using `bg-gray-100` or other non-white backgrounds for primary content, missing `rounded-lg` on cards.

---

### 3. Compile findings

Group all findings by category (2A–2F). For each finding, output:

```
### [Category Name]

**[file-path:line]** — [description of violation]
- Current: `[current classes]`
- Recommended: `[corrected classes]`
```

If a file has no violations, note it as compliant and skip it.

At the end, output a summary count: `X findings across Y files`.

### 4. Apply corrections

After presenting findings, ask the user which categories or specific findings to apply. Then make the Tailwind class changes using the Edit tool. Change only the classes identified — do not restructure JSX, rename components, or alter logic.

## Conventions

- Use only Tailwind classes from the design system palette. Custom colors use `brand-*` and `teal-*` (registered in `tailwind.config.js`). Amber, status, and grays use Tailwind defaults.
- Never introduce arbitrary values (`text-[#123456]`) when a named token exists.
- When a component wraps children with `className` props, audit the wrapper's classes, not the children's (children are audited when their own files are read).
- If a component uses a shared utility (e.g., `cn()`, `clsx()`) to compose classes conditionally, evaluate all branches.
- Do not flag third-party component libraries (e.g., Headless UI) for internal class usage — only flag the classes the application code passes to them.
