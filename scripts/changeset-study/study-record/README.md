# Changeset study: research record

Everything tried on batched, pre-planned file writes for the spec-driven process, where it was left, and what was decided. Code lives beside this folder in `scripts/changeset-study/` and `scripts/changeset/`.

| Read | For |
| --- | --- |
| [DECISION.md](DECISION.md) | The integration approach decided on 2026-10-17 and the evidence behind each line |
| [LOG.md](LOG.md) | Dated timeline of every experiment, result and evidence path |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Where work stopped, what each next experiment needs, and the commands to run it |
| [stacked-optimization.md](stacked-optimization.md) | The optimization rounds and end-to-end runs, with the usage tables |
| [stacked-interventions-1.md](stacked-interventions-1.md) | The briefing that started the optimization work |
| [RECOMMENDATIONS.md](RECOMMENDATIONS.md), [V4A-WRITER-SUITE.md](V4A-WRITER-SUITE.md), [ideas.md](ideas.md), [creative-ideas.md](creative-ideas.md) | Earlier proposals and idea notes |
| [EXPERIMENT-NOTES.md](EXPERIMENT-NOTES.md), [batched-edits-for-spec-driven-development.md](batched-edits-for-spec-driven-development.md), [efficient-llm-code-editing-notes.md](efficient-llm-code-editing-notes.md) | Experiment history and background reading |

Raw runtime artifacts (requests, responses, receipts, candidates, hidden grading) are too large for the repository. They live in the spec package's runtime base, which `node ~/.agents/scripts/spec-location/cli.mjs locate agent-tooling/changeset-execution-poc` resolves; paths in these documents written as `runtime/<...>` are relative to that base. Documents moved here from the adjacent research folder may still describe paths relative to that folder; the runtime base above is the one they mean.
