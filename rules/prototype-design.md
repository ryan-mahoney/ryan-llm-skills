# Prototype Design Guide (v1.0)

**Core rule:** A prototype is the screen, not a description of the screen.

Apply when producing HTML prototypes of product screens: design packages
(`docs/design-packages.md`), ad-hoc mockups, and any file an implementer will use as the
visual source of truth. Pair it with the posture rule for the surface
([functionalist-design.md](functionalist-design.md) or [expressive-design.md](expressive-design.md)),
the state rule ([ux-states.md](ux-states.md)), and the wording rules
([cta-design.md](cta-design.md), [form-design.md](form-design.md), [table-row-design.md](table-row-design.md)).

## 1. Show it, don't say it
- No copy that claims the page is clear, fast, simple, or powerful. Clarity is demonstrated
  by hierarchy, wording of controls, and what is left out.
- A heading names the object or the decision ("Routes with late trips"), never the
  feature ("Your routes at a glance").
- No onboarding sentences that explain the interface to itself.

## 2. A person, a decision or an action
- Every screen serves a named person doing one of two things: deciding or acting.
- Deciding: order and compare the information the decision needs. The number or fact that
  drives the decision leads. Secondary data supports it or is absent.
- Acting: place the primary action where the decision lands, name it verb + object, and
  count the clicks. Fewer is better.
- Screens that only display records are the failure mode. Data must appear, and appear
  correctly, but in service of the person, not as an inventory of the schema.

## 3. Nothing self-referential
- No state switchers, variant tabs, or "view as" controls inside the prototype.
- No labels such as "Empty state", "Error state", "Loading". The screen simply is that
  state.
- No designer notes, rationale, TODOs, or "this prototype" text in the markup. Rationale
  belongs in the index or a sidecar document.
- Realistic content from the domain, consistent across screens: real-looking names,
  counts, dates, units. Placeholder text only where the real product shows a placeholder.

## 4. One screen, one state, one file
- Each file holds one screen in one state. All states required by `ux-states.md` for a
  view are separate files.
- Shared chrome is copied forward from the first screen that established it, then edited.
  No runtime includes, no fetch, no external resources.
- Keep each file self-contained and under the size cap; a file an implementer cannot read
  in one pass has failed.

## 5. Design system first, deviations recorded
- Mirror the design system's tokens, type scale, spacing, and components.
- Deviate when the person's job needs it, and record token, before, after, and reason in
  the index. Never justify a deviation inside the prototype.

## 6. Posture declared up front
- Decide `desktop-only` or `responsive` before the first screen. `desktop-only` is a
  complete answer for operator tools; it removes every responsive obligation.
- `responsive` means every declared width is built, captured, and inspected.

## 7. Accessible, modern, quiet
- Semantic HTML, AA contrast, visible focus, keyboard-reachable controls.
- No chartjunk, decorative gradients, or motion on functional surfaces.
- Modern means the current idiom of the design system, not novelty.

## 8. Final test
1. Could a stranger tell what the person decides or does here without reading any
   explanatory copy?
2. Is there any word on the screen that talks about the screen? Delete it.
3. Does the file stand alone, offline, under the cap?
4. Is every deviation from the system recorded outside the file?
