# DeepSeek-only executable changesets: separate divergent arm

This arm asks whether the current deterministic changeset executor, owned entirely
by DeepSeek, can deliver the three exposed hard tasks with source-range edits,
candidate test execution, a boundary review and at most one batch repair. It is a
separate experiment from the writing-only owner/query/writer route: its DeepSeek
review and repair calls belong to this campaign and cannot be credited to that route.

No live trial has been run for this arm. Offline fixtures establish runner mechanics,
not task delivery, provider behavior, actual spending or comparative speed.

## Frozen treatment

The source is the retained original three-role run03. Preparation verifies its exact
`tasks.json` hash, the ordered three-task schedule, each donor job and recorded task
hash. Task specifications, source files, check commands, protected paths, limits,
dependency configuration and terminal oracles are copied unchanged. Owner briefs,
query plans, candidate code and prior grading feedback are not reused as model inputs.

All model roles use one explicit direct `deepseek/deepseek-*:off` selector. The intended
first model is `deepseek/deepseek-flash:off`. There is no Sol, delegated editor,
optimizer, context router or apply model. The `boundary-review` strategy requires
ordinary deterministic edit/range operations. The same selected model performs
read-only discovery planning and the subsequent batch boundary reviews and repair.

Preparation copies the current study/engine/research scripts, planner skill and
explicit Acorn module. It verifies the original campaign's three SDK package/dist
pins and dependency hash, then snapshots the entire installed SDK `node_modules`
tree and every dependency mount. Symlinks must resolve within each snapshot root.
Original and copied bytes must remain identical during preparation. The manifest
binds frozen code, parser, SDK, dependencies, tasks and Node executable. Runtime
records may contain resolved identity paths; this document uses run-relative paths.

The original shared `cell.mjs` is preserved as `original-cell.mjs`. A single exact
source-checked overlay changes its native discovery-plan JSON parsing call to
`retryPlanningJson`. The manifest and `cell-overlay.json` record the original hash,
complete replacement text and resulting hash. Any backend drift that removes or
duplicates the target rejects preparation; no fuzzy source patch is applied.

The isolated adapter retries only a `SyntaxError` from parsing the planner's final
response. It asks the same scout once more with the parse error and a bounded copy
of the original invalid response. Thus both model requests use the existing Client,
transcript, accounting, shared call budget and deadlines. Transport, budget,
cancellation and non-JSON-validation errors do not receive this retry. A second
invalid response remains a failure. Initial and repair discovery attempts may each
make their one format retry; the review/repair loop itself remains one batch repair.

## Execution and evidence

The existing backend executes the deterministic batch, runs the visible command and
selected changed candidate tests, and asks DeepSeek for a boundary review informed
by those checks. If needed, one new batch repairs concrete findings. Hidden terminal
grading happens only after implementation freezes. Its feedback never returns to a
model. There is no unbounded retry or additional owner pass after that terminal grade.

For handoff, run the frozen existing `path-audit.mjs` as a separate post-hoc diagnostic
on `candidate.json`. It checks exact candidate dirty-path handling in disposable Git
repositories. Bind its result to the candidate hash; a missing, failed or mismatched
audit prevents audited delivery. This diagnostic is not a model input and does not
replace candidate tests, terminal acceptance or a review.

Report recorded delivery and audited delivery separately. Audited delivery requires
terminal acceptance, successful final execution, passing visible/changed tests,
accepted boundary review, result and every request matching the frozen manifest model and the required candidate-bound
handoff audit. Preserve model receipts, requests, responses, planning transcripts,
plans, drafts, candidates, errors and all failed attempts. Failures use the original
task's cell-plus-grading cap for time-to-success; post-hoc audit time is separately
visible in audited elapsed time. Unknown accounting remains unknown, not zero.

The recommendations' blanket zero-cache-read statement described an earlier receipt
set and is stale for later retained campaigns. Record actual input, output, cacheRead,
cacheWrite and provider-reported cost fields here; infer neither a guaranteed cache
benefit nor zero cache use. DeepSeek cost comes from its own receipts. An equivalent
Sol tariff is not a measured DeepSeek bill or a matched control.

## Offline preparation and later execution

Preparation performs no model-runtime initialization, auth check or inference:

```bash
node scripts/changeset-study/divergent/deepseek-direct/runner.mjs prepare \
  --source "$RUN03" --output "$NEW_RUN" --ledger "$CAMPAIGN_LEDGER" \
  --parser "$ACORN_MODULE" --model deepseek/deepseek-flash:off \
  --sdk-root "$PINNED_SDK_ROOT"
```

`PINNED_SDK_ROOT` names the installed `node_modules/@earendil-works` directory.
`NEW_RUN` must be new and outside the checkout, donor and snapshot inputs. The ledger
must already exist, be separate from the output, and resolve to the same canonical
path used by all donor jobs. Schema 1, a $50 limit and valid reservation entries are
required at preparation, execution start and before each cell. Ledger contents are
not frozen or hashed: legitimate settlements from other campaign work remain valid. The existing $50 ledger/reservation guard remains
active; execution stops before another cell when retained exposure reaches $49.
Incomplete output after a freeze error remains evidence and cannot be overwritten.

After independent review and authorization for the later campaign, use the frozen
runner so orchestration and reporting also come from the reviewed snapshot:

```bash
node "$NEW_RUN/frozen/scripts/changeset-study/divergent/deepseek-direct/runner.mjs" \
  run --output "$NEW_RUN"
```

Execution is single-use. A repeat needs a new preparation with identical frozen
inputs. The first `started.json` prevents accidentally paying for the same trial twice.
Frozen input checks run before every cell. No credentials are saved in the snapshot.

## Acceptance before a paid comparison

Review the isolated overlay and its original/result hashes, and confirm the actual
source03 fixture and SDK/dependency preparation succeeds. The maintained focused
runner checks must pass; they cover unsafe output paths, mixed models, changed donor
tasks, immutable snapshot validation, one format retry and audit qualification.
This draft does not claim comparison parity merely because its fake fixtures pass.

Known differences remain explicit. The current backend has no separate simulation
of all source-range effects before deterministic execution, and this arm does not
add source outlines, automatic named-file preloading, stable-prefix cache controls,
apply models or symbol bindings against future generated source. Deterministic edit
failures still reach the existing boundary review/one-repair path. Any additional
backend change is another reviewed freeze, not a silent correction to this one.

Run this arm once only in the later authorized campaign. A performance claim needs
3/3 audited delivery, lower time and measured cost against appropriate native
DeepSeek controls, and an identical successful repeat. The retained lifecycle native
result alone is not a three-task control. These exposed development cases can justify
fresh matched evaluation; they cannot establish general superiority. Decisions about
apply-model arms follow the actual failure class and belong to their own protocols.
