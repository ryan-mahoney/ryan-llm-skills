// RED regression: the implementation-6 Linux case 6 fixture tree contract.
//
// The Linux recovery case asserts on the exact integration tree of the
// candidate checkout, which only lists base tree files until the wave promotes
// its step outputs. That assertion is only meaningful if the fixture's own
// `expected` map describes the frozen base commit faithfully. In particular the
// `setup: 'deps'` fixture commits `fixture.lock` into the base commit (see
// makeWaveFixture: "D-9 base commit: README ..., .gitignore,
// checks/fixture-check.mjs and, for deps setup, fixture.lock."), so any
// integration-tree comparison built from `expected` must contain that path.
//
// This file does not run a wave. It builds the fixture only and inspects the
// returned `expected` map against the base commit's tracked tree, so a mismatch
// fails fast and names the missing path instead of surfacing later as an opaque
// tree-diff in the Linux case.
//
// Scope note: `expected` deliberately also carries future step outputs
// (src/step-NN.txt), so the base tree files are asserted individually as a
// subset of `expected` rather than comparing both keysets for equality. The
// production exact integration-tree assertion is left untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeWaveFixture } from './package-fixture.mjs';

// The base commit files besides the step outputs. These are the paths the
// implementation-6 Linux case 6 tree contract has to see in `expected`.
const BASE_TREE_FILES = ['.gitignore', 'README', 'checks/fixture-check.mjs'];
const LOCK_PATH = 'fixture.lock';
const LOCK_CONTENT = 'fixture-lock\n';

// Minimal supported member count: the fixture default is 5, and 1 keeps the
// short-circuit path (a single step) while still producing one src/step-01.txt
// entry in `expected` so the subset check has a non-empty step population.
const MEMBERS = 1;

function trackedBaseFiles(fixture) {
  const raw = execFileSync('git', ['-C', fixture.paths.repo, 'ls-tree', '-r', '--name-only', fixture.baseCommit], {
    encoding: 'utf8',
  });
  return raw.split('\n').filter(Boolean);
}

test('wave native: deps fixture expected covers the tracked base tree including git HEAD:fixture.lock', async () => {
  const fixture = await makeWaveFixture({ members: MEMBERS, setup: 'deps' });
  try {
    assert.equal(fixture.options.deps, true, 'deps setup fixture must record deps: true');

    // The git HEAD:fixture.lock contents are the contract value the integration
    // tree comparison depends on, so they are compared against the committed
    // bytes rather than only asserted against the fixture constant.
    assert.equal(fixture.expected.get(LOCK_PATH), LOCK_CONTENT, 'expected must carry git HEAD:fixture.lock contents');
    const committedLock = execFileSync('git', ['-C', fixture.paths.repo, 'show', `${fixture.baseCommit}:${LOCK_PATH}`], {
      encoding: 'utf8',
    });
    assert.equal(fixture.expected.get(LOCK_PATH), committedLock, 'expected fixture.lock content matches git show HEAD:fixture.lock');

    // The base commit really contains the lock file, so `expected` describing
    // it is a base-tree fact and not an invented entry.
    const tracked = trackedBaseFiles(fixture);
    assert.ok(tracked.includes(LOCK_PATH), `base commit must track ${LOCK_PATH}; tracked: ${tracked.join(', ')}`);

    // Base paths are a subset of `expected`: `expected` also lists future step
    // outputs, so each base path is asserted individually.
    for (const path of [...BASE_TREE_FILES, LOCK_PATH]) {
      assert.ok(fixture.expected.has(path), `expected must represent tracked base file ${path}`);
      assert.ok(tracked.includes(path), `expected entry ${path} must be a tracked file of the base commit`);
    }

    // Every tracked base file is represented, which is the whole point of the
    // subset check: no base file may be silently absent from the tree contract.
    for (const path of tracked) {
      assert.ok(fixture.expected.has(path), `expected must represent tracked base file ${path}`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('wave native: non-deps fixture expected omits fixture.lock', async () => {
  const fixture = await makeWaveFixture({ members: MEMBERS });
  try {
    assert.equal(fixture.options.deps, false, 'default fixture must not use deps');
    assert.equal(fixture.expected.has(LOCK_PATH), false, 'expected must not carry fixture.lock without deps setup');

    const tracked = trackedBaseFiles(fixture);
    assert.equal(tracked.includes(LOCK_PATH), false, `base commit must not track ${LOCK_PATH}; tracked: ${tracked.join(', ')}`);

    for (const path of BASE_TREE_FILES) {
      assert.ok(fixture.expected.has(path), `expected must represent tracked base file ${path}`);
    }
  } finally {
    await fixture.cleanup();
  }
});
