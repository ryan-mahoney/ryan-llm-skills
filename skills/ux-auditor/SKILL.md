---
name: ux-auditor
description: Exhaustively audit a top-level UI implementation component against an HTML prototype and produce a grouped markdown checklist of corrections. Use when a user asks for UI parity review, visual QA, design implementation audit, pixel-level drift detection, or behavior/style mismatch analysis between prototype HTML and shipped component code.
---

# UX Auditor

Audit an implemented UI against a prototype with element-by-element rigor. Produce a correction-first checklist that is grouped, actionable, and explicit about current vs expected behavior.

## Required Arguments

Require exactly two arguments in `$ARGUMENTS`:
1. Path to the HTML prototype file.
2. Path to the top-level implementation component file.

Use this format:
`$ARGUMENTS="<prototype-html-path> <top-level-component-path>"`

If either argument is missing or unreadable, stop and ask for the missing path.

## Audit Workflow

1. Read inputs and gather rendering context.
- Read the prototype HTML.
- Read the top-level component.
- Read directly related style sources (for example CSS/SCSS modules, styled components, Tailwind class composition, design tokens, and immediate child components that materially affect output).
- Identify interactive states and responsive breakpoints present in either source.

2. Build a full prototype inventory before judging implementation.
- Walk from page shell to leaf elements.
- Inventory text, iconography, hierarchy, spacing relationships, dimensions, alignment, and behavior cues.
- Use the `Deviation Taxonomy` section in this file as the canonical audit lens.

3. Compare each prototype element against implementation.
- Evaluate every element across:
  - Layout and geometry
  - Spacing and rhythm
  - Typography
  - Color and visual styling
  - Borders, radius, shadows, and opacity
  - Content and icon fidelity
  - Interaction behavior and state transitions
  - Responsive behavior and reflow
- Record only concrete deviations with evidence from both prototype and implementation.

4. Resolve uncertainty through design-system guidance.
- If implementation contains additions not in the prototype, consult `design-system.md` before recommending removal or change.
- Locate `design-system.md` by checking project root first, then searching with `rg --files | rg 'design-system\\.md$'`.
- If the design system explicitly justifies the addition, classify it as `Design-System-Allowed`.
- If the design system contradicts the implementation or does not support it, classify as `Needs-Correction` or `Needs-Design-Decision` with rationale.

5. Produce a grouped markdown checklist framed as corrections.
- Group findings by page area first (for example Header, Hero, Form, Table, Footer).
- Inside each area, group by deviation category (use taxonomy categories).
- Each checklist item must be phrased as a corrective action, starting with `Correct ...`.
- Include severity and proof for every item.

## Output Format

Return markdown using this exact structure:

```markdown
# UX Deviation Checklist

## Inputs
- Prototype: <path>
- Implementation: <path>

## Audit Summary
- Areas reviewed: <count>
- Elements reviewed: <count>
- Total deviations: <count>
- Severity counts: P0 <n>, P1 <n>, P2 <n>, P3 <n>
- Design-system consultations: <count>

## <Area Name>

### <Category Name>
- [ ] [P1] Correct <specific element/behavior> to match prototype.  
  Current: <implementation reality>.  
  Expected: <prototype requirement>.  
  Evidence: <selector/text/node in prototype> vs <component/style reference>.  
  Design-system: <Allowed | Not Found | Conflicts | N/A>.

## Design-System Decisions
- <Only include items where design-system affected the recommendation>

## Unclear Items Needing Design Input
- <Only include unresolved uncertainties>
```

If no deviations are found, still return the same structure and explicitly set `Total deviations: 0`.

## Severity Definitions

- `P0`: Breaks core task flow or accessibility-critical behavior.
- `P1`: Strong visual/interaction mismatch likely noticeable to users.
- `P2`: Moderate mismatch in style, spacing, or hierarchy.
- `P3`: Minor polish issue with low UX risk.

## Quality Bar

- Be exhaustive, not selective. Cover every visible and interactive element.
- Prefer measurable language over subjective language.
- Do not praise implementation quality. Focus on deviations and corrections.
- Do not recommend speculative redesign. Recommend parity with prototype unless design-system guidance overrides.

## Deviation Taxonomy

Use these categories to classify every mismatch between prototype and implementation.

### 1. Layout And Geometry
- Container width, max-width, min-height, fixed sizes
- Positioning strategy (static, absolute, sticky, fixed)
- Grid/flex direction, wrapping, alignment, and distribution
- Element order and hierarchy

### 2. Spacing And Rhythm
- Margin and padding mismatches
- Gap/stack rhythm inconsistencies
- Section-to-section spacing and whitespace density
- Misaligned baselines or inconsistent vertical rhythm

### 3. Typography
- Font family, size, weight, line height, letter spacing
- Text transform and casing
- Heading/body hierarchy differences
- Truncation, wrapping, and overflow behavior

### 4. Color And Visual Style
- Foreground/background color mismatches
- Gradients and overlays
- Border color and stroke weight
- Opacity and blend differences

### 5. Surface Styling
- Border radius
- Shadow/elevation
- Blur and glass effects
- Divider and card treatment

### 6. Content And Icon Fidelity
- Text copy differences
- Missing or extra icons/images
- Incorrect icon size, stroke, or placement
- Content order and grouping differences

### 7. Interaction And State Behavior
- Hover, focus, active, visited, disabled states
- Validation and error state rendering
- Pressed/toggled/selected states
- Animation presence, duration, easing, sequencing
- Keyboard and screen-reader relevant interaction parity

### 8. Responsive Behavior
- Breakpoint-specific layout shifts
- Mobile/desktop spacing and sizing deltas
- Element visibility rules by viewport
- Reflow and wrapping parity

### 9. Data Presentation Patterns
- Table/list density and row styling
- Empty/loading/error state visuals
- Sorting/filtering affordance mismatch
- Badge/chip/tag treatment

## Uncertainty Handling With design-system.md

When implementation adds elements or styling not visible in prototype:

1. Read `design-system.md`.
2. Search for matching token, component pattern, or stated rule.
3. Classify the finding:
- `Design-System-Allowed`: addition is supported and non-conflicting.
- `Needs-Correction`: addition conflicts with prototype or design-system rules.
- `Needs-Design-Decision`: no clear design-system support; flag for product/design judgment.

Treat unsupported additions as deviations unless explicitly justified by `design-system.md`.
