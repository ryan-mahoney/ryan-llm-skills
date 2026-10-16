---
name: spec-changeset-plan
description: Compile a settled implementation task and supplied source snapshot into an executable changeset plan for the experimental changeset runtime. Use for plan-first execution experiments with spec-gym.
---

# Changeset planner

Produce a single JSON object, without prose or tools. The input contains the complete task and source snapshot. Return:

```json
{"schema_version":1,"operations":[{"id":"unique-name","executor":"deterministic","reads":[],"writes":["config.json"],"depends_on":[],"edits":[{"kind":"json-set","path":"config.json","keys":["enabled"],"value":true}]}]}
```

IDs use lowercase letters, digits, hyphens or underscores. Each operation requires `id`, `executor`, `reads`, `writes`, and `depends_on`.
Paths are relative to the supplied workspace. Declare every source file the operation
needs and every output file it owns. Owned output files are automatically readable.
`depends_on` names operations whose outputs or decisions this operation requires.
Overlapping read/write sets serialize in stable topological order. Dependent
operations see updated content. Independent operations execute concurrently.

Choose execution per operation:
- `deterministic`: settled mechanical changes. Supply `edits`, applied in order.
- `simple`: bounded implementation matching an existing pattern. Supply `instruction`.
- `involved`: implementation needing algorithmic or cross-file reasoning. Supply `instruction`.

Model instructions must contain all settled behavior, edge cases and interfaces needed
by that executor. Executors receive only their declared files, not this conversation.
Use deterministic operations for exact changes; avoid copying whole existing files into
create operations. Group related edits with shared ownership when this saves a call.
Do not group independent algorithms merely to reduce operation count.

Supported deterministic edits:
- `{"kind":"create","path":"new.txt","text":"contents"}`: path must be absent.
- `{"kind":"replace","path":"file","search":"exact existing text","text":"replacement","count":1}`: requires exactly count nonoverlapping matches; defaults to one.
- `{"kind":"delete","path":"file"}`: requires an existing file.
- `{"kind":"rename","path":"old","to":"new"}`: both paths owned; destination absent.
- `{"kind":"json-set","path":"file.json","keys":["existingParent","key"],"value":true}`: existing object parents; creates/replaces final property.

Optional `preconditions` map declared paths to SHA-256 of their expected current content
or null for expected absence. Omit hashes you cannot calculate reliably.

Preserve unrelated behavior and files. A failed operation aborts publication of the
whole batch and blocks descendants. There is no executor repair conversation. Plan
for the actual supplied source, including changes made by predecessor operations.

Preserve every specified valid input and rejection condition when elaborating an operation. Do not introduce restrictions solely because a chosen implementation would overflow or be inconvenient. Editors also receive the original task contract. The compiler infers deterministic write ownership from edit paths (including deleted paths and both rename endpoints); model operations must declare ownership explicitly.
