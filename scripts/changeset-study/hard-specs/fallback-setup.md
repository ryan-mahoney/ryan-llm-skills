# Publish prepared setup output to worktree-fallback attempts

Wave step workspaces in `pi/extensions/spec-runtime/step-workspaces.mjs` have two
backends. The OverlayFS backend mounts a frozen, read-only snapshot lower
(`snapshots/<snapshotId>/lower`, created once per setup identity by the existing
snapshot publisher) under a per-attempt upper, so a worker sees the prepared setup
output (for example `deps/setup-output` produced by the target's declared setup
command) in its checkout. The worktree fallback, used whenever overlay is unavailable,
only runs `git worktree add` at the base commit in `provisionWorktree`. It never
publishes the staged setup output, so fallback workers lose `deps/setup-output`
although the real setup produced those bytes in staging.

`runtime.test.mjs` currently characterizes the defect: its portable composition
variant asserts `checkout.setup === null` ("KNOWN GAP") in the first phase and after
phase remount.

Repair it as a bounded change:

- In `provisionWorktree` and its caller on the fallback branch of `prepare`, publish
  the staged setup input to the fallback worktree with the same semantics as the overlay
  path. Use the same snapshot publisher, so both backends produce byte-identical frozen
  lowers; do not add a competing staged-copy mechanism. The fallback worktree must
  still be a detached worktree at the base commit, with the canonical common Git
  directory, an index matching the base tree, tracked symlinks preserved, and the
  snapshot's untracked setup output present. The canonical checkout never receives the
  setup output.
- Replaying an already published attempt preserves the attempt's bytes, including
  edits the worker made.
- Add a `wave workspaces:` regression in `step-workspaces.test.mjs` that fails when
  publication is removed.
- Flip the portable variant in `runtime.test.mjs` from asserting the known gap to
  asserting the published value `'prepared'` in both phases, so the native and
  portable variants make the same assertion.

Gates: `node --test --test-name-pattern='^wave workspaces:' pi/extensions/spec-runtime/step-workspaces.test.mjs`
and `PI_WARDEN_ENABLED=1 node --test --test-name-pattern='^wave runtime: portable' pi/extensions/spec-runtime/runtime.test.mjs`.
