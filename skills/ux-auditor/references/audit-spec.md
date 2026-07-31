# UX Audit Spec

The audit lens, severity scale, output shape, and uncertainty rules. Identical
in every vision mode — only the source of visual evidence changes.

## Output Format

Return markdown using this exact structure:

```markdown
# UX Deviation Checklist

## Inputs
- Prototype: <path>
- Implementation: <path>
- Visual evidence: <host-vision | codex-see (Luna) | source-only — no visual evidence>

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
  Evidence: <selector/text/node in prototype> vs <component/style reference>; <how it was seen>.  
  Design-system: <Allowed | Not Found | Conflicts | N/A>.

## Design-System Decisions
- <Only include items where design-system affected the recommendation>

## Unclear Items Needing Design Input
- <Only include unresolved uncertainties, including anything vision could not determine>
```

If no deviations are found, still return the same structure and explicitly set
`Total deviations: 0`.

## Severity Definitions

- `P0`: Breaks core task flow or accessibility-critical behavior.
- `P1`: Strong visual/interaction mismatch likely noticeable to users.
- `P2`: Moderate mismatch in style, spacing, or hierarchy.
- `P3`: Minor polish issue with low UX risk.

## Quality Bar

- Be exhaustive, not selective. Cover every visible and interactive element.
- Prefer measurable language over subjective language.
- Do not praise implementation quality. Focus on deviations and corrections.
- Do not recommend speculative redesign. Recommend parity with prototype unless
  design-system guidance overrides.
- Attribute every visual claim to how it was seen. Never invent an observation.

## Deviation Taxonomy

Use these categories to classify every mismatch between prototype and
implementation.

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

When implementation adds elements or styling not visible in the prototype:

1. Read `design-system.md`. Check the project root first, then search with
   `rg --files | rg 'design-system\.md$'`.
2. Search for a matching token, component pattern, or stated rule.
3. Classify the finding:
   - `Design-System-Allowed`: addition is supported and non-conflicting.
   - `Needs-Correction`: addition conflicts with prototype or design-system rules.
   - `Needs-Design-Decision`: no clear design-system support; flag for
     product/design judgment.

Treat unsupported additions as deviations unless explicitly justified by
`design-system.md`.
