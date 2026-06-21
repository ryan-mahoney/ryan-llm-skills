# Context and Harness: PRINCE and Spec-Driven Development Reach the Same Answer

Bayer's toxicologists ask a chatbot whether a compound produced piloerection, ataxia, and loose faeces in study T123456-2. A coding workflow turns a reviewed spec into a sequence of committed diffs, one per step. Different problems, different users, no shared code. Both teams landed on the same two-part definition of what makes an LLM system reliable.

Sarang Kulkarni's writeup of PRINCE, Bayer's preclinical knowledge engine, names them directly: "Reliability comes from engineering both the context the model sees and the harness within which the model acts" ([Kulkarni 2026](https://martinfowler.com/articles/reliable-llm-bayer.html)). Our spec-driven skill suite was built without reference to that article and arrives at the same split. The convergence is worth examining. So is the one place PRINCE is genuinely ahead.

## The two systems

PRINCE (Preclinical Information Center) answers natural-language questions over more than 18,000 preclinical studies. It evolved through three stages the Bayer team labels Search, Ask, and Do ([Vieira-Vieira et al. 2025](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1636809/full)). The current system is a LangGraph workflow: clarify intent, plan, retrieve through a hybrid retriever, reflect on whether the evidence is sufficient, then synthesize a cited answer. The retrieval path is specific. Five expanded query variants run in parallel, each blending semantic similarity and keyword search at a 0.7/0.3 weight, returning roughly twenty chunks that a `bge-reranker-large` cross-encoder narrows to seven. A second path translates questions to Athena SQL, permits only `SELECT`, caps results at fifty rows, and retries failed queries up to three times.

The spec-driven workflow solves a different problem: produce correct code from a reviewed specification. It is a pipeline of skills over a single `.specs/<slug>/` folder. An architect proposes; critics stress-test; a writer commits to an implementation spec with numbered steps; a compiler turns that spec into a conformance checklist; a runner implements each step in its own subagent and its own commit; an auditor checks the result against the checklist; a remediator fixes what failed. Every stage reads and writes files. Nothing carries state in memory between stages.

Hold those two descriptions side by side and the shared architecture appears.

## Context engineering, line by line

Kulkarni's first discipline is deciding what each agent sees. PRINCE gives its planning stage planning context, its researcher retrieval context, its reflection agent the evidence, its writer the synthesis material. Larger context windows did not remove the need to be selective; they made selectivity a design decision instead of a constraint.

The spec workflow makes the same decision at three points, and at one of them it is stricter than PRINCE.

First, rule selection. When the spec writer chooses which design and testing conventions apply, the instruction is to "select by relevance, not completeness" and to avoid padding the list because "irrelevant rules dilute the ones that matter." A backend spec usually selects nothing.

Second, step isolation. Each implementation step runs in a fresh subagent that receives only its step text, a distilled set of facts from prior steps' learning files, the high-risk guardrails, and the paths of any applicable rules. The step's planning pass reads only the files that step names plus their immediate neighbors. It does not re-survey the repository, because the spec already did.

Third, and this is the sharp one: when the conformance checklist is injected into an implementer's prompt as a guardrail, the system passes the prose constraint and withholds the check. The criterion might be "validation stays store-owned," compiled to a concrete `rg` command with an expected hit set. The implementer sees the sentence. It never sees the grep. Handing over the check "invites letter-not-spirit evasion and destroys the audit's independence as verification." PRINCE is selective about what context helps. The spec workflow is also selective about what context would let the model cheat the test it will later face.

## Harness engineering, line by line

The second discipline is the structure around the model: recovery, state, error handling, the loops that catch a bad result before it ships. Here the mapping is dense.

| PRINCE mechanism | Spec-workflow mechanism |
|---|---|
| LangGraph checkpointers persist state in PostgreSQL; resume from the failure point | Files are the checkpoints: learning files, subspecs, `blockers.md`, per-iteration review and fix artifacts; each step is its own commit; the refine loop resumes "one past the highest existing artifacts" |
| Node-level retries re-run a workflow step | Bounded fix-up subagents: two attempts per step, three remediation rounds, ten refine iterations, every cap surfaced when hit |
| Error context is fed back so an agent can "chart a different trajectory" | Learning files propagate discoveries forward; the branch loop computes a recurrence set and forces any returning bug to be fixed by "a genuinely different change" |
| LLM fallback across providers on failure | No failover. Instead, per-step `Complexity` tags route each step to an appropriately strong model, and `Visual` tags route to design-capable handling |
| Three reflection loops: process, data, draft | Process: architect, critics, per-step self-planning. Data: spec review, `UNVERIFIABLE` routing, spec-defect escalation. Draft: step review, judge, audit, remediate |

The reflection comparison is the one to sit with. PRINCE runs three loops. A process loop in Think & Plan asks whether the agent is taking the right steps, a technique the team credits to [Anthropic's think tool](https://www.anthropic.com/engineering/claude-think-tool). A data loop in the Reflection Agent asks whether the retrieved evidence is sufficient and generates follow-up questions when it is not. A draft loop in the Writer checks the output for missing sections and inconsistent tables. The spec workflow has all three. It has them at design time, at evidence time, and at output time.

But it adds a constraint PRINCE never claims: the reflector and the fixer are different agents, and they cannot be the same context.

## The firewall PRINCE doesn't have

PRINCE's loops are a model reflecting on its own work. That is the standard shape, and it catches real problems. The spec workflow refuses it.

The conformance checklist is compiled blind. The compiler reads the spec, the proposal, the critique, and any precedent code the spec cites, and it is forbidden from reading the implementation it will judge. The reason is stated plainly: "an auditor that interprets the spec and judges the code in the same pass will harmonize them." Compile against the implementation and you compile the implementation's excuses.

The same split runs through the back half. The auditor reports violations and never edits code. The remediator fixes findings and never re-judges its own fixes; convergence is measured by re-running the independent audit. The per-step judge evaluates in a read-only subagent before any correction subagent touches the code. The reviewer that hunts for bugs is a different agent from the one that fixes them.

This is the design difference that matters. PRINCE asks the model to check itself and mostly trusts the answer. The spec workflow assumes a model grading its own work will rationalize, and it spends extra agents to prevent it. On verification rigor, the build-time system is ahead of the runtime one.

## Where PRINCE is ahead

One gap runs the other way, and it is real.

PRINCE knows whether it is getting better. It runs dataset evaluations against curated reference answers, scoring Faithfulness, Answer Relevancy, Context Relevancy, and Answer Accuracy. It runs daily batch evaluations on real production traffic through RAGAS. It traces every production request in Langfuse and tracks system health in CloudWatch. When PRINCE regresses, a number moves.

The spec workflow verifies each output exhaustively and then forgets it. It audits a branch, remediates it, and writes a clean report. It has no corpus of past specs with known-good outcomes, no metric tracked across runs, no signal that the criteria compiler has started over-compiling or that one step type fails review more than others. Every run starts cold and is judged alone.

The mechanism PRINCE uses for this is out of scope for a workflow that runs once per feature under human supervision. Provider failover and live request tracing belong to a service answering unpredictable queries around the clock, not to a build-time pipeline. But aggregate evaluation is not out of scope, and the raw material already exists. Every `audit.md`, every `remediation.md`, every branch review artifact and learning file is a labeled record of what the system caught and what it missed. Nothing harvests them. PRINCE built that harvester first because a production chatbot fails loudly and a code workflow fails into a passing test suite.

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
