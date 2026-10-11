# The Functionalist Web Design Manifesto

**Version:** 1.1  
**Philosophy:** "Form Follows Data"  
**Primary Influences:** Edward Tufte, The Swiss Style (International Typographic Style), Josef Müller-Brockmann, Gerry McGovern, Otl Aicher.

---

## 1. Core Philosophy

This framework operates on the belief that web design is not self-expression, but a tool for cognition and communication. We reject decoration that obscures information and embrace structure that amplifies it.

**The Prime Directive:** Maximize the _Data-Ink Ratio_ (Tufte). Every pixel and every word must justify its existence by contributing to the user's understanding or task completion.

---

## 2. Visual Design Principles

_Goal: To achieve visual order and neutrality through geometry and hierarchy._

### 2.1. The Grid and Layout

- **DO:** Employ a rigorous **Swiss Style Grid System** (referencing _Josef Müller-Brockmann_). Use the grid to align elements mathematically, creating subconscious order. Restory aligns to a 4px base unit; spacing tokens (`p-2`, `p-4`, `p-6`, `p-8`) are the only legal rhythm.
- **DO:** Use "Small Multiples" (Tufte) to display comparative data or image galleries. Repeated formats allow the user to spot patterns quickly. Component grids (the design-system route cards, token swatches, principle tiles) are the canonical implementation.
- **DO:** Utilize **Negative Space** actively. Whitespace is not empty; it is an active structural element that separates data and reduces cognitive load.
- **DO:** Use **restrained radius** as a structural cue, not decoration. Restory uses two radii only: `radius-field` (8px) for controls and compact containers, and `radius-box` (14px) for cards, drawers, and editor sheets. A single radius for "pills" (status badges, navigation chips) is permitted.
- **DO NOT:** Break the grid for "artistic effect" unless it serves a distinct functional purpose.
- **DO NOT** use "Bento Grids" whose radii or shadows turn data into "candy." Card grids are acceptable when each tile is a fixed component (headline, label, body) bounded by a 1px structural border at low opacity (e.g., `border-base-300/30`). Maintain structural sharpness.

### 2.2. Typography and Type

- **DO:** Use **Neo-Grotesque** or **Grotesque** sans-serif typefaces (e.g., Inter, Helvetica, Univers) for UI elements. These are designed for neutrality and legibility. Restory ships **Inter** with a system fallback for every control, heading, and line of prose.
- **DO:** Pair the sans family with a single **monospace** family (Restory uses **JetBrains Mono**) reserved for identifiers: filenames, workspace paths, slash commands, tokens, and code. Mono is a category marker, not a stylistic flourish.
- **DO:** Establish a strict typographic hierarchy (H1, H2, H3, Body) and adhere to it. Scale text logically. Restory's compact scale runs Display 48 / H1 30 / H2 20 / H3 16 / Body 16 / Small 14 / Caption 12, with weights from Regular 400 to Extrabold 800. Add weight before adding another size.
- **DO:** Permit **tracked uppercase eyebrows** as a wayfinding device above titles, card labels, and assistant message roles. They are short (one or two words), bold, and always paired with a normally-cased title below.
- **DO NOT** use "Expressive" display fonts or heavy serifs for body text. Avoid fonts that demand attention to themselves rather than the content.
- **DO NOT** use wide tracking (letter-spacing) on lowercase body text; it destroys the word-shape recognition required for fast reading. Tracking is allowed only on the uppercase eyebrows above.

### 2.3. Color and Palette

- **DO:** Use color for **Information Encoding** and **Wayfinding** (referencing _Otl Aicher's_ 1972 Olympics identity). A specific color should always signal a specific category or state.
- **DO:** Separate **identity** from **action** at the palette level. Restory uses **green (`secondary`)** for product identity — the wordmark, the active product area, the "you are here" mark — and **indigo (`primary`)** for interactive work: links, commit actions, focus rings, active controls. The two roles never compete for the same purpose on the same view.
- **DO:** Reserve **status tokens** (`info`, `success`, `warning`, `error`) for state alone, and always pair color with text or an icon so meaning survives without color perception.
- **DO:** Use **tinted backgrounds** (e.g., `bg-primary/10`, `bg-warning/10`) and **left-border accents** as quiet, structural color treatments. They encode role without raising visual volume.
- **DO:** Meet WCAG **AA** as the floor for text and interactive elements; AAA where the surface allows it (Restory's base text on canvas clears AAA). Document the contrast ratio for each token.
- **DO NOT** use "SaaS Mesh Gradients," amorphous blobs, or color merely for decoration ("vibe").
- **DO NOT** use low-contrast dark modes or "glassmorphism" if it sacrifices text legibility. Translucent tints are acceptable only over an opaque base surface where contrast is preserved.

### 2.4. Decoration and "Chartjunk"

- **DO:** Strip away all non-data ink. Borders, radii, and shadows must encode something — boundary, grouping, or layer — or they go.
- **DO:** Use **elevation as a layer signal**, not ornament. Restory permits three levels: flat (border only) for in-page chrome, `shadow-sm` for popovers and menus that float briefly, and `shadow-xl` for dialogs and drawers that block the workflow. A 1px structural border at low opacity remains the default boundary even on shadowed surfaces.
- **DO NOT** use **Chartjunk** (Tufte). This includes heavy grid lines on tables, redundant drop shadows, bevels, or textures behind data. Table rows use horizontal separators only; vertical gridlines are reserved for unavoidable comparison cases.
- **DO NOT** use **"Ducks"** (designs where the form is dictated by the metaphor, like a "cloud" shape for cloud storage).

---

## 3. UI/UX Structure

_Goal: To create interfaces that function as tools, not toys._

### 3.1. Navigation and Wayfinding

- **DO:** Design for **Top Tasks** (referencing _Gerry McGovern_). Identify the top 5 reasons a user visits your site and make them the primary focus of the navigation.
- **DO:** Prefer a **persistent left sidebar** for tool-like applications. Group routes under short, uppercase section headings (e.g., Overview, Foundations, Components, App surfaces, In practice). The current item is marked with both a background tint and a colored border — never color alone.
- **DO:** Use a **sticky top bar** for the product mark and global identity, and let the sidebar carry the route list. The two are complementary, not competing.
- **DO:** Use "Structural" color coding to denote section changes. Restory's canonical form is a **4px left border accent** on the affected surface (`border-l-4 border-l-warning`, `border-l-primary`) — quieter than a full banner, louder than tinted text.
- **DO NOT** bury navigation in "hamburger menus" on desktop interfaces.
- **DO NOT** create "mystery meat navigation" where users have to hover or click to discover what a link means.

### 3.2. Interaction Design

- **DO:** Provide immediate, clear feedback. When a user clicks a button, the state change should be instant and binary (Active/Inactive).
- **DO:** design for **Input-Efficiency**. Reduce the number of clicks and keystrokes required to complete a task.
- **DO:** Permit **functional motion** — short hover transitions on interactive elements, a `motion-safe` spinner on loaders, focus-ring appearance. Motion must respect the user's reduced-motion preference and must not delay the underlying action.
- **DO NOT** use animations for "delight" that slow down the user (e.g., loading spinners that take longer than the data fetch, or page transitions that cause motion sickness).
- **DO NOT** use **Neumorphism** (Soft UI). It creates ambiguity about whether an element is clickable or just a texture.

### 3.3. Content Structure (CMS)

- **DO:** Think in **Components** (referencing _Karen McGrane_). Break content into reusable chunks (Headline, Summary, CTA, Metadata) rather than "blobs" of text.
- **DO:** design "Structured Content" that can be ported to any device (mobile, watch, kiosk) without losing meaning.

---

## 4. Content Strategy

_Goal: To treat content as data that must be curated, not created._

### 4.1. Governance and Auditing

- **DO:** practice **Ruthless Deletion**. If content is outdated, inaccurate, or does not support a Top Task, delete it.
- **DO NOT** hoard content. "More" is not better. "Relevant" is better.
- **DO:** Conduct regular Content Audits to identify "rot" (dead links, old prices, irrelevant news).

### 4.2. Clarity and Accessibility

- **DO:** adhere to **Plain Language** principles. Write for the user's reading level, not the company's ego.
- **DO:** use **Front-loading**. Put the most important keywords and conclusions at the start of sentences and paragraphs (the "inverted pyramid" style).
- **DO NOT** use "Corporate Happy Talk" (e.g., "Welcome to our state-of-the-art solution..."). It adds zero value and forces the user to work harder to find the point.

---

## 5. Copywriting

_Goal: To make the text invisible so the message shines through._

### 5.1. The "Omit Needless Words" Rule

- **DO:** follow _Strunk & White_ and _Nicole Fenton_: "Omit needless words."
  - _Example:_ Instead of "In order to start the process," use "To start."
  - _Example:_ Instead of "We are currently experiencing a high volume of calls," use "Call volume is high."
- **DO NOT** use intensifiers that add no meaning (e.g., "very," "really," "absolutely," "cutting-edge").

### 5.2. Tone and Voice

- **DO:** be **Objective and Helpful**. The tone should be like a technical manual written by a human being—precise, calm, and direct.
- **DO NOT** use "Marketing Fluff" or hyperbole (e.g., "revolutionary," "game-changing," "unparalleled"). These are triggers that indicate low value.
- **DO NOT** use passive voice. Active voice is shorter and clearer ("The system saves the file" vs "The file is saved by the system").

---

## 6. Summary Checklist (The "Cruft" Scan)

Before launching any page, ask:

1.  **Is the grid obvious?** Can I see the alignment without turning on guides?
2.  **Is the "Data-Ink Ratio" high?** Can I erase this element without losing meaning?
3.  **Is the color functional?** Does the color tell me something, or is it just pretty?
4.  **Is the text skimmable?** Are there headers, lists, and short paragraphs?
5.  **Did I delete the adjectives?** Is the language plain and direct?
6.  **Is it accessible?** Is the contrast high enough? Is the code semantic?

---

_"Good design is as little design as possible." — Dieter Rams_
_"Above all else, show the data." — Edward Tufte_
