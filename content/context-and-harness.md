# Context and Harness: PRINCE and Spec-Driven Development Reach the Same Answer

Bayer's toxicologists ask a chatbot whether a compound produced piloerection, ataxia, and loose faeces in study T123456-2. A coding workflow turns a reviewed spec into a sequence of committed diffs, one per step. Different problems, different users, no shared code. Both teams landed on the same two-part definition of what makes an LLM system reliable.

Sarang Kulkarni's writeup of PRINCE, Bayer's preclinical knowledge engine, names them directly: "Reliability comes from engineering both the context the model sees and the harness within which the model acts" ([Kulkarni 2026](https://martinfowler.com/articles/reliable-llm-bayer.html)). Our spec-driven skill suite was built without reference to that article and arrives at the same split. The convergence is worth examining. So is the one place PRINCE is genuinely ahead.

## The two systems

PRINCE (Preclinical Information Center) answers natural-language questions over more than 18,000 preclinical studies. It evolved through three stages the Bayer team labels Search, Ask, and Do ([Vieira-Vieira et al. 2025](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1636809/full)). The current system is a LangGraph workflow: clarify intent, plan, retrieve through a hybrid retriever, reflect on whether the evidence is sufficient, then synthesize a cited answer. The retrieval path is specific. Five expanded query variants run in parallel, each blending semantic similarity and keyword search at a 0.7/0.3 weight, returning roughly twenty chunks that a `bge-reranker-large` cross-encoder narrows to seven. A second path translates questions to Athena SQL, permits only `SELECT`, caps results at fifty rows, and retries failed queries up to three times.

The spec-driven workflow solves a different problem: produce correct code from a reviewed specification. Each feature's explicit artifacts live together under `.specs/<feature>/`: proposal, critique, spec, prepared plans, manifest, learnings, and reviews. An architect proposes; critics stress-test; a writer commits to numbered steps; preparation code-grounds the spec, derives prose guardrails, and plans each step; a runner consumes those immutable plans one commit at a time; one final branch loop reviews and fixes the integrated result. Every stage exchanges explicit files. Nothing depends on hidden in-memory state between stages.

Hold those two descriptions side by side and the shared architecture appears.

## Context engineering, line by line

Kulkarni's first discipline is deciding what each agent sees. PRINCE gives its planning stage planning context, its researcher retrieval context, its reflection agent the evidence, its writer the synthesis material. Larger context windows did not remove the need to be selective; they made selectivity a design decision instead of a constraint.

The spec workflow makes the same decision at three points, and at one of them it is stricter than PRINCE.

First, rule selection. When the spec writer chooses which design and testing conventions apply, the instruction is to "select by relevance, not completeness" and to avoid padding the list because "irrelevant rules dilute the ones that matter." A backend spec usually selects nothing.

Second, step isolation. During preparation, each planning leaf reads only the files its assigned step names plus immediate neighbors and test precedent. During execution, each implementation leaf receives the immutable prepared subspec, relevant prior learnings, prose guardrails, live invariants, and applicable rules. It does not re-survey or replan the repository because preparation already did.

Third, guardrails remain prose. Preparation may derive a statement such as "validation stays store-owned," but it never compiles that statement into a shell program or expected search-hit set. Implementers consume the property; focused behavioral verification remains in each prepared subspec. The final branch review applies the same bounded prose lens as one source of ordinary findings. PRINCE is selective about what context helps; the spec workflow is also selective about which intermediate form best supports agent reasoning.

## Harness engineering, line by line

The second discipline is the structure around the model: recovery, state, error handling, the loops that catch a bad result before it ships. Here the mapping is dense.

| PRINCE mechanism | Spec-workflow mechanism |
|---|---|
| LangGraph checkpointers persist state in PostgreSQL; resume from the failure point | Files are the checkpoints: a hash-bound preparation manifest, immutable subspecs, learnings, blockers, and per-iteration branch review/fix artifacts; each step is its own commit |
| Node-level retries re-run a workflow step | Prepared one-or-two-attempt step limits plus a bounded branch-refine loop; every cap is surfaced |
| Error context is fed back so an agent can "chart a different trajectory" | Learning files propagate discoveries forward; the branch loop computes a recurrence set and forces any returning bug to be fixed by "a genuinely different change" |
| LLM fallback across providers on failure | No failover. Instead, per-step `Complexity` tags route each step to an appropriately strong model, and `Visual` tags route to design-capable handling |
| Three reflection loops: process, data, draft | Process: architect, critics, sequential preparation. Data: code-grounded spec correction and preparation blockers. Draft: per-commit review, integrated branch review, and bounded guardrail findings |

The reflection comparison is the one to sit with. PRINCE runs three loops. A process loop in Think & Plan asks whether the agent is taking the right steps, a technique the team credits to [Anthropic's think tool](https://www.anthropic.com/engineering/claude-think-tool). A data loop in the Reflection Agent asks whether the retrieved evidence is sufficient and generates follow-up questions when it is not. A draft loop in the Writer checks the output for missing sections and inconsistent tables. The spec workflow has all three. It has them at design time, at evidence time, and at output time.

But it adds a constraint PRINCE never claims: the final reflector and fixer have separate ownership and communicate through an immutable review artifact.

## The firewall PRINCE doesn't have

PRINCE's loops are a model reflecting on its own work. That is the standard shape, and it catches real problems. The spec workflow refuses it.

Preparation derives guardrails before execution and binds them into the manifest. Execution cannot rewrite them or its subspecs to fit the code it produced. At the final boundary, `spec-branch-review` reports structured findings and never edits code; `spec-branch-fix` acts on that file and never rewrites the verdict; convergence is measured by a fresh review. The reviewer that hunts for bugs remains distinct from the fixer.

This is the design difference that matters. PRINCE asks the model to check itself and mostly trusts the answer. The spec workflow assumes a model grading its own work will rationalize, and it spends extra agents to prevent it. On verification rigor, the build-time system is ahead of the runtime one.

## Where PRINCE is ahead

One gap runs the other way, and it is real.

PRINCE knows whether it is getting better. It runs dataset evaluations against curated reference answers, scoring Faithfulness, Answer Relevancy, Context Relevancy, and Answer Accuracy. It runs daily batch evaluations on real production traffic through RAGAS. It traces every production request in Langfuse and tracks system health in CloudWatch. When PRINCE regresses, a number moves.

The spec workflow verifies each output and then forgets it. It prepares a package, executes focused contracts, refines the branch, and writes a clean report. It has no corpus of past specs with known-good outcomes, no metric tracked across runs, no signal that preparation has started over-planning or that one step type fails branch review more than others. Every run starts cold and is judged alone.

The mechanism PRINCE uses for this is out of scope for a workflow that runs once per feature under human supervision. Provider failover and live request tracing belong to a service answering unpredictable queries around the clock, not to a build-time pipeline. But aggregate evaluation is not out of scope, and the raw material already exists. Every preparation report, immutable subspec, branch review/fix artifact, and learning file is a labeled record of what the system caught and what it missed. Nothing harvests them. PRINCE built that harvester first because a production chatbot fails loudly and a code workflow fails into a passing test suite.

## Runtime and build time

Asking whether the spec workflow "fully achieves the aims" of the PRINCE article is the wrong question, because PRINCE's aims include things a code workflow should not want. PRINCE serves open-ended natural language to thousands of users; its input is a toxicologist's free-text question. The spec workflow serves a reviewed, frozen specification to a subagent; its input was already stress-tested by an architect and a critic before a single line was written. A constrained input needs a different harness than an unconstrained one.

What survives the domain change is the thesis. Reliability is two disciplines: control the context, build the harness. Bayer proved it on a RAG system grounding 18,000 studies. The spec workflow proves it on a code generator that turns prose into commits. Neither one is a better model or a cleverer prompt. Both are engineering around the model, in the same two directions, and the agreement is the evidence.

The one thing left to borrow is the scoreboard.

---

## References

- Kulkarni, Sarang Sanjay. ["Building Reliable Agentic AI Systems."](https://martinfowler.com/articles/reliable-llm-bayer.html) martinfowler.com, 16 June 2026.
- Vieira-Vieira, C. H., Kulkarni, S. S., Zalewski, A., Löffler, J., Münch, J., & Kreuchwig, A. ["From data silos to insights: the PRINCE multi-agent knowledge engine for preclinical drug development."](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1636809/full) *Frontiers in Artificial Intelligence*, Vol. 8, 19 August 2025.
- Subramaniam, Bharani, & Fowler, Martin. ["Emerging Patterns in Building GenAI Products."](https://martinfowler.com/articles/gen-ai-patterns/) martinfowler.com.
- Anthropic. ["The 'think' tool: Enabling Claude to stop and think in complex tool use situations."](https://www.anthropic.com/engineering/claude-think-tool)
