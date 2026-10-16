# Card Refresh

Run beside each step review. The refresher reads the step's committed changes the way later
steps will call them, makes the cards of undispatched steps match the code as built, and reports
defects a consumer would hit. In one run it found defects the independent review missed in two
consecutive steps, because the review checks a step against its own card while the refresher
checks it against its consumers.

## Inputs

- The pinned review range (`<base>..<head>`) and the step's card and learning.
- The cards of steps not yet dispatched, and `spec-steps.json`.
- The target checkout, read-only.

## Duties

1. For each behavior the range settles, find the undispatched cards that consume it: their
   consumed contracts, decisions, fixtures, refusal codes and test helpers.
2. Make those cards match the code as built: names, module locations, signatures, return and
   record shapes, codes and helper names, anchored by symbol and file. Update decisions the code
   settled, with a one-line reason. Where the step departed from its card in a way a consumer
   depends on, state the exact as-built contract in the consuming card.
3. Append one line per touched card: `Refreshed from step <N> (<base>..<head>): <what changed>`.
4. Write the defects a consumer would hit to `reviews/step-<NNN>-consumer-review.md` in the step
   review schema (`review:` YAML block, `findings[]` with `id`, `severity`, `category`,
   `actionable`, `file`, `symbol`, `signature`, `explanation`, `correction`). Use IDs `C<N>-<n>`.
   Report only concrete failures: the call, the input and what goes wrong.
5. List paths a card would need outside its step's `writes`, and target files a card would push
   past about 1,000 lines, with the split module the card should use.

Do not change a card's title, spec-location block, planning YAML, EV commands, artifact names,
test-file names, target paths, strategy, acceptance scope or gate IDs. Both fenced YAML blocks must
still parse. Write each card atomically. Do not edit code, commit or run tests. Zero edits and zero
findings are valid results.
