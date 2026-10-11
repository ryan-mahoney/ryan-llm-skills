# Form Design Guide (v1.2)

**Core rule:** Every field is a cost.

## 1. Defaults
- Single-column layout (`grid gap-5`)
- Top-aligned labels, bold (`text-sm font-bold`)
- One primary action, secondary alongside (not disabled)
- Validate on submit; focus the first invalid field

## 2. Layout
- Max width `max-w-2xl` (672px) for prose forms; `max-w-xl` (576px) for short forms
- Multi-column only for tightly coupled fields (e.g. filter row of selects)
- Never hide required fields
- Use Ark UI `Field.Root` with `grid gap-1` per field; `grid gap-5` between fields

## 3. Labels
- Always visible above the control
- Concise nouns, sentence case (Email, Password, Notes, Section body, Export format)
- Bold weight (`font-bold`) so the label is the anchor
- Placeholders are format hints only, never label substitutes
- Helper text (`Field.HelperText`) is muted (`text-xs text-base-300`) and sits below the control

## 4. Inputs
- Width matches expected input (`w-full` inside a constrained container)
- Min height 44px (`min-h-11`) so touch targets meet the button size
- Use `rounded-field`, `border-base-300/40`, `bg-base-100`
- Correct HTML types (`email`, `password`, etc.) on `Field.Input`
- Focus: 2px primary outline with `outline-offset-2` (`focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`)
- Disabled: `bg-base-200`, `text-base-300`, `cursor-not-allowed`
- Textareas: sans-serif by default (`min-h-24`); monospace only when whitespace or columns matter (markdown source, JSON, YAML)

## 5. Grouping
- Spacing communicates structure; rely on `gap-*` not borders
- Use Ark `Field.Root` for single controls and `RadioGroup.Root` + `RadioGroup.Label` for choice sets — not native `<fieldset>`/`<legend>`
- Section headings for distinct form regions

## 6. Required vs Optional
- Mark required fields with `Field.RequiredIndicator` rendering `*` in `text-error`
- One system only — do not mix required and optional markers
- Color is never the sole signal (asterisk + label + `aria-invalid` carry the meaning)

## 7. Validation & Errors
- Validate on submit (use `noValidate` so the form owns the messaging)
- Set `Field.Root invalid` to flip `aria-invalid` and surface `Field.ErrorText`
- Error text explains what is wrong and how to fix it (`Enter a valid email address.`)
- Error styling: red border (`border-error`) plus red outline on focus plus a separate `Field.ErrorText` line (`text-xs font-semibold text-error`)
- Focus the first invalid field on submit

## 8. Actions
- One dominant primary, secondary subdued (outline or ghost)
- Layout: `flex flex-wrap gap-3` with primary first, then secondary
- Both buttons share the input min height (`min-h-11`)
- Never disable submit to hide errors — let the form report them

## 9. Accessibility
- Use Ark `Field.*` so labels, errors, and inputs are programmatically linked
- Keyboard operable; visible focus ring on every control
- Works at 320px width

## 10. Final Test
1. Can I remove a field?
2. Is the path obvious?
3. No mouse required?
