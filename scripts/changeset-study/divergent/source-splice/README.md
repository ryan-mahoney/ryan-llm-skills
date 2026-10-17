# Offline source splice prototype

This experimental prototype previews one deterministic splice into an existing staged file. The caller supplies an exact snapshot, declared read paths, owned write paths, a SHA-256 binding for the target and each copied source, and unique source and target anchors. It reuses the repository's `replace-range` transform and syntax validator; it does not add or modify the normal changeset runtime.

Target anchors use this rule: keep the complete `start_anchor`, replace everything after it up to but not including `end_anchor`, and keep the end anchor and remaining suffix. A `null` end anchor means replace through EOF. Source parts copy from the beginning of `start_anchor` up to but not including `end_anchor`; `null` means copy through EOF. Literal parts are inserted as supplied. Anchor strings must be nonempty and occur exactly once in the bound file. Source and target ranges cannot be reversed or overlap their start anchor.

The target must exist in the supplied snapshot, be declared readable and writable, and match its supplied hash. Every source must exist, be declared readable, and match its own supplied hash. The candidate is built privately and checked before return. JSON files are parsed, and `.mjs`/`.js` files receive Node module syntax checking; other file types receive no syntax check. Any failure throws before the input snapshot changes. The returned `preview` is a private candidate, not an applied workspace mutation.

This does not establish that a planner-selected range is semantically safe or that copied code is correct. It supports one target range per call and does not resolve dependencies, authorize edits from nearby context, apply candidates, or run project tests. It is an offline feasibility prototype, not a production implementation.

Run its focused contract tests from the repository root:

```sh
node --test scripts/changeset-study/divergent/source-splice/source-splice.test.mjs
```
