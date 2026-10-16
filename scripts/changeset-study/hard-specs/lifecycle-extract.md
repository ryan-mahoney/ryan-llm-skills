# Extract wave lifecycle orchestration from runtime.mjs

Review finding (guardrail): a standing direction requires splitting new behavior into a
cohesive module instead of growing `pi/extensions/spec-runtime/runtime.mjs` past about
1,000 lines. The last change added about 1,230 lines there, leaving about 1,970, with
environment/bootstrap, containment, setup publication and phase-remount orchestration
embedded in the existing module. Extract a cohesive wave lifecycle/containment module
while retaining the existing `Runtime` entrypoints.

Create `pi/extensions/spec-runtime/wave-lifecycle.mjs` and move into it, without
behavioral edits:

- the observed environment facts (`environmentFacts`);
- the transport environment allowlist (`TRANSPORT_ENV_NAMES`) and `sanitizeTransport`;
- the fixed contained-root bootstrap source (`ROOT_BOOTSTRAP`) and private
  environment/request forwarding;
- setup staging and publication: `targetSetup`, `declaredEnvironment`, `shQuote`,
  `waveSetupScript`, `readSetupReceipt`, `waitForSetupClose`, `buildWaveStaging`,
  `gitList` and `partitionUntracked`;
- the bodies of the contained-root, wave-deadline, contained-service drain, wave-member
  preparation and wave-member remount orchestration that `Runtime` methods currently
  hold.

This is a pure move with import wiring and delegation only: no new capability,
changed defaults, error messages or lifecycle operation ordering. `Runtime` keeps the
same public methods (`containedRoot`, `ensureWaveDeadline`, `drainContainedService`,
`prepareWaveMember`, `remountWaveMember` and the rest) as delegates that run the moved
logic with the original `Runtime` receiver and the injected service adapter.
`runtime.mjs` keeps exporting `environmentFacts` (re-exported from the new module), and
every existing importer, including the tests, needs no change. The new module must not
import `runtime.mjs` (no import cycle); pass the Runtime persistence, provenance and
process helpers it needs into it instead. Do not edit existing tests.

Acceptance: `runtime.mjs` no longer defines the moved functions and constants, it is at
most 1,550 lines, and `pi/extensions/spec-runtime/runtime.test.mjs` passes unchanged.
Two tests in that file already fail before this change ("repeated starts return the same
run ..." and "start creates the target worktree ... writes no lock fields"); they are
tracked separately and are not part of this task.

Gate: `node --test pi/extensions/spec-runtime/runtime.test.mjs` (about 30 seconds).
