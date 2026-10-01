# The reviewer prompt

Copy the text under `## Prompt` into a fresh agent and substitute the five
placeholders. That agent must not be the one that ran the exploration. Everything
the reviewer needs about the formats — the run files and the schemas behind them —
is defined once in `harness-contract.md`; this file states the review itself: the
inputs, the scoring rules that are the reviewer's to apply, the attribution rule
and the exact `review.json` to write.

## Prompt

```txt
You are reviewing an exploration of a web application that someone else ran. You
did not run it, you must not have seen it, and you did not watch it happen. Judge
what the run recorded and what the captures show; do not reconstruct what you
think the tester was thinking beyond what the record says.

The run directory is {RUN_DIR}. Read these, in this order:

  {RUN_DIR}/steps.jsonl    one line per attempt: kind, n, action, target, intent,
                           expected, ok, rejected, error, capture, consoleErrors,
                           httpErrors, alerts, downloads; plus the note and finish
                           lines
  {RUN_DIR}/captures/*.png one capture per step
  {RUN_DIR}/result.json    the harness's own result: status, check, claim, reason,
                           eyes, referenceActions, proxies, stubExclusions, commit
  {JOURNEY_PAGE}           the journey page, including its harness-only scenario
                           fields — Success check, Reference actions, Entry route —
                           which the tester never saw
  {RUBRIC}                 the reviewer rubric: the four per-step questions, the
                           ten heuristics, the required states and the severity
                           vocabulary

Do not read any other review file in the run directory, including `review.json`,
`review-2.json` or any markdown summary of a previous review. A reviewer that
reads another review copies its judgments instead of forming its own, and the
repeatability measurement this file exists to support is only meaningful when the
two reviews are independent. Do not read the application source, the tests, the
harness code or the documentation; you are reviewing a run, not the product's
design intent.

Establish your eyes before you claim anything about how a screen looks:

  ~/.agents/skills/see/scripts/see-check mode

If that prints anything other than `unknown`, use the mode it prints. Otherwise
run `~/.agents/skills/see/scripts/see-check start`, open the PNG it writes, report
the colours you actually see left to right to `see-check verify`, and use the mode
that answer establishes. Report only what you actually saw. In the `codex-relay`
mode every visual fact comes from `codex-see`, and every observation you write
down that rests on an image is attributed to that relay. In the `source-only`
mode you have no visual evidence at all: work from the recorded text and the
accessibility snapshot in the step log, say so, and make no claim about how
anything looks. Copy the run's `result.json` `eyes` value into `review.json`
`eyes`, and if your own mode differs from the run's, say so in {REVIEW_MD}.

Then score, in this order.

**Per step.** For every step in `steps.jsonl` with `ok: true`, score the rubric's
four questions q1 to q4 from 0 to 2 and record the step number `n`, the scores and
the `captures` the score rests on. A step with `ok: false` or `rejected` is not
scored at all: read its record for evidence and leave it out of `steps`. A step
that carried no expectation has `q3: null`; a null is not scored and is never a 0.

**Per screen.** One `screens` entry per distinct route the run visited. Score the
ten heuristics H1 to H10 on the rubric's 0 to 3 scale, or the string `n/a` with a
reason, and give each score `evidence` — what the tester observed — and the
`capture` it rests on. Record each required state from the rubric's state list as
`seen` or `notExercised`; a state the run never reached is reported, never scored,
and earns no zero. Contrast, target size and focus visibility are `verify` items:
put them in `screens[].verify` for a follow-up with real tooling and a real user
agent. Never measure them from a screenshot.

**Per journey.** Read the proxies from `result.json`. You do not recompute them,
and you do not band them. You write no band and no rating: every threshold and
every rating word is computed in `rating.mjs`, and this run's rating comes from
there. If you find yourself wanting to record a cut-off or a verdict like
"Direct" in the file you are writing, that value belongs to the module, not to
you. The one journey-level judgment you do own is attribution, below.

**Findings.** A finding is `{id, severity, kind, step, capture, statement,
consequence}` with severity `critical`, `high`, `medium`, `low` or `info` from the
rubric. Cite the step and the capture for every visual claim. Do not raise a
finding against the run because it was long: the run's numbers are the harness's
to report. The `Reference actions` value on the journey page is the tester's
instruction, not a claim you verify; challenge it only by writing a finding that
says what the run actually took and why the page's estimate was wrong.

**Stub-rendered regions produce no findings.** Geocoding results, street routing
and boundaries, basemap tiles and building meshes, and the scripted language-model
stand-in are stubbed in the QA stack, and the per-repository list of excluded
request paths is in `result.json` `stubExclusions`. A region the stub drew is not
the product, so never raise a finding about how a stub-rendered region looks, what
a basemap tile shows, or a request the harness excludes. Say on the limits slide
of the deck that they were stubbed; say nothing else about them here.

**Attribution for a non-completed run.** When `result.json` `status` says the
check did not pass, `journey.attribution` must be one of:

- `product` — the application did not offer or accept a path the vocabulary could
  use. The tester had a legible goal and the product gave them no way to reach it.
- `tester` — a misread screen, a repeated failing action, or giving up while a
  usable path was on screen.
- `harness` — the vocabulary could not express an action the goal needed, such as
  hover, double-click or drag, or the harness rejected an action it should have
  accepted, or it crashed.

`journey.decidingStep` is the `n` of the step that decided it: the step after
which no usable path remained. When the run completed, both `attribution` and
`decidingStep` are null. Do not guess between the three — say in {REVIEW_MD} what
you could not tell and which step settled as much as it could.

Write the review to {REVIEW_JSON}, exactly the schema below, with no extra keys
and none missing. Then write {REVIEW_MD}: what happened in this run in a few
sentences, then the top findings, each with its step number and capture name.

The last line you print is the path of {REVIEW_JSON}, and nothing else.
```

## `review.json` schema

Contract C-9 in `harness-contract.md`, restated here as the fenced example the
reviewer copies. It is strict: a missing or unknown key is an error, and the deck
builder fails on it.

```json
{
  "run": "ux-qa-2026-03-04-import-a1b2",
  "eyes": "host-vision",
  "steps": [
    {
      "n": 4,
      "q1": 2,
      "q2": 2,
      "q3": 2,
      "q4": 1,
      "captures": ["step-004-after.png"],
      "note": "Import button was below the fold; tester scrolled first"
    }
  ],
  "screens": [
    {
      "route": "/gtfs/:version/import",
      "screen": "SCRN-012 feed import",
      "heuristics": {
        "H1": { "score": 3, "evidence": "progress text during the upload", "capture": "step-004-after.png" },
        "H2": { "score": 2, "evidence": "field is named for the file, not the format", "capture": "step-003-after.png" },
        "H3": { "score": "n/a", "evidence": "no reversible action reached", "capture": null },
        "H4": { "score": 3, "evidence": "buttons match the rest of the app", "capture": "step-003-after.png" },
        "H5": { "score": 1, "evidence": "wrong file accepted, then rejected after upload", "capture": "step-005-after.png" },
        "H6": { "score": 2, "evidence": "tester looked for the file name field", "capture": "step-003-after.png" },
        "H7": { "score": 3, "evidence": "single path, no repetition needed", "capture": "step-004-after.png" },
        "H8": { "score": 2, "evidence": "two headings and three banners on one screen", "capture": "step-003-after.png" },
        "H9": { "score": 3, "evidence": "error names the accepted formats", "capture": "step-005-after.png" },
        "H10": { "score": "n/a", "evidence": "no help surface on this screen", "capture": null }
      },
      "states": {
        "seen": ["ideal"],
        "notExercised": ["empty", "error", "partial or degraded"]
      },
      "verify": ["contrast of the secondary link against the page ground", "target size of the upload control"]
    }
  ],
  "journey": {
    "attribution": null,
    "decidingStep": null
  },
  "findings": [
    {
      "id": "F-01",
      "severity": "medium",
      "kind": "error-prevention",
      "step": 5,
      "capture": "step-005-after.png",
      "statement": "A non-zip file is accepted by the chooser and only rejected after the upload begins.",
      "consequence": "The tester spent two attempts on a file the form could have refused at selection."
    }
  ]
}
```

Key notes, so the reviewer does not have to infer them:

- `run` is the run ID from `result.json`, and `eyes` is the mode established above.
- `q1` to `q4` are integers 0 to 2; `q3` may be `null`, which is never a 0.
- `heuristics` carries H1 to H10 in order. A score is 0 to 3 or the string `n/a`.
  `evidence` and `capture` may be `null` only on an `n/a` score.
- `attribution` is `product`, `tester` or `harness` when the run is
  not-completed, and `null` in both other fields otherwise.
- `severity` is `critical`, `high`, `medium`, `low` or `info`.

## Orchestrator notes

- Dispatch a fresh agent that did not run the exploration, with only the text
  above and the substituted paths. Substitute `{RUN_DIR}` with the run
  directory, `{JOURNEY_PAGE}` with the journey page that holds the scenario,
  `{RUBRIC}` with this skill's `references/rubric.md`, and `{REVIEW_JSON}` and
  `{REVIEW_MD}` with paths inside the run directory.
- The reviewer's model is the orchestrator's choice. When the reviewer is the same
  model that ran the exploration, the deck says so on the limits slide; when it
  is a different one, say that too. Prompt-level independence is what the design
  relies on, not model diversity.
- For the repeatability measurement, dispatch a second fresh reviewer with
  `{REVIEW_JSON}` set to `review-2.json`, in its own context, with no sight of the
  first review. `agreement()` in `rating.mjs` compares the q1 to q4 of steps
  present in both files and the deck shows exact and within-one agreement,
  labelled repeatability — not validity. One review is not a second data point.
- A malformed `review.json` is caught by the strict loader in `build-deck.mjs`,
  which exits 1 naming the file and the key. That is the intended failure mode:
  fix the review, do not loosen the loader.
- The bands, the ratings and the reviewer's minimum step score live only in
  `scripts/rating.mjs`. If a threshold needs to change, change it there and in
  its tests, not in this file and not in `rubric.md`.
- The `harness-contract.md` section C-9 owns the schema. If a key there changes,
  change the fenced example above in the same change, so a reviewer is never told
  a shape the deck builder rejects.
