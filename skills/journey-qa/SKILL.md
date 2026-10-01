---
name: journey-qa
description: Explore, review, replay and deck a web application through user scenarios the way a first-time operator would. Mode explore drives one JRNY-###/slug scenario with bin/ux-qa and a fresh tester agent; review scores a stored run with a second fresh agent; replay re-runs a recorded trail; deck builds the journey or summary HTML deck. Requires a repository harness implementing references/harness-contract.md. Not for CI.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "<explore|replay|review|deck> <JRNY-###[/slug]>"
license: MIT
metadata:
  version: "1"
---

# Journey QA

Orchestrate `bin/ux-qa` for one scenario: a fresh tester walks the product from
a brief, an external check decides whether the goal happened, a second fresh
agent reviews the recorded run, and a deck reports the result honestly.

The skill orchestrates the harness; it never reimplements it. Every command,
flag, exit code and run-file schema lives in `references/harness-contract.md`.
Every rating band and threshold lives in `scripts/rating.mjs`. Read the one you
need and take the other from its owner.

## Requirements

- The target repository has `bin/ux-qa` implementing
  [`references/harness-contract.md`](references/harness-contract.md). Without
  that harness there is nothing to orchestrate: stop, write a report naming the
  missing `bin/ux-qa`, and return it. Do not write a fallback harness here.
- Never pin a model name. The tester and reviewer agents are the orchestrator's
  choice; prompt-level independence, not model diversity, is what the design
  relies on. The deck's limits slide states whether both agents were the same
  model.
- Run every `bin/ux-qa` command from the application repository root.

## Selfcheck precondition

A scenario is explorable only when both hold:

1. its reference trail exists, in
   `.specs/ux-qa/reference-trails/<JRNY-###>-<slug>.json`, and
2. `bin/ux-qa selfcheck <id>` passes on the current commit.

```bash
bin/ux-qa selfcheck JRNY-001/import
```

The selfcheck runs both legs: the no-op leg must fail the check and the
reference-trail leg must pass it. Run it if it has not passed on the current
commit; when it exits non-zero, report which leg failed and stop. An
unverifiable scenario has no path-efficiency denominator and no independent
positive control, so exploring it produces a run nobody can interpret.

## Mode `explore`

1. Start the stack and read the two paths it prints.

   ```bash
   bin/ux-qa up JRNY-001/import
   ```

   It prints a `run:` line and a `brief:` line. Take both paths from that
   output; never invent or guess either one.

2. Dispatch a **fresh agent** with the `## Prompt` block of
   [`references/explorer-prompt.md`](references/explorer-prompt.md) and nothing
   else, substituting `{RUN_DIR}` with the printed `run:` value and `{BRIEF}`
   with the printed `brief:` value. Do not pass the spec, the registry, the
   journey page, the rubric, a code path or any other context — that is what the
   blindness of the run rests on.

3. When the tester returns, close the run. It stops only the processes this run
   owns and writes `result.json`.

   ```bash
   bin/ux-qa down --run "$RUN_DIR" --record
   ```

   `--record` writes the replay trail, and only when the check passed.

4. Continue with mode `review`.

**Checkpoint fallback.** If you cannot spawn agents, stop and return a
checkpoint to your coordinator — not a report and not a self-run. The
checkpoint names the prompt file
(`skills/journey-qa/references/explorer-prompt.md`), the two substituted values
(`{RUN_DIR}` and `{BRIEF}` as printed by `bin/ux-qa up`), and states plainly
that a fresh agent must be dispatched with only that text. Leave the run open:
the dispatching agent runs `bin/ux-qa down`. Do not explore the scenario
yourself; an orchestrator that acts as the tester destroys the independence the
run exists to provide.

## Mode `review`

1. Dispatch a **second fresh agent** — never the agent that explored, and never
   yourself — with the `## Prompt` block of
   [`references/reviewer-prompt.md`](references/reviewer-prompt.md),
   substituting `{RUN_DIR}`, `{JOURNEY_PAGE}` (the journey page holding the
   scenario), `{RUBRIC}` (`skills/journey-qa/references/rubric.md`),
   `{REVIEW_JSON}` and `{REVIEW_MD}` (paths inside the run directory).

2. Validate the result by building the deck. The strict loader in
   `build-deck.mjs` exits 1 naming the file and the key, so a malformed
   `review.json` fails loudly instead of reaching a partner.

   ```bash
   node "$SKILL_DIR/scripts/build-deck.mjs" --run "$RUN_DIR" --out "$RUN_DIR/deck.html"
   ```

   Fix the review, not the loader.

3. For a `not-completed` run the reviewer sets `journey.attribution` to
   `product`, `tester` or `harness` and names the deciding step. This skill does
   not second-guess it and must not edit the attribution after the fact.

4. **Repeatability.** To measure repeatability, dispatch a second fresh
   reviewer in its own context with no sight of the first review and
   `{REVIEW_JSON}` set to `review-2.json`, then pass it as the second review:

   ```bash
   node "$SKILL_DIR/scripts/build-deck.mjs" --run "$RUN_DIR" --out "$RUN_DIR/deck.html" \
     --second-review "$RUN_DIR/review-2.json"
   ```

   Report agreement as repeatability, never as validity: one review is not a
   second data point.

The same checkpoint fallback as `explore` applies when agents cannot be
spawned: name the reviewer prompt file, the five substituted values, and the
requirement that the reviewer be a fresh agent that never saw the exploration.

## Mode `replay`

```bash
bin/ux-qa replay JRNY-001/import
```

With no scenario IDs every recorded trail replays. On drift, report the failing
step and its error and recommend re-exploration. Never patch a trail: an edited
trail is no longer the record of what a tester actually did. A drifted trail is
replaced by a new exploration, and the deck lists every exploration of the
scenario.

## Mode `deck`

```bash
node "$SKILL_DIR/scripts/build-deck.mjs" \
  --run "$RUN_DIR" --out .specs/ux-qa/decks/<JRNY-###>-<slug>.html

node "$SKILL_DIR/scripts/build-deck.mjs" --summary \
  --brief docs/product-brief.md --runs .specs/ux-qa/runs \
  --out .specs/ux-qa/decks/summary.html
```

Inspect the result rather than trusting the command. Capture it with `uishot`
at `--viewport 1280x800` and look at the PNG through the `see` skill's eyes
mode; record which mode you used (`host-vision`, `codex-relay` or
`source-only`) alongside the deck, and say so when you have no visual evidence.

Decks are local files under `.specs/ux-qa/`, which is gitignored. Publishing a
deck anywhere is a separate explicit action the orchestrator takes, never a
side effect of this mode.

## Limits to carry into every report

- The tester was **instructed** not to read the code. It received only the brief
  and a browser; nothing in the harness can detect a file read, so decks and
  reports say "instructed", never "blind".
- The reviewer is the same model as the tester unless the orchestrator says
  otherwise; prompt-level independence is what the design relies on.
- Externals other than the validator are stubbed. The validator is real; the
  run's `result.json` `stubExclusions` says which regions were stubbed.
- One exploration per scenario unless the deck's Explorations slide lists more.

## References

- `references/harness-contract.md` — commands, exit codes and run-file schemas.
- `references/rubric.md` — per-step and per-screen anchors; cites `rating.mjs`
  for every number.
- `references/explorer-prompt.md` — the tester's prompt and dispatch notes.
- `references/reviewer-prompt.md` — the reviewer's prompt, `review.json` schema
  and dispatch notes.
- `references/deck.md` — deck slides, limits wording and vocabulary rules.
- `scripts/rating.mjs` — bands, ratings and reviewer agreement; the only place a
  threshold is written.