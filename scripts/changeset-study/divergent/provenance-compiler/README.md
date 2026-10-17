# Provenance-bound compiler prototype

This isolated offline prototype tests a narrow hybrid plan shape: an ordinary DeepSeek writer assignment may carry an optional mechanical recipe. A recipe can only copy exact source spans or exact code spans from the settled owner brief. The recipe binds the full brief and every source file by SHA-256. Sol-style planning can choose references, ordering, and dependencies, but this compiler accepts no newly authored code text.

In `forced-delegation` mode, recipes are stripped and the original model assignment remains intact. In `hybrid` mode, the compiler activates a recipe only when its target is the operation's sole owned path, its inputs match their hashes, its brief spans lie inside fenced code, and (for an existing target) source-copy and deletion ranges account for every original target byte exactly once. The candidate is syntax-checked before it is returned. Ineligible recipes remain assigned to their original writer and include a reason in `decisions`. Input plans must contain only `simple` or `involved` writer assignments; any supplied `edits` field is rejected.

The returned `files` object is a private preview of activated recipes after local syntax preflight. To execute the returned plan, provide the original initial snapshot; do not apply the preview first, or the deterministic edits will run against already changed bytes. The prototype deliberately limits activation to operations with no predecessors and declines a recipe if another operation writes its target or bound source. It evaluates recipes against the initial snapshot; it does not simulate predecessor edits or infer that a span's provenance authorizes a semantic change. Consequently, the default remains forced delegation. Even an activated recipe is only provenance evidence, not proof that the requested change is correct. The caller must preserve the original plan graph and treat this as a research candidate, not a production executor.

The recipe's source and brief offsets are JavaScript string offsets (UTF-16 code units), as used by `slice`. A brief span must be inside a strict fenced block: fences use at most three leading spaces; a backtick opener's info string cannot contain a backtick; and a close uses the same marker, at least the opener's length, and trailing whitespace only. A minimal recipe has this shape:

```js
{
  version: 1,
  action: 'assemble',
  target: 'src/generated.mjs',
  brief_sha256: '<64 lowercase hex characters>',
  sources: [{ path: 'src/input.mjs', sha256: '<64 lowercase hex characters>' }],
  parts: [
    { kind: 'source', path: 'src/input.mjs', start: 0, end: 18 },
    { kind: 'brief', start: 240, end: 282 }
  ],
  deleted_ranges: []
}
```

Run the focused offline checks with `node --test scripts/changeset-study/divergent/provenance-compiler/compiler.test.mjs`.
