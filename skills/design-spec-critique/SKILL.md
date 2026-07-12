---
name: design-spec-critique
description: "Critique a design proposal or prototype by selecting two real design practitioners with deep, relevant expertise and evaluating the work through their known perspectives. Use when the user says 'critique this design', 'design review', 'review this prototype', 'poke holes in this UI', 'what's wrong with this design', 'is this good design', or 'what am I missing', especially after design-spec-architect writes proposal.md or design-spec-prototype builds a prototype."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Design Spec Critique — Practitioner-Perspective Design Review

You are conducting a design review. You take a proposed design — a `proposal.md`, a built prototype, or a direction described in conversation — and subject it to rigorous critique from the perspectives of two real design practitioners with deep, published expertise relevant to the specific surface.

This is not a rubber stamp. The value is finding flaws, blind spots, over-decoration, under-design, and unstated assumptions _before_ the design is built or shipped. Default to rigorous challenge, but do not invent flaws to sound tough. If a design is strong, say so and focus on the tradeoffs and open questions that still matter.

## Step 1 — Ingest the Work

### 1a. Locate what to critique — prefer the prototype

In priority order:

1. **The feature prototype.** Resolve `.specs/<feature>/prototype/` from an explicit spec folder or source path. If it exists, critique it as the most concrete artifact.
2. **Sibling `proposal.md`** in the resolved `.specs/<feature>/` folder when there is no prototype.
3. A design shared in the conversation, or shipped UI the user points to.

Never select the most recently modified spec when multiple feature folders exist. Read `proposal.md` for the intended Context Verdict even when critiquing the prototype.

### 1b. Extract the core claims

Pull out what the design implicitly asserts:

- **"This fits the design system"** — does it reuse the real tokens/components, or quietly invent new ones?
- **"This posture is right for this surface"** — is an expressive treatment masking a functional job, or vice versa?
- **"This is the right hierarchy"** — does the eye land where the task needs it?
- **"This is accessible / responsive / complete"** — based on what evidence? Which states are missing?

Write the claims down; they become the critique targets.

## Step 2 — Select Two Practitioner Perspectives

Choose two real design practitioners whose published work, books, talks, or known positions make them specifically relevant to this surface. Not generic "good designers" — people whose expertise addresses the actual decisions here.

### Selection criteria

- **Domain match.** Data-dense tool → an information-design or data-viz authority (e.g. Edward Tufte). Brand/marketing → an identity/typography authority. Forms/usability → a usability authority (e.g. Don Norman, Jakob Nielsen, Steve Krug). Design systems → a systems authority (e.g. Brad Frost). Motion → a motion-design authority. Product UI craft → practitioners known for interface polish (e.g. the Refactoring UI authors).
- **Complementary angles.** Pair productive tension: one optimizing for clarity/restraint, one for impression/craft; one for usability, one for systems consistency.
- **Real, attributable positions.** Only use people whose design positions are publicly documented. Ground the critique in things they have actually argued, not a caricature.
- **Verified relevance.** Before invoking a named practitioner, confirm at least one relevant published source for their perspective. If you cannot, use a named lens instead.

### Fallback to named lenses

When no well-matched real practitioner can be verified, use two clearly named design lenses: `functionalist` / `data-density`, `expressive` / `brand`, `accessibility-first`, `conversion-first`, `systems-consistency`, `usability-first`. Say why those lenses fit this surface.

### Present the selection

For each, write a one-line credential (why their perspective applies here), the lens they bring (the specific angle), and a grounding source. Do not default to the same two people every time — choose fresh based on the surface and its posture.

## Step 3 — Conduct the Critique

For each perspective, work through the design systematically: what they would **challenge**, what they would **approve**, and the **key question** they would ask. Ground every point in a known principle or documented position.

Use these design dimensions as the material the lenses examine — weighted by the surface's posture (functional vs expressive):

- **Visual hierarchy & focal order** — does attention land on the top task / the memorable element?
- **Typography & legibility** — scale, measure, contrast between levels, font choices.
- **Color usage & meaning** — functional encoding vs decoration; consistency with the system.
- **Contrast & accessibility** — WCAG AA (AAA where required); never color-alone signaling; visible focus; keyboard operability; semantic structure; announced state changes.
- **Spacing, grid & alignment** — is the grid legible; is the rhythm consistent.
- **Design-system consistency** — reuses real tokens/components, or invents off-system one-offs.
- **States** — are empty, loading, error, partial, and ideal all designed per `ux-states.md`? Missing states are a primary finding.
- **Responsive behavior** — does the design hold from 320px up.
- **Motion** — purpose vs delight cost; respects `prefers-reduced-motion`.
- **Copy & CTAs** — verb-led, predictable labels per `cta-design.md`; plain language; one primary action.
- **Posture fit** — for functional surfaces, judge against `functionalist-design.md` (data-ink, restraint); for expressive, against `expressive-design.md` (distinctiveness, committed direction, anti-AI-slop). Do not demand brand flourish of a data table, or austere restraint of a hero.

## Step 4 — Synthesize

Step out of the personas and synthesize as the design architect:

- **4a. Agreement points** — concerns both raised are highest-confidence; elevate them.
- **4b. Tension points** — where they diverge, explain what each optimizes for and recommend based on this surface's actual posture and context, not in the abstract.
- **4c. Blind spots** — what neither lens would catch: an accessibility gap a brand designer skips, a content/copy issue a systems thinker ignores, a performance cost of heavy atmosphere.
- **4d. Priority ranking** — **Must address** (will cause real problems if shipped), **Should address** (meaningfully better), **Consider** (polish).

## Step 5 — Write the Critique Document

```markdown
# Design Critique: [Surface/Feature Name]

> Reviewing: [prototype path + URL, proposal.md, or conversation/shipped UI]
> Posture under review: [Functional | Expressive | Hybrid]
> Date: YYYY-MM-DD

## Design Summary

[2-3 sentences restating the design and its stated posture, so the critique stands alone.]

## Practitioner Perspectives

### [Name] — [Lens in ~5 words]

**Relevant background:** [One sentence on why their expertise applies.]
**Grounding source:** [Book, talk, article, or body of work.]

**Would challenge:**
- [Specific concern grounded in their known position. Cite the principle.]

**Would approve:**
- [What aligns with their thinking.]

**Key question they'd ask:**
> "[A pointed question at the heart of their concern.]"

---

### [Name] — [Lens in ~5 words]

[Same structure.]

---

## Synthesis

### Where Both Agree
[Highest-confidence findings.]

### Where They Diverge
[The tension, what each optimizes for, and a recommendation grounded in this surface's posture and context.]

### Blind Spots
[Accessibility, content, performance, or domain concerns neither lens covers.]

## Recommendations

### Must Address
1. **[Short title]** — [Concrete change and why. Reference the element/state/screen, not "the design" in general.]

### Should Address
1. **[Short title]** — [Change and why.]

### Consider
1. **[Short title]** — [Refinement and why.]

## Revised Confidence

[Strong with minor adjustments | Viable but needs rework in specific areas |
Wrong posture or direction — needs rethinking. State which and why.]
```

## Step 6 — Output

- Write `critique.md` in the resolved `.specs/<feature>/` folder. For non-pipeline material, write `CRITIQUE-[name].md` beside the supplied source.
- Write atomically and begin with the level-1 heading.
- When you critiqued a prototype, reference specific screens, states, and elements so the findings are actionable.
- Report `outcome: critiqued`, the critique path, confidence, and counts for Must/Should/Consider. Recommend the single next stage (`design-spec-writer` or another prototype iteration).

## Principles

1. **Critique, don't rubber-stamp.** Surface the real tradeoffs; do not manufacture weakness when the design is strong.
2. **Specificity is respect.** "This might not be accessible" is useless. "The `#8b8b8b` secondary text on `#f5f5f5` is 2.9:1, below the 4.5:1 AA floor" is actionable.
3. **Practitioners are lenses, not authorities.** Argue from the principle they advocate and why it applies here, not from "X wouldn't like it."
4. **Judge against the posture.** Hold the design to the rules its surface actually answers to. Penalizing a data table for not being expressive — or a hero for not being austere — is a bad critique.
5. **Context beats dogma.** A scrappy internal tool is not held to a flagship marketing page's polish.
6. **Better, not perfect.** Recommendations should make the design concretely better, not chase theoretical ideals.
7. **Evidence over performance.** No faked citations or invented positions. If a source cannot be grounded, switch to a named lens and reduce the claim strength.
