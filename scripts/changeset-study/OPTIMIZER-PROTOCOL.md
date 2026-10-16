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
