# Table & Row Design Guide (v1.2)

**Core rule:** Tables exist to find, compare, or act.

## 1. Structure
- Wrap the table in a bordered container (`rounded-field border border-base-300/30`)
- Horizontal row separators only (`border-b border-base-300/20`, removed on last row)
- No vertical gridlines
- Header row uses a tinted fill (`bg-base-200`) to separate from the body
- Consistent row padding (`px-3 py-3` body, `px-3 py-2` head)

## 2. Typography
- Body and header share one size: `text-sm` (14px)
- Secondary metadata (tags, badges, file paths): `text-xs` (12px)
- File paths use `font-mono`
- Numbers use `tabular-nums`
- Sentence case headers; no ALL CAPS

## 3. Alignment
- Text left
- Numbers right, with `tabular-nums`
- Header alignment matches its cells (right-aligned headers for numeric and Actions columns)
- Actions live in a fixed final right-aligned column

## 4. Headers
- Always visible
- Terse, single-word labels where possible (Section, File, Words, Status, Modified, Actions)
- `font-semibold` in the muted text color (`text-base-300`)
- Sort indicators via `aria-sort` on the sortable `<th>`

## 5. Cell Content
- Primary identifier is the first cell and renders as a link
- Use a `<th scope="row">` for the primary identifier
- Stack secondary chips (tags) directly under the primary identifier instead of adding columns
- Truncate or wrap long text; do not let cells dictate row height
- Status uses a bordered pill with tinted background plus a visible text label — never color alone
- Repeat the status text in the cell so it stays legible in print and assistive contexts

## 6. Row Interaction
- Full-row hover tint (`hover:bg-base-200/60`)
- Rows are not clickable; the primary identifier link is the navigation target
- No checkbox selection column by default — add one only when bulk actions are a real top task

## 7. Actions
- 1–2 inline buttons per row in the final column
- Buttons use the shared action style (bordered, `text-xs font-bold`, `min-h-9`)
- Each button carries an `aria-label` that names its target (e.g. `Open Opening draft`)
- 3+ actions move into a menu
- Bulk actions appear in a contextual toolbar above the table when selection is enabled

## 8. Search & Filter
- Filter bar sits directly above the table inside a tinted panel (`bg-base-200`)
- Search input is a real `<input type="search">` with a visible label
- Status and other facets are native `<select>` controls
- Active filters appear as removable chips with `aria-label="Remove <Name> filter"`

## 9. Empty States
- Render a single `<tr>` with `colSpan` covering every column
- Center the message, use muted color, and name the next action (clear filters, create section)
- Keep the header row visible so the schema stays readable

## 10. Responsive
- Desktop (`md` and up): full table inside `overflow-x-auto`
- Below `md`: swap to a card list (`<ul>` of bordered cards) — do not horizontally scroll a wide table
- A `compact` mode hides secondary columns (e.g. Workspace, Modified) when the table is narrow but the card swap is not warranted
- Cards keep the primary identifier, file path, status badge, and a two-column `<dl>` for the remaining metadata

## 11. Accessibility
- Semantic `<table>`, `<thead>`, `<tbody>`, `<th scope>` markup
- `aria-label` on the table names the dataset
- `aria-sort` on sortable headers
- Action buttons are real `<button type="button">` with descriptive `aria-label`
- Keyboard operable; focus styles use `focus-visible:outline outline-2 outline-primary`

## 12. Final Test
1. Task clear?
2. Any removable column?
3. Comparison effortless?
