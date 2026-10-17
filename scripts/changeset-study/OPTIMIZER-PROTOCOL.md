# Three-role writer optimization comparison

DeepSeek owns implementation decisions, Sol compiles a settled brief into a query
plan, and DeepSeek applies bounded assignments. Sol never reviews writer output.
Testing and behavioral review belong to the outer workflow. This experiment
measures writing completion and performance separately from downstream quality.

## Frozen roles and controls

Use `owner-query-writer`, Sol `openai-codex/gpt-6.1-sol:low`, and native DeepSeek
`deepseek/deepseek-flash:off` for both implementation ownership and writing.
Keep the original three exposed tasks, source snapshots, SDK, dependency mounts,
output and time limits, protected files, and separate terminal grading. No previous
candidate, test failure, or terminal grading feedback is given to a model.

The DeepSeek owner gets the step and read-only source tools. Its settled brief
contains behavior, interfaces, preservation obligations and required test edits.
Sol gets that brief, a file tree and read-only tools, without the original step.
It may correct its own invalid source bindings once before dispatch. A missing
implementation decision is reported as an input gap rather than invented by Sol.
Writers get one file, at most 4,000 assignment characters, selected current source
at most 32,000 characters, and one local application/syntax retry. No behavioral
check feeds that retry. At most four independent assignments run concurrently.

## Treatments

1. `none`: run the bounded query plan unchanged except deterministic conflict
   ordering and duplicate context removal.
2. `deterministic`: contract adjacent compatible assignments to the same file,
   retaining every instruction, obligation and dependency. At most two original
   assignments may combine, and the original packet size limits still apply.
   Refuse contraction when an intermediate state is observed, preconditions need
   independent enforcement, or initial combined source excerpts cannot resolve.
3. `contextual`: the same local optimizer, with one batched Jev request choosing
   whether eligible pairs should stay separate and whether uniquely owned small
   files with no other writer of their read/write paths benefit from full context. Whole-file expansion is capped at 8,000
   characters per file and 16,000 total. Files eligible for contraction do not get
   individual context questions. Jev never decides dependency safety or removes
   requirements. Advice below 0.7 confidence falls back to fixed policy; this is
   an uncalibrated routing heuristic. Errors retain fallback and cost uncertainty.

The optimizer never discards a prose instruction as redundant. Source-range edits
already move unchanged bytes without generation. Eliminating intermediate writes
or bypassing writers requires stronger executable semantics than this IR supplies;
those are future extensions, not claimed measured optimizations.

## Paired measurement

Run `none` first to obtain the owner briefs and raw query plans. Retain each plan
and brief hash. Run deterministic and contextual writing from those exact inputs
in fresh source snapshots, using the same frozen code. These replays make no owner
or query calls. Report actual incremental spending separately from allocated
pipeline costs: add the donor's owner/query time, calls and usage when estimating
the complete three-role workflow. Do not add its writing or test time. All actual
calls, including Jev, count toward the money tracker.

Report per-case and total owner/query/routing/optimizer/writer/check elapsed time,
assignment count, dependency depth, observed concurrency, retries, calls,
input/output/cache tokens, normalized cost and accounting uncertainty. Keep Sol's
comparison tariff equal to DeepSeek's. Jev uses its separately recorded estimated
input-only tariff. Conservative reservations are not cash invoices.

Primary writing outcome is completion of every planned operation without an
application error. Visible tests, candidate-added tests and terminal acceptance
are separate downstream outcomes. A fast incomplete batch is not a writing win.
A completed batch with failing tests is not complete feature delivery. Report
both dimensions when selecting a configuration. Historical native Sol and reviewed
Sol-only runs are contextual controls, not matched comparisons to these roles.

Run the three treatments, then repeat a promising frozen treatment on the same
plans to assess variability. If the first plans cannot apply, retain the failures
and make at most two generic backend/prompt revisions with new freezes before
reassessing. Do not tune prompts to hidden assertions. Stop before the active $50
allowance is exhausted. The user reset that allowance on 2026-10-16; the previous
ledger remains archived with $29.2873046 exposure. Do not silently reset it again.

Select the best observed configuration with explicit quality and sample limits.
This is development on exposed cases, not proof of a global optimum or a production
end-to-end speedup. Production integration reuses the existing step owner's
reasoning and editor batch lifecycle; this runner measures owner reasoning explicitly.

## Reproduce

Resolve runtime paths under the adjacent experiment package. `CAMPAIGN_LEDGER` is
its active tracker. A plan replay retains the same frozen code:

```sh
node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$BASE_RUN" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:off --strategy owner-query-writer \
  --optimization none --parser "$ACORN_MODULE"

node scripts/changeset-study/iterate.mjs \
  --source "$PREVIOUS_WORKFLOW_RUN" --output "$OPTIMIZED_RUN" \
  --ledger "$CAMPAIGN_LEDGER" --model openai-codex/gpt-6.1-sol:low \
  --editor-model deepseek/deepseek-flash:off --strategy owner-query-writer \
  --optimization deterministic --freeze-from "$BASE_RUN" --plans-from "$BASE_RUN"
```

For contextual routing substitute `--optimization contextual`. The installed
Typesafe module can be selected with `JEV_TYPESAFE_MODULE`; credentials are resolved
by its library and are never copied into run artifacts.

## Grouping representation correction

The first raw calibration plan exposed a representation issue: combining two short
assignments exceeded the five requirement-string limit even while all text fit
the character bound. The optimizer now retains each original requirement list
verbatim in one labeled string per original assignment. Total assignment limits
remain unchanged, and groups contain at most two original assignments so Jev
judges the actual pair. This is a new optimizer freeze; the original unoptimized
run remains unchanged. Replays reuse its plans with the corrected optimizer code,
so code hashes differ only as recorded in each manifest.

## Recovery classifier correction

The first three-role calibration run exposed a recovery classifier error: an
application failure mentioning a `context-budget` path matched a broad budget
keyword and suppressed the allowed retry. Restrict terminal classification to
actual request-limit messages and cancellation types. Retain the original run.
Use a fresh unoptimized replay on the corrected backend, followed by deterministic
and contextual replays of the same raw plans. These three arms share the corrected
freeze, so retry behavior is not credited to the optimizer. The owner/query work
is allocated from the original run in all three comparisons.

## Assignment bound correction

The initial handoff plan was rejected before writing because one instruction was
2,469 characters against a 2,400-character subfield limit, despite fitting the
4,000-character total assignment bound. Retain that result. The corrected backend
enforces the total bound without the redundant instruction sublimit. It can replay
the exact last submitted planning attempt when the donor has no accepted raw plan;
record the source artifact name and hash. All three corrected writing arms use
the same bounds and plan bytes. This does not imply the original plan passed its
original runtime contract.

## Deterministic context compaction

The original extraction plan selected 44,600 source characters and was rejected
before writing. The corrected backend parses oversized `.mjs` selections and
omits interiors of long block-bodied functions, keeping signatures, surrounding
code, and the first 160 / last 80 body characters as exact source slices. Each
slice has original offsets; omitted ranges and definitions remain explicit.
No file content changes during this presentation pass, and the writer is told to
preserve unseen bodies through exact replacements or source-range operations.
Non-code or uncompressible context still fails at 32,000 delivered characters.

All corrected writer arms share this context policy. The original extraction
selection becomes 11,775 delivered source characters, omitting 32,825; that is a
measured payload reduction, not a demonstrated writing or correctness improvement.
Original plan bytes remain unchanged. Source snapshots and candidate tests remain
isolated from planning feedback as before.

## Bounded query-planning comparison

The original three-role run spent 26.67, 192.28 and 93.93 seconds in Sol query
planning. The harder cases repeatedly discovered source and regenerated plans
for schema/context failures. A subsequent exploratory treatment will reuse the
exact original DeepSeek owner briefs and replace query discovery with one direct
Sol request containing a deterministic source catalog. It may make the existing
single correction of its own plan before dispatch; it never reviews writer output.

The catalog includes relevant named paths, exact unique source anchors and
structural information, with a 48 KiB catalog bound and 80 KiB complete request
bound. Insufficient catalog information produces a needs-discovery result rather
than an invented binding. Obvious scalar path/dependency fields may be normalized
to arrays locally; this does not add implementation decisions. Preserve original
responses and normalization metadata. Record catalog generation time and hashes.

Reuse the fastest application-complete writer configuration observed in the
matched writing comparison, with explicit downstream-quality limits. If none
completes all cases, retain that result and diagnose application failures before
claiming a preferred configuration. Query comparison measures new query plans and
therefore may change grouping and writer behavior; it is not an isolated model
substitution. Allocate original owner time/usage only, and count new query work
as incurred. Future plan replays allocate both that owner's and the new query's
work. Require hash-verified brief provenance and no owner request during reuse.

Run the three cases once with the new query configuration and repeat a promising
frozen configuration before treating its result as stable. Retain all attempts,
all intermediate failed results, and the same active spending guard. Report the
best configuration observed within this search, not a global optimum. A cheaper
or faster writing subsystem is not sufficient for an end-to-end speed claim.

The matched corrected comparison completed only calibration in every arm; none
completed handoff or extraction. Deterministic grouping reduced calibration from
six writer calls to three and was the only arm with all downstream calibration
checks passing. Jev chose the same grouping as fixed policy on every eligible
pair, so there is no evidence to pay for its routing on this workload. The next
exploratory run uses deterministic grouping provisionally, not as a proven
suite-wide winner.

Before that run, a second generic backend revision unions overlapping context
selections and progressively elides function-body interiors under the same
32,000-character cap. On the retained staged handoff failure, selected source
falls from 130,702 to 26,389 characters. Writer prompts state the sole destination,
its current existence, and that compose creates once rather than appending;
recovery includes every rejected edit's kind and path even when its text is
truncated. These fixes address observed application failures without adding task
behavior or test answers. New query plans and this backend revision are jointly
exploratory; a result cannot isolate either one's causal effect.

The initial 24 KiB catalog proposal rejected a complete extraction inventory.
The revised 48 KiB catalog cap retains every named entry. Dry-run complete query
requests for the three original briefs are approximately 19, 68 and 67 kB, each
under the unchanged 80 KiB request guard. Unresolved bare names remain explicit
metadata, never invented destinations. New paths require an explicit catalog
binding. Later operations on newly created files may use bounded staged contents;
initial source anchors remain exact catalog pairs.

## Catalog binding refinement after the first attempt

The first catalog run completed calibration writes but blocked both larger cases
before dispatch. Its shorter aggregate query time is not a completion-preserving
gain. Retain those results. The next frozen catalog attempt adds deterministic
bindings for named constants, leading comments, uniquely named local helpers and
named imports, including exact declaration signatures. Compact inventories retain
all names; catalog and complete-request bounds remain 48 and 80 KiB. The query
prompt explains the existing source compactor so raw AST range length alone does
not cause the planner to refuse an otherwise executable binding.

Reuse the original owner briefs, deterministic optimizer and writer behavior.
Run all three cases once; repeat only if application completion makes the result
promising. No behavioral grading feedback enters planning or writer recovery.
This is a new catalog freeze and an exploratory refinement of the failed attempt,
not a replay of the first catalog's query plans. The separate experiments proposed
in the user's later research recommendations begin only after the current goal.

## Protocol 09: catalog with one bounded source lookup

Protocol 08 still blocked handoff before writing because its catalog did not supply
sufficient prompt-capture fixture context or a useful existing EOF append binding.
Extraction also selected a source-preflight-valid range whose endpoints came from
different entries on the same path. The exact-pair catalog validator rejected that
range, and the resulting correction request exceeded the 80 KiB guard by 286 bytes.
Retain both results. Protocol 09 accepts independently supplied same-path endpoints
and BOF/EOF boundaries, and provides a separate larger complete-request allowance.
Protocol 09 adds a separate `--query-mode catalog-lookup` treatment;
`discovery` remains the default and `catalog` retains its 80 KiB request guard.

Reuse the exact hash-verified original owner briefs and frozen task sources. The
initial Sol request contains only the unchanged brief, deterministic catalog, file
tree and protected-file list. Before producing the final plan, Sol may return only
`{"source_requests":[...]}` for one deterministic batch of at most eight reads and
64,000 delivered UTF-16 source characters. There are no repository tools, shell
commands, writes, original step specification or behavioral grading feedback.
Requests name an exact existing frozen source path and one selector:

- `symbol` selects a uniquely named AST function, method, variable or class; qualified
  class/object method names are allowed. Unambiguous leading comments remain.
- `search` selects a literal match's enclosing module statement or test, or its
  containing class method. Multiple matches require an explicit zero-based
  `occurrence`; ambiguity reports bounded candidate offsets and headers.
- `tail:true` selects an EOF suffix of at most 8,000 characters, beginning at a
  uniquely bound complete line when possible, for existing append context.
- `whole:true` reads an existing small file under the same total batch bound.

The source resolver uses only the supplied frozen input map. It returns exact
source slices, whole-file hashes, offsets and unique context anchors; it never
chooses a semantic match or reads generated candidates. Missing paths, ambiguous
symbols, invalid selectors, unavailable unique anchors or excessive source fail
explicitly. No further lookup batch is available after either success or failure.

Sol receives the unchanged initial packet plus the successful lookup result and
must then return a complete final plan or blocked result. The existing single
pre-dispatch validation correction remains available; it can correct its own plan
but cannot request more source. Thus the query planner makes at most three calls:
initial, optional lookup followup, optional validation correction. All are charged
normally at stage `planning`; every complete serialized system-plus-input request,
including lookup text and any previous plan, must fit 160 KiB in this mode. Nothing
is silently truncated. No lookup, query, model review or owner repair follows writing.

Looked-up snippets establish known-existing paths and add their exact endpoints
to the same-path context bindings. Supplied start/end endpoints may be combined;
BOF/EOF null boundaries are available on known existing paths. Source ordering,
uniqueness, protected paths and the unchanged 32,000-character delivered writer
context limit remain checked by preflight. Initially absent writes still need an
explicit absent-path catalog binding; source lookup cannot invent new destinations.

Persist `source-requests.json`, `source-lookup.json` and their result hashes,
including an explicit failed-lookup artifact when resolution fails. Catalog and
lookup construction time both use deterministic `query-context` stages. Preserve
all original model requests/responses, normalized raw plans, receipts and writer
results. This is another exploratory protocol revision; it does not establish a
completion-preserving speed gain, isolate lookup effects from changed plans, or
start the separate experiments proposed in the later research recommendations.

## Protocol 10: shared format recovery and interchangeable endpoints

Run 09 calibration returned a source-request object plus additional prose and a
blocked object in the same provider response. JSON decoding failed before any lookup
or writer. Handoff's first plan selected the valid catalog start of `const here`
as the exclusive end of its import context. Source preflight accepted that range;
the catalog guard rejected it because it distinguished start from end endpoints.
Retain those attempts and their charges. These observations motivate two changes:

1. Any supplied endpoint may serve either boundary on the same known source path.
   Actual source uniqueness, ordering, ownership and delivered-context limits still
   apply. Endpoints from another path and unknown anchors remain invalid.
2. In `catalog-lookup` mode, a malformed JSON response may consume the existing
   single pre-dispatch correction allowance. Return the parse error and at most
   12,000 characters of text output as diagnostic data, then request one final JSON
   object. Do not select an object from a malformed multi-object response or silently
   discard trailing text. Only a successful transport followed by JSON decoding
   failure is eligible; transport, budget, cancellation and stop-reason failures
   are not retried. A format correction precludes a later validation correction.

There are still at most three Sol calls and one source lookup batch. Count malformed
responses toward the call cap. Every full request, including its diagnostic excerpt,
must fit 160 KiB. No format recovery or query follows writer dispatch. Persist the
original responses, usage and `query_format_recoveries` record. No behavioral failure
feedback enters a query or writer retry.

Use the same three exposed cases, original owner briefs, deterministic optimization
and explicit model selectors. This is a new frozen treatment, not a repeat of 09.
Focused offline verification covers malformed replies before lookup, repeated format
failure, exhaustion of the shared correction allowance and provider errors. Jev's
offline verification checkpoint returned incomplete-context fallback; the focused
lookup integration passed in 647 ms. Broader tests remain operator-managed.

## Protocol 11: regenerate settled owner briefs

Run 10 completed calibration and extraction writing. Handoff stopped before dispatch
because the reused owner brief supplied a test URL resolving outside the profile
directory named by both the step and current runtime. The same brief asked the query
planner to decide whether to correct that recipe. The query planner reported an input
gap, as its role requires. Source-only diagnosis confirmed the mismatch; terminal test
failures were not needed to identify it.

Run all three original cases with fresh DeepSeek owner reasoning and the protocol 10
query/writer backend. Do not reuse or manually patch the original briefs. Add a generic
owner instruction to reconcile concrete recipes with existing source, resolve relative
paths from the module containing the expression, and settle mechanical choices before
handoff. Give the owner the original step and source only, with no prior candidates,
briefs, query responses or downstream failures. There is no new owner feedback loop.

Retain deterministic grouping, the same explicit selectors, one source lookup batch,
the shared query correction allowance, local writer retry and outer checks. Count all
fresh owner time, calls, tokens and charges. This is a new end-to-end exploratory
treatment with new briefs and plans, not a paired replay isolating prompt effects.
Earlier brief-reuse attempts remain unchanged. The separate divergent prototypes have
offline evidence only; their live comparisons remain queued after this goal.

## Protocol 12: resolve sandbox paths and admit the larger catalog

The fresh-owner run completed calibration, including downstream checks. Both larger
cases stopped during deterministic catalog construction before any query-planner or
writer request. Handoff named one existing file by its relative path and equivalent
absolute sandbox path. The catalog dropped the leading slash, treated the latter as
an absent relative path, and incorrectly reported an ambiguous basename. Extraction's
catalog contained 51,727 bytes, exceeding the 49,152-byte catalog limit by 2,575 bytes.
These are harness failures; they do not establish a model's inability to plan or edit.

Normalize absolute paths only against the declared source root. An absolute reference
under `/work` may alias an exact existing source-map key. Unknown absolute references
and paths outside that root remain unresolved; they cannot authorize absent write
paths. Preserve real basename ambiguity checks. Increase the catalog-only allowance
to 64 KiB in `catalog-lookup` mode; ordinary catalog mode retains its 48 KiB limit.
Every complete query request still must fit 160 KiB, source lookup remains limited to
eight requests and 64,000 characters, and writer context remains 32,000 characters.

Reuse all three exact fresh owner briefs from run 11 without manual edits. Run the
same deterministic optimizer and query/writer selectors once against the unchanged
original sources and checks. Record owner work as borrowed allocation as well as
actual query/writer time, usage and charges. Offline preflight must establish that all
three catalogs and initial query packets fit before paid execution. Followup packets
remain subject to their existing complete-request bound. Retain every failure and
receipt. This is another exploratory treatment, not a successful repeat or a matched
comparison against the historical controls. Repeat promising frozen plans before
selecting a configuration; divergent live experiments remain a separate later phase.

The query cap now measures the serialized `Client.json` context: system prompt and
one user message containing the JSON payload, including its timestamp. This includes
JSON string escaping previously omitted by the `{systemPrompt,input}` estimate;
it excludes provider framing and request options. Persist that scope and each admitted
context's byte count. Offline initial contexts for calibration, handoff and extraction
measure 25,460, 104,647 and 84,602 bytes respectively. Their catalogs measure 5,038,
34,742 and 51,727 bytes. All fit the applicable bounds. Ten focused catalog/lookup/cell
checks passed in 921 ms; Jev's offline verification returned fallback advice.

## Protocol 13: local syntax context for composed writes

Run 12 completed calibration and handoff writing. Extraction failed its first
composition because two copied object methods lacked a separating comma. Its one
local retry received the parser diagnostic and rejected edit JSON, but no assembled
source around the error. The retry moved a declaration into an object literal and
failed syntax again. These errors came from application diagnostics and rejected
writer responses; downstream behavioral failures do not inform this treatment.

Keep the exact run 12 briefs and raw query plans. Improve only the writer's local
application feedback: for a compose syntax error with a known parser line, provide
a bounded excerpt of the privately assembled output and a deterministic mapping to
the intersecting compose parts. Bound the additional serialized diagnostic to 4 KiB.
Do not expose the full assembled file or guess a parser location. Explain that compose
concatenates parts literally, without inserting separators or repairing lexical scope.
No successful edit is changed, and the writer still has at most one local retry.
There is no owner regeneration, fresh Sol query, post-dispatch Sol call, or behavioral
feedback to writers. Syntax failure leaves staged source unchanged.

After focused offline verification, replay all three cases once under one new freeze
using the run 12 raw plans and deterministic grouping. Retain failed attempts, source
hashes, the additional diagnostic and all receipts. Attribute reused owner/query work
as allocation, not new spending. This is a new exploratory treatment; it is neither a
successful repeat nor an isolated estimate of prompt effects. Complete application
remains separate from downstream delivery. Do not select a configuration from one
successful case or count unchanged-source checks as implemented behavior.

## Protocol 14: compare ungrouped assignments on the same backend

Run 13 reused every raw and dispatched plan from 12. Calibration completed writing
and downstream checks. Handoff failed an exact replacement in an assignment that
combined two original operations; extraction again failed composition syntax. This
is not evidence that the syntax-context treatment made application more reliable.

Replay the same three raw plans and briefs from 12 with optimization `none`, using
the exact code freeze from 13. Keep the model selectors, source bytes, local retry,
context limits, concurrency and outer checks unchanged. There are no new owner or
query-planner calls. Compare writing time, calls, token usage, application completion
and downstream outcomes against 13; allocate original owner and query work separately.
This isolates grouping as the configured difference, but one observation per arm
still includes model-generation variability. Do not attribute a difference solely
to grouping or declare reliability from a single successful replay. Stop after this
one run and retain all failed attempts and costs before selecting the next treatment.

## Protocol 15: enable low reasoning for the same writer assignments

Runs 13 and 14 completed only calibration. Handoff failed exact replacements and
extraction failed composition syntax despite one local retry with error-local source.
The pinned SDK provider-boundary audit confirms previous `deepseek/deepseek-flash:off`
requests explicitly sent `thinking:{type:'disabled'}`; the selector did not silently
inherit DeepSeek's default. A synthetic key and intercepted transport verified that
`:low` sends `thinking:{type:'enabled'}` plus `reasoning_effort:'low'`, retaining the
same native provider and model ID. The offline audit fixture used a 16,000-token
output setting; the live hard-case jobs retain their original 32,000-token output
limit, 300-second call deadline and 1,200-second implementation deadline. No inference
occurred in this audit. These controls agree with the
[official thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/).

Run all three original cases once, reusing the exact run 12 raw plans and owner
briefs, with deterministic grouping and `deepseek/deepseek-flash:low` writers. Sol's
selector remains `openai-codex/gpt-6.1-sol:low`, but plan reuse incurs no new Sol or
owner requests. Retain the run 13 writer prompt, application retry, source compactor,
engine, output bounds and outer checks unchanged. A new code freeze records corrected
role accounting: inherited ownership remains `deepseek/deepseek-flash:off`, while the
new writer selector is `:low`. Do not weaken strict identical-replay selector checks.
Verify matching execution-module hashes before inference and record any differences.

Count provider-reported output and cache usage without treating reasoning as free.
Measure new writer calls, tokens, time, application completion and downstream outcomes;
allocate inherited owner/query work separately. Do not infer a causal effect from one
pair or claim success when a faster run applied fewer operations. If low reasoning
completes all assignments, repeat the unchanged treatment before selecting it. Only
after a reliable treatment exists should a cheaper contextual policy selectively use
thinking; do not add a model to reason about each routing choice. The divergent
prototypes remain offline and separate from this writing-only comparison.

## Optional recovery treatment: off first, low on local rejection

The runner now accepts `--writer-recovery-model deepseek/deepseek-flash:low`
with `--editor-model deepseek/deepseek-flash:off` in `owner-query-writer` mode.
This is an available treatment, not a measured result. A successful initial write
incurs no recovery call. A rejected JSON response, edit application, or syntax check
uses the existing single retry with low reasoning on the same native model. Budget,
deadline, cancellation and transport failures do not trigger escalation. Both clients
share the call limit and ledger, and every attempt contributes usage and elapsed time.

The retry retains the initial assignment and source excerpts, plus the existing
bounded local diagnostic. Trusted operation IDs and attempt numbers are recorded
outside the model prompt and joined to receipts. The reporter checks model routing,
operation ownership and retry limits. Behavioral checks remain outside writing, with
no Sol call after dispatch and no additional repair round.

Before measuring this treatment, retain the completed low-reasoning result and repeat
it unchanged if it completes application across all three original cases. Any later
recovery comparison must reuse the same three raw plans and owner briefs, record a
new freeze, and preserve the existing source, optimizer, prompts and checks. Report
all failed attempts, borrowed planning allocation and actual new charges separately.
No live recovery result is claimed by the offline implementation or its focused tests.

## Protocol 16: measure failure-triggered low reasoning

Run 15 completed calibration and all handoff assignments. Extraction created its new
module, but the dependent runtime rewire required its local retry; that retry stopped
at the unchanged 32,000-token output bound. It consumed 31,999 reported output tokens,
all reported as reasoning, and returned no complete edit response. This local failure
means the all-low treatment does not qualify for a successful repeat. Downstream
check results do not determine this next treatment.

Run the three original cases once with the optional recovery policy described above:
initial native DeepSeek writers use `:off`, and only a rejected local attempt switches
to `:low`. Reuse run 12 raw plans and owner briefs, deterministic grouping and original
source/checks. Freeze the reviewed implementation at a new revision. Keep all existing
context, output, call and cell bounds; no new owner, Sol query or Jev call is needed.
Retain failed attempts and any length stops. Report actual writer time, tokens and
charges separately from inherited planning allocation. Compare application completion
and downstream delivery separately against the fixed-off and fixed-low treatments.
If this completes application across all three cases, repeat its exact freeze before
selection. Otherwise investigate smaller assignments as a distinct query-planning
treatment; do not keep escalating output limits or add unbounded retries.
