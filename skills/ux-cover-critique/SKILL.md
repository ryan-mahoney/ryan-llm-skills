---
name: ux-cover-critique
description: Critique a book cover image against the book's positioning (genre, audience, author's market standing) and propose specific, prioritized design improvements. Use this skill whenever the user shares a book cover — front cover, full jacket, ebook cover, or audiobook tile — and asks for design feedback, a critique, a redesign, whether the cover "works," why it isn't getting clicks, or whether it looks self-published, even if they don't use the word "critique." Also use when the user wants to compare candidate cover directions for the same book, or to analyze a set of comparable covers to extract genre conventions and synthesize a new cover direction from the strengths of many designs.
argument-hint: "<cover-image> <genre-and-positioning>"
metadata:
  version: "1"
---

# UX Cover Critique

Turn a cover image plus the book's positioning into two lists: prioritized specific changes, and the specific things that work and must survive those changes. Both are justified by the stated principles of working cover designers and art directors.

A cover has one job, and it is not to summarize the book. Suzanne Dean's formulation: catch the eye, engage the potential reader, and get them to pick the book up. Everything in this critique is anchored to that job, in a specific market, for a specific reader — not to whether the cover is attractive in the abstract.

The failure mode this skill exists to prevent is taste-based feedback ("make it pop," "try a different font") and its equally useless generic twin ("strong type, nice palette"). Every finding, strength or weakness, must name a specific element on this specific cover; weaknesses get a specific replacement, strengths get a reason they must not be lost.

Scope routing: interior pages and spreads go to `ux-information-critique`; application screens go to `ux-page-critique`.

## Inputs

Required:
- **An image of the cover.** Front cover minimum; full jacket, spine, or wrap if available.
- **Positioning:** the title and author as they should read, the genre or category, the target reader, the author's market standing (debut, mid-list, brand name), and the primary sales context (online retail, physical shelf, both).

If positioning is missing, ask for it in one line before proceeding. A cover cannot be judged without knowing which shelf it is fighting for — a critique that assumes the wrong genre is worse than none. Accept an informal answer; "debut cozy mystery, mostly Amazon" is enough.

Optional but valuable, and worth asking for once if not offered: comparable titles or images of comp covers, series membership, the subtitle and any straplines or endorsement quotes that must appear, and constraints (publisher template, existing series look, what can't change).

## Before Step 1: establish your eyes

The cover image is this critique's entire evidence base, and not every model
running this skill can view images — one that cannot will write a fluent, wholly
fabricated critique rather than admit it. Settle the question first with the
sibling `see` skill: run its probe and carry the mode into the output.

- `host-vision` — view the image and work exactly as written below.
- `codex-relay` — you cannot see it. Every observation comes from a `codex-see`
  question: the blind read first, with the positioning withheld, then the
  thumbnail test (ask explicitly what survives at thumbnail scale), then one
  question per rubric dimension. Attribute each observation to the relay.
- `source-only` — you have no eyes. Stop. Say the cover cannot be examined and
  offer the alternatives (install Codex CLI, or describe the cover in text). Do
  not critique a cover you have not seen.

## Method

Work through these seven steps in order. Steps 1 and 2 must happen before reading the positioning closely, because their diagnostic value depends on being uncontaminated by what the cover is *supposed* to signal.

### Step 1: Blind read

Before applying the positioning, look at the image alone and answer in one or two sentences each:
- What genre and register does this look like? (Literary or commercial? Trade or academic? Professionally published or self-published?)
- What experience does it promise — what would a browser expect this book to feel like?
- Where does the eye land first, second, third?
- Where does it sit on Chip Kidd's clarity–mystery spectrum, and does that position invite or confuse?

Write these down in the output. This simulates the browsing moment, which is the only moment a cover gets. Readers assign genre and register in under a second, from convention, before reading a word. If the blind read mis-genres the book, that gap *is* the headline finding, and it usually can't be fixed by adjusting anything else.

### Step 2: Thumbnail test

If the image is available as a file, downscale it to roughly 150px wide and look at the result:

```
sips --resampleWidth 150 cover.png --out <scratchpad>/cover-thumb.png   # macOS
magick cover.png -resize 150x <scratchpad>/cover-thumb.png              # ImageMagick
```

Answer: Is the title legible? The author name? Is there one dominant shape or color block? Is the genre still identifiable? What essential detail vanished?

Retail grids and social feeds display covers at roughly app-icon scale, and covers are increasingly seen there first. For an online-first book, thumbnail failure is a P0 regardless of how good the full-size execution is. If no file is available, view the image small and say the test was approximate.

### Step 3: Compare against the positioning

Now read the positioning and state plainly:
- **Genre:** does the cover signal the stated category, the wrong category, or no category? Publishers deliberately design toward familiarity — commercial editors brief designers with direct competitor covers because readers are drawn to covers that feel like the books they already love. "It doesn't look like other books in the genre" is a finding, not a compliment, unless the differentiation is clearly deliberate and the genre signal survives it.
- **Hierarchy vs. market standing:** debuts are title-led (the title must do the interest-capture); brand-name authors are name-led (the name is the product). Check that the size relationship between title and author name matches the author's actual position, and that any straplines, blurbs, or badges are earning their space.
- **Register:** does the finish level match the price point and shelf? Name any tell that reads self-published (the rubric's dimension 7 lists them).

Name mismatches specifically. Not "the cover could better signal genre" but "the script face and pastel palette promise a rom-com; the positioning says psychological thriller — the reader this cover attracts will be the wrong one, and the right one will scroll past."

### Step 4: Apply the rubric

Read `references/rubric.md` and work through all eight dimensions. Do not skip dimensions that seem fine — a strong dimension is a finding too (it feeds Step 6), and covering all eight keeps the critique from becoming a list of whatever caught the eye first.

Score each dimension 1–5 using the anchors. Scores are diagnostic scaffolding, not the deliverable; never present them without the specific findings underneath. While scoring, note the specific elements responsible for high scores. "Concept: 4" is scaffolding; "the single burned matchstick doing the work of the whole arson plot is the cover's best idea" is a finding.

### Step 5: Convert findings into changes

Every finding becomes an entry with four parts:

1. **Observation** — what is literally visible. "The title is set in a thin serif over the busiest region of the photograph."
2. **Principle** — which idea it violates, and whose, where the attribution is certain. Where uncertain, state the principle without a name — see the guardrails.
3. **Change** — a specific, implementable instruction. "Move the title to the sky area, set it in a heavier weight, and let the figure sit under it at half the current size."
4. **Expected effect** — what improves and for whom. Keep it honest; if the effect is small, say so.

Assign each a priority:
- **P0** — the right reader never picks it up: mis-signals genre or audience, title unreadable at retail size, or the concept actively repels the target reader.
- **P1** — weakens the promise: muddy concept, hierarchy misaligned to market standing, degraded thumbnail, register below the price point.
- **P2** — craft: kerning, spacing, integration refinements, polish.

Order by priority, then by effort. Ordering by severity alone buries the cheap wins.

### Step 6: Record what to keep

Convert the strengths noted in Steps 1–4 into **keep** entries with three parts:

1. **Observation** — the specific element or decision that works.
2. **Principle** — why it works, attributed under the same rule as Step 5.
3. **Risk if lost** — the concrete way a plausible fix would destroy it. "Enlarging the title to fix the thumbnail will crowd the negative space that gives the figure its isolation — enlarge into the sky, not toward the figure."

A keep is not praise; it is a constraint on the changes. Aim for 2–4, held to the same specificity bar as the changes. A keep must be something that would hold up on the front table of a good bookstore, not merely the least-bad part of this cover. If nothing clears that bar, say so plainly.

### Step 7: State the limits

End with what could not be assessed from the image provided. Be concrete rather than issuing a blanket disclaimer. See the guardrails.

## Output format

```
## Blind read
[Four answers from Step 1, before the positioning was applied]

## Thumbnail test
[What survives and what vanishes at ~150px]

## Positioning alignment
[Genre, hierarchy, and register — match or mismatch, stated specifically]

## Scorecard
[Eight dimensions, 1–5, one clause of justification each]

## Keep
[2–4 entries: Observation / Principle / Risk if lost]

## Changes
### P0
[Observation / Principle / Change / Expected effect]
### P1
...
### P2
...

## What I could not judge from this image
[Specific gaps, plus what would resolve each]
```

Aim for 3–8 changes and 2–4 keeps. If dimensions 1 or 2 of the rubric score low, say the cover needs a new concept rather than adjustments, and describe what the new concept must do — polishing typography on the wrong concept wastes a design round. In that case the Keep section matters most, because it defines what the next concept must carry forward.

## Epistemic guardrails

**Never invent an attribution.** Naming a designer per finding is useful compression, but it creates pressure to manufacture provenance. Attribute only where genuinely confident; otherwise state the principle unattributed. A correct principle with no name is fine. A correct principle with the wrong name is a fabrication the user may go on to repeat.

**Production is invisible on screen.** Finish, foil, deboss, cloth, paper stock, and sprayed edges can transform a design — they are load-bearing in classics, romantasy special editions, and gift books. When a judgment could flip on production values, say so instead of guessing.

**Screen color is not print color,** and not even other screens' color. Judge relationships (contrast, dominance, temperature), not absolute hues, and flag close calls as *verify on a proof*.

**Judge only what is shown.** Do not speculate about the spine, back cover, or flaps unless they are in the image; if the sales context is physical shelving, note that an unseen spine is a real gap — spine-out is how most physical books are actually displayed.

**Genre conventions are local in time and market.** State the assumption (contemporary US/UK trade unless told otherwise). Conventions date quickly — a style that reads as a past trend cycle (the rubric names known cases) is a legitimate, dateable finding, not an aesthetic opinion.

**Prediction, not test.** This critique predicts browsing behavior; it is not sales data. Where the stakes justify it, recommend the checks that settle it: the cover placed in a real retail grid next to its comps, and a preference test with genre readers. Never let a rubric score substitute for that.

**No claims about the book's content beyond the brief.** The critique evaluates the promise, not the book. Whether the book keeps the promise is not assessable here — but note when a cover promises something the positioning says the book is not, because that mismatch produces bad reviews, not just weak sales.

## Multiple covers

Two distinct multi-image tasks; name which one is being performed.

**Candidate comparison** — several directions for the same book. Score each against the same positioning, but lead with the concept question: which candidates distill and which illustrate. Separate fixable weaknesses (execution) from terminal ones (concept), and recommend one direction with the reason. Do not average — a bold concept with rough execution beats a polished nothing.

**Comp-set analysis** — a stack of covers from one genre or shelf. Extract the shared armature: palette range, type register, imagery mode, hierarchy conventions, front-cover furniture. Then identify, per cover, the single axis on which it differentiates from the pack. The output is two lists: the convention set a new cover must signal to be shelved correctly, and the differentiation space still unclaimed. This is the mode that feeds designing a new cover from the strengths of many.

## Series covers

If the cover belongs to a series, judge it twice: as a cover, and as a unit in the system. The canonical pattern is a fixed armature with variable content — Romek Marber's Penguin Crime grid held the typographic zones and category color constant while the image varied; Coralie Bickford-Smith's Clothbound Classics hold foil, cloth, and pattern constant while motif and palette vary. Identify the series constants (grid, type, color, material, motif), check whether this cover holds them, and check whether the variation is deliberate and rhythmic rather than drift. Breaking the system is occasionally right; not knowing the system exists never is.

## Tone

Direct and specific, in both directions. Attack the artifact, not the person who made it. Self-published authors get the same rubric as Knopf — the professional-tell findings in dimension 7 are mostly execution problems with known fixes, and saying so is more useful than softening them. If the cover is largely working, say that plainly: the deliverable becomes a long Keep section and a short list of changes, and that is a legitimate outcome of the critique, not a failure of it.
