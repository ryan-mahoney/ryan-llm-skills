---
name: ux-information-critique
description: Critique book pages or document spreads that convey information — trade nonfiction, textbooks, reference works, manuals, reports — against the intended reading job, and propose specific, prioritized typographic and structural improvements. Use this skill whenever the user shares an image or PDF of a book interior, page layout, spread, or information-dense document and asks for design feedback, a typography review, a layout critique, or why a page feels dense, gray, cluttered, or hard to navigate — even if they don't use the word "critique." Also use when the user asks whether a page "reads well," how to make a chapter or report clearer, how to improve tables, figures, captions, or heading structure, or wants to extract the structural strengths of several exemplary layouts to inform a new design.
argument-hint: "<page-images-or-pdf> <reading-job>"
metadata:
  version: "1"
---

# UX Information Critique

Turn images of information-bearing pages plus a stated reading job into two lists: prioritized specific changes, and the specific things that work and must survive those changes. Both are justified by established book typography and information design principles.

The organizing idea comes from Willberg and Forssman's *Lesetypografie*: typography is judged by the *kind of reading* it must serve. A novel page, a textbook page, and a dictionary page obey different laws, and a page can satisfy every local craft rule while failing its reading mode entirely. The first question is never "is this well set?" but "well set *for what kind of reading*?"

The failure mode this skill exists to prevent is generic feedback. "Increase the leading, add white space, break up the text" is true of almost every dense page and therefore useless — and "clean layout, nice typography" is its equally useless positive twin. Every finding must name a specific element on the specific page; weaknesses get a specific replacement, strengths get a reason they must not be lost.

Scope routing: book covers go to `ux-cover-critique`; application screens go to `ux-page-critique`.

## Inputs

Required:
- **Images or a PDF of the pages.** Prefer full spreads over single pages — the double-page spread, not the page, is the unit of book design (Hochuli), and margin and running-head judgments are impossible from a cropped page. PDFs can be read directly, page ranges at a time.
- **The reading job:** who reads this, in what mode, and what they should come away with.

If the reading job is missing, ask for it in one line: "Who reads this, and how — straight through, to look things up, or to study parts selectively?" A critique without a stated reading mode collapses into rule-checking. Accept an informal answer.

Optional but valuable, and worth asking for once if not offered: the trim size and whether the sample is at actual size, the book's genre and competitive set, which page types exist beyond those shown (openers, tables, index, notes), known reader complaints, and constraints (template, brand, tooling, what can't change).

## Before Step 1: establish your eyes

The page images are this critique's entire evidence base, and not every model
running this skill can view images or render a PDF — one that cannot will write
a fluent, wholly fabricated critique rather than admit it. Settle the question
first with the sibling `see` skill: run its probe and carry the mode into the
output.

- `host-vision` — read the images or PDF pages directly and work as written below.
- `codex-relay` — you cannot see them. Every observation comes from a `codex-see`
  question, and the relay takes images, not PDFs: export the pages to PNGs
  first, one spread per image, and relay them in reading order. Ask the blind
  read with the reading job withheld, then one question per rubric dimension.
  Attribute each observation to the relay.
- `source-only` — you have no eyes. Stop. Say the pages cannot be examined and
  offer the alternatives (install Codex CLI, or describe the layout in text). Do
  not critique a spread you have not seen.

## Method

Work through these six steps in order. Step 1 must happen before reading the stated reading job, because its diagnostic value depends on being uncontaminated by it.

### Step 1: Blind read

Before applying the stated reading job, look at the pages alone and answer in one or two sentences each:
- What kind of book or document is this, and who is it for?
- How does the page *expect* to be read — straight through, scanned, looked up, studied?
- Where does the eye enter the page, and what path does it take?
- At arm's length (or downscale the spread to ~300px wide and look at that), what structure is visible as pure blocks of gray and white?

Write these down in the output. The arm's-length view is the page's honest self-description: heading structure, grouping, and density are all legible as value patterns before a single word is read. If the blind read's answer to "how does this expect to be read" differs from the stated reading job, that gap *is* the headline finding.

Count what is countable while looking closely — these are facts, not estimates, and they anchor the whole critique:
- characters per line on a few full lines (including spaces)
- lines per page
- heading levels visible, and the signals distinguishing them
- distinct emphasis forms in play (italic, bold, caps, color, underline)
- typefaces in use
- consecutive hyphenated line-ends, if justified

### Step 2: Name the reading mode

Classify the page against Willberg and Forssman's typology (detailed in the rubric): **linear** (immersive continuous reading), **informative** (skimming to find whether and where), **differentiating** (slow scholarly reading of layered content), **consultative** (targeted lookup), **selective** (some parts read, others skipped). Most information-bearing books mix two; name the primary and secondary mode.

State plainly whether the page's architecture serves the stated reading job or a different one. Name the mismatch specifically. Not "the layout could better support scanning" but "the reading job is *selective study*, but nothing distinguishes the worked examples from the narrative — a student hunting for examples must read everything, which is the one thing selective typography exists to prevent."

A mode mismatch is structural: it cannot be fixed by leading and kerning, and it makes polish recommendations premature.

### Step 3: Apply the rubric

Read `references/rubric.md` and work through all eight dimensions. Do not skip dimensions that seem fine — a strong dimension is a finding too (it feeds Step 5), and covering all eight keeps the critique from becoming a list of whatever caught the eye first. Skip dimensions only when genuinely absent from the sample (no tables shown → dimension 6 is "not assessable," which is itself worth reporting if tables exist in the book).

Score each dimension 1–5 using the anchors. Scores are diagnostic scaffolding, not the deliverable; never present them without the specific findings underneath. While scoring, note the elements responsible for high scores. "Text setting: 4" is scaffolding; "the 66-character measure with generous leading is why a dense subject reads calmly" is a finding.

### Step 4: Convert findings into changes

Every finding becomes an entry with four parts:

1. **Observation** — what is literally visible, with counts where possible. "Body lines run 95–100 characters; the leading looks roughly equal to a single line height."
2. **Principle** — which idea it violates, and whose, where the attribution is certain. Where uncertain, state the principle without a name — see the guardrails.
3. **Change** — a specific, implementable instruction. "Narrow the text block to bring the measure near 66 characters, and give the freed fore-edge width to the margin — which also creates the home the orphaned figure captions need."
4. **Expected effect** — what improves and for whom. Keep it honest; if the effect is small, say so.

Assign each a priority:
- **P0** — defeats the reading job. The reader cannot do what they came to do: content levels indistinguishable in a selective text, no lookup apparatus in a consultative one, figure and argument separated by a page turn, structure invisible.
- **P1** — friction and fatigue on the main reading path: bad measure, tight or inconsistent leading, emphasis noise, rivers, widow/orphan patterns, captions that don't carry their figure.
- **P2** — finish and craft: letterspacing of small caps, figure style, rag quality, folio placement.

Order by priority, then by effort. Ordering by severity alone buries the cheap wins.

### Step 5: Record what to keep

Convert the strengths noted in Steps 1–3 into **keep** entries with three parts:

1. **Observation** — the specific element or decision that works. "Sidenotes sit in the outer margin directly beside the passages they annotate."
2. **Principle** — why it works, attributed under the same rule as Step 4.
3. **Risk if lost** — the concrete way a plausible fix would destroy it. "Widening the text block to fix the short measure would consume the margin the sidenotes live in — fix the measure with size, not width."

A keep is not praise; it is a constraint on the changes. Aim for 2–4, held to the same specificity bar as the changes. A keep must be something that would hold up in a well-made book, not merely the least-bad part of this one. If nothing clears that bar, say so plainly.

### Step 6: State the limits

End with what could not be assessed from the sample provided. Be concrete rather than issuing a blanket disclaimer. See the guardrails.

## Output format

```
## Blind read
[Four answers plus the counts from Step 1, before the reading job was applied]

## Reading mode
[Primary and secondary mode; match or mismatch with the stated job, stated specifically]

## Scorecard
[Eight dimensions, 1–5, one clause of justification each; "not assessable" where the sample lacks the material]

## Keep
[2–4 entries: Observation / Principle / Risk if lost]

## Changes
### P0
[Observation / Principle / Change / Expected effect]
### P1
...
### P2
...

## What I could not judge from this sample
[Specific gaps, plus what would resolve each]
```

Aim for 3–8 changes and 2–4 keeps. If the reading mode itself is wrong (Step 2, or rubric dimensions 1–2 scoring low), say the page needs rearchitecting rather than adjustment, and describe what the new architecture must do — refining the leading on the wrong architecture wastes a design round. In that case the Keep section matters most, because it defines what the rearchitecture must carry forward.

## Epistemic guardrails

**Count; don't measure.** Characters per line, lines per page, heading levels, emphasis forms, and typefaces are countable from an image and should be reported as counts. Point sizes, margins in millimeters, and exact leading are not recoverable from a scaled image — express them as relationships: "the leading looks tight for this measure," "the foot margin appears smaller than the head, inverting the classical arrangement." If the user can state trim size and point size, ratios become checkable — ask rather than assert.

**Photographed spreads distort.** Page curvature, perspective, and uneven lighting corrupt exactly the things being judged — alignment, margins, evenness of color. Prefer PDFs or flat scans; flag any judgment that could be an artifact of the photograph.

**One spread is not the system.** Book design is a system enforced across hundreds of pages; a single sample cannot establish consistency, and the shown spread is usually a flattering one. Limit consistency claims to what is visible, and request the revealing page types: a chapter opener, a dense text spread, a spread with a table or figure, and the notes or index. What a design does with its hardest page is the real test.

**Never invent an attribution.** Naming a source per finding is useful compression, but it creates pressure to manufacture provenance. Attribute only where genuinely confident; otherwise state the principle unattributed. A correct principle with no name is fine. A correct principle with the wrong name is a fabrication the user may go on to repeat.

**Define contested terms before using them.** "Widow" and "orphan" have no industry-consistent assignment — this skill uses Chicago's: a *widow* is a paragraph's last line stranded at the top of a page; an *orphan* is a paragraph's first line stranded at the bottom. Say which convention is in use when the finding depends on it.

**Prediction, not test.** This critique predicts reading experience; it is not comprehension data. Karen Schriver's research adds a sharper warning: readers who struggle with a document tend to blame themselves, not the design — so the absence of complaints is not evidence the design works. Where stakes justify it, recommend the check that settles it: a few readers given the actual lookup or study tasks the book claims to serve.

**Print rendering is not screen rendering.** Ink gain, paper color, and print contrast change apparent weight and gray value. Flag close calls — a light gray secondary text, a thin rule — as *verify on a printed proof*.

## Multi-spread input

If given several spreads from one book, additionally check:
- **System consistency** — do margins, running heads, heading treatments, caption styles, and baseline placement hold across spreads, or drift? Same-level headings treated differently on different pages is a system failure, not a local one.
- **Register** — do lines of text back up across the sheet and align across the spread? Vertical spacing added in odd increments breaks it visibly.
- **Coverage** — which page types are represented and which are missing; report the system judgment as provisional until the hard pages (tables, notes, index) are seen.

Report cross-spread findings in their own section before the per-page ones, since they typically indicate a template gap rather than a page-level problem, and fixing them once fixes them everywhere.

When the input is several *different* books or documents (exemplars rather than one system), the task inverts: extract, per exemplar, the structural decisions responsible for its strengths — mode architecture, apparatus, figure handling — as specifically as keeps, so they can inform a new design. Name what each exemplar's approach costs, not just what it buys.

## Tone

Direct and specific, in both directions. Attack the artifact, not the person who made it. Authors who typeset their own books get the same rubric as a university press — most of what makes a page read as amateur is a small set of structural decisions with known fixes, and saying so is more useful than softening it. If the pages are largely working, say that plainly: the deliverable becomes a long Keep section and a short list of changes, and that is a legitimate outcome of the critique, not a failure of it.
