# Batched Edits for Spec-Driven Development

Oct 16, 2026 · @Ryan Mahoney

Pre-planned spec execution maps onto a known agent pattern: plan without observations, run steps as a dependency DAG in waves of disjoint files, and apply each wave as one atomic multi-file patch. With GPT-6.1 Sol, OpenAI's apply\_patch tool and its V4A format handle the batching natively.

No published benchmark covers batched pre-planned edits in spec-driven workflows specifically. The evidence below comes from general agent research and practitioner tooling, so measure on your own specs.

## The research pattern: plan without observations, execute as a DAG

Two agent architectures match this setup closely, and both cut cost sharply against the usual act-observe loop.

| Approach | Idea | Reported gain |
| --- | --- | --- |
| [ReWOO](https://web3.arxiv.org/abs/2305.18323) | Plan every step up front instead of pausing after each tool call to read results | 64% fewer tokens on average; up to 5x token efficiency, accuracy kept or improved |
| [LLMCompiler](https://icml.cc/virtual/2024/poster/32829) | Planner emits a DAG of tasks; dependents use placeholders filled with earlier outputs; independent tasks run in parallel | Up to 3.7x lower latency, 6.7x lower cost, \~9% higher accuracy vs ReAct |

Mapped to spec-driven work: the spec's implementation steps are the plan, the edits are the tool calls, and the orchestrator is the executor. Most of the benefit arrives once the plan carries explicit dependencies.

## What spec-driven practitioners do

GitHub Spec Kit is the common reference point, and community tooling has converged on waves of tasks with disjoint file ownership.

- **Parallel markers.** Spec Kit's tasks template marks tasks touching different files as parallel \[P\]; tasks that share files stay sequential ([template notes](https://zenn.dev/seo/articles/b66b99f2560b0f)).
- **Defined failure behavior.** The implement step halts if a sequential task fails; for \[P\] tasks it continues with the successes and reports failures ([speckit-implement](https://www.vibeindex.ai/skills/dceoy/speckit-agent-skills/speckit-implement)).
- **Explicit dependency waves.** An open proposal notes the default tasks list carries no dependency metadata. It adds a "(depends on T001)" suffix and a wave schedule to tasks.md ([issue #1934](https://github.com/github/spec-kit/issues/1934)).
- **Disjoint file ownership.** The most repeated rule: parallel by default within a wave, disjoint file sets, and only the controller touches git ([subagent-driven-dev](https://claudskills.com/skills/subagent-driven-dev/SKILL.md)). Overlapping edits by two workers lose work ([orchestrator skill](https://skills.cat/skills/wyattowalsh/agents/orchestrator)).
- **Worktrees plus staged review.** \[P\] tasks go to sub-agents in their own worktrees, reviewed for spec compliance, then code quality ([fact-toolkit](https://pypi.org/project/fact-toolkit)).
- **Don't over-split.** One post-mortem found 4-way delegation one or two agents too fine; orchestrator status polling cost more tokens than the delegation saved ([delegation rules](https://gist.github.com/techygarg/f8f98a2f026538fad4a69b593a964d95)).

## The Sol-specific piece: apply\_patch with V4A

OpenAI's apply\_patch tool is the biggest practical lever: one V4A envelope can create, update, delete and rename files, and OpenAI trained its models on that grammar ([V4A explainer](https://codex.danielvaughan.com/2026/03/31/codex-cli-apply-patch-v4a-diff-format/)).

- **Built for multi-file work.** OpenAI positions it for refactors across many files at once; your harness interprets and applies the patch ([OpenAI docs](https://developers.openai.com/api/docs/guides/tools-apply-patch.md)).
- **Make the harness atomic.** One open-source implementation applies all hunks in memory and writes only after every file's final state is computed; any failed hunk rolls back the whole patch ([recursive-agent](https://docs.rs/recursive-agent/0.1.0/recursive/tools/apply_patch/)).
- **Fail loudly.** The same harness rejects a hunk whose pattern matches zero or several times, so mismatches never misapply silently.
- **Room for big batches.** [GPT-6.1 Sol](https://www.datacamp.com/pl/blog/gpt-6-1-sol) takes 1,050,000 input tokens and returns up to 128,000.

## Recommended orchestrator design

Plan intent ahead, generate patch text at execution time, and verify per wave rather than per edit.

1. **At planning time**, each step declares the files it owns, its dependencies, and edit intent with content anchors (function names, unique snippets). Don't pre-generate literal patch text: patches written against an earlier repo state go stale once earlier steps land. The plan needs no observations; the patch does.
2. **At execution time**, group steps into waves of disjoint file sets. Load each wave's owned files once and have Sol emit one V4A patch for the whole wave.
3. **Apply atomically** in your harness. An anchor mismatch serves as per-edit verification, so there's no read-back loop.
4. **Verify per wave.** Run typecheck and tests after each wave and send only failing tasks back for repair.
5. **Review per story.** A spec-compliance check per story, not per edit, catches drift without restoring the loop.

## Sources

- [ReWOO (arXiv)](https://web3.arxiv.org/abs/2305.18323)
- [ReWOO overview (alphaXiv)](https://alphaxiv.org/overview/2305.18323v1)
- [An LLM Compiler for Parallel Function Calling (paper)](https://arxiv.org/pdf/2312.04511)
- [LLMCompiler (ICML 2024)](https://icml.cc/virtual/2024/poster/32829)
- [Spec Kit tasks template notes (Zenn)](https://zenn.dev/seo/articles/b66b99f2560b0f)
- [speckit-implement skill](https://www.vibeindex.ai/skills/dceoy/speckit-agent-skills/speckit-implement)
- [Spec Kit issue #1934: task dependency declarations](https://github.com/github/spec-kit/issues/1934)
- [subagent-driven-dev skill](https://claudskills.com/skills/subagent-driven-dev/SKILL.md)
- [Orchestrator skill (skills.cat)](https://skills.cat/skills/wyattowalsh/agents/orchestrator)
- [fact-toolkit (PyPI)](https://pypi.org/project/fact-toolkit)
- [Subagent delegation rules (gist)](https://gist.github.com/techygarg/f8f98a2f026538fad4a69b593a964d95)
- [The V4A Diff Format](https://codex.danielvaughan.com/2026/03/31/codex-cli-apply-patch-v4a-diff-format/)
- [OpenAI: Apply Patch tool](https://developers.openai.com/api/docs/guides/tools-apply-patch.md)
- [apply\_patch module (recursive-agent)](https://docs.rs/recursive-agent/0.1.0/recursive/tools/apply_patch/)
- [GPT-6.1 Sol (DataCamp)](https://www.datacamp.com/pl/blog/gpt-6-1-sol)
