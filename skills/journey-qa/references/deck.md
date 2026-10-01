# Deck content

`scripts/build-deck.mjs` writes two kinds of deck from stored runs: one **journey
deck** per exploration, and one **summary deck** per collection of runs. This file
owns what a deck says. The formats it reads are defined once in
`harness-contract.md`; every band, rating word and threshold comes from
`scripts/rating.mjs` and no number that decides a rating is written here.

The audience is a skeptical partner who was not in the run. A deck therefore shows
every number it displays, names where that number came from, lists every
exploration of the scenario rather than the flattering one, and always carries the
limits slide. A deck that hides a missing capture, a repeated exploration or a
stubbed region fails its purpose; so does a deck that claims more than the run
established.

Both decks are **one self-contained HTML file**: inline CSS, no external
stylesheet, font stack `Inter, "Helvetica Neue", Helvetica, Arial, sans-serif`,
every `<img>` a `data:` URI, and no `http://` or `https://` string anywhere in the
file. Every displayed figure is rendered in an element carrying
`data-source="<path>"`, for example `proxies.actions` or `result.referenceActions`,
whose text is exactly the value at that path in the run files. The deck computes
nothing: values come from `result.json` (C-6), `review.json` (C-9) and
`brief.md`, and rating words from `rating.mjs`.

---

## Journey deck slides

`--run <run dir> --out <file> [--second-review <review.json>]`. Nine slides, in
this order. Slide 1 is `#s1`.

1. **Title.** The scenario's `Goal` in the user's own words, the run ID, and one
   **result line**: the rating from `rate()` — `Direct`, `Detours`, `Lost`,
   `Not completed` or `Not rated` — and, for a run whose check did not pass, the
   attribution wording of R18 beside the deciding step: `Not completed: product`
   when `review.journey.attribution` is `product`, and `Not completed in this run
   (tester or harness limit)` for `tester` or `harness`. The app commit under
   test (`result.json` `commit`, with `dirty` when the tree was not clean) appears
   on this slide.
2. **What the tester was given.** The tester-visible content of `brief.md`: the
   persona, the goal, the start path and the file names the tester could upload.
   Nothing from the harness-only scenario fields (`Account`, `Seed`, `Success
   check`, `Reference actions`, `Entry route`) appears here, because the tester
   never saw them (R5).
3. **Step filmstrip.** One row per executed step in `steps.jsonl` order: the
   capture, the action in the tester's vocabulary (`click`, `fill`, `select`,
   `upload`, `press`, `goto`, `back`, `scroll`, `look`, `wait`), the action
   target, the stated `--intent` and the stated `--expect`. A step whose capture
   file is absent renders a labelled `Not captured` placeholder; it never renders
   as nothing, and the step keeps its row. A rejected attempt is shown with its
   rejection reason and marked as not executed.
4. **Measured proxies.** The raw values of `result.json` `proxies` first —
   `actions`, `observations`, `scrolls`, `wrongTries`, `rejected`, `backtracks`,
   `errorsSeen.banners`, `errorsSeen.httpErrors`, `errorsSeen.consoleErrors`,
   `errorsSeen.failedActions`, `errorsSeen.total`, `endedInError`,
   `actionsToEntryRoute` and `elapsedSeconds` — each printed as its own number, and
   only then the band of each proxy as a text label from `bandOf()`. The
   denominator of path efficiency is `result.referenceActions`, the count the
   reference trail executed. Wall-clock time is reported and never banded.
5. **Reviewer scores.** The per-step questions of the review, one row per scored
   step with its capture names, headed `reviewer-assessed`, lowest-scoring steps
   first. A step with `q3: null` shows `not scored` rather than a zero. Heuristic
   scores appear only as cited findings: a heuristic number is never averaged,
   totalled or shown as a single screen score. A run with no scored step says so
   instead of implying a score.
6. **Findings.** Every entry of `review.json` `findings` with its severity, step
   number, capture, statement and consequence. When the array is empty the slide
   reads `No findings recorded.` — never an empty panel.
7. **Explorations of this scenario.** Every sibling run directory of the same
   scenario, including this one, one row each with the run ID, its
   `result.json` `status`, the tester's claim, and the rating when that run has a
   usable review. A sibling with no recorded result reads `no result recorded`. A
   run rated `Not rated` (a harness error) lists with its status and is never
   given a rating word. The slide states how many of the runs completed the
   scenario, so a single successful exploration out of several reads as one.
8. **Limits.** The six statements below, in this order, plus the two additional
   lines named after them.
9. **Evidence index.** Run ID, scenario ID, app commit and `dirty` flag, the
   check's own `observations` text, the capture count, and the `eyes` mode the run
   and the review recorded. This is where a reader checks a claim against the run
   files behind it.

## Summary deck slides

`--summary --brief <docs/product-brief.md> --runs <runs dir> --out <file>`. Six
slides, in this order.

1. **Title.** The brief's title, the collection the runs came from, the app
   commit of the most recent run in it, and the counts summary line.
2. **Per-journey ratings.** One row per journey and scenario: journey ID, scenario
   ID, the result of the latest usable run (`completed`, `not-completed` or `no
   result recorded`), the rating from `rate()`, the attribution and deciding step
   when the run was not completed, and how many explorations of that scenario
   exist.
3. **Coverage matrix.** One row per `FEAT-###` in the brief, one column per
   journey, and exactly three states per cell: `no registered journey` when the
   feature's Journeys column names no journey, `registered, not yet explored` when
   it names a journey with no usable run, and `explored: <rating>` when one does
   — one entry per scenario of that journey, for example `change-times Direct;
   add-trip Detours`, and for a run whose check did not pass `explored: Not
   completed: product` or `explored: Not completed in this run (tester or harness
   limit)`.
4. **Counts.** Three separate numbers, never merged: the number of features in the
   brief, the number of features with a registered journey, and the number of
   journeys explored. They differ, and a partner reading them must see that they
   differ.
5. **Limits.** The same six statements and two additional lines as the journey
   deck, worded identically.
6. **Evidence index.** Every run the summary used: run ID, scenario ID, commit,
   `eyes` mode, and the check's own `observations` text.

---

## Limits slide statements

These six statements are mandatory on both decks, in this order. Statement 6
appears only when a second review was supplied, and every deck states it as a
limit and never as a strength.

1. **The tester was instructed not to read the code.** The tester received only
   the brief and a browser; nothing in the harness can detect a file read, so this
   is the honest form of the claim.
2. **The data is a small demo feed.** Nine stops and two-stop trips, with
   calendars advanced by 1,000 weeks so service dates are in the future. No
   conclusion about real data volume or real calendar density follows from a run
   over this feed.
3. **Externals other than the validator are stubbed.** Geocoding, street routing,
   boundaries, basemap tiles and buildings, and the scripted language-model
   stand-in. The per-repository exclusion list is printed on this slide exactly as
   `result.json` `stubExclusions` carries it, and the validator is the real jar,
   not a stub.
4. **One exploration per scenario** unless the Explorations slide lists more.
   Every exploration of the scenario is listed there with its status and rating.
5. **The reviewer is the same model as the tester.** When it is a different one,
   the deck says which. Prompt-level independence is what the design relies on.
6. **Repeatability, not validity.** When `--second-review` is given, state the
   agreement `agreement()` computed — exact and within one, over the steps present
   in both reviews — and label it repeatability. One review is not a second data
   point.

Then, on their own lines:

- **Reviewer judgments are not user research.** A simulated tester walking a real
  stack says something about whether a path is legible to one careful agent
  reading a written brief. It does not say what users do, want or tolerate.
- **The app commit under test.** Name the commit, and say whether the working tree
  was dirty.

---

## Vocabulary rules

These rules bind deck prose, slide titles, table headers, findings text and the
caption of every figure. They exist because each banned word overstates what a
run establishes.

- Never write **"blind"**. Write **"instructed not to read the code"**. The
  harness cannot detect a file read, so blindness is not a claim this design can
  make (R3).
- Never write **"easy"**, or any other word about how a person feels. A run
  reports a path, not an experience.
- Never write **"passed"** about the application. Write the harness's own words:
  `completed`, `not-completed` or `harness-error`, and the check's `pass` value.
- Never write **"works"**. Write what was observed: the check's observations, the
  reviewer's finding, the proxy value.
- Write the rating words exactly as `rating.mjs` returns them: `Direct`,
  `Detours`, `Lost`, `Not completed`, `Not rated`.
- Write **"explored"** for a run that exists, never "verified" or "validated" for
  a run that a tester made. The validator is the one thing that validates, and it
  validates a feed, not a journey.
- Never state a band threshold or a rating rule as a number. Cite
  `scripts/rating.mjs`, which computes both.

## Interaction rules

Both decks behave the same way:

- `ArrowRight`, `ArrowDown` and `PageDown` advance one slide; `ArrowLeft`,
  `ArrowUp` and `PageUp` go back one slide.
- `Home` selects the first slide and `End` the last.
- A `#s<N>` location hash selects slide `N`, counted from 1, and the deck reads
  the hash on load so a slide can be linked to directly.
- The print stylesheet prints **every** slide, one per page, in order, with
  images present. A printed deck is a complete record, so printing a subset is a
  defect.
- Focus is visible on any control, and text contrast meets AA. Colour marks the
  rating and each severity only, always beside a text label, so the deck reads
  correctly in greyscale and to a reader who cannot distinguish the hues.

## Rebuild rule

**Rebuild the decks from the stored runs after any change to `rubric.md`,
`rating.mjs`, this file or the deck generator. No new exploration is needed.**
A run directory holds everything the deck reads — `result.json`, `review.json`,
`steps.jsonl`, `brief.md` and the captures — so re-running `build-deck.mjs` over
the same runs is what a rubric or wording change requires. A reviewer whose
judgment changes has produced a new `review.json` and a new `--second-review`
file; neither asks the application to be run again.

A capture that has gone missing since a deck was built is reported as `Not
captured` on the next build rather than left as a broken image. When a deck and a
run file disagree, the run file is the record and the deck is rebuilt, never
edited by hand.

The deck builder is the consumer of the formats in `harness-contract.md` (C-6,
C-9, C-11) and of the ratings in `rating.mjs`. When one of those changes, update
this file in the same change, so no slide ever describes a field the strict
loader would reject.
