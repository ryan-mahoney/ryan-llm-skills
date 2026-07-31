---
name: ux-page-critique
description: Critique a screenshot of an application page against a Job To Be Done and propose specific, prioritized UX and visual design improvements. Use this skill whenever the user shares a screenshot, mockup, or screen recording of an interface and asks for design feedback, a UX review, a critique, a redesign, or wants to know why a page feels cluttered, confusing, or unpolished — even if they don't use the word "critique." Also use when the user asks how to improve conversion, clarity, hierarchy, or usability on a specific screen, or asks whether a page "works." Applies to web apps, SaaS dashboards, mobile screens, and marketing pages.
argument-hint: "<screenshot> <job-to-be-done>"
metadata:
  version: "1"
---

# UX Page Critique

Turn a screenshot plus a stated user goal into two lists: prioritized specific changes, and the specific things that work and must survive those changes. Both are justified by established design principles.

The failure mode this skill exists to prevent is generic feedback. "Improve contrast, add whitespace, simplify the navigation" is true of almost every interface and therefore useless — and "clean layout, nice typography" is its equally useless positive twin. Every finding produced here, strength or weakness, must name a specific element on the specific page; weaknesses get a specific replacement, strengths get a reason they must not be lost.

## Inputs

Required:
- **An image** of the page (screenshot, mockup, or frame).
- **A Job To Be Done (JTBD)** for the page: who the user is, what they're trying to accomplish, and what "done" looks like to them.

If the JTBD is missing, ask for it in one line before proceeding — a critique without a stated goal collapses into aesthetic preference. Accept an informal answer; two sentences is enough. Don't demand a formal JTBD statement.

Optional but valuable, and worth asking for once if not offered: known friction points (support tickets, drop-off, questions users keep asking), the surrounding flow (what screen comes before and after), constraints (design system, framework, what can't change), and the platform/viewport.

## Before Step 1: establish your eyes

The image is this critique's entire evidence base, and not every model running
this skill can view images — one that cannot will write a fluent, wholly
fabricated critique rather than admit it. Settle the question first with the
sibling `see` skill: run its probe and carry the mode into the output.

- `host-vision` — view the image and work exactly as written below.
- `codex-relay` — you cannot see it. Every observation comes from a `codex-see`
  question. Ask the blind read as its own relayed question with the JTBD
  withheld, then one relayed question per rubric dimension. Attribute each
  observation to the relay, and never restate a relay answer more confidently
  than it was given.
- `source-only` — you have no eyes. Stop. Say the image cannot be examined and
  offer the alternatives (install Codex CLI, or describe the page in text). Do
  not critique a screenshot you have not seen.

## Method

Work through these six steps in order. Step 1 must happen before reading the JTBD closely, because its diagnostic value depends on being uncontaminated by the intended goal.

### Step 1: Blind read

Before applying the JTBD, look at the image alone and answer in one or two sentences each:
- What is this page for?
- Who is it for?
- What is the single most important thing the user can do here?
- Where does the eye land first, second, third?

Write these down in the output. This is Steve Krug's trunk test performed honestly: if the blind read doesn't match the JTBD, that gap *is* the headline finding, and it usually explains most of the page's other problems. Resist the urge to peek — a blind read that quietly incorporates the stated goal is worthless.

### Step 2: Compare against the JTBD

State plainly whether the page is organized around the user's goal or around the system's data model. This is Alan Cooper's goal-directed design test. Common tell: the page is titled after a database entity ("Assessments") rather than a user intent ("Choose who to interview"), and the primary action is a CRUD operation rather than the thing the user came to do.

Name the mismatch specifically. Not "the page could better reflect user goals" but "the JTBD is *decide who advances*, but the page affords *view individual records* — there's no way to compare two candidates without leaving this screen."

### Step 3: Apply the rubric

Read `references/rubric.md` and work through all eight dimensions. Do not skip dimensions that seem fine — a strong dimension is a finding too (it feeds Step 5), and covering all eight prevents the critique from becoming a list of whatever happened to catch the eye first.

Score each dimension 1–5 using the anchors in the rubric. Scores are diagnostic scaffolding, not the deliverable. Never present scores without the specific findings underneath them.

While scoring, note the specific elements responsible for high scores, not just the score itself. "Grouping: 4" is scaffolding; "the two-level spacing scale makes the card groups legible without a single border" is a finding.

### Step 4: Convert findings into changes

Every finding becomes an entry with four parts:

1. **Observation** — what is literally visible. "The Export, Archive, and Advance buttons are all the same size, weight, and color, in the top right."
2. **Principle** — which idea it violates, and whose, where the attribution is certain. Naming a source lets the user go read it and disagree. Where the source is uncertain, state the principle without a name rather than guessing — see the guardrail below.
3. **Change** — a specific, implementable instruction. "Make Advance a solid primary button. Demote Export and Archive to a single overflow menu behind a kebab icon."
4. **Expected effect** — what improves and for whom. Keep this honest; if the effect is small, say so.

Assign each a priority:
- **P0** — blocks the JTBD or actively misleads. The user cannot do the thing, or does the wrong thing.
- **P1** — creates friction, hesitation, or error risk on the main path.
- **P2** — polish, consistency, and craft. Real but not urgent.

Order by priority, then by effort. Ordering by severity alone tends to bury the cheap wins.

### Step 5: Record what to keep

Convert the strengths noted in Steps 1–3 into **keep** entries with three parts:

1. **Observation** — the specific element or decision that works. "Status is conveyed by a colored dot plus a text label, consistently across all three tables."
2. **Principle** — why it works, attributed under the same rule as Step 4: name the source only when certain.
3. **Risk if lost** — the concrete way a plausible fix would destroy it. "Consolidating the tables to save space would likely drop the labels first — don't."

A keep is not praise; it is a constraint on the changes. Its purpose is to stop the P0 fixes from regressing what the page already does well, and to tell the person implementing the changes what is deliberate rather than accidental. Aim for 2–4 keeps. Hold them to the same specificity bar as the changes: "clean layout" is as empty as "add whitespace." If nothing on the page clears that bar, say so plainly — an honest empty section is better than a manufactured strength.

A keep must be something that would hold up in a good product, not merely the least-bad part of this page. Do not grade on a curve.

### Step 6: State the limits

End with what could not be assessed from a static image. Be concrete about this rather than issuing a blanket disclaimer. See "Epistemic guardrails" below.

## Output format

Use this structure:

```
## Blind read
[Four answers from Step 1, before the JTBD was applied]

## JTBD alignment
[Match or mismatch, stated specifically]

## Scorecard
[Eight dimensions, 1-5, one clause of justification each]

## Keep
[2-4 entries: Observation / Principle / Risk if lost — the things the changes below must not break]

## Changes
### P0
[Observation / Principle / Change / Expected effect]
### P1
...
### P2
...

## What I could not judge from a screenshot
[Specific gaps, plus what would resolve each]
```

Aim for 3–8 changes and 2–4 keeps. A list of thirty findings is a way of avoiding the judgment call about what matters, and it guarantees nothing gets done. If more than eight real problems exist, say the page needs restructuring rather than adjustment, and describe the restructure — and in that case the Keep section matters most, because it defines what the restructure must carry forward.

## Epistemic guardrails

These exist because a confident wrong measurement is worse than an acknowledged gap, and because design feedback delivered with false precision is hard to argue with.

**Do not state pixel values, spacing measurements, or font sizes as fact.** Screenshots are scaled and compressed. Say "the gap between the header and the table looks roughly equal to the gap between table rows, which flattens the grouping" — not "the padding is 12px."

**Do not compute contrast ratios and present them as measured.** Flag suspected contrast failures as *verify*: "the secondary grey text on the card background looks likely to fall below 4.5:1 — check it." Recommending a tool check is more useful than inventing a number.

**Never assess motion, transitions, latency, or perceived responsiveness from a still image.** If these seem central to the page's problems, say so and request a recording.

**Never invent an attribution.** Naming a source per finding is useful compression, but it creates pressure to manufacture provenance — "as Norman observes..." attached to something Norman never wrote. Attribute only where genuinely confident. Otherwise state the principle unattributed; it loses nothing. A correct principle with no name is fine. A correct principle with the wrong name is a fabrication the user may go on to repeat.

**Do not claim what users will do.** This is a heuristic review, not usability testing. It predicts where problems are likely, which is different from evidence that they occur. Say "this is likely to cause hesitation because..." and note that five moderated sessions would settle it. Never let a rubric score substitute for that.

**Distinguish what's visible from what's inferred.** If a state, interaction, or off-screen element is being assumed, mark it as an assumption.

**Where principles conflict, say so.** Density versus clarity, consistency versus fitness for purpose, and progressive disclosure versus discoverability all pull against each other regularly. Naming the tradeoff and picking a side with a reason is more useful than pretending the rubric resolves it.

## Multi-screen input

If given several screens from one flow, additionally check:
- **Consistency drift** — the same concept named differently, competing button styles, a spacing system that holds on one screen and not the next, multiple greys doing the same job.
- **Continuity** — does each screen confirm the previous action succeeded, and make the next step obvious?
- **Step count** — which steps exist for the user's benefit versus the system's?

Report cross-screen findings in their own section before the per-screen ones, since they typically indicate a design-system gap rather than a page-level problem, and fixing them once fixes them everywhere.

## Tone

Direct and specific, in both directions. Attack the artifact, not the person who made it — and treat the Keep section as real findings, not a courtesy paragraph before the criticism. Founders who designed their own product are often one or two structural changes away from something good; the Keep section is where that becomes visible instead of buried under a wall of criticism.

If the page is largely working, say that plainly rather than manufacturing findings to justify the exercise — the deliverable becomes a long Keep section and a short list of changes, and that is a legitimate outcome of the critique, not a failure of it.
