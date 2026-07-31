# The Rubric

Eight dimensions. Score each 1–5. The anchors describe 1, 3, and 5; interpolate for 2 and 4.

The dimensions are ordered deliberately. The first two ask whether this is the *right page* — problems there can't be fixed by adjusting anything below them. Dimensions 3–5 are structural. Dimensions 6–8 are execution. When a low score appears high in the list, weight it heavily and be skeptical of recommending polish further down.

**Contents**
1. Orientation and purpose
2. Goal fit
3. Hierarchy and attention
4. Grouping and structure
5. Language and labeling
6. Action and feedback
7. Information design and density
8. Robustness and accessibility

---

## 1. Orientation and purpose

*Can a user who arrived unexpectedly tell where they are, what this is, and what they can do?*

Krug's bar: self-evident at a glance, not merely self-explanatory on careful reading. Norman's two gulfs — execution and evaluation — are the underlying test.

**Look for:** a page title naming the user's purpose; visible location within the product; identifiable page type within a second; a clear entry point for the eye.

**Failure signals:** the page is comprehensible only if you remember how you got there; the title names a data table; nav state ambiguous; the user must read body copy to identify what kind of page this is.

- **1** — Purpose unreadable without prior context. No location cues.
- **3** — Purpose inferable after a few seconds of reading. Location cues present but weak.
- **5** — Purpose, location, and available actions apparent immediately, without reading body copy.

---

## 2. Goal fit

*Is the page organized around what the user is trying to accomplish, or around how the system stores data?*

Cooper's goal-directed design. This is the most commonly violated principle in software built by the people who built the database, and the one JTBD is really asking about.

**Look for:** does the page's primary affordance match the JTBD verb? If the job is *decide*, does the page support comparison and judgment — or only viewing? If the job is *fix a problem*, does it surface the problem or require hunting for it?

**Failure signals:** the page is a CRUD view of a table; the user must hold information in their head across screens; the most common action requires the most clicks; everything is presented equally because the designer didn't know what the user wanted.

- **1** — Structure mirrors the data model. The job requires assembling information across screens.
- **3** — Supports the job, but with detours — the user does work the system could have done.
- **5** — Shaped around the decision or action the user came to make; the system did the assembly.

---

## 3. Hierarchy and attention

*Does visual emphasis match actual importance?*

Hierarchy is established as much by *de-emphasizing* secondary content as by emphasizing primary content (Wathan and Schoger). Most amateur interfaces fail by promotion, not omission. Diagnostic: squint until detail disappears and see what still stands out.

Hierarchy is not only about the primary action. Labels, metadata, and timestamps usually get more attention than they deserve, because they were styled once and never demoted.

**Look for:** three or more distinct levels of emphasis; one clear focal point; secondary information visibly recessive; a consistent type scale rather than arbitrary sizes.

**Failure signals:** everything the same weight; labels as prominent as the values they label; competing focal points; bold used so widely it stops meaning anything; no obvious entry point for the eye.

- **1** — Flat. Squint test yields an undifferentiated field, or emphasizes the wrong thing.
- **3** — Some hierarchy, but competing focal points or over-emphasized secondary content.
- **5** — Clear focal point, deliberate levels, secondary content properly recessive.

---

## 4. Grouping and structure

*Is related content visually related, and unrelated content visually separated?*

Gestalt: proximity, similarity, common region, continuity. Proximity is the strongest and the most underused — space groups more effectively than borders do. The most common structural error in application UI is over-division: boxes inside cards inside panels, each line competing with content. Removing a border and increasing space usually makes structure *more* legible.

**Look for:** consistent spacing scale; spacing that reflects relationships (more space between groups than within them); alignment to a small number of axes; borders reserved for cases where space alone won't do.

**Failure signals:** uniform spacing everywhere, so grouping reads as one undifferentiated list; nested containers; more space within a group than between groups; competing alignment edges; cards as default packaging for everything.

- **1** — No discernible system. Spacing arbitrary; grouping communicated only by borders, or not at all.
- **3** — A system exists but breaks in places; some over-division or inconsistent alignment.
- **5** — Consistent scale, relationships legible through space, minimal chrome, few alignment axes.

---

## 5. Language and labeling

*Is the interface written in the user's vocabulary, and does it say what will happen?*

Copy is design, not decoration applied afterward. Sierra's reframing is the useful lens: users don't want to use the product, they want to be capable at the thing the product is for. Labels should reflect that outcome, not the system's internal nouns.

**Look for:** buttons as verb-plus-object ("Send invitation") rather than vague ("Submit", "OK", "Continue"); domain terms the user would actually say; error messages stating what to do next; empty states that teach rather than apologize.

**Failure signals:** database entity names surfaced in the UI; the same concept named differently in different places; buttons whose outcome is unclear until pressed; errors describing what the system failed to do rather than what the user should do now; instructional paragraphs compensating for an unclear layout.

- **1** — System vocabulary throughout; ambiguous actions; errors unhelpful.
- **3** — Mostly clear, with inconsistent terminology or a few vague controls.
- **5** — Consistent user-facing vocabulary; every action states its outcome; errors are actionable.

---

## 6. Action and feedback

*Is the next step obvious, is its result predictable, and is it recoverable?*

Nielsen's heuristics are the working checklist. Norman on signifiers: a control has to *look* actionable. Fitts and Hick for target size and choice count respectively — a wall of equal options costs more than the options are worth.

**Look for:** exactly one visually primary action; disabled states that explain themselves; destructive actions distinguished and confirmed or undoable; every action producing visible confirmation; interactive elements that look interactive.

**Failure signals:** competing primary buttons; destructive actions styled identically to safe ones; disabled controls with no explanation of what would enable them; controls discoverable only on hover; the user recalling values from an earlier screen; no acknowledgment after submission.

- **1** — Next step unclear or contested; no feedback; destructive actions undifferentiated.
- **3** — Primary action identifiable, but crowded by competitors or with weak confirmation.
- **5** — One unambiguous next step; all actions confirmed; risky actions guarded and reversible.

---

## 7. Information design and density

*Does every element carry information, and is the user doing work the software should do?*

Tufte's data-ink ratio: gridlines, heavy borders, gradients, shadows, redundant icons, and repeated units are all deletion candidates.

Victor's "Magic Ink" is the sharper lens for dashboards. His argument: most software called *interaction* design is really *information* software, and requiring the user to filter, sort, and query is often a design failure. The software has context; it should infer what the user probably wants and show it, with interaction as fallback rather than primary mechanism.

Density itself is not a vice. Sparse layouts are often worse — they scatter related information across scroll distance and force reliance on memory. The question isn't how much is on screen but whether what's there is information.

**Look for:** decoration deletable without information loss; comparisons the user makes manually that the interface could make; defaults that answer the common question without configuration; repeated labels or units that could be factored out.

**Failure signals:** chart junk; every number requiring the user to compute a difference or rank; filters presented before any content; whitespace used to fill rather than group; raw values where the user needs a judgment.

- **1** — Heavy decoration, low information; user manually assembles every comparison.
- **3** — Reasonable content, but the user still does work the system could do.
- **5** — High information density, minimal chrome, defaults that answer the likely question directly.

---

## 8. Robustness and accessibility

*Does it hold up outside the happy path, and can everyone use it?*

Both are about cases that demos skip. Screenshots almost always show a populated, well-behaved, medium-length state — precisely the state that hides problems.

**States to interrogate** (name any the screenshot leaves unanswered): empty / first-run, loading, error, permission-denied, single item, very many items, very long strings (names, titles, emails), zero-result search, partial data.

**Accessibility checks visible in a still image:** apparent contrast of body, secondary, and placeholder text, and text over images; whether color alone carries meaning (status indicators, chart series, validation); apparent target size; visible focus states if captured; heading structure implied by type hierarchy; form labels present rather than placeholder-only.

Flag contrast as *verify* rather than asserting a ratio — see the guardrails in SKILL.md. Reference thresholds: 4.5:1 body text, 3:1 large text and interface components.

**Failure signals:** placeholder-as-label; status conveyed only by a colored dot; truncation with no affordance to see the full value; layouts assuming short content; light grey secondary text on white; no empty or loading treatment anywhere in the flow.

- **1** — Happy path only; several likely contrast or color-dependence problems.
- **3** — Some states handled; a few accessibility risks worth verifying.
- **5** — States evidently designed rather than defaulted; no visible accessibility risks.

---

## Sources

Worth reading directly rather than taking these summaries on trust — the arguments are more nuanced than a rubric can carry, and they disagree with each other in useful ways.

- Steve Krug, *Don't Make Me Think* — scanning, satisficing, the trunk test.
- Alan Cooper, *About Face* — goal-directed design.
- Don Norman, *The Design of Everyday Things* — affordances, signifiers, the two gulfs.
- Jakob Nielsen — the ten usability heuristics.
- Adam Wathan and Steve Schoger, *Refactoring UI* — applied hierarchy, spacing, type, color.
- Edward Tufte, *The Visual Display of Quantitative Information* — data-ink, chart junk.
- Bret Victor, "Magic Ink" — information software versus interaction software.
- Luke Wroblewski, *Web Form Design* — forms, labels, validation.
- Jenifer Tidwell, *Designing Interfaces* — interaction pattern catalogue.
- Kathy Sierra, *Badass* — user capability as the product's real goal.
- Christopher Alexander, *A Pattern Language* — coherence through repeated relationships.
- WCAG 2.2 — contrast, target size, non-color-dependence.
