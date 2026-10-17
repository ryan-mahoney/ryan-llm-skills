# Experiment log

One line per experiment. Evidence paths are relative to the spec package's runtime base (see README). Commits are on `spec-changeset-execution-poc`.

## Earlier study (before 2026-10-17)

| Run | Configuration | Result | Evidence |
| --- | --- | --- | --- |
| sol-nemotron-workflow | Native Sol agent, three hard tasks | 3/3 delivered, 475 s, 28 Sol calls, 502k Sol input | `hard-nemotron-20261016/sol-nemotron-workflow` |
| sol-only 01–03 | Sol emits edits: patch editors, direct edits, source ranges | 1/3, 2/3, 2/3 | `sol-only-iterations/01..03` |
| sol-only 04, 05 | Sol emits checked ranges | 3/3 twice, 301–327 s, 13–14 Sol calls, 192–218k Sol input | `sol-only-iterations/04,05` |
| sol-only 06, 07 | Sol with boundary review | 3/3 twice, 320–340 s, 16–17 Sol calls | `sol-only-iterations/06,07` |
| dispatch-deepseek 11 | Fresh DeepSeek owner briefs, Sol planner, DeepSeek writers | 1/3 | `dispatch-deepseek/11-fresh-owner-briefs` |
| dispatch-deepseek 18 | Run-11 briefs reused, Sol smaller-regions plan, DeepSeek JSON writers | 2/3; the retained plan every replay uses | `dispatch-deepseek/18-smaller-regions` |
| sol-writer-controls 01, 02 | Sol writes the run18 packets | 2/3 twice, 102–108 s writing; the writer ceiling for that plan | `sol-writer-controls/01,02` |
| combined-dispatch 01 | Consolidation, Jev, V4A, JSON fallback, matched against JSON baseline | 1/3 each arm; combined applied 2/3 | `combined-dispatch/01-matched` |
| combined-dispatch 02 | V4A with complete-line context | 3/3 applied, 2/3 delivered, 96 s writing, 40k output tokens | `combined-dispatch/02-revised-combined` |
| v4a-suite | DeepSeek, MiMo, Muse generating V4A and JSON on synthetic edits | all qualified; no misapplies | `v4a-suite` |

## Optimization rounds, fixed run18 plan (2026-10-17)

| Round | What changed | Result | Commit |
| --- | --- | --- | --- |
| 1 | Reference V4A, JSON baseline, lean variants (no Jev, pruned edges, static-first prompts, V4A/hybrid/JSON routing) | all 1/3; hybrid handoff 15.6 s with 0 fallbacks; reference re-run 1/3 not 2/3 | `9309aec` |
| 2 | Seeded moves; snapshot anti-dependencies; name-fidelity sentence | seeded extraction 9.6 s and 2,207 output tokens, delivered | `9309aec` |
| 3 | Narrow vs wide hybrid routing, two repeats | narrow kept; wide slower and less reliable | `9309aec` |
| 4–5 | Lean profile; lenient envelope; seam retry; seed layout note | seam patch failed on exported function inside wrapper | `437badc` |
| 6 | Recipe-ordered seed | that failure class gone; one silent misapply found (commented-out block) | `437badc` |
| 7 | Seed integrity gate | no silent misapply reaches grading | `437badc` |
| 8 | Low-reasoning seam retry | recovers structurally failed seams | `437badc` |
| 9 | Recipe-fidelity gate; side by side with reference | 4/9 vs 4/9; lean 59 s vs 86 s | `ad556d7`, `2e3d455` |
| 10 | Fidelity-triggered low-reasoning retry | 6/9; extraction 3/3 | `2e3d455` |
| 11 | Six alternating repeats each | lean 10/18 vs reference 7/18; pooled 20/36 vs 11/27, 55 s vs 87 s, 24k vs 36k output | `a0e0fbc`, `bdca5bb` |

Evidence: `stacked-optimization/round1` … `round11`, each with `results.md`.

## End-to-end runs, fresh plans (2026-10-17)

| Run | Configuration | Result | Sol calls / input | Commit |
| --- | --- | --- | --- | --- |
| plan1-lean | Run-11 briefs, fresh Sol plan, lean writers | 2/3; handoff fails the same tests | 3 / 59k | `855c7e7` |
| e2e1 | Fresh DeepSeek brief, Sol plan, lean writers | 1/3; planner bound and blocked result | 3 / 59k | `855c7e7` |
| e2e2 | Tightened roles, 256 KiB cap | 0/3; blocked twice, ambiguous basename once | | `855c7e7` |
| e2e3, e2e4 | Owner revision on blocked plan (1, then 2) | 1/3 each; handoff blocked again each time | 10–13 / 194–303k | `855c7e7`, `81c5dd2` |
| e2e5 | Sol owner brief, Sol plan, lean writers | 1/3 | 18 / 298k | `2aaf7c3` |
| e2e6–e2e8 | Single Sol discovery planner, lean writers | 1/3, 2/3, 1/3 | 10–11 / 155–205k | `2aaf7c3`, `e071543` |
| e2e9, e2e10 | Single Sol planner plus one repair round | 1/3 each; handoff acceptance tests passed once | 14–19 / 320–395k | `25db95a`, `4de362c` |
| e2e11 | Single DeepSeek planner (`deepseek-flash:max`), lean writers | see OPEN-QUESTIONS | | `cf0a531` |

Evidence: `stacked-optimization/plan1-lean`, `e2e1-lean` … `e2e11-single-deepseek`.
