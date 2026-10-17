# Stacked writing route: review and optimization loop

Response to [the stacked-interventions briefing](stacked-interventions-1.md). Paths are relative to the `changeset-execution-poc` worktree (branch `spec-changeset-execution-poc`) unless marked as research or runtime paths. Runtime evidence resolves from the spec-package runtime base (`../../specs/changeset-execution-poc/runtime` from this directory) under `stacked-optimization/`.

## Review of the briefing

The revised stack doubled writing time because of one representation choice, not because of consolidation or scheduling. In the revised run, two of the 17 packets took 54.7 of the 95.2 execution seconds and emitted roughly 20,000 of the 22,533 extraction output tokens: the V4A `Add File` for `wave-lifecycle.mjs` (28.1 s, a 45 KB response) and the merged delegate/remove packet on `runtime.mjs` (26.5 s, a 43 KB response). V4A has no by-reference copy, so a move re-emits every moved line twice, once as `+` in the new file and once as `-` in the old one. The JSON baseline's `compose` and `replace-range` carried the same bodies by anchor in 2.7 s and 1.8 s.

The JSON baseline did not deliver extraction, and that failure was a writer composition error, not a planner error: its `wave-lifecycle.mjs` is 552 lines against the delivered 594, and hidden grading failed with `Cannot read properties of undefined (reading 'call')` from the delegating methods. The by-reference compose assembled the returned object wrongly while still passing the syntax gate. So neither representation is right for a move on its own: literal V4A is correct but pays for every line, by-reference JSON is cheap but trusts the model to place separators it cannot see.

Answers to the six questions, with the evidence behind each:

1. **Representation.** Deterministic consolidation plus a per-packet representation choice is the right shape, but the split is by operation, not by file. Observed: new files written literally delivered (V4A 3/3 applied, extraction passed); range edits on existing files are where V4A pays (the two large `-` blocks) and where its two residual malformed patches occurred (`runtime-imports`, a range removal across three excerpts, and `runtime-editor-outcome`). The deterministic rule tested below: absent destination → literal V4A; existing destination whose recipe names a source range → executable JSON; otherwise V4A.
2. **Jev.** Remove it from the default writing path. Six successful requests across both combined runs changed zero merge or context decisions; its cost was about 1 s and 3 calls per task. Nothing in the retained plans produces a pair a judge could veto on cognitive load that the packet size bound does not already refuse. Keep it as an option for a workload with many eligible same-file pairs, which these three tasks do not have.
3. **Extraction regression.** Mainly an avoidable representation choice. The packet and query design produced a correct plan both times; only the writer's encoding of "copy these ranges" changed cost by an order of magnitude. The deeper design change worth testing is to stop asking any model to copy at all: pre-fill the absent destination deterministically from the packet's own excerpts and have the writer patch the seams.
4. **Smallest fair comparison.** A replay of the three retained plans and briefs with no new planner calls, run sequentially from the same code revision and node binary, with a fresh JSON baseline and the current V4A profile as contemporaneous controls, reporting input, output and cache-read tokens separately because DeepSeek's prefix cache makes repeated prompts nearly free. That is what the loop below runs. It still has one observation per cell unless repeated, and it still exposes the development cases.
5. **Latency versus quality.** Headline on delivered tasks (hidden grading passed with protected files intact), with writing wall time and token totals reported only for arms that deliver the same set. A failed delivery contributes its full cost and no saving. Hold the outer checks constant by replaying the same candidate checks and hidden suites; report visible and hidden durations separately because they vary with the candidate.
6. **Before integration.** Two repeated replays where the best route delivers at least what the V4A profile delivers, with no silent misapply (an applied packet whose hidden result is worse than the control's) and with the writer never receiving test feedback. Sol still only plans and dispatches; every change below is local to validation, scheduling and the writer boundary.

What the evidence does not support: a general V4A speed advantage (per packet, the JSON baseline was as fast or faster on handoff; V4A output tokens were equal) and any claim about the handoff task, which fails behavioral checks under every arm for planner-level reasons.

## Levers added for the loop

All are opt-in `dispatchOptions` on the `optimized-v4a` profile (`scripts/changeset-study/dispatch-profile.mjs`); defaults reproduce the revised run exactly.

| Option | What it changes | Why |
| --- | --- | --- |
| `advice: 'none'` | Skips the Jev request; deterministic policy only | Zero decision changes in six requests |
| `prune_dependencies: true` | Drops declared `depends_on` edges with no file overlap before optimization (`pruneDeclaredDependencies` in `optimizer.mjs`); `compile` keeps every read/write overlap | Handoff's `runtime-imports` waited for the three-deep `handoff-builder` chain although it never reads that file; depth 6 → 4 |
| `writer_routing: 'hybrid' \| 'json'` | Per-packet representation (`routeWriterFormat` in `v4a-editor.mjs`); JSON uses the focused writer with its existing local retry | Range edits re-emitted as `-` lines dominated extraction |
| `prompt_order: 'static-first'` | Shared contract first, per-packet ownership sentence last, both writers | Lets DeepSeek's prefix cache hit across packets ($0.006 vs $0.30 per million) |
| `concurrency: 8` | Executor width | Pruned plans have more ready packets |
| `anti_dependencies: 'snapshot'` | A writer may start once the reader of its file has started (`execute` in `scripts/changeset/engine.mjs`); readers already take their snapshot at start | Extraction serialized the 28 s copy before a 3 s rewire that only needed the copy to have begun |
| `seed_moves: true` | Pre-fills an absent destination with the packet's declared excerpts, concatenated in planner order, and hands the writer an `Update` on that seed (`seedMove` in `v4a-editor.mjs`); only for recipes that say compose/copy/move/extract | Removes the literal copy from the model's output entirely |

Harness: `scripts/changeset-study/divergent/stacked-optimization/run.mjs` replays the `02-revised-combined` inputs through a frozen copy of the current scripts, one sequential cell per variant and task, and writes `results.md` and `results.json` after every cell.

## Results

Each round replays the same three retained plans and briefs. "Delivered" means hidden grading passed with protected files intact; "Applied" means every packet applied locally. Writing seconds are preprocessing plus execution, summed over the three tasks. Context tokens are input plus cache-read, because DeepSeek's prefix cache turns a repeated prompt into nearly free tokens and a changed prompt into a cold one; output tokens are the writer's own cost. Fallbacks count second writer attempts from the request log. Node v22.15.0; the frozen 02 run used v22.23.3.

### Round 1: which levers matter

Variants: `reference-v4a` is the checked-in profile unchanged; `json-baseline` is the historical JSON route with no consolidation; the `-lean` variants drop Jev, prune sequencing-only dependencies, order prompts static-first and run eight wide, differing only in representation.

| Variant | Cells | Delivered | Applied | Writing s per 3-task pass | Calls | Context tokens | Output tokens | USD | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| reference-v4a | 3 | 1/3 | 3/3 | 82.5 | 24 | 108617 | 33306 | 0.0587 | 4 |
| json-baseline | 3 | 1/3 | 3/3 | 43.9 | 28 | 110027 | 17743 | 0.0335 | 2 |
| v4a-lean | 3 | 1/3 | 2/3 | 59.2 | 19 | 84724 | 30258 | 0.0585 | 3 |
| hybrid-lean | 3 | 1/3 | 3/3 | 52.8 | 18 | 78193 | 26618 | 0.0439 | 1 |
| json-lean | 3 | 1/3 | 2/3 | 31.2 | 16 | 69436 | 17417 | 0.0359 | 1 |

Observations behind the numbers:

- The reference profile is not a stable 2/3. Re-run unchanged it delivered 1/3: extraction applied, but the rewire packet's V4A patch was rejected and its JSON fallback bound the factory helpers to `readFileSync`/`writeFileSync`/`renameSync` instead of the module's `read`/`atomic`/`save`, so the lifecycle factory failed at runtime. The same invented bindings appeared in the hybrid variant's JSON primary. The requirement text spelled the object as shorthand `{ read, atomic, save, timestamp, ... }`; the writer "resolved" names it could not see in its excerpts.
- Pruning two sequencing-only edges on handoff (`runtime-imports` after `handoff-builder` and after `export-complete-outcomes`) cut dependency depth from 6 to 4 and writing time from about 35 s to 15–22 s with no change in which packets applied.
- Hybrid routing sent three range packets to executable JSON. Extraction fell from 44–58 s to 33 s and handoff had zero fallbacks in that pass. The literal copy packet alone still took 28 s and about 11,000 output tokens.
- All-JSON was fastest per pass (31 s) but failed to apply extraction once (a malformed JSON response with trailing text on the compose packet), repeating the by-reference fragility the matched comparison saw.

### Round 2: seeding the copy and overlapping the rewire

Round 2 added one sentence to both writer contracts: write identifiers exactly as the recipe spells them, a shorthand member names an existing module-scope binding, never substitute an import or an invented binding. All round-2 variants carry it, including the reference re-run.

| Variant | Cells | Delivered | Applied | Writing s per 3-task pass | Calls | Context tokens | Output tokens | USD | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| reference-v4a | 3 | 1/3 | 2/3 | 78.6 | 19 | 79205 | 33496 | 0.0626 | 1 |
| hybrid-lean-seeded | 3 | 2/3 | 3/3 | 39.7 | 19 | 88059 | 20694 | 0.0497 | 2 |
| hybrid-lean-snapshot | 3 | 2/3 | 2/3 | 50.8 | 18 | 80972 | 28754 | 0.0478 | 1 |
| hybrid-lean-seeded-snapshot | 3 | 1/3 | 2/3 | 27.7 | 20 | 99614 | 17746 | 0.0365 | 3 |

- `seed_moves` is the decisive change for extraction. The copy packet became a 5.1 s `Update` on the pre-filled module with 1,355 output tokens (round 1: 28 s and about 11,000 tokens), the patch touched only the imports, the `environmentFacts` relocation, the factory wrapper and the method separators, and hidden grading passed. The whole task wrote in 9.6 s with 2,207 output tokens against 58.1 s and 22,533 in the revised stack.
- The rewire packet produced the correct helper object in both seeded and snapshot runs after the name-fidelity sentence (2/2, against 1/4 before). One sentence and three observations do not establish the rate; it is the right direction.
- Snapshot scheduling overlapped the rewire and delegate packets with the copy: unseeded extraction finished in 28.3 s, the copy packet's own duration. With seeding the copy is no longer the long pole, so snapshot scheduling buys little on this workload and adds executor semantics the waves integration would have to carry. It stays an option, not a default.
- The reference profile re-run delivered 1/3 again, differently: handoff failed to apply (the merged `runtime-imports` packet's V4A rejected and its JSON fallback failed syntax), and extraction passed every hidden test but the merged delegate packet never removed the moved helpers, so the module boundary check failed. Large removals are where literal V4A silently under-delivers.
- Remaining failures cluster on one packet shape: merged packets stitched from three or four excerpts of the 1,400-line `runtime.mjs` (`runtime-editor-outcome`, `runtime-imports`, `test-foundation`). V4A rejected those in four of five observations; the JSON fallback usually recovered. The seeded-snapshot extraction failure was a seeded patch that broke syntax followed by a fallback `replace` whose search text was not unique.

### Round 3: narrow versus wide hybrid routing, two repeats

`hybrid-lean-seeded` is round 2's best route unchanged. `hybridwide-lean-seeded` additionally sends merged packets and packets stitched from three or more excerpts of an existing file to the JSON writer first.

| Variant | Cells | Delivered | Applied | Writing s per 3-task pass | Calls | Context tokens | Output tokens | USD | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hybrid-lean-seeded | 6 | 3/6 | 5/6 | 41.7 [30.7–52.6] | 19 [18–20] | 87041 [80216–93866] | 22868 [18498–27238] | 0.0371 [0.0328–0.0415] | 0 |
| hybridwide-lean-seeded | 6 | 2/6 | 3/6 | 37.3 [36.0–38.6] | 19 [18–19] | 83803 [81551–86054] | 17630 [15609–19650] | 0.0311 [0.0309–0.0312] | 0 |

- Wide routing lost on both counts. Handoff writing rose from about 18 s to 26 s because the JSON writer is slower than V4A on the merged test-file appends (8–12 s each), and it failed to apply once when `runtime-editor-outcome` produced a syntax error on both JSON attempts; under narrow routing that packet's V4A attempt fails matching and the JSON fallback, which receives the application diagnostic, has recovered every time. Narrow hybrid stays the default.
- Seeded extraction delivered 1/2 under narrow and 0/2 under wide; none of the three failures was a routing effect. One was a duplicate trailing `*** End Patch` marker, which the strict envelope rejected, followed by a 29 s JSON fallback that tried to `create` over the seed. One was a seam patch that nested the exported `environmentFacts` inside the factory wrapper (syntax error on both attempts). One was the rewire packet's second JSON attempt leaving a non-unique anchor for the delegate packet's excerpts.
- Three fixes follow from those failures and are in the round-4 code: the applier's declared lenient envelope now collapses consecutive trailing end markers (nested envelopes still fail); a failed seam patch falls back to the planner's original packet view, where the destination is absent and `compose` is legal, instead of a 40 KB "existing" file; and the seed note carries the excerpt layout with line ranges plus the rule that `export` is only valid at module scope.
- Handoff applied 2/2 under narrow routing at 17.8 and 18.6 s with warm cache reads (33,920 and 23,424 tokens), against 35 s in the revised stack. Its critical path is now the three sequential appends to `runtime.test.mjs` (7–12 s each), which no representation change shortens.

### Rounds 4 and 5: the lean profile under repeats, and the seam patch as the remaining risk

Round 4 ran `optimized-lean` (narrow hybrid, seeded moves, no advice, pruned edges, static-first prompts, eight wide) three times on the code with the lenient envelope and the seed layout note. Round 5 repeated it after one change: a rejected seam patch now gets a second seam attempt carrying the applier diagnostic instead of a JSON fallback, because the JSON fallback on a seeded move had been either a 24–29 s malformed full rewrite or a by-reference compose with a non-unique anchor.

Round 4 (per task, three repeats):

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 3 | 3/3 | 3/3 | 3.1 [2.9–3.3] | 2 [2–2] | 7747 [7747–7747] | 1153 [1112–1192] | 0.0015 [0.0015–0.0016] | 0 |
| lean | dependency-handoff | 3 | 0/3 | 3/3 | 18.7 [17.1–19.6] | 14 [14–15] | 57932 [53688–64451] | 14378 [13098–15185] | 0.0265 [0.0239–0.0283] | 0 |
| lean | lifecycle-extract | 3 | 1/3 | 1/3 | 15.5 [7.6–27.2] | 3 [2–5] | 26623 [25789–28069] | 4591 [1862–9488] | 0.0075 [0.0028–0.0154] | 0 |

Round 5 (per task, three repeats):

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 3 | 2/3 | 3/3 | 3.4 [3.0–3.9] | 2 [2–2] | 7747 [7747–7747] | 1196 [968–1439] | 0.0016 [0.0013–0.0019] | 0 |
| lean | dependency-handoff | 3 | 0/3 | 3/3 | 21.9 [18.7–24.6] | 14 [14–14] | 58254 [55448–60308] | 15135 [14811–15773] | 0.0268 [0.0252–0.0283] | 0 |
| lean | lifecycle-extract | 3 | 0/3 | 0/3 | 5.0 [4.3–5.5] | 2 [2–2] | 25819 [25729–25955] | 985 [626–1342] | 0.0016 [0.0011–0.0021] | 0 |

- Handoff applied in six of six passes at 17–25 s with 13–15 calls, against 35 s and 15 calls in the revised stack and 36.8 s and 20 calls in the JSON baseline. Its behavioral failure is unchanged and planner-level.
- Calibration delivered in five of six; the one miss was a writer semantic error on the merged policy packet, the first calibration failure in 17 observations across all rounds.
- Extraction is where the route is still unreliable. The seeded seam patch applied in one of three round-4 passes (the pass that delivered: 11.6 s, 2,422 output tokens) and in none of the six round-5 attempts. Replaying each rejected patch against its seed shows one failure class in all three round-5 pairs: the writer opened the factory wrapper at the top of the seed and left `export function environmentFacts` inside it, which is a syntax error, instead of relocating it. The planner-ordered seed put that exported function in the middle of the helpers because the planner's excerpt list differed from its own recipe order.
- The retry with diagnostic did not help against that class: the second patch repeated the same structure with the diagnostic line number moved. The seed order, not the retry, is the lever, so round 6 orders seed parts by where the recipe first mentions each excerpt's start anchor. For this packet that puts `environmentFacts` first at module scope and leaves the writer with only wrapper, separator and import seams.

### Round 6: recipe-ordered seed

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 3 | 3/3 | 3/3 | 3.1 [2.7–3.5] | 2 [2–3] | 9069 [7747–11712] | 1164 [1092–1300] | 0.0016 [0.0015–0.0018] | 0 |
| lean | dependency-handoff | 3 | 0/3 | 2/3 | 16.9 [14.7–19.7] | 12 [12–13] | 48170 [45693–50167] | 11797 [10580–13032] | 0.0191 [0.0163–0.0215] | 0 |
| lean | lifecycle-extract | 3 | 1/3 | 2/3 | 9.8 [6.7–14.1] | 3 [2–5] | 28595 [19879–39618] | 2112 [1538–2860] | 0.0047 [0.0024–0.0090] | 0 |

- The `export` inside the wrapper failure class disappeared: with `environmentFacts` first in the seed, no seam patch nested it. Extraction delivered once (14.1 s, 2,860 output tokens, after one seam retry and one JSON retry on the rewire packet) and failed twice in new ways. One pass applied cleanly and passed syntax but the writer had wrapped the transport-sanitizing block in `/* ... */` to "move" it, and the module failed at runtime with `P is not defined`: a silent misapply that the local gates did not see. The other pass failed both seam attempts on matching.
- That misapply motivates a deterministic gate for seeded moves, in the round-7 code: every non-comment seed line must survive as the tail of some non-comment output line (an added `export ` prefix or trailing comma passes), with block comments blanked from the parser's exact comment ranges. Replayed against the five retained seeded candidates, the gate accepts the four that delivered and rejects the one that failed at runtime.
- Handoff applied in two of three passes at 14.7–19.7 s; the failure was a merged `runtime.mjs` packet that both the V4A attempt and its JSON fallback got wrong, the same shape as the earlier handoff application failures.

### Round 7: seed integrity gate

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 3 | 2/3 | 3/3 | 3.0 [2.9–3.1] | 2 [2–2] | 7747 [7747–7747] | 1066 [1030–1111] | 0.0014 [0.0014–0.0015] | 0 |
| lean | dependency-handoff | 3 | 0/3 | 2/3 | 25.8 [19.5–31.1] | 14 [13–14] | 58512 [52270–67136] | 16279 [14520–17777] | 0.0277 [0.0247–0.0325] | 6 |
| lean | lifecycle-extract | 3 | 1/3 | 1/3 | 8.0 [5.1–12.8] | 3 [2–4] | 28768 [26094–33934] | 1727 [1077–2996] | 0.0027 [0.0017–0.0044] | 3 |

- No silent misapply reached grading: the only extraction pass that applied also delivered (12.8 s, 2,996 output tokens, after a syntax-rejected first seam patch). The other two passes failed both seam attempts locally, one by matching and one by syntax each time, at 5–6 s and about 1,100 output tokens for the whole task.
- Across rounds 4–7 the seam patch succeeded on the first attempt in 3 of 12 passes and on the retry in 2 more, so a seeded extraction delivers about 40 percent of the time at 5–14 s, where literal V4A delivered about a third of the time at 44–58 s and by-reference JSON never delivered. The seam patch fails in structural ways (an unclosed or early-closed wrapper, a hunk anchored on lines it had itself changed), which is a writer-capability limit rather than a format or context defect. Round 8 therefore runs the second seam attempt on the same DeepSeek model with low reasoning, the recovery tier the study already supports for JSON writers.
- Handoff applied in two of three passes; the failure was a merged `runtime.mjs` packet whose excerpt anchor had become non-unique after its predecessor's edit, the deferred excerpt check doing its job.

### Round 8: low-reasoning seam retry

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean-low-seam | context-calibration | 3 | 3/3 | 3/3 | 3.0 [2.7–3.4] | 2 [2–2] | 7747 [7747–7747] | 1085 [1053–1130] | 0.0014 [0.0014–0.0015] | 0 |
| lean-low-seam | dependency-handoff | 3 | 0/3 | 3/3 | 20.0 [18.9–20.9] | 14 [12–15] | 57313 [47895–62330] | 15513 [14181–16483] | 0.0269 [0.0231–0.0297] | 6 |
| lean-low-seam | lifecycle-extract | 3 | 1/3 | 2/3 | 30.3 [13.3–42.1] | 4 [4–4] | 30922 [26299–33356] | 7088 [3338–9695] | 0.0108 [0.0053–0.0159] | 3 |

- The second seam attempt ran on `deepseek/deepseek-flash:low` and recovered both seeds the first attempt had rejected (36.0 s and 27.7 s, 8,543 and 8,230 output tokens including reasoning). The `:off` retry had recovered two of nine over rounds 4–7. Two observations do not establish a rate, but they are the first seam retries that worked on structurally failed patches.
- Extraction still delivered only one of three. One pass lost on the delegate packet's JSON range anchor (non-unique twice); the other applied completely and then failed hidden grading because the rewire packet rebound the factory helpers to `readFileSync`/`writeFileSync`/`renameSync`/`Date.now` again, despite the requirement spelling the shorthand object and the name-fidelity sentence. That invented-binding error has now caused four of the extraction deliveries lost since round 1; it is a writer semantic error on an existing-file edit and no representation, seed or scheduling change touches it.
- Handoff applied three of three at 18.9–20.9 s.

### Round 9: recipe-fidelity gate, side by side with the reference

Both writers now reject a result that paraphrases code the recipe quotes verbatim: a backticked snippet introduced as insert/register/exact text must appear whitespace-normalized, and a brace list presented as an object to pass or inject, whose names already exist in the declared source, must appear as shorthand members rather than explicit bindings. Replayed over the 380 applied operations retained from rounds 1–8, the gate flags nothing in any delivered candidate and flags all four rebound factory objects and both dropped calibration registrations. This round ran the lean route and the unchanged reference profile alternately, three repeats each, on the same code and day.

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 3 | 3/3 | 3/3 | 3.0 [2.9–3.1] | 2 [2–2] | 7747 [7747–7747] | 1129 [1096–1161] | 0.0015 [0.0015–0.0015] | 0 |
| lean | dependency-handoff | 3 | 0/3 | 3/3 | 20.1 [16.3–26.5] | 14 [13–17] | 59078 [49570–75808] | 15741 [13079–20267] | 0.0257 [0.0217–0.0333] | 7 |
| lean | lifecycle-extract | 3 | 1/3 | 1/3 | 36.3 [33.5–38.3] | 3 [2–4] | 30655 [25711–33431] | 8573 [8125–9006] | 0.0111 [0.0104–0.0119] | 4 |
| reference-v4a | context-calibration | 3 | 3/3 | 3/3 | 3.8 [3.5–4.3] | 3 [3–4] | 9094 [7745–11791] | 1249 [1085–1455] | 0.0020 [0.0014–0.0031] | 1 |
| reference-v4a | dependency-handoff | 3 | 0/3 | 2/3 | 27.2 [22.0–33.5] | 13 [10–15] | 46176 [33558–54136] | 13393 [11656–15479] | 0.0222 [0.0173–0.0259] | 4 |
| reference-v4a | lifecycle-extract | 3 | 1/3 | 1/3 | 55.3 [40.8–64.1] | 5 [5–6] | 42989 [41599–44858] | 20112 [14358–23342] | 0.0318 [0.0240–0.0367] | 4 |

| Variant | Cells | Delivered | Applied | Writing s per 3-task pass | Calls | Context tokens | Output tokens | USD | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | 9 | 4/9 | 7/9 | 59.4 [54.0–67.9] | 20 [19–21] | 97480 [90748–109266] | 25443 [22796–30369] | 0.0384 [0.0340–0.0460] | 11 |
| reference-v4a | 9 | 4/9 | 6/9 | 86.3 [66.2–101.2] | 22 [18–24] | 98258 [82902–106739] | 34753 [27099–40027] | 0.0561 [0.0427–0.0641] | 9 |

- Delivery is equal at 4/9, with the lean route applying 7/9 against 6/9. The lean route wrote each three-task pass in 59.4 s against 86.3 s and emitted 25,443 output tokens against 34,753. Both routes delivered calibration 3/3, handoff 0/3, extraction 1/3.
- The fidelity gate did its job once: the rewire packet's second attempt rebound the factory helpers again and was rejected locally instead of reaching grading. The packet then had no attempts left, so the task failed to apply rather than failing hidden grading as the same error had done four times before. Its retry now escalates to the low-reasoning client when the first attempt failed fidelity (round 10).
- The low-reasoning seam retry recovered one of two rejected seeds (37.0 s, 8,125 output tokens, delivered) and missed the other on syntax. Across rounds 8–9 it has recovered three of four, where the `:off` retry recovered two of nine. Its cost is what moved the lean pass from 33.5 s and 17,900 output tokens in rounds 4–7 to 59.4 s and 25,400 here; delivery did not move (extraction 3/12 against 2/6).
- The reference profile's extraction cost 55 s and 20,000 output tokens per pass whether or not it delivered; its one delivery took 61 s and 22,635 tokens.

### Round 10: fidelity-triggered low-reasoning retry

When the JSON writer's first attempt fails the fidelity gate, its retry now goes to the low-reasoning client as well; other JSON retries stay on `:off`.

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 3 | 3/3 | 3/3 | 3.3 [2.9–4.2] | 2 [2–3] | 9212 [7747–12143] | 1320 [1094–1598] | 0.0018 [0.0015–0.0022] | 1 |
| lean | dependency-handoff | 3 | 0/3 | 2/3 | 24.4 [17.1–29.6] | 13 [12–15] | 53452 [44431–66848] | 15423 [12667–18857] | 0.0266 [0.0231–0.0329] | 5 |
| lean | lifecycle-extract | 3 | 3/3 | 3/3 | 22.9 [8.6–46.8] | 3 [3–4] | 24578 [19879–33976] | 5561 [1801–10907] | 0.0077 [0.0037–0.0138] | 1 |

- Every pass delivered 2/3: calibration 3/3 and extraction 3/3, the first time extraction delivered in every repeat under any route. Two of the three seam patches landed on the first attempt (9.4 s and 4.2 s, 1,800–4,000 output tokens for the task); the third needed the low-reasoning retry (38 s). The rewire packet produced the correct helper object on its first attempt in all three passes, so the escalation was not exercised.
- Handoff applied 2/3; the miss was a `replace` count mismatch on both attempts of the merged `runtime-imports` packet.
- Writing time per pass was 50.7 s [28.6–77.5] and output tokens 22,304 [15,562–31,362]; the spread is the seam retry.

### Round 11: six alternating repeats each, final code

| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lean | context-calibration | 6 | 6/6 | 6/6 | 3.5 [2.6–4.7] | 2 [2–3] | 8486 [7747–12179] | 1299 [1119–1612] | 0.0017 [0.0015–0.0023] | 1 |
| lean | dependency-handoff | 6 | 0/6 | 5/6 | 19.2 [14.1–23.7] | 14 [13–15] | 54442 [48393–63427] | 15060 [11782–17187] | 0.0246 [0.0184–0.0284] | 11 |
| lean | lifecycle-extract | 6 | 4/6 | 4/6 | 32.9 [7.9–67.2] | 4 [3–5] | 30313 [19879–40530] | 8181 [1680–17540] | 0.0110 [0.0023–0.0232] | 6 |
| reference-v4a | context-calibration | 6 | 5/6 | 5/6 | 3.8 [3.2–4.9] | 3 [3–4] | 8504 [7745–12296] | 1372 [1117–2066] | 0.0018 [0.0015–0.0029] | 1 |
| reference-v4a | dependency-handoff | 6 | 0/6 | 4/6 | 27.0 [19.1–35.4] | 14 [11–15] | 51121 [41944–56893] | 14695 [12095–18408] | 0.0245 [0.0205–0.0295] | 9 |
| reference-v4a | lifecycle-extract | 6 | 2/6 | 6/6 | 56.2 [53.0–62.1] | 5 [4–6] | 33093 [26710–44732] | 20729 [19861–22751] | 0.0284 [0.0251–0.0340] | 5 |

- Lean delivered 10/18 against 7/18, applied 15/18 against 15/18, and wrote a pass in 55.6 s against 87.0 s with 24,540 output tokens against 36,797. Extraction delivered 4/6 against 2/6; three of the four lean deliveries landed the seam patch on the first attempt (7.9–8.8 s, 1,680–1,892 output tokens for the task) and one needed the reasoning retry (59 s). Calibration delivered 6/6 against 5/6; the reference's miss was its first calibration application failure in 14 passes.
- The reference applied extraction 6/6 but delivered 2/6: four literal copies passed every local gate and failed hidden grading, the pattern the lean route's gates were built to surface locally. Lean's two extraction misses were both local application failures (no graded failure), one at 10 s and one at 44 s after a reasoning retry.
- Handoff: lean applied 5/6 at 19.2 s, reference 4/6 at 27.0 s; neither delivered, as in every round.

### Fresh planning run: Sol re-plans, the lean route writes

To test whether the handoff failure belongs to the retained plan, the three tasks ran once through `iterate.mjs` with fresh Sol query planning from the retained run-11 owner briefs and `--dispatch-profile optimized-lean`. This is the stacked approach end to end minus the owner stage, with new planner calls; it is a single observation per task.

| Task | Delivered | Applied | Planning s | Writing s | Process s | Calls | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Calibration | yes | yes | 22.6 | 3.7 | 26.9 | 4 | 2,845 |
| Handoff | no | yes (13/13) | 115.6 | 20.7 | 207.6 | 16 | 22,069 |
| Extraction | yes | yes | 28.6 | 51.2 | 135.0 | 5 | 12,886 |

- Delivery is 2/3, the same as run 18 and the briefing's revised stack, with the writing stage at 75.6 s across the three tasks against run 18's 47.9 s JSON baseline that delivered 1/3 and the revised stack's 96.2 s. Planning took 166.8 s, more than twice the writing.
- Handoff applied every packet of a new 22-assignment plan (consolidated to 13) in 20.7 s and failed two of the same three hidden tests the retained plan failed in all 16 final-code cells: the step-13 owner prompt listing an accepted step 1 despite eleven newer runs, and worker receipts never making unsealed or conflicting dependencies accepted. A different plan from the same brief reproduces the failure, so it sits in the owner brief or in how both roles read the specification's acceptance precedence, upstream of anything the writer boundary controls. The retained brief restates those rules correctly in prose; the miss is in the implementation the plan derives from it.
- Extraction's seam patch failed syntax once and the low-reasoning retry recovered it in 43 s. Sol's new plan again put the exported `environmentFacts` inside a factory excerpt, so the recipe-ordered seed did its job.

### Full end-to-end run: fresh owner briefs, fresh Sol plans, lean writers

One pass of the complete stack with no retained artifacts: DeepSeek owner discovery and brief, Sol query planning with catalog lookup, lean writing. Single observation per task.

| Task | Delivered | Owner brief s | Planning s | Writing s | Process s | Calls | Stopped at |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Calibration | yes | 23.8 | 24.5 | 5.2 | 54.1 | 10 | delivered |
| Handoff | no | 130.4 | 25.7 | not reached | 159.7 | 50 | planner request exceeded the 160 KiB bound after the source lookup ("needs discovery") |
| Extraction | no | 111.4 | 5.5 | not reached | 144.4 | 34 | planner returned `blocked`: the fresh brief left `assertWaveLease` neither exported nor injected, and the role forbids inventing that decision |

- Neither failing task reached a writer. Handoff stopped at the planning interface bound the earlier study documented as "needs discovery", and extraction stopped on an incomplete fresh owner brief that the planner correctly refused to complete on its own. Both are owner and planner stage outcomes; the writer route had no part in them. This is why the briefing's comparison and every replay round here reuse retained briefs and plans: the writing stage can only be measured when the stages before it hold still.
- Where the writer did run (calibration), the whole stack delivered in 54 s, with 5.2 s of writing.

### Planner-stage work: owner revision, role tightening, and three more end-to-end runs

After the writer-stage result, scope was extended to the planning stages. Changes (commit `855c7e7` and after): the owner role writes the settled brief only and states every data shape and code-level recipe as literal code; the planner role carries that detail into packets verbatim and lists compose copies in finished-file order; when Sol returns a blocked result, the owner that wrote the brief settles the missing decision in its retained context and planning restarts, up to three times; the catalog no longer treats a test-relative spelling of an existing file as an ambiguous basename; the lookup-mode request cap is 256 KiB.

| Run | Calibration | Handoff | Extraction | Process s |
| --- | --- | --- | --- | ---: |
| e2e2 (roles tightened, cap raised) | no: planner blocked on a test-harness conflict in the brief | no: catalog refused an ambiguous basename | no: planner blocked on an unsettled import list | 272 |
| e2e3 (one owner revision, catalog fix) | hidden passed after one revision, 88 s | no: blocked again after one revision | no: seam patch dropped a copied line after a revision; 279 s | 519 |
| e2e4 (two owner revisions) | hidden passed, 86 s | no: blocked a third time after two revisions, each on a different unsettled detail | no: both seam attempts failed matching; 333 s | 604 |

- The owner revision loop works as a mechanism: every calibration cell that Sol blocked was settled by the owner and then applied and passed hidden grading. On handoff it does not converge: each revision closes the one gap Sol named and Sol finds the next (a numeric card field, the continuation block's position, how unreadable wave files enter coverage gaps). The fresh DeepSeek brief is not settled enough for Sol's standard, and Sol correctly refuses to design.
- Fresh plans also change the move shape. Two of the three extraction plans converted the lifecycle methods into exported functions rather than a returned object, which the seed and seam approach handles worse (a 97 s low-reasoning retry still failed matching), and one dropped a copied line after a header rewrite that the integrity gate now tolerates.
- Planning now dominates every task: owner 25–152 s plus Sol 29–101 s, against a writing stage of 6–114 s.

### Against Sol alone

The native Sol agent reference run that the whole study replays from delivers all three tasks:

| Route | Delivered | Process s (3 tasks) | Calls | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| Native Sol agent (reference run) | 3/3 | 475 | 28 | 12,994 |
| Sol-only boundary-review changeset (runs 06, 07, earlier study) | 3/3, twice | 320–340 | | |
| Stack end to end, lean writers (e2e1, e2e3, e2e4) | 1/3 each | 358, 519, 604 | 94, 75, 75 | |
| Stack with retained plans, lean writers (rounds 9–11) | 2/3 at best; handoff never | writing only: 55 | 20 | 24,207 |

The stacked approach, in any configuration measured here, is neither faster nor more reliable than Sol working alone on these three tasks. Its writing stage is now cheap and well gated, but it only receives what two planning roles hand it, and the owner-to-planner handoff is where delivery is lost. What the stack does change is which model does the writing: Sol's work stops at the plan, and the writing runs on DeepSeek. Whether that is worth a lower delivery rate is a subscription-economics question the briefing raised and this study cannot answer.

### Sol's usage per configuration, and which role should own the write planning

The question that matters on a subscription is how much of Sol's work on a hard step can move to DeepSeek without losing delivery. Sol's own calls and tokens per three-task pass, from receipts, for every configuration measured (per-task marks are calibration, handoff, extraction in cell order; native Sol's cells sort as handoff, calibration, extraction):

| Configuration | Delivered | Per task (cal, handoff, extract) | Process s | Sol calls | Sol input | Sol output | DeepSeek calls | DeepSeek output |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native Sol agent (reference) | 3/3 | ✓245 ✓23 ✓207 | 475 | 28 | 501,720 | 12,994 | 0 | 0 |
| Sol-only changeset, checked ranges (Sol writes edits) | 3/3 | ✓18 ✓216 ✓92 | 327 | 13 | 191,962 | 10,072 | 0 | 0 |
| Sol-only changeset, boundary review (Sol writes edits) | 3/3 | ✓24 ✓203 ✓93 | 320 | 16 | 309,834 | 12,180 | 0 | 0 |
| DeepSeek brief (reused) + Sol plan + DeepSeek JSON writers (run 18) | 2/3 | ✓25 ✗177 ✓130 | 332 | 5 | 95,927 | 9,345 | 28 | 31,517 |
| DeepSeek owner + Sol plan + lean writers (e2e1) | 1/3 | ✓54 ✗160 ✗144 | 358 | 3 | 59,167 | 1,920 | 91 | 34,411 |
| … with owner revision (e2e3) | 1/3 | ✓88 ✗152 ✗279 | 519 | 10 | 193,613 | 6,779 | 65 | 78,149 |
| … two revisions (e2e4) | 1/3 | ✓86 ✗185 ✗333 | 603 | 13 | 302,747 | 10,428 | 62 | 92,298 |
| Sol owner brief + Sol plan + lean writers (e2e5) | 1/3 | ✓59 ✗354 ✗143 | 555 | 18 | 297,891 | 24,465 | 18 | 26,186 |
| Single Sol discovery planner + lean writers (e2e6) | 1/3 | ✓24 ✗233 ✗90 | 347 | 11 | 182,567 | 15,115 | 11 | 19,281 |
| … (e2e7) | 2/3 | ✓19 ✗231 ✓176 | 426 | 10 | 155,136 | 11,966 | 20 | 43,710 |
| … anchor disambiguation (e2e8) | 1/3 | ✓21 ✗324 ✗194 | 539 | 11 | 205,367 | 16,850 | 23 | 53,341 |

Changes made for these runs (commits `855c7e7` through `615c7ce`): the entry point takes `spec_dispatch`'s role names (`--strong-owner-model` for the planner and hard-step owner, `--owner-model`, `--editor-model`) and records them as `spec_roles`; an explicit owner model gets its own client; a planner that reports a missing owner decision gets the owner's revision up to three times; the lean profile runs on `focused-dispatch`, where one Sol discovery agent plans the writer packets directly; ambiguous-anchor errors name every match and its following text; an excerpt anchor that an earlier packet made ambiguous resolves from the original file's context; the catalog ignores a test-relative spelling that normalizes to a missing path; the lookup request cap is 256 KiB.

What the table shows:

- **Sol alone is the quality ceiling and not the cost ceiling.** The native agent delivers 3/3 at 28 calls and 502,000 input tokens. The Sol-only changeset routes also deliver 3/3 and use 38 to 62 percent of that input, because Sol plans once with catalog context instead of reading turn by turn. Nothing that moves work to DeepSeek has delivered handoff.
- **Two roles are the expensive way to use Sol.** Sol owner brief plus Sol planner used 18 calls and 298,000 input tokens for 1/3; a DeepSeek owner with Sol planning the writes used up to 13 Sol calls and 303,000 tokens once revisions were allowed, also 1/3. The brief-to-plan handoff both loses delivery and makes Sol re-plan.
- **One Sol agent that owns the step and plans the writes is the efficient shape.** Over three single-agent runs Sol used 7 to 11 calls and 155,000 to 205,000 input tokens per pass, a third to 40 percent of native, delivered calibration every time and extraction once (Sol planned it as five incremental moves; DeepSeek wrote it in 42 s), and applied handoff completely once. Its remaining losses were writer-stage: two JSON attempts malformed on one packet, a seam patch dropped copied imports and was recovered by the low-reasoning retry, and three of nine single-agent cells lost a packet to writer errors that the gates caught locally.
- **Handoff is a feedback problem, not a planning problem.** In the run where all eleven handoff packets applied, hidden grading failed the same three tests that fail under every configuration. Native Sol passes them because it runs tests and iterates; the briefing's design forbids feeding a behavioral failure back to any role, and the Sol-only routes that delivered handoff had a repair round. On this evidence the stacked approach cannot deliver handoff without one bounded repair round at the planner, which is a design change the briefing deferred rather than a tuning question.

For integration this maps directly onto `spec_dispatch`: for a hard step the strong owner model is one Sol agent that owns the step and plans the writes (`focused-dispatch`), and the editor model writes through the lean route; for other steps the owner model is DeepSeek, and whether Sol should plan those writes at all is untested here because every task in this study is the hard class. The owner-brief-plus-separate-planner shape should not be carried into integration.

### The relevant pass criterion: writer-attributable outcome on a fixed plan

Hidden-test delivery measures the whole stack, and a review or repair round can rescue any route, so it cannot score the writing stage. The criterion that matches this work is writer-attributable: on an identical plan, did the writers implement what the planner asked, at what cost? The ceiling is the same plan written by Sol. The study's Sol writer controls on the run18 plan delivered 2/3 twice (handoff fails with Sol writing too), so 2/3 is what that plan allows, and anything below it is the writers' loss.

| Configuration | Plan | Delivered | Process s | Writing s | Sol calls | Sol input | Sol output | DeepSeek calls | DeepSeek input | DeepSeek output |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Native Sol agent | agent edits | 3/3 | 475 | | 28 | 501,720 | 12,994 | | | |
| Sol-only changeset, checked ranges | Sol, fresh | 3/3 | 327 | | 13 | 191,962 | 10,072 | | | |
| Sol writer control 1 | run18, fixed | 2/3 | 235 | 102 | 26 | 88,583 | 13,724 | | | |
| Sol writer control 2 | run18, fixed | 2/3 | 240 | 108 | 26 | 76,636 | 13,846 | | | |
| DeepSeek JSON writers (run 18) | run18 | 2/3 | 332 | 74 | 5 | 95,927 | 9,345 | 28 | 105,211 | 31,517 |
| DeepSeek V4A reference (rounds 9, 11) | run18, fixed | 2/3, 1/3 | | 91, 92 | | | | 20, 19 | 54,830, 40,479 | 37,134, 36,516 |
| DeepSeek lean (round 10, three passes) | run18, fixed | 2/3, 2/3, 2/3 | | 77, 46, 29 | | | | 22, 17, 17 | 36,295, 23,033, 30,880 | 31,362, 19,989, 15,562 |
| DeepSeek lean (round 11, passes 3 and 4) | run18, fixed | 2/3, 2/3 | | 29, 31 | | | | 18, 19 | 20,035, 23,502 | 16,722, 18,691 |
| Single Sol planner + lean writers (e2e6–8) | Sol, fresh | 1/3, 2/3, 1/3 | 347–539 | 57–164 | 10–11 | 155,000–205,000 | 12,000–17,000 | 11–23 | 32,000–96,000 | 19,000–53,000 |
| Sol brief + Sol plan + lean writers (e2e5) | Sol, fresh | 1/3 | 555 | 68 | 18 | 297,891 | 24,465 | 18 | 83,699 | 26,186 |
| DeepSeek brief + Sol plan + lean writers (e2e4) | Sol, fresh | 1/3 | 603 | 119 | 13 | 302,747 | 10,428 | 62 | 178,436 | 92,298 |

On the fixed plan the lean DeepSeek route reaches the Sol-writer ceiling in five of its last six passes, at 29–77 s of writing against Sol's 102–108 s, with 16,000–31,000 DeepSeek output tokens and no Sol usage; the previous V4A route reached it in one of two at 91 s and 37,000 tokens. That is the pass for the writing stage: equal to Sol writing the same packets, at about a third of the time, with local gates instead of a review step. Rows with a fresh Sol plan vary the plan as well as the writers, so their delivery is not a writer score; their useful number is Sol's usage.

### One planner repair round (e2e9)

`optimized-lean-repair` lets the planner alone see the diff and visible-check output once after a failed round and re-plan; writers still receive only packets and hidden grading stays outside every role. One single-agent run with it, fresh Sol plans:

| Task | Rounds | Outcome | Process s | Sol calls | Sol input |
| --- | ---: | --- | ---: | ---: | ---: |
| Calibration | 1 | delivered on visible and hidden checks | 23 | 2 | 25,000 |
| Handoff | 2 | first pass applied 8/11; the repair plan applied 8/8; hidden failures fell from four tests to two, and both acceptance-classification tests that fail under every other configuration passed | 446 | 9 | 273,054 |
| Extraction | 1 | first packet's anchor was not in the new file; the unchanged candidate passed the visible check, so no repair ran | 116 | 3 | 22,000 |

Whole run: 1/3 delivered, 585 s, Sol 14 calls and 320,591 input tokens, DeepSeek 21 calls and 25,133 output tokens. The extraction miss exposed that a visible check passing on an unchanged candidate must not suppress the repair round; the trigger now also fires on a failed application (`4de362c`).

A second run on the fixed trigger (e2e10) did not reproduce the handoff gain: the re-plan's anchors on the test file were ambiguous in both rounds, three packets never applied, and the same three hidden tests failed; extraction's repair round applied cleanly after a first-round seam failure but left the moved helpers in `runtime.mjs`, failing the module boundary check. Whole run: 1/3 delivered, 831 s, Sol 19 calls and 395,108 input tokens, DeepSeek 32 calls and 60,892 output tokens. Over two runs the repair round moved handoff's acceptance tests once, at Sol usage equal to or above native Sol's on that task. By the writer-attributable criterion both runs are planner observations; they say a planner-only repair round is not a reliable substitute for native Sol's iterate-on-tests loop, and it spends the Sol tokens the single-agent plan had saved.

## Conclusion and recommendation

Headline: on a fixed plan the lean DeepSeek writing route matches the Sol-writer ceiling (2/3, the most that plan allows) at about a third of Sol's writing time with no Sol usage, and beats the previous DeepSeek route on both time and tokens. Whole-stack delivery against native Sol (3/3) is a planner and feedback question: one Sol agent owning the step and planning the writes uses a third to 40 percent of native Sol's tokens, and handoff fails under every route for want of a test-feedback round the briefing's design excludes.

Final-code comparison, pooled: the lean route over rounds 9–11 (12 passes) and the reference profile over rounds 9 and 11 (9 passes), run alternately on the same code and days. Writing seconds and tokens are per three-task pass, mean with range.

| Route | Passes | Delivered | Applied | Writing s | Output tokens | Context tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Revised stack (`optimized-v4a`, briefing) | 1 | 2/3 | 3/3 | 96.2 | 40,418 | 90,881 |
| `optimized-v4a`, same-day re-runs (rounds 9, 11) | 9 | 11/27 | 21/27 | 86.7 [66.2–101.2] | 36,116 | 94,564 |
| `optimized-lean`, final code (rounds 9–11) | 12 | 20/36 | 30/36 | 55.3 [28.5–85.0] | 24,207 | 92,801 |
| `optimized-lean` with `:off` seam retry (rounds 4–7) | 12 | 13/36 | 26/36 | 33.5 [24.6–49.9] | 17,896 | 91,246 |

Per task, final code:

| Task | Reference delivered / applied (n=9) | Lean delivered / applied (n=12) | Reference writing s | Lean writing s | Reference output tokens | Lean output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Calibration | 8/9, 8/9 | 12/12, 12/12 | 3.8 | 3.3 | 1,331 | 1,262 |
| Handoff | 0/9, 6/9 | 0/12, 10/12 | 27.0 | 20.7 | 14,261 | 15,321 |
| Extraction | 3/9, 7/9 | 8/12, 8/12 | 55.9 | 31.3 [7.9–67.2] | 20,523 | 7,624 |

What the rounds establish:

- **Faster and fewer tokens.** The lean route writes a three-task pass in 36 percent less time than the same-day reference (55.3 s against 86.7 s) with 33 percent fewer output tokens (24,200 against 36,100), and 43 percent less time and 40 percent fewer tokens than the briefing's revised stack. Context tokens are flat because the same excerpts are sent; the static-first prompt order moves most of them into cache reads once a prompt repeats. The speed-first setting (`seam_retry_reasoning: 'off'`) writes a pass in 33.5 s with 17,900 output tokens.
- **Quality held and improved.** Delivery is 20/36 against 11/27 (56 against 41 percent), application 30/36 against 21/27. Calibration 12/12 against 8/9. Extraction 8/12 against 3/9. Handoff 0 under both, applied 10/12 against 6/9. The reference applied extraction 7/9 but delivered 3/9: four of its literal copies passed syntax and failed at runtime. Every lean extraction that applied also delivered.
- **Handoff is a planner-level control, not a writer-route outcome.** In all 16 applied handoff cells on the final code (10 lean, 6 reference) the same three hidden tests fail: nine prerequisites staying indexed under the detail budget, the step-13 owner prompt listing an accepted step 1 despite eleven newer runs, and worker receipts never making unsealed or conflicting dependencies accepted. A fourth, the incomplete-packet continuation test, fails in 3 of 10 lean and 3 of 6 reference cells. The set is identical across routes and across the briefing's own run, so it is a property of the retained plan and brief (the classification and detail-budget recipes), not of grouping, representation, seeding or scheduling. Changing it means new planner calls, which the replay design excludes so that writer routes stay comparable.
- **No silent misapply on the final code.** Two deterministic gates at the writer boundary make "applied" mean more: copied seed lines must survive, and code the recipe quotes verbatim must appear as written. Replayed over 380 applied operations from earlier rounds, neither flags a delivered candidate; together they catch the commented-out block, all four rebound factory objects and both dropped calibration registrations that had reached grading before. In 36 final-code lean cells, no applied extraction failed grading.
- **Where the gains came from.** Pruning sequencing-only dependency edges (handoff 35 s to about 20 s). Seeding moves so the writer patches seams instead of retyping 41,000 characters (the copy packet from 28 s and about 20,000 output tokens to 4–9 s and 1,000–1,900 on a first-attempt success, which happened in 7 of 12 final-code passes). Executable JSON for range edits on existing files. Jev off. Low reasoning only on the second attempt of a seeded seam patch or after a fidelity failure: across rounds 8–11 it was invoked 12 times and succeeded in 10 (9 of 11 seam retries, 1 of 1 fidelity retry on the rewire packet; the two misses were one seam syntax failure and one handoff count mismatch), at 7–41 s and roughly 8,000–15,000 output tokens each, where the `:off` retry had recovered 2 of 9 seam patches.
- **Not established.** Twelve lean passes and nine reference passes on three exposed development cases are not a general reliability estimate, and the per-cell outcomes are single observations of a stochastic writer. Snapshot scheduling works but stays optional. Handoff's behavioral failure reproduces with a fresh Sol plan from the same brief, and with a fresh owner brief the stack stops before writing on the planner's request bound (one observation each); extraction with a fresh brief stopped on an owner decision the planner refused to invent. Handoff is therefore not an outcome this optimization could change; it needs owner and planner work on the acceptance precedence and the planning request budget, which is a different experiment with its own planner calls.

Recommended default: `optimized-lean` as checked in (narrow hybrid routing, pruned edges, no advice, static-first prompts, eight wide, seeded moves with integrity and fidelity gates, `:low` on seam and fidelity retries). Use `seam_retry_reasoning: 'off'` when writing time matters more than extraction delivery; it keeps the speed and token gains at the reference's historical delivery rate.

Next, in order of expected value:

1. **Planner-emitted layout for moves.** The seed is correct by construction; the seam patch's first-attempt rate is about 60 percent and the recovery costs 30–60 s. A packet field saying which excerpt goes inside which wrapper would turn most seam work into deterministic wrapping. This changes the packet contract and belongs with the planner.
2. **Handoff's test-file chain.** Three sequential appends to one test file are the critical path (7–12 s each). Concurrent append-only packets composed deterministically would cut handoff to about 12 s, but need the planner to declare appends.
3. **A second workload before integration.** The harness makes a 12-pass side-by-side cost about $0.55 and 75 minutes. Run lean and reference alternately on a workload with a different move shape before any `spec-end-to-end` change.

Evidence: `stacked-optimization/round1` through `round11`, `plan1-lean`, `e2e1-lean` through `e2e5-sol-owner`, `e2e6-single-sol` through `e2e8-single-sol`, `e2e9-single-sol-repair` and `e2e10-single-sol-repair` under the runtime base, each with `results.md`, `results.json` and per-cell `requests.jsonl`, `responses.jsonl`, `receipts.jsonl`, `writer-attempts.json`, `candidate.json` and `result.json`. Code: branch `spec-changeset-execution-poc`, commits `9309aec`, `437badc`, `ad556d7`, `2e3d455`, `a0e0fbc`, `bdca5bb`, `855c7e7` and the revision-count follow-up; options documented in `scripts/changeset-study/COMBINED-DISPATCH.md`. The shared ledger moved from $4.98 to about $7.22 across all rounds; the fresh-planning and end-to-end runs' Sol calls are subscription usage outside the ledger's catalog pricing.
