# The reviewer rubric

Three levels, in this order: per step, per screen, per journey. A run produces one
`review.json` (C-9 in `harness-contract.md`) scored against this file.

The anchors below are the starting values a reviewer scores against. They are not
research results. Recalibrate them by editing this file, in the same change that
shows the anchors no longer describe what the reviewer actually sees.

**Every number that decides a rating lives in `scripts/rating.mjs`.** This file
states none of them. The measured proxies come from `result.json` (C-6), which
the harness computes; the band of each proxy and the rating come from
`rating.mjs`. If you find yourself wanting to write a cut-off here, you are about
to duplicate a threshold — cite `rating.mjs` and let it answer instead.

Reviewer judgments are not user research. A simulated tester walking a real
stack says something about whether the path is legible to one careful agent
reading a written brief. It does not say what users do, want, or tolerate.

---

## 1. Per step

Cognitive walkthrough, after Wharton, Rieman, Lewis and Polson (1994). Four
questions per **ok** action, scored 0 to 2, recorded against the step number and
the capture names in `steps[].captures`.

A step with `ok:false` is **not scored**. Count it as a wrong try in
`proxies.wrongTries` and read its record for evidence; a rejected attempt still
has a step number.

**Q1 — right sub-goal.** Does the tester's stated intent match a sub-goal the
screen actually offers?

- **2** — the intent matches a sub-goal visible on this screen.
- **1** — the tester is guessing: the record or a note shows a "try" or "maybe"
  before the action.
- **0** — the intent matches nothing on this screen, or the tester is lost or
  working toward something unrelated.

**Q2 — notice the action.** Did the tester see the control the action needed, on
this screen, in the initial viewport?

- **2** — the first action taken on this screen was the needed control, and it is
  visible in the initial-viewport capture.
- **1** — a scroll, a tab change, a menu open, or one wrong try was needed first.
- **0** — two or more wrong tries, or the control is not visible in the capture.

**Q3 — label predicts effect.** Did the label or control text set an expectation
that the observed outcome met?

- **2** — the observed outcome matches the expectation logged before the action
  (`steps.jsonl` `expected`).
- **1** — partial: the outcome was right but not the one promised, or the promise
  was vague enough to be satisfied by accident.
- **0** — the outcome contradicted the expectation, or the tester logged surprise
  or confusion.
- **null** — no expectation was logged. Not scored, and never 0.

**Q4 — progress visible.** Did the screen afterwards show that something
happened, tied to that action?

- **2** — the post-action capture shows explicit confirmation, or an unmistakable
  state change attributable to the action.
- **1** — the screen changed without any confirmation that the change came from
  this action.
- **0** — nothing visibly changed, or an error appeared with no next step.

Any question at **0** is a finding candidate. It is not automatically a defect:
an action the brief told the tester to perform may still be a design finding, and
`rating.mjs` treats a zero anywhere as a reason the run is not `Direct`.

---

## 2. Per screen

One entry per distinct route the run visited. Nielsen's ten heuristics, each
scored 0 to 3, plus the states from `rules/ux-states.md` section 1.

**Heuristic scale** (H1 visibility of system status, H2 match with the real
world, H3 user control and freedom, H4 consistency and standards, H5 error
prevention, H6 recognition over recall, H7 flexibility and efficiency, H8
aesthetic and minimalist design, H9 recover from errors, H10 help and
documentation):

- **3** — nothing observed against this heuristic on this screen in this run.
- **2** — a minor issue, noticed but not worked around.
- **1** — friction the tester had to work around, with the workaround recorded.
- **0** — blocked or misled; the tester could not proceed as intended.
- **n/a** — with a reason. `n/a` is not a zero and does not drag the screen.

A heuristic score reaches a deck only as a cited finding — the heuristic, the
step or capture, and what the tester observed. Never as an aggregate, an average,
or a percentage across screens: the screen that never got visited cannot be
averaged in, and an average hides the single zero that matters.

**States.** For each required state in `rules/ux-states.md` section 1 — empty,
loading, error, partial or degraded, permission denied or unavailable when access
can vary, offline or reconnecting when network state matters, stale or
revalidating, ideal — record `seen` or `not exercised in this run`. Absence is
**reported**, never scored: a screen that never reached an error state has no
error-state finding, and never earns a zero for one it was not asked to reach.

**Contrast, target size and focus are `verify` items.** They go in
`screens[].verify` for a follow-up with real tooling and a real user agent. They
are never measured from a screenshot, and a ratio asserted from a captured image
is a fabricated number.

A screen with a **0** or **1** anywhere may get an optional `ux-page-critique`
follow-up. That is a separate, deliberate task after the run, not a step of it.

---

## 3. Per journey

The measured proxies are computed by the harness into `result.json` (C-6):
`actions`, `backtracks`, `errorsSeen.total`, `endedInError` and
`actionsToEntryRoute`, each read against `referenceActions` for the efficiency
ratio. The reviewer reads them; the reviewer does not recompute them.

The bands and the rating are computed by `scripts/rating.mjs` from those raw
numbers. This file defines the vocabulary only, in words:

- **Direct** — the external check passed, every proxy sits in its best band, and
  no step question scored 0. The top rating is `Direct`, not "easy": a simulated
  tester who completed without detours supports a claim about the path, not about
  how easy the product is.
- **Detours** — the check passed, with at least one proxy in its middle band or
  at least one step question at 0.
- **Lost** — the check passed, with at least one proxy in its worst band.
- **Not completed** — the external check failed. The reviewer attributes it to
  `product`, `tester` or `harness` and names the deciding step; the harness cannot
  tell those three apart on its own.
- **Not rated** — a harness error, or no check result. Nothing about the journey
  is claimed, and **no deck is built**.

**Presentation order.** Completion and the measured proxies come first, because
they are the part of the run that was measured rather than judged. The reviewer
scores come second under the label "reviewer-assessed", so a reader never has to
remember which half of the deck is an instrument reading and which half is one
agent's opinion.

**Where thresholds may change.** Only in `scripts/rating.mjs` and its tests. To
retune a band, edit the constant there, run `node --test
skills/journey-qa/scripts/rating.test.mjs`, and leave this file saying whatever
it says now. If the anchors here stop matching what reviewers actually do, fix
the anchors here; that is a change to judgment, and it does not go through the
rating module.

---

## Sources

- John Wharton, Jacob Rieman, Clayton Lewis and Peter Polson, "The Cognitive
  Walkthrough Method: A Practitioner's Guide" (1994) — the four per-step
  questions.
- Jakob Nielsen, *Usability Engineering* and the ten usability heuristics.
- `rules/ux-states.md` — the required states a data-driven view defines.
- `references/harness-contract.md` — C-6 `result.json`, C-9 `review.json`.
- `scripts/rating.mjs` — the only place a threshold is written.