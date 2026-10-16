# Changeset execution: current evidence and implementation plan

Updated 2026-10-16. Paths below are relative to this worktree unless stated otherwise.
Branch: `spec-changeset-execution-poc`.

## What has worked

The strongest completed result is still the Sol-only changeset executor. Across
three exposed development cases, two frozen runs completed the required checks
and audits in 319.74 and 339.55 seconds, versus 474.96 seconds for the historical
native Sol baseline. That is 28–33% less elapsed time on these cases. Calls fell
from 28 to 16–17, and total tokens from 514,714 to 328,670–340,136. This is useful
small-sample evidence, not a production-wide speedup or an unseen benchmark.
See `scripts/changeset-study/SOL-ONLY-FINDINGS.md` and its retained results.

The executor already supports dependency scheduling, concurrent independent
writes, current staged file contents, exact replacements, and source-range moves
that avoid regenerating unchanged bodies. It retains successful staged operations
when another assignment fails. File conflicts serialize deterministically.

Small DeepSeek assignments also work individually. In the latest completed
Sol-planner/DeepSeek-writer run, both calibration assignments applied and the
implementation passed external acceptance. That case took 16.38 seconds. Its new
test had a faulty assertion, so complete downstream delivery did not pass.
The harder cases still had application failures: a stale/nonunique test excerpt
in handoff and a replacement mismatch during extraction. Neither completed all
planned assignments. We have not demonstrated a reliable overall win for the
DeepSeek writing configuration.

The dispatch-only runtime makes no Sol calls after writing starts. DeepSeek gets
one local recovery attempt for malformed output, failed application, or syntax
failure. Behavioral test results do not feed that recovery loop. Downstream tests
remain visible as separate evidence; passing file application alone does not
establish feature correctness.

## Current code, verified locally but not yet measured live

The working tree adds a distinct three-role strategy:

1. DeepSeek reads the step and source and settles implementation decisions.
2. Sol receives that settled brief, locates source boundaries, and creates writer
   assignments and dependencies. It does not receive the original step or review
   writer output.
3. DeepSeek applies bounded assignments concurrently where dependencies allow.

`roles.mjs`, `cell.mjs`, and `strategies.mjs` under
`scripts/changeset-study/` implement those boundaries. A focused integration test
checks model routing and the absence of post-dispatch review and repair calls.

The new local optimizer (`optimizer.mjs`) deduplicates context selections and
combines eligible adjacent assignments to the same file. It retains instructions,
requirements, file ownership, dependency ordering, and bounded assignment sizes.
It refuses contraction when an intermediate result has an observer, when combined
instructions exceed limits, or when source context cannot be resolved. It does
not infer semantic equivalence from prose or silently discard intermediate edits.

The contextual router (`context-router.mjs`) batches bounded Jev questions about
assignment grouping and small-file context. Deterministic code retains authority
for dependency safety and size limits. Unavailable or uncertain advice falls back
to a fixed policy. Requests, latency, estimated cost, and failed-request budget
holds are retained. This routing has not yet produced a live measured result.

Eight focused checks passed in approximately 0.38 seconds: role boundaries,
editor recovery, source bounds, dependency-preserving grouping, and routing
fallback accounting. These are runtime contract checks, not evidence of live
model effectiveness. A read-only review identified a context-routing issue:
context advice must describe the actual combined assignment it will govern.
That correction is now implemented: context expansion is considered only for
uniquely owned files that cannot be merged. Its focused checks passed.

## Next implementation and measurement

- Finish the context-routing correction and retain its focused evidence.
- Freeze the three-role strategy, prompts, source, model selectors, and task bytes.
- Run the existing calibration, handoff, and extraction cases with bounded
  assignments. Keep every failed attempt.
- Reuse those exact owner briefs and raw query plans for deterministic optimization
  and contextual optimization comparisons. This isolates writing changes from
  variation in implementation decisions and query planning.
- Measure owner time, query planning, local optimization, Jev routing, writing,
  dependency depth, concurrency, calls, input/output/cache tokens, and normalized
  cost. Count borrowed planning time and cost in allocated pipeline comparisons;
  distinguish those from actual incremental spending.
- Report application completion separately from visible tests, candidate-added
  tests, and external acceptance. Retain downstream failures when recommending a
  configuration. Repeat a promising configuration before treating it as stable.
- Select the best configuration observed under the measured constraints, rather
  than claiming a globally optimal configuration or a production speedup.

Models remain Sol 6.1 (`openai-codex/gpt-6.1-sol:low`) for query planning and
DeepSeek V4.1 Flash (`deepseek/deepseek-flash:off`, native DeepSeek provider) for
implementation ownership and writing. Mercury and Nemotron are outside this
comparison. Sol is priced at the same comparison tariff as DeepSeek, as requested;
that normalized metric is separate from conservative budget reservations.

## Integration into spec-end-to-end

The intended insertion point is the existing step owner's writing stage. The
production owner already reasons about implementation; integration must reuse
that work rather than introduce another owner planning phase. The research runner
measures it explicitly to make the role boundary visible.

The managed runtime already supports batches of 2–4 disjoint editor packets.
The proposed addition compiles the owner's settled decisions into a whole-batch
plan, optimizes it locally, and dispatches dependency-safe waves through those
existing writer slots. Reuse current writer leases, path fences, cancellation,
receipts, and staged source handling. Preserve any test-first ordering required
by the outer workflow.

Verification and review remain in the existing outer process. Sol's query planner
does not inspect or approve writer results. Production managed-runtime integration
has not been implemented in this branch; the current work is an experimental
backend and measurement harness.

## Budget and retained evidence

The user requested a fresh money tracker during this work. The previous ledger
was archived with $29.2873046 of conservative exposure, including unresolved older
reservations. A new $50 allowance is active. Prior spending and results were not
deleted or relabeled. Research artifacts and raw requests remain in the adjacent
experiment package, outside Git; published findings use repository-relative links.

Implementation and reporting work can be delegated to Sol 6.1 or Luna, as
requested. This does not change the explicitly selected live experiment models.
User-provided `ideas.md` and `creative-ideas.md` remain untouched.
