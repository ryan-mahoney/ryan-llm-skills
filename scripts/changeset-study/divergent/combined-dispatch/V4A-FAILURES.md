# Why seven V4A attempts failed

The retained combined-dispatch run contains six rejected V4A applications and one
applied patch rejected by syntax validation. None of these seven patches satisfies
the pinned applier's complete-line, forward-only source-matching contract. These
observations do not justify weakening path, ambiguity, overlap or atomicity guards.

Evidence base: `combined-dispatch/01-matched` relative to the changeset-execution-poc
spec runtime directory. Each cell retains `job.json`, `plan-0.json`,
`requests.jsonl`, `responses.jsonl` and `result.json`. Request reservation IDs join
responses to the operation and `writer_attempt:0`. Source positions below refer to
the actual staged source reconstructed from successful predecessor operations;
independent operations own different destinations. No retained artifact was edited.

| Cell / operation | Observed rejection | Source evidence |
| --- | --- | --- |
| Calibration / `factor-calibration` | Second chunk searches backward. | First chunk matches policy.mjs lines215–216; second matches line104. Both source sequences exist, but their emitted order violates the forward cursor. |
| Handoff / `test-foundation` | Nested and duplicate patch envelopes. | Response contains five `Begin Patch` and six `End Patch` markers, including a final duplicate end. Internal envelope markers are invalid update lines. |
| Handoff / `runtime-imports` | Nested and duplicate patch envelopes. | Response contains three `Begin Patch` and four `End Patch` markers. This is not one strict patch. |
| Handoff / `runtime-target-config` | Third chunk supplies a partial source line. | Removal is a 283-character prefix of the 2232-character owner-prompt line978. A unique prefix is not a complete matching physical line. |
| Handoff / `test-wave-acceptance` | Removal is a partial anchor, with no edit. | Both removal and addition are `test('settled p`, a 15-character prefix of the 107-character staged line101. The packet's first excerpt ends at that partial anchor. |
| Handoff / `runtime-editor-outcome` | Third chunk omits part of a source line. | It expects a line beginning `  } catch`; staged line1135 begins `  try { mkdirSync(editorLock); } catch`. The complete original line was present in the writer excerpt. |
| Extraction / `extract-lifecycle` | New-file text applies, then fails syntax. | Added module ends at line15 with `return { checkout, primary, observed_only: tr`. The provider returned `stop`, not an output-length stop. The syntax guard rejects it atomically. |

The two envelope failures are not bare-blank-line compatibility issues. Six JSON
fallbacks recovered local application; extraction's fallback failed a nonunique
source-range anchor, leaving the original source and blocking two dependents.
Even reordering calibration's chunks would not implement its full assignment: the
patch calls `calibrationFrom` without adding that helper.

The local [adapter contract](../v4a-suite/applier.mjs) preserves the pinned upstream [chunk traversal](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/apply-patch/src/file_update.rs)
advances through original source coordinates. Its [parser contract](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/apply-patch/src/parser.rs)
also requires chunks in source order and treats update content as complete lines.
The local adapter additionally rejects ambiguous matches and preserves original
line endings. Neither deliberate difference caused these seven failures.

The revised [context builder](../../v4a-context.mjs) selects complete physical source
lines, deduplicates overlapping selections and retains their full text within an
explicit 64,000 UTF-16-code-unit source bound. It does not use JSON body compaction.
The revised [writer instructions](../../v4a-editor.mjs) require exactly one envelope,
one owned file header, chunks in original source order and complete physical lines.
They explain that a source-range composition recipe must become literal complete
V4A file content; V4A has no implicit copy operation. These changes passed scoped
review; paid rerun results remain pending. The applier is unchanged.

Keep strict application and one bounded same-model JSON fallback. Do not guess
missing line tails, silently reorder chunks, extract arbitrary nested patches or
accept incomplete source. Mechanical application alone cannot establish semantic
completion; ordinary candidate and hidden checks remain separate.

Reservation IDs, in table order:

```text
eef74ec0-62c7-4604-bd21-c8f44ceb462d
557155a3-24e0-4356-8cf1-c931cdd9869c
41d423cc-46a3-463b-9cff-2c74d9eed50a
a46ca849-8266-4aed-9298-a11827f6db68
bcd65d36-47a0-477f-bf2a-d09a1a7e6e67
25e4603c-6dd9-44f4-abda-ac1770a7e193
161ffe3c-ce2e-4418-bc52-6da1353e7610
```
