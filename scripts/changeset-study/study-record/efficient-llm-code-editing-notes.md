# Efficient LLM Code Editing: Research Notes

Oct 16, 2026 · @Ryan Mahoney

When edits can be planned ahead, the research points to one pattern: plan once, emit all edits as a single batch of content-anchored changes, apply them atomically, and verify once at the end instead of per edit. Five ideas support this, and most fit a pre-planned workflow directly.

## 1. Separate planning from applying

Deciding what to change and writing the change into a file are different skills, and splitting them improves both accuracy and cost.

- **[Aider Architect/Editor](https://aider.chat/2024/09/26/architect.html).** One model works out the solution; a second turns it into concrete edit instructions. This split set the state of the art on aider's editing benchmark. DeepSeek R1 as architect plus Sonnet as editor scored 64.0% on the polyglot benchmark at about 14x lower cost than the earlier o1 record.
- **[Cursor fast apply](https://cursor.com/blog/instant-apply).** A frontier model plans in chat; a dedicated fine-tuned model applies the result. It beats GPT-4 and GPT-4o on the accuracy/latency tradeoff and runs at about 1000 tokens/s on a 70B model.
- **[CodePlan](https://www.microsoft.com/en-us/research/?p=970266) (Microsoft, 2023).** Closest to a pre-planned scenario. It frames repository-level coding as planning: a chain of edits, each an LLM call on one location with context from the repo and earlier changes. Ordering comes from incremental dependency analysis and change may-impact analysis, not the LLM. 5 of 6 repositories passed validity checks; unplanned baselines passed none.

## 2. Edit format matters, and the best choice depends on the model

For batches, use content-anchored formats and avoid line numbers: earlier edits shift later line positions, while content anchors fail loudly instead of misapplying.

| Format | Anchored by | Key finding |
| --- | --- | --- |
| Search/replace | Quoted code | Most effective format for larger models in [Diff-XYZ](https://liner.com/review/diffxyz-benchmark-for-evaluating-diff-understanding) (JetBrains, 2025); never misapplies silently |
| Unified diff (no line numbers) | Context lines | Raised GPT-4 Turbo from 20% to 61% on [aider's laziness benchmark](https://aider.chat/docs/unified-diffs.html); most robust on multi-hunk edits |
| Line ranges | Positions | Breaks when earlier edits shift lines |
| Whole function by name | Function name | Misapplied silently even unperturbed, due to duplicate names |

The silent-misapplication and multi-hunk findings come from a 2026 preprint, [Look Before You Leap: Pre-Action Verification for LLM Agents](https://arxiv.org/pdf/2609.11957). Unified diff holds up on multi-hunk edits because each hunk carries its own context, which patch validates independently. Aider's and Diff-XYZ's results disagree on which content-anchored format wins, so test both on your model.

## 3. Speculative decoding built for edits

Most of an edited file is unchanged, so an inference stack can copy it instead of generating it token by token. This mainly matters if you host the model yourself.

- **[EfficientEdit](https://arxiv.org/abs/2506.02780v1) (ASE 2025).** Targets regeneration of unchanged code (about 70% of the edited code was reused in its example) and the modest 2–3x gain of standard speculative decoding on edits.
- **[Blazedit](https://huggingface.co/blog/ganler/blazedit).** Combines a small draft model with prompt-lookup decoding; up to 7.7x faster whole-file editing.
- **[Cursor speculative edits](https://cursor.com/blog/instant-apply).** Its biggest speed win. Cursor notes it cannot add this to Anthropic's models, which is why it trained its own apply model.

## 4. Have the LLM write the transformation, not the edits

For edits that follow a pattern, this is likely the biggest win. Meta's [Don't Transform the Code, Code the Transforms](https://neurips.cc/virtual/2024/103628) (NeurIPS 2024 workshop) has the LLM write a code transformation from a few input/output examples. The transform is easy to inspect and debug, and running it costs a tiny fraction of an LLM rewrite.

Across 16 Python transformations, the generated transforms were perfectly precise on 7 and less imprecise than direct rewriting on the other 9. In practice: the model writes a libcst, jscodeshift, ast-grep, Comby or OpenRewrite script, and you run it once across the repo.

## 5. Edit structure, not text

[CodeStruct](https://preview.aclanthology.org/ingest-acl/2026.acl-long.607/) (ACL 2026) replaces string-matching edits with syntax-validated operations on named AST entities. On SWE-Bench Verified it raised Pass@1 by 1.2–5.0% and cut token use by 12–38% for most models. Weaker models gained most: GPT-5-nano's empty-patch failures fell from 46.6% to 7.2%.

## A practical recipe for pre-planned edits

Replace the per-edit read→modify→verify loop with one plan, one batch, one verification pass.

1. **Plan once, with ordering.** List every edit, sorted by dependency (definitions before call sites), as CodePlan does.
2. **Emit the whole batch in one generation.** Use content-anchored blocks (search/replace or line-number-free unified diff) across many files, not one tool round-trip per edit.
3. **Apply atomically with a dry run.** For example, `git apply --check`, then apply. Anchor-match failures act as free per-edit verification, so there's no need to read each file back after writing.
4. **Verify once at the end.** Run build, typecheck and tests; send only failures back to the model for a targeted repair pass.
5. **Route repetitive edits to a codemod**, and run independent files in parallel.
6. **If you control inference**, put a cheap apply model with speculative decoding behind the planner.

## Sources

- [Aider: Unified diffs make GPT-4 Turbo 3X less lazy](https://aider.chat/docs/unified-diffs.html)
- [Aider: Separating code reasoning and editing](https://aider.chat/2024/09/26/architect.html)
- [How AI frameworks control model thinking](https://dev.to/crabtalk/how-ai-frameworks-control-model-thinking-4fi)
- [Diff-XYZ: A Benchmark for Evaluating Diff Understanding](https://liner.com/review/diffxyz-benchmark-for-evaluating-diff-understanding)
- [Look Before You Leap: Pre-Action Verification for LLM Agents](https://arxiv.org/pdf/2609.11957)
- [CodePlan (Microsoft Research)](https://www.microsoft.com/en-us/research/?p=970266)
- [Cursor: Instant Apply](https://cursor.com/blog/instant-apply)
- [EfficientEdit (arXiv 2506.02780)](https://arxiv.org/abs/2506.02780v1)
- [Blazedit: Blazing-Fast Code Editing via Multi-Layer Speculation](https://huggingface.co/blog/ganler/blazedit)
- [Don't Transform the Code, Code the Transforms](https://neurips.cc/virtual/2024/103628)
- [CodeStruct: Code Agents over Structured Action Spaces](https://preview.aclanthology.org/ingest-acl/2026.acl-long.607/)
