# Expressive Design Guide (v1.0)

**Core rule:** A memorable interface commits to one bold idea and executes it precisely.

This guide governs **expressive surfaces** — landing pages, marketing, brand moments, hero sections, pitch decks, onboarding, empty-state illustration, anything whose job is to be felt and remembered. For **functional surfaces** — dashboards, forms, tables, settings, data tools — use [functionalist-design.md](functionalist-design.md) instead; it optimizes for cognition, not impression. When a surface is hybrid (an expressive shell around a functional core), name the zones and apply each guide where it belongs.

The two guides disagree on purpose. Do not average them into a tasteful midpoint — that midpoint is the generic look both are trying to escape. Pick a posture per surface and execute it fully.

## 1. Commit to a Direction
- Choose one clear aesthetic and execute with precision: editorial, brutalist, retro-futuristic, organic, luxury/refined, industrial, playful, art-deco/geometric, maximalist, severe-minimal — among many.
- Intentionality beats intensity. Bold maximalism and refined minimalism both win; a hedged middle does not.
- Name the one thing someone will remember. If nothing is memorable, the direction is too timid.
- Match implementation effort to the vision: maximalist needs elaborate motion and layered detail; minimal needs restraint and obsessive spacing/typography.

## 2. Typography
- Pick characterful type. A distinctive display face paired with a refined body face.
- Establish a real hierarchy and exaggerate the contrast between levels.
- DO NOT default to Inter, Roboto, Arial, or system stacks here — those are the functional defaults; expressive work earns a voice.

## 3. Color & Theme
- Commit to a cohesive palette via CSS variables. A dominant color with one or two sharp accents beats a timid, evenly-distributed spread.
- Vary across work — light and dark, warm and cool. Do not converge on the same scheme every time.
- DO NOT ship the cliché AI-slop look: purple/blue gradients on white, evenly-spaced pastel cards, generic SaaS mesh.

## 4. Motion
- Spend motion on high-impact moments: one orchestrated page-load with staggered reveals reads as more considered than scattered micro-interactions.
- Use surprising hover and scroll-triggered states with purpose.
- Prefer CSS-only for static HTML; a motion library for React when available.
- Motion serves the moment, never blocks the task. Respect `prefers-reduced-motion`.

## 5. Spatial Composition
- Unexpected layouts: asymmetry, overlap, diagonal flow, deliberate grid-breaking.
- Use negative space as an active element, or commit to controlled density — pick one.
- Break the grid only on purpose, and make the break legible as intent, not error.

## 6. Atmosphere & Depth
- Build depth instead of defaulting to flat solid fills: gradient meshes, noise/grain overlays, geometric patterns, layered transparency, dramatic shadows, decorative borders, custom cursors.
- Every effect must match the chosen direction. An effect with no relationship to the concept is decoration for its own sake — cut it.

## 7. Non-Negotiables (these do not flex, even here)
- **Accessibility:** body text meets WCAG AA contrast; never signal by color alone; visible focus; keyboard operable; semantic HTML.
- **Performance:** atmosphere is cheap (CSS, compressed assets), not megabytes of hero video that delay first paint.
- **States:** expressive surfaces still have loading, empty, and error states — design them per [ux-states.md](ux-states.md).
- **Copy:** distinctive voice, still plain and front-loaded — see [cta-design.md](cta-design.md). Bold ≠ vague.
- **Responsive:** the direction holds from 320px up, not just on a desktop hero shot.

## 8. The "Slop" Scan
Before shipping, ask:
1. Could I name the aesthetic direction in one phrase?
2. Is there one unforgettable element?
3. Did I avoid the default fonts, the cliché gradient, the cookie-cutter layout?
4. Does every effect serve the concept?
5. Does it still pass contrast, keyboard, and 320px?

_"Don't hold back — but make every choice intentional."_
