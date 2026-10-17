# Matched Sol writer control

Measured status: controls 01 and 02 each completed application in all three cases,
with valid frozen source-replay audits and no retries. Each passed delivery in two
cases. Writing plus optimization took 102.32 and 108.18 seconds. See the
[measured comparison](../../writer-control-results.md), [JSON evidence](../../writer-control-results.json)
and [compact visual](../../writer-control-results.html). Provider output-limit and
retry differences remain explicit; no full-workflow or global speed win is claimed.

## Original prospective protocol

The text below records the preparation design registered before live execution.
Its original unmeasured status is historical; frozen copies remain unchanged.

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

For a main fixed-off replay, the same read-only auditor can be selected explicitly:

```sh
node scripts/changeset-study/divergent/writer-control/fixed-off-audit.mjs \
  --run "$FIXED_OFF_RUN" --donor "$RUN18" --sdk-root "$PINNED_SDK_ROOT"
```

This does not prepare or execute another arm. It independently binds main-run jobs
to donor18 tasks, plans, briefs and result hashes, verifies main/donor frozen manifests,
SDK/model/dependency pins and the canonical ledger, then uses the same response/source
replay with explicit DeepSeek-off and main frozen-backend parameters. Transport/model
retries disqualify the observed local-retry comparison while retaining charges. The
Sol-control prepare/run functions and the audit's default selector remain Sol-only;
historical main reporter behavior is unchanged. No new owner/query/review occurs.

The fixed-off CLI exits zero when evidence integrity is valid, including a correctly
recorded application failure. A nonzero exit means invalid provenance/evidence or an
audit error. Check `all_qualified_application` and `all_delivery_checks_pass` separately
for outcomes; exit status does not certify success. `audit_provider_calls: 0` describes
the read-only audit itself, not the writer calls retained in the observed run.
