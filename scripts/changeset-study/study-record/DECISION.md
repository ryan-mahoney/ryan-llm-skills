# Decision: how the changeset executor integrates with spec-end-to-end

Decided 2026-10-17 after the optimization rounds and end-to-end runs in [stacked-optimization.md](stacked-optimization.md). Models are configuration; this fixes the shape.

## The approach

**The strong owner plans the writes for every step; the editor model writes them.**

1. One planner agent per step, with read-only discovery, emits the writer packet plan directly (the `focused-dispatch` planner role). No implementation brief, no separate query-planner role, no routing advice call.
2. Step ownership remains `owner_model` by default and `strong_owner_model` for a step `spec_dispatch` routes as hard. Write planning always uses `strong_owner_model`, including easy and medium steps where that model does not own the step. The study's entry point uses `--owner-model`, `--strong-owner-model`, and `--editor-model` and records them as `spec_roles`.
3. The runtime validates the plan, prunes dependency edges with no file overlap, pre-fills moved files from their declared excerpts, and dispatches to `editor_model` writers through the `optimized-lean` route: hybrid V4A/JSON representation, seed-integrity and recipe-fidelity gates, low-reasoning retry only after a seam or fidelity failure, eight writers wide.
4. The planner finishes at dispatch. Writers never see the specification, the owner or test output. Behavioral checks, review and fixes remain with the outer workflow.
5. If the planner cannot produce a valid plan after its one correction, return a checkpoint with the concrete failure. A smaller request can retry through the same pathway within the existing attempt budget. No owner or fixer implements directly as a fallback.
6. The planner repair round (`repair_rounds: 1`) is a flag, off by default.

## Why

- On a fixed plan, the lean DeepSeek writers match Sol writing the same packets (2/3, the plan's ceiling) in five of six passes, at 29–77 s of writing against Sol's 102–108 s, with 16,000–31,000 output tokens and no Sol usage. The writing stage is settled.
- One Sol agent planning the writes used 10–11 Sol calls and 155,000–205,000 input tokens per three hard tasks against native Sol's 28 and 502,000. Every two-role shape (a brief, then a separate planner) used more Sol and delivered less, because the brief-to-plan translation loses the owner's code-level detail.
- Routing advice (Jev) changed no decision in six requests.
- A planner-only repair round recovered handoff's acceptance tests in one of two runs at Sol usage equal to or above native, so it is not a reliable substitute for the outer workflow's review and fix stages.

## Not carried into integration

The `owner-query-writer` strategy (brief then planner), the owner brief revision loop, Jev in the writing path, and the catalog-lookup planner. They exist to serve the two-role shape and remain in the study for reference.

## Current policy for easy and medium steps

For now, `strong_owner_model` plans writes at every difficulty tier, including steps owned by `owner_model`. This resolves the integration policy without changing step ownership.

Two runs with DeepSeek planning hard steps delivered 0/3 and 1/3 at two to four times Sol's planning time. DeepSeek planning for easy and medium steps remains unmeasured. That research question does not block the current policy. See [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).
