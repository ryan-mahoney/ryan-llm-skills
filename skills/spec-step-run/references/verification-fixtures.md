# Verification fixtures and journey readiness

Use this guidance when a required expensive browser journey or runtime check depends
on compilation, seeded state, a server, or live workers. It adds no setup probe to
ordinary simple tests and no new acceptance gate. Reuse sufficient readiness evidence
until an affected change or failure invalidates it.

Reuse the repository's maintained fixture lifecycle, configuration, seed helpers and
browser context before creating a disposable runner. Inspect the relevant helper and
one working caller to establish real signatures, setup order, required config paths,
and teardown. Keep isolated state fresh between scenarios; reusing a fixture means
reusing its implementation, not leaking mutable state across runs. Extend a maintained
fixture for a real missing capability instead of copying its lifecycle into another
script. Use a temporary runner only when the existing route cannot exercise the state.

Before the full journey, establish the smallest bounded readiness assertion that
addresses its actual dependencies. Reuse the existing setup path to compile/load the
fixture, create its workspace before invoking Git, resolve required configuration from
the supplied checkout, and seed the required records. Check only applicable boundaries;
do not invent substitute APIs or configuration defaults to make setup pass. Where
possible put readiness at the start of the existing journey so the same fixture and
server are used and failure stops before expensive interaction.

An HTTP success response establishes transport readiness only. For live-worker UI,
wait within a finite deadline for the expected seeded worker identity/state and its
rendered row; establish the websocket/subscription state when the scenario depends on
it. Use repository assertions or meaningful selectors/text, not a sleep or any matching
row. A page shell, login/loading view, or unrelated worker is not the required state.
Keep the subsequent behavioral assertions: readiness alone does not prove acceptance.

In Pi, the owner runs verification after the editor returns; the editor writes fixture
or runner corrections. For a needed server use the existing
`spec_verify.server: {command, ready_url, readiness_timeout}` with a foreground server
on an owned loopback port. Put application readiness and the affected journey in the
outer verification command, with an explicit timeout for the whole command and bounded
waits inside it. The managed helper checks HTTP success and owns startup/termination;
it does not assert application or worker readiness. Reuse framework teardown and close
browsers/fixture resources in `finally` on success, failure or interruption. Do not add
background server calls or custom signal traps to replace the managed lifecycle.
Unconfirmed server cleanup retains the existing cancellation/writer-blocking policy.

On failure, retain the first failing boundary and its concrete diagnostic:
fixture compilation/configuration, seed/setup, transport, application/worker readiness,
or the product assertion. Diagnose that boundary with the smallest affected check and
send any writes back to the editor. Do not rerun the unchanged full journey for the same
setup failure. After a relevant correction, repeat the affected readiness check, then
the required journey once readiness holds. Preserve exit failures and useful logs.

Record fixture/setup failure separately from an observed product defect; a broken
harness cannot certify either product success or product failure. Existing learning
and evidence records hold the failed command, boundary, correction, final result and
proof limits. Resolve required acceptance evidence or return a truthful checkpoint;
fixture trouble does not waive the journey or turn it into a deferred pass.
