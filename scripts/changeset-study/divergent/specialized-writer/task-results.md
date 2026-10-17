# Specialized full-file writers: three-task experiment

Neither route delivered a complete task: **Morph 0/3; Relace 0/3**. Morph applied both eligible preparations; Relace applied calibration and rejected handoff's third file on syntax. Lifecycle failed during DeepSeek preparation, so neither vendor was tested there. These are six retained cells, including both owner failures. Fast file modification did not establish a delivery or whole-workflow win. Missing vendor preservation-marker conventions also prevent treating this freeze as a clean vendor-quality comparison.

The [JSON evidence](task-results.json) records stage timings, calls, tokens, charges, candidate/input hashes and qualification. The [protocol](PROTOCOL.md) describes this standalone alternative to changesets: direct DeepSeek Flash off prepares settled instructions and code snippets; each vendor receives those exact snippets and original source files. No Sol planning/review, changeset IR, hidden feedback, model review or semantic repair occurred.

| Task | DeepSeek preparation | Preparation s | Calls | Catalog USD |
| --- | --- | ---: | ---: | ---: |
| Context calibration | prepared, 2 targets | 5.397 | 1 | 0.003370500 |
| Dependency handoff | prepared, 6 targets | 37.571 | 1 | 0.042806568 |
| Lifecycle extraction | failed; no vendor test | 83.156 | 2 | 0.058686588 |
| Total | 2/3 prepared | 126.124 | 4 | 0.104863656 |

Lifecycle's initial response contained prose and tool-style markup instead of JSON. Its one allowed JSON-format correction reached the owner's enforced 32,000-token output limit. That failed outcome is reused unchanged; no snippet was supplied manually and no owner was rerun.

| Vendor / task | Application | Delivery | File modification s | Downstream checks s | Estimated complete route s | Writer calls / USD |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Morph / calibration | 2/2 files | fail | 1.446 | 0.253 | 7.097 | 2 / 0.013181600 |
| Morph / handoff | 6/6 files | fail | 22.230 | 300.669 | 360.486 | 6 / 0.158110000 |
| Morph / lifecycle | owner failed | fail | — | — | 83.156 | 0 / 0 |
| Relace / calibration | 2/2 files | fail | 1.809 | 0.254 | 7.460 | 2 / 0.013621700 |
| Relace / handoff | stopped at file 3 | fail | 5.488 | 1.944 | 45.015 | 3 / 0.079066800 |
| Relace / lifecycle | owner failed | fail | — | — | 83.156 | 0 / 0 |

Application here means every requested complete file returned normally and passed local syntax checks; it does not mean behavior passed. Complete-route estimates allocate that task's original preparation once, plus the writer attempt and downstream checks. Infrastructure recovery, development and freeze time are outside these estimates. The untested lifecycle contributes its failed preparation time, never a successful zero-time write. Relace handoff stopped early, so its shorter attempt cannot establish faster completed application.

Both calibration candidates passed the completed hidden calibration suite and the five existing tests. Their owner-generated regression failed an incorrect assertion: it expects a 540,000-character payload to pass after seeding, although the retained minimum calibration ratio of 0.5 projects 90,517 tokens against a 90,000-token guard. Full delivery remains failed because the required new regression does not pass.

Morph handoff omits the original `promptRevision` definition while retaining its call. The supplied runtime update references that helper but omits its definition and every `// ... existing code ...` preservation marker. The frozen owner prompt requested anchors without requiring those markers. [Morph documents that omitted markers indicate deletion](https://www.morphllm.com/fast-apply-model#the-edit-format), so the request has a vendor-format mismatch. This plausibly explains the missing helper, but no corrected-format run isolates causality; it is not an unambiguous model retention error. All six selected existing tests fail with `promptRevision is not defined`. The generated tests also include a missing fixture-directory failure. Hidden grading reported failures and was killed by its 300-second abort signal without a completion marker; total downstream time was 300.669 seconds including the preceding checks and posthoc audit. Its raw sandbox `timedOut` field is false because cancellation came from the external abort signal; `SIGKILL`, exit 137 and incomplete grading remain recorded. The process group was cleaned up. The frozen path audit could not identify its expected dirty-state structure, so it did not qualify the candidate.

Relace handoff returns two `currentHandoff` definitions, while its original source and supplied update each contain one. [Relace’s agent definition](https://docs.relace.ai/docs/instant-apply/agent) and [workflow guide](https://docs.relace.ai/docs/instant-apply/workflow) also prescribe precisely placed comments for omitted unchanged sections; the retained update has none. This is an observed integration failure confounded by snippet format, not a controlled model-only failure. The syntax fence rejected it before installation; the partial candidate retains the original runtime. Its selected existing checks pass, but hidden checks fail because the required `buildDependencyHandoff` export is absent. The path audit is structurally inapplicable. Neither result supports delivery.

| Accounting | Morph route | Relace route | Actual combined experiment |
| --- | ---: | ---: | ---: |
| Writer calls | 8 | 5 | 13 |
| Writer catalog USD | 0.171291600 | 0.092688500 | 0.263980100 |
| Preparation calls, allocated once per route | 4 | 4 | 4 actual |
| Complete calls | 12 | 9 | 17 actual |
| Complete catalog USD | 0.276155256 | 0.197552156 | 0.368843756 actual |
| Complete tokens | 449,118 | 365,265 | 537,544 actual |
| Capped time to delivered success | 4,500 s | 4,500 s | — |

All 17 requests are priced; there are zero unresolved holds. Actual combined spend counts preparation once, while each hypothetical complete route allocates it once. Summing the two route totals would double-charge preparation. Charges use retained SDK/catalog usage, not independently verified invoices; harness development and offline checks are outside the experiment ledger. Every failed delivered task receives the original 1,200-second implementation plus 300-second hidden-grading cap for the capped comparison.

The first paid freeze completed those four owner calls, then stopped before any vendor call because the harness supplied fractional milliseconds to Node's integer-only timeout API. The retained corrected freeze rounds the remaining deadline and pins the exact original preparation files, aggregate results, source revision and reservation IDs. No paid owner work was repeated. Owner code was committed at `56a11ea`; writer-only resume at `6284c83`.

Posthoc checks verified frozen code/Node/SDK/dependencies, identical owner snippets and original source per vendor request, routing, protected files, candidate hashes and all 17 canonical ledger reservations. Nine focused offline adapter/runner checks passed in about 199 ms; independent review closed the timeout and reuse findings. Broad testing remains operator-managed outside this evidence.

This is one sequential run on three exposed development tasks. Morph's 38,000-token and Relace's 128,000-token output ceilings differ; both use the declared approximate bytes/4 input guard. No writer context refusal or writer length stop occurred. Lifecycle truncation belongs to the owner. There is no matched complete native baseline, and the missing lifecycle applications, early Relace failure and failed downstream checks prevent a quality-preserving efficiency claim.

A follow-up could validate vendor snippet conventions and reject known output damage
before installation. The maintained [OpenCode Morph plugin](https://github.com/JRedeker/opencode-morph-fast-apply#safety-guards)
documents import-loss, major-truncation and marker-leakage guards. Those are detection/abort
mechanisms, not general deterministic repair or proof that all changes match intent.
Relace's suggested diff return to an agent adds review outside this experiment's frozen
no-model-review boundary. No such follow-up was implemented or measured here.
