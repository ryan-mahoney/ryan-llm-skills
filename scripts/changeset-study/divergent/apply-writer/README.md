# Offline apply-writer prototype

This isolated prototype evaluates one narrow question: can an injected apply transport return a complete file while a deterministic verifier rejects changes outside a planner-declared source range?

The plan supplies a current source hash and one exact UTF-16 range. The verifier requires the complete original prefix and suffix outside that range to remain unchanged, then runs Node syntax validation for `.mjs` and `.js` files in module mode and `.cjs` files in CommonJS mode. Other file types report `syntax_checked: false`; they receive the unchanged-region check only. A rejected response gets one retry with a short summary of the failed invariant. A second rejection is terminal.

This deliberately does not infer where a lazy snippet belongs. A snippet's surrounding text does not grant permission to edit a location; only the planner-owned range does. Each apply call handles one contiguous range. Split independent edits into separate calls. Stale hashes, malformed or out-of-bounds ranges, multiple ranges, and wrong-path data fail before transport. The verifier preserves exact context outside the declared range, but it cannot establish that the planner chose a semantically safe range or that the edit inside it implements the intended behavior. Candidate tests and the outer workflow's separate review remain necessary.

This prototype has no provider SDK, model selection, registry metadata, credentials, or network access. Morph v3 fast and Relace apply 3 remain unconfigured and unmeasured here; this code makes no claim about their cost, latency, availability, or output limits. It is preparation for a later matched experiment, not a production implementation.

Run the focused offline contract test with:

```sh
node --test scripts/changeset-study/divergent/apply-writer/apply-writer.test.mjs
```
