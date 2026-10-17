# Provisional configuration evidence

**Status:** Research-only. The provisional best observed writer configuration
within the requested DeepSeek-owner / Sol-query / DeepSeek-writer architecture
uses `catalog-lookup`, `smaller-regions`, no grouping, no Jev advice by default,
and four-way writer concurrency. DeepSeek Flash `:off` is used for the primary
writer and the single same-selector retry. This is a writer-boundary selection
for further integration work, not a production adoption recommendation.

The existing DeepSeek step owner keeps implementation decisions and acceptance
obligations. Sol compiles its settled brief into bounded source bindings and
writer packets. Deterministic optimization does not group operations. Jev advice
is optional and off by default. The writer stage has no Sol review or repair loop.
The existing outer workflow still owns required tests and separate review gates.

The [managed integration plan](./INTEGRATION.md) describes the runtime work still
required. The isolated alternatives are [DeepSeek-only changesets](./divergent/deepseek-direct/PROTOCOL.md),
[bounded apply-writer splicing](./divergent/apply-writer/README.md),
[provenance-bound deterministic recipes](./divergent/provenance-compiler/README.md),
and [exact source-range splicing](./divergent/source-splice/README.md). The
[measured Sol writer control](./divergent/writer-control/README.md) is an
alternative within the same fixed-plan boundary, not the required writer route.

## Matched writer-boundary observations

Runs 19–23 and the Sol controls reuse run 18's plans and source. Runs 18/19 and
the Sol controls use the original frozen writer backend; runs 20–23 use its newer
application-diagnostic revision. Each run passed integrity and completed
application in all three cases. Times below cover writing and optimization only;
they exclude owner/query work and downstream checks. Normalized costs use common
DeepSeek token rates and are not actual comparable provider charges.

| Arm and run | Writer route | Application / delivery | Writer seconds | Calls / retries | Tokens | Normalized USD |
|---|---|---:|---:|---:|---:|---:|
| DeepSeek 18 | `off` → one local `low` retry | 3/3 · 2/3 | 73.55 | 28 / 2 | 142,488 | $0.0694 |
| DeepSeek 19 repeat | `off` → one local `low` retry | 3/3 · 1/3 | 124.22 | 28 / 2 | 161,072 | $0.0802 |
| DeepSeek 20, diagnostic | `off` → one local `low` retry | 3/3 · 1/3 | 110.07 | 27 / 1 | 123,397 | $0.0486 |
| DeepSeek 21 repeat, diagnostic | `off` → one local `low` retry | 3/3 · 1/3 | 136.81 | 29 / 3 | 154,719 | $0.0687 |
| DeepSeek 22, diagnostic | `off` → one `off` retry | 3/3 · 1/3 | 50.08 | 26 / 0 | 115,989 | $0.0378 |
| DeepSeek 23 repeat, diagnostic | `off` → one `off` retry | 3/3 · 1/3 | 35.30 | 26 / 0 | 113,585 | $0.0330 |
| Sol control 01 | `low`, same-selector retry policy | 3/3 · 2/3 | 102.32 | 26 / 0 | 102,307 | $0.0430 |
| Sol control 02 repeat | `low`, same-selector retry policy | 3/3 · 2/3 | 108.18 | 26 / 0 | 102,386 | $0.0397 |

The pairs are separate: 20–23 use the application-diagnostic backend revision,
so their timings must not be merged with the 18/19 pair. The 22/23 runs had zero
retries; they show no benefit from changing the retry selector because the retry
was never exercised. Their faster observed times support this provisional
configuration on these fixed inputs, but do not isolate a retry-selector effect.
The Sol controls are not candidates for the requested DeepSeek-writer route.
Their reported receipt charges were $0.3144 and $0.2929; subscription quota is
not measured and the Sol adapter omits the requested `maxTokens`, so actual costs
and provider-enforced output ceilings are not comparable.

Application completion is not delivery. All eight runs passed calibration and
all eight failed dependency-handoff delivery. Lifecycle delivery passed in
DeepSeek 18 and both Sol controls, but failed in DeepSeek 19–23. The Sol controls
therefore had 2/3 delivery twice, compared with 1/3 in both DeepSeek diagnostic
pairs. This evidence supports a configuration choice only at the writing
boundary; it shows no delivery-quality win or production readiness. Per-case
accounting for runs 18/19 and the Sol controls is in
[writer-control-results.json](./writer-control-results.json) and its
[offline visual](./writer-control-results.html). Runs 20–23 are in
[optimized-results.json](./optimized-results.json). Detailed source audits
remain in the adjacent runtime store.

## Selection limits and next work

The selected boundary configuration uses `:off` for both the primary writer and
the single retry. The frozen runtime supports this same-selector retry, but this
pair did not exercise it; the pair therefore says nothing about its recovery
benefit. The legacy path can also retry transport/model exceptions, and the
strict audit rejects any observed retry caused by such an exception. A managed
integration must preserve local failure classification and keep the retry
bounded.

Deterministic grouping remains available but is not selected: its measured gain
was limited to one calibration observation. Jev produced the same dispatched
plans as deterministic policy in its measured comparison, with added calls and
no demonstrated benefit. These results do not rule out either technique on other
workloads.

No run here measures a fresh end-to-end workflow. Runs 20–23 reuse run 18's plan
and brief and make no fresh owner/query calls; run 18 also reused an earlier owner
brief. Fresh owner, query, writer, required-check and outer-review time must be
measured together in the managed workflow before adoption. No further writer
selector runs are planned. The separate DeepSeek-only changeset experiment below
removes Sol as query planner while retaining the changeset executor; it is not a
native-agent editing comparison.

The [specialized file writer](divergent/specialized-writer/README.md) is a separate
alternative architecture, not a writer swap inside the changeset IR. It connects
Morph and Relace through OpenRouter using complete source and owner-produced
update snippets. Its integration checks do not constitute a workload comparison.
The earlier bounded apply-writer prototype is an optional range-verification
variant, not a prerequisite for this route. Keep both distinct from the
provisional changeset configuration and the DeepSeek-only changeset experiment.

## Separate DeepSeek-only changesets observation

The [single frozen run](deepseek-only-results.md) ([JSON](deepseek-only-results.json))
completed with audited delivery 0/3. Calibration applied its initial plan, then
failed final repair qualification; both larger cases exhausted discovery calls
before emitting a plan. The possible prompt/tool-role conflict is unproven. This
includes DeepSeek planning/review/repair and does not change the provisional
writer-boundary selection above. No matched three-task native DeepSeek baseline
or performance win is established, and no further trial has started.
