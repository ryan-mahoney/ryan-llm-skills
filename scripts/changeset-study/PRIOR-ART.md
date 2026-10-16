# Prior art and reusable components

The individual ideas already exist. The research opportunity is their integration:
compile a settled specification into dependent edits, choose deterministic or model
execution, carry current file state forward, and validate the resulting behavior.
Existing work does not establish that this particular combination is faster on
ordinary coding tasks; that requires the matched study.

| Component | Existing work | Relationship to this approach |
|---|---|---|
| Separate reasoning from editing | [Aider architect/editor mode, September 2024](https://aider.chat/2024/09/26/architect.html) | An architect describes a solution; an editor turns it into applicable edits. Aider explicitly motivated this with strong reasoning models that struggled with edit formatting, and compared pairings against solo baselines. It also tested a model paired with itself. |
| Specialized edit application | [Cursor / Fireworks Fast Apply case study](https://fireworks.ai/case-study/cursor) | A specialized model and speculative decoding accelerate application of generated changes. This targets the application stage, not the whole discovery-to-acceptance workflow. |
| Available edit-application service | [Morph Fast Apply](https://www.morphllm.com/products/fastapply) | Accepts partial edit snippets and merges them into existing files, including batched multi-file use. Its published speed and accuracy numbers are vendor claims, not measurements from this study. |
| Compile and schedule model work | [LLMCompiler, ICML 2024](https://arxiv.org/abs/2312.04511) | A planner, task dispatcher and parallel executor replace sequential reasoning-and-action overhead for tool calls. This is close architectural prior art, although its reported task results cannot be transferred to source-code editing. |
| Stage filesystem transformations | [Angular DevKit Schematics](https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/schematics/README.md) | A Tree represents the initial filesystem plus staged changes. Rules compose transformations; disk application waits until the changes are ready. This is a particularly close reusable foundation for the proposed in-memory workspace. |
| Maintain mutable source in memory | [ts-morph filesystem support](https://ts-morph.com/setup/file-system), [deferred saves](https://ts-morph.com/manipulation/) | Provides an in-memory filesystem and TypeScript source manipulation, with changes saved later. Useful where semantic operations should replace textual edits. |
| Represent and compose changesets | [CodeMirror ChangeSet](https://codemirror.net/docs/ref/#state.ChangeSet), [system guide](https://codemirror.net/docs/guide/) | Change objects can be composed and positions mapped through other changes. These are document-level primitives, not a semantic dependency scheduler for repository edits. |
| Exchange versioned multi-file edits | [LSP WorkspaceEdit](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/types/workspaceEdit.md) | A standard representation for edits across documents and resource operations. Version information helps identify stale edits. It does not decide whether the resulting program satisfies a specification. |
| Execute deterministic structural changes | [jscodeshift](https://github.com/facebook/jscodeshift) | Runs codemods over JavaScript/TypeScript files using AST transformations. A planner can select or parameterize a codemod instead of asking a model to rewrite each file. |

The hypothesis that this work was abandoned because models became better editors is
not supported by these sources. Architect/editor separation was implemented, and edit
application services and changeset libraries remain documented. Several of the most
useful primitives come from editors and code-migration tools rather than LLM libraries.

## What this experiment adds

The current runtime combines dependency declarations, current staged context,
deterministic operations, concurrent one-shot editors and bounded batch repair.
The study compares that combination with a native tool-using agent under identical
model selection and external acceptance checks. Neither the component list nor a
successful demonstration establishes novelty or a general performance advantage.

## Evaluation precedents

Executable validation of task environments and reference solutions is established
practice in [SWE-bench's evaluation harness](https://www.swebench.com/SWE-bench/reference/harness/)
and [SWE-smith's validation workflow](https://swesmith.com/guides/harnesses/).
Their datasets offer a route to broader replication after this small corpus, but
this study does not claim a SWE-bench score or equivalent repository coverage.

Sources checked on 2026-10-16. Links document the components; no third-party benchmark
number is included in the study's own performance results.
