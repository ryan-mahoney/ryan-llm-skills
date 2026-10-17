# Matched Sol writer control (offline prototype)

This separate control reuses terminal run-18 source, briefs, raw plans, dispatched
plans and the exact frozen worker/backend. Only bounded writers use
`openai-codex/gpt-6.1-sol:low`. No new owner, query, review or Jev call is allowed.
It does not change the DeepSeek-writer route or its strict reporter.

The runner freezes its own harness separately, retains the full SDK dependency tree
and dependency mount, and requires the existing canonical donor $50 ledger. It never
creates or resets a ledger. Preparation and audit need no provider call. Output must
be new and outside the checkout, donor dispatch tree, SDK and dependencies. A source
with incomplete application in any of the original three cases is ineligible.

This prototype has not made live calls. The current research goal, selected models and shared budget already authorize this
comparison. Root coordinates concrete live execution after audit and a freeze, using
the qualified candidate and its repeat; no new user approval is needed. See PROTOCOL.md.

```sh
node scripts/changeset-study/divergent/writer-control/runner.mjs prepare \
  --source "$RUN18" --output "$NEW_CONTROL_ROOT" --ledger "$CAMPAIGN_LEDGER" \
  --sdk-root "$PINNED_SDK_ROOT" --model openai-codex/gpt-6.1-sol:low

# Root executes the reviewed frozen control:
node "$NEW_CONTROL_ROOT/harness/runner.mjs" run --output "$NEW_CONTROL_ROOT"
node "$NEW_CONTROL_ROOT/harness/runner.mjs" audit --output "$NEW_CONTROL_ROOT"
```

SDK root means the `node_modules/@earendil-works` directory. Artifact paths in the
control manifest are relative to its output root; canonical donor and ledger paths
are runtime identities. Source/helper modules in this directory use only Node APIs.

Audits replay retained model responses with the donor's frozen parser, focused-input
builder and edit engine. They compare actual staged excerpts, local retry failures,
final candidate, dispatched plan and receipts. Execution and verification outcomes
remain separate; no independent semantic review is claimed. All costs remain
retained even when a routing, retry or source-provenance audit fails.
