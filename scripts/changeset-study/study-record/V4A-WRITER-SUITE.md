# V4A writer suite: can cheap models emit patches that apply?

Design note, 2026-10-16. Code paths are relative to the agents repository checkout.
Run records go in the adjacent experiment package's runtime store, outside Git.

## Question

Given a file and a fully settled instruction, can model M emit a V4A patch that a
deterministic applier accepts and that produces the intended file? Measured per model,
per edit encoding, with no discovery, no tools, no planning and no behavioral tests.
This isolates payload reliability, which is the one property the cheap-writer
configuration depends on and the one the branch has never measured directly.

The suite answers "which encoding is each cheap model most reliable at", not only
"can it do V4A". Encoding is a factor, so the same cases run under every format.

## What is scored

Per case, in order, each gate recorded separately:

| Gate | Meaning | Why it is separate |
|---|---|---|
| parsed | envelope and hunks are well formed | malformed output was the DeepSeek failure in the early trials |
| applied | every hunk matched and applied; record exact, fuzzy pass used, or failure class | anchor failures were the dominant delegated failure in runs 01 to 17 |
| unambiguous | no hunk's context matched more than once | Codex's applier takes the first match silently; the suite refuses and records it |
| syntax | changed file passes `node --check` (or the language's equivalent) | cheap gate the engine already runs |
| correct | result equals gold after whitespace normalization, or AST-equal for `.mjs` | the only way to catch a silent misapply |
| cost | output tokens, latency, receipt cost | the reason to use a cheap writer at all |

The dangerous cell is applied-but-incorrect. It can only be detected with gold, so
every tier below has gold except the realistic replay tier, which is scored
application-only and labeled as such.

A model "can do it" for an encoding when, over two identical frozen runs, parsed and
applied are at least 95 percent, applied-but-incorrect is zero, and correct is at
least 90 percent on the tiers with gold. Thresholds are proposed; fix them before the
first run and do not move them afterward.

## Case tiers

### Tier 0: transcription

Input: the before file and the after file. Task: emit the patch that turns one into the
other. Gold: the after file. This is the purest encoding test; the model has nothing to
decide. A model that fails here cannot be a writer in any configuration. Source: real
commits in the agents repository, one file per case, hunks of 1 to 60 changed lines.

### Tier A: instruction with code

Input: the before file and an instruction that fully determines the change and
includes any new text verbatim ("replace the body of `seedCalibration` with the
following", "delete `partitionUntracked` and its export", "rename `read` to `readJson`
at its definition and three call sites"). Gold: the after file. Source: the same
commits as Tier 0, with instructions written from the gold diff by a strong model and
spot-checked, so the instruction is exact by construction. This is the shape a settled
owner brief should produce.

### Tier B: realistic replay, application only

Input: the 26 writer requests DeepSeek received in run 18, exactly as recorded
(assignment, requirements, excerpts) with the staged file each one applied to. No gold
exists for these beyond the delivered candidates, so score parsed, applied, unambiguous
and syntax, and mark correctness as not measured. This tier is what the production
configuration actually asks of a writer, so it anchors the others to reality.

### Tier C: format stress

Hand-built files with gold, each isolating one hazard the published V4A material
names or the branch has hit:

- tabs versus spaces in leading indentation (not fuzzed by Codex's applier)
- CRLF line endings
- a block that appears twice, where the instruction targets the second occurrence
- smart quotes and Unicode dashes in context lines
- an edit in the last three lines of a file without a trailing newline
- two hunks in one file, far apart
- two hunks in one file, close enough that context overlaps
- create a new file, delete a file, rename a file with a one-line edit
- a 140 KB file with a five-line change near the middle
- an insertion where the natural anchor line is blank or a lone brace
- an instruction that cannot be satisfied (the named function does not exist); the
  correct output is a refusal, not a patch

Tier C is where the writer prompt's rules get tested one at a time.

## Encodings

Every case runs under each encoding with an identical system prompt per encoding and
no per-model tuning. One documented prompt revision per encoding is allowed before the
frozen run; after that, changes are a new run.

1. **V4A**: `*** Begin Patch` envelope, `@@` text anchors, space/minus/plus lines,
   `*** End of File` where needed, relative paths, one hunk per `@@`. Applier matches
   exact, then trailing whitespace, then all whitespace, as Codex does, and refuses
   ambiguous matches, as Codex does not.
2. **JSON search and replace**: the branch's current edit vocabulary, as the control.
3. **Plain old and new blocks**: Pi's `edit` shape as fenced text, not JSON. This
   separates "no JSON escaping" from "diff format" when V4A and JSON differ.
4. **Full file rewrite**: for files under 4 KB only, as a floor.

Where the provider supports grammar-constrained custom tools (OpenAI Responses and the
Codex transport), run V4A once constrained and once as plain text, so the constraint's
contribution is visible. Cheap models on OpenAI-compatible endpoints get plain text
with a lenient parser only.

## Models

Only the models the spec process actually routes to, through the providers it uses.

| Model | Selector | Provider and API | Price, USD per million in / out |
|---|---|---|---:|
| DeepSeek V4.1 Flash | `deepseek/deepseek-flash` (`:off` and `:low`) | native DeepSeek, OpenAI-completions; pinned catalog | 0.30 / 1.20 |
| MiMo 2.6 Pro | `primalabs/primalabs-ai/MiMo-V2.6-Pro` | PrimaLabs, OpenAI-completions; user-defined provider in Pi `models.json`, chat-template thinking toggle, 65,536 max output | not in the entry; must be supplied |
| Muse Spark 1.3 Contributor | `openrouter/meta/muse-spark-1.3-contributor` | OpenRouter, OpenAI-completions; pinned catalog | 0.10 / 0.20 |

Two harness notes follow from that table:

- The PrimaLabs MiMo entry carries no cost fields. The study client derives its budget
  reservation from the model's catalog cost and refuses a request with an unknown
  ceiling, so the suite must register frozen cost metadata for this selector the way
  `scripts/changeset-study/model-catalog.mjs` does for Nemotron, with the PrimaLabs
  price and the date it was observed. Receipts will otherwise record unknown usage
  and hold the full reservation.
- Muse Spark's OpenRouter entry advertises a 943,718-token completion ceiling, which is
  OpenRouter's catalog ceiling rather than any single upstream's. Freeze a smaller
  explicit output bound for the suite, as the Nemotron entry did, so a length stop is
  attributable to the model and not to an unenforced limit.

None of the three advertises grammar-constrained custom tools, so all three get V4A as
plain text with the lenient parser. The constrained variant applies only to the Sol
`:low` reference row on the Codex transport, which runs once so each cheap model's gap
is measured against a known-good writer. Mercury stays out, per the standing rule.
Selectors parse as `provider/model[:thinking]` on the first slash, so the PrimaLabs
selector's embedded slash is fine.

With three models the full matrix is small: at roughly 150 cases and four encodings,
one pass is about 1,800 requests with inputs mostly under 8k tokens, on the order of
one to two dollars per model at these prices. That leaves room to run every model under
every encoding and to repeat the frozen suite without touching the budget guard.

## Harness

- Location: `scripts/changeset-study/divergent/v4a-suite/`, beside the other divergent
  experiments, reusing the existing `Client` for ledger, receipts and deadlines. No
  sandbox and no commands except `node --check`.
- Applier: one Node module, in-memory, operating on a `{path: text}` map so the engine
  can adopt it later unchanged. Parser with strict and lenient modes, matcher with the
  three Codex passes plus uniqueness refusal, path validation, `End of File` handling.
  Port the matching rules from Codex's `codex-rs/apply-patch` or the Apache-licensed
  Node adaptation in the `pi-codex-tools` extension; do not depend on the Rust crate,
  since the engine is Node and works in memory.
- One request per case, temperature at provider default, one sample. A second pass
  with one retry carrying the applier's error message runs as a separate treatment so
  retry benefit is measured, not assumed.
- Case bytes, prompts, applier source, model metadata and SDK are frozen and hashed
  before inference. Every response is retained, including rejected ones.
- Cost guard: the existing shared $50 ledger. At roughly 150 cases, four encodings and
  ten models with inputs under 8k tokens, a full pass is on the order of a few dollars
  at cheap-tier prices; Sol and Haiku rows cost more and can run on a subset.

## Reporting

One table per model: rows are encodings, columns are the six gates plus output tokens
and latency, with Tier B shown separately because it has no gold. One table per tier
across models for the V4A encoding. A per-case failure list grouped by failure class
(malformed, invalid context, ambiguous, indentation, path, length stop, silent
misapply) so prompt or applier fixes target a class, not an aggregate.

Report the two frozen repeats side by side. A model qualifies only if both repeats
meet the thresholds. Variance between repeats is itself a result worth showing, since
runs 18 and 19 on the branch differed by a factor of two in writer time on identical
inputs.

## What this suite does not answer

It does not say whether a cheap writer delivers features. Handoff failed in all eight
writer-boundary runs for reasons upstream of the writer, and lifecycle flipped between
runs on identical plans because of behavioral breakage no payload check can see. The
suite tells you which models can be trusted to encode a settled edit. Whether the edit
is right is the owner's problem, and the own-test check plus one repair is still the
cheapest answer to that.

## Order of work

1. Build the applier and its offline contract tests, including the Tier C fixtures.
   This module is useful to the engine regardless of the suite's outcome.
2. Mine Tier 0 and Tier A cases from repository history; write and spot-check Tier A
   instructions; export Tier B from run 18's retained requests.
3. Freeze, then run all three models under all four encodings in one pass; the matrix
   is small enough that there is no reason to stage it. Repeat the frozen suite once.
4. Rank encodings per model. If V4A does not beat JSON for DeepSeek on Tiers A and B,
   the writer-payload change is not worth making for the current configuration.
5. Feed the applier and the winning encoding back into the changeset engine as the
   writer payload, keeping range operations for moves.
