# Shared Jev decisions

The CLI and stdio MCP server share one decision implementation. They recommend
verification effort and review priority across projects. They never execute supplied
commands, change Git state, establish test passes, or replace repository requirements.

Use Node 22.19 or later. Install locked dependencies once:

```sh
npm ci --prefix ~/.agents/scripts/jev --ignore-scripts
node ~/.agents/scripts/jev/cli.mjs status --offline
node ~/.agents/scripts/jev/cli.mjs verification --repo /absolute/repo --input /path/input.json
node ~/.agents/scripts/jev/cli.mjs review-triage --repo /absolute/repo --input - < /path/input.json
```

Omitting `--input` reads stdin JSON. `--offline` collects mechanical Git facts and
returns an unavailable fallback without a service request. Status needs no input or
repo. Passive status reports credential availability, cached authentication and
`connectivity: "not_checked"` separately. `status --verify-connectivity` uses the
library's `listModels` to validate the current connection; it submits no judgment.
Cached authentication does not establish current connectivity or bind to a changed key.

The direct `pi-typesafe` 0.9.1 dependency uses `TYPESAFE_API_KEY`, then its existing
owner-only Pi login store. No Pi agent process runs. `JEV_TYPESAFE_MODULE` can name
an absolute library entry file. Without that override, normal module resolution is
preferred; the fallback is `~/.pi/agent/npm/node_modules/pi-typesafe/dist/index.js`.
That fallback needs the package's SDK and TypeBox peers installed. Imports that fail
produce `module_unavailable`; a key alone never produces a working status.

## Input contract version 1

Only these fields are accepted. Unknown fields, duplicate IDs and oversized inputs
are rejected. Input is bounded to 32 KiB. Commands and source references are text
for assessment and are never executed or fetched.

```json
{
  "schema_version": 1,
  "policy": { "broad_suite_owner": "ci" },
  "change_summary": "Reject duplicate account emails before saving",
  "acceptance_criteria": ["Duplicate emails leave existing account data intact"],
  "mandatory_gates": ["account-isolation-contract"],
  "focused_checks": [{
    "id": "duplicate-email",
    "purpose": "Exercise rejected duplicate email and unchanged stored account",
    "command": "node --test accounts.test.mjs",
    "source": "accounts.test.mjs",
    "scope": ["accounts.mjs"]
  }],
  "planned_ci_checks": [{
    "id": "retained-suite",
    "purpose": "Run retained account and isolation contracts in CI",
    "scope": ["accounts.mjs", "isolation.mjs"]
  }],
  "evidence": [],
  "findings": []
}
```

`policy.broad_suite_owner` is `ci` or `operator`, supplied from repository policy.
Missing ownership defaults the broad suite to `operator` and produces uncertainty
for local judgment; the tool does not invent CI. `operator` records broad testing owned by the operator outside recorded evidence; it does not
claim those tests passed. Missing CI never transfers the broad suite to local execution.
Useful focused local feedback is still allowed with explicit operator ownership. Mandatory gates remain in every output, including required local gates.
CI ownership without planned CI descriptions produces `ci_scope_unknown`.
`base_revision` optionally identifies a full 40–64 character Git SHA for a committed
change; the excerpt compares that base with the current working tree. Without a
base the excerpt covers staged, unstaged and untracked changes. A clean checkout
without a supplied base has no actual change context and produces uncertainty;
supply the intended comparison base when assessing completed branch work.

`focused_checks` permits up to 20 candidates. `planned_ci_checks` permits up to 24.
Both use `{id,purpose,command?,source?,scope?}`; IDs contain letters, numbers, `_`,
`.` or `-` and are at most 80 characters. Each scope is an array of paths/patterns
supplied for interpretation, not a claim that coverage was demonstrated.

`evidence` permits up to 24 entries:
`{id,revision,observed_at,kind,status,command?,artifact?,working_tree_digest?,scope?}`.
Revision is a full SHA; observation time is an ISO timestamp; kind is `local` or
`ci`; status is `passed`, `failed` or `unknown`. Artifacts are supplied metadata,
never fetched or treated as proof. Revision/digest mismatch, missing scope,
observations over 24 hours old or over one minute in the future, and incomplete
snapshots mark evidence stale. Even current evidence remains
`caller_reported_not_verified`. Map a trusted CI receipt into these fields only
while retaining the receipt's head verification, checks and semantic limitations
in the caller's evidence record. CI status alone does not establish coverage.

`findings` permits up to 7 entries:
`{id,summary,category?,relevant_failure?}`. Category is `acceptance`, `security`,
`tenant`, `data`, `failure` or `other`. Missing evidence or unresolved relevance
requires investigation. A protected category or relevant failure cannot become a
follow-up solely on the model's recommendation.

`outcome` optionally records a caller-declared `pending`, `accepted` or `overridden`
handling outcome for this invocation. It defaults to pending and is not a claim
that tests ran or a defect was resolved.

## Stable questions and conservative output

Verification batches independent questions about useful local feedback, candidates
that address plausible regressions, changes that invalidate earlier checks, and
verification needs that planned CI does not cover. Review batches concrete defect,
protected obligation, sufficient evidence and fix/investigate/follow-up questions
for each finding. Both also ask whether the context is sufficient.

The SDK returns probabilities. Noul probability at least 0.8 maps to true; at most
0.2 maps to false; intermediate values map to unknown. Review choices below 0.8
confidence or selected-label probability map to investigation. Missing answers, wrong types, invalid probabilities
or invalid choice distributions produce `malformed_response`.

Outputs contain `schema_version`, `task`, `status`, `decision_id`, `revision`,
`working_tree_digest`, `recommendation`, `assessment` when available, `uncertainty`,
`fallback`, `test_pass_claim`, `evidence`, `latency_ms` and `log`.

- Status is `recommendation`, `uncertain` or `unavailable`.
- Local recommendation is `focused`, `none` or `main_agent`; focused IDs always refer
  to supplied candidates. Missing context leaves local judgment with the caller.
- Broad suite recommendation is `ci` or `operator`; unknown ownership defaults to
  operator. No-CI repositories can complete work while reporting the observed evidence gap honestly.
- Findings use `must_fix`, `investigate` or `follow_up`.
- `fallback` is always `main_agent_judgment`; `test_pass_claim` is always false.
- Offline, missing module/key, malformed response, budget or transport errors return
  safe fallbacks. Required repository policy stays in force.

The caller should act on a recommendation only within existing policy. An uncertain
result reports what needs investigation; it does not authorize skipping a gate.

## Bounds, privacy and persistence

Git facts use fixed read-only argument arrays, disabled external diff/textconv and
filesystem-monitor hooks, an eight-second collection deadline, 2.5-second command
limits, 256 KiB command/untracked-content limits and at most 200 untracked files.
They include revision, staged/changed/untracked paths, a digest and a sanitized
12 KiB diff excerpt. Source excerpts go to Jev with supplied input. Common
credential/environment/key paths (including `.npmrc`, `.netrc` and `.pypirc`) are omitted and common token/credential patterns and URL-embedded credentials
are redacted; redaction itself marks context incomplete. This is a limited filter, not proof that arbitrary source contains no
secret. Binary, omitted, truncated or unstable context makes the decision uncertain.
Submodule or symlink content that cannot be safely collected also prevents confidence.

One judgment per invocation, no retries, a five-second request deadline and a
60 KiB request limit bound remote work. Shared CLI/MCP caps default to 30
requests, 100,000 input tokens and estimated USD 0.25 per local day; its persisted
ledger is isolated at `state/usage.json`, so unrelated Pi or Warden consumers do not
exhaust this tool's allowance. Library `PI_TYPESAFE_MAX_*` environment caps can
further lower the allowance. `JEV_MAX_REQUESTS_PER_DAY`,
`JEV_MAX_INPUT_TOKENS_PER_DAY` and `JEV_MAX_USD_PER_DAY` can lower these caps,
including zero. Larger values cannot raise the defaults. Connectivity probes use
`listModels` and do not count as judgments.

`~/.agents/scripts/jev/state/decisions.jsonl` records UUID, time, hashed repository
path, revision, digest, enum decisions, hashed focused-check IDs, mandatory-gate counts, category counts, latency, uncertainty and
caller-declared outcome. No diff, command, finding text, upstream message, credential
or source path is recorded. Files use owner-only permissions. A short directory
lock coordinates CLI/MCP writers; unavailable logging is explicit. Rotation retains
one previous log, bounding storage to about 2 MiB. `JEV_STATE_DIR` changes its location.
A process killed while holding the lock leaves logging unavailable; remove the empty
`decisions.lock` directory after confirming no writer is running. Judgment fallback
continues even when logging is unavailable.

## MCP

```json
{
  "mcpServers": {
    "jev": {
      "command": "node",
      "args": ["/absolute/path/to/.agents/scripts/jev/mcp.mjs"]
    }
  }
}
```

The official MCP SDK owns initialization and newline stdio framing. Tools are
`jev_verification` and `jev_review_triage` with `{repo,input}`, and `jev_status`
with optional `{verify_connectivity:true}`. Launch with `--offline` for local-only
fallback. Status probing is opt-in; normal decisions are the authorized shared
service calls. Standard output contains protocol messages only. See the official
[MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
contracts.

Run `npm test --prefix ~/.agents/scripts/jev`. Tests use synthetic repositories,
a fake judgment boundary and the real MCP SDK client; no billable service calls.
