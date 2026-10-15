import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeWrite, stepWaves, validateStepIndex, writeConflicts } from './steps.mjs';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const CLI_TIMEOUT = 120_000;
const HOST = hostname().split('.')[0].toLowerCase();

const TARGETS = ['agents'];
const MULTI_TARGETS = ['alpha', 'beta'];
const EMPTY_PLAN = { gates: [] };
const OPTIONS = { targets: TARGETS };
const VALIDATION = { targets: TARGETS, evidencePlan: EMPTY_PLAN };
const MULTI_VALIDATION = { targets: MULTI_TARGETS, evidencePlan: EMPTY_PLAN };

const step = (number, requires = [], extra = {}) => ({
  step: number,
  requires,
  writes: [`src/step-${number}.ts`],
  ...extra,
});

function sixStepIndex(overrides = {}) {
  return {
    spec: 'spec.md',
    steps: [
      step(1),
      step(2, [1]),
      step(3),
      step(4, [2, 3]),
      step(5),
      step(6, [4, 5]),
    ],
    setup: { agents: 'none' },
    wave_checks: [
      { after: 5, owner_step: 1, gates: ['EV-A'] },
      { after: 2, owner_step: 2, gates: ['EV-B'] },
      { after: 4, owner_step: 4, gates: ['EV-C'] },
      { after: 6, owner_step: 6, gates: ['EV-D'] },
    ],
    ...overrides,
  };
}

function completePlan() {
  return {
    spec: 'spec.md',
    gates: [
      {
        id: 'EV-A',
        phase: 'merge',
        required: true,
        kind: 'focused-test',
        ownerStep: 1,
        command: "node --test --test-name-pattern='^step index' scripts/spec-observe/steps.test.mjs",
        artifact: 'evidence/step-index.txt',
      },
      {
        id: 'EV-B',
        phase: 'merge',
        required: true,
        kind: 'integration-test',
        ownerStep: 2,
        command: "node --test --test-name-pattern='^steps lint CLI' scripts/spec-observe/steps.test.mjs",
        artifact: 'evidence/steps-cli.txt',
      },
      {
        id: 'EV-C',
        phase: 'merge',
        required: true,
        kind: 'deterministic-inspection',
        ownerStep: 4,
        command: 'node scripts/spec-observe/cli.mjs steps lint agent-tooling/waves',
        artifact: 'evidence/wave-checks.txt',
      },
      {
        id: 'EV-D',
        phase: 'merge',
        required: true,
        kind: 'focused-test',
        ownerStep: 6,
        command: "node --test --test-name-pattern='^step index' scripts/spec-observe/steps.test.mjs",
        artifact: 'evidence/step-index.txt',
      },
    ],
  };
}

/**
 * A resolvable spec-location package: real storage layout, kit, and recorded
 * locations for one target. Callers write scope.json/spec-steps.json contents
 * per case and remove the whole temporary tree afterwards.
 */
function makeLintFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'steps-lint-')));
  const primary = join(root, 'repo');
  const storage = join(root, 'storage');
  const workspaceDir = join(storage, 'projects', 'demo');
  const capturesDir = join(workspaceDir, 'captures');
  const packageDir = join(workspaceDir, 'specs', 'linted');

  mkdirSync(primary, { recursive: true });
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'project-context.md'), '# demo workspace\n');
  writeFileSync(
    join(workspaceDir, 'kit.yaml'),
    [
      'version: 1',
      'id: "demo"',
      'name: "Demo"',
      'repositories:',
      '  - id: "agents"',
      `    path: "${primary}"`,
      `execution_host: "${HOST}"`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(packageDir, 'spec.md'), '# Linted\n\nStep index lint fixture.\n');
  writeFileSync(join(packageDir, 'scope.json'), JSON.stringify({
    schema_version: 1,
    workspace: 'demo',
    slug: 'linted',
    targets: [{ id: 'agents', branch: 'spec-linted' }],
    designs: [],
    plan: null,
    epic: null,
  }, null, 2));
  writeFileSync(join(packageDir, 'locations.json'), JSON.stringify({
    schema_version: 1,
    package_ref: 'demo/linted',
    execution_host: HOST,
    materialized_at: '2026-01-01T00:00:00.000Z',
    storage_root: storage,
    workspace_dir: workspaceDir,
    package_dir: packageDir,
    project_context: join(workspaceDir, 'project-context.md'),
    kit: join(workspaceDir, 'kit.yaml'),
    plan: null,
    epic: null,
    captures_dir: capturesDir,
    designs: [],
    targets: [{
      id: 'agents',
      primary,
      common: null,
      branch: 'spec-linted',
      worktree: null,
    }],
  }, null, 2));
  return { root, storage, packageDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runLint(...items) {
  return spawnSync(process.execPath, [CLI, 'steps', 'lint', ...items], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT,
  });
}

function cliFailure(result) {
  return result.stderr || result.stdout || result.error?.message || 'no CLI output';
}

test('step index: six-step dependency example derives expected waves', () => {
  const result = stepWaves([
    { step: 1, requires: [] },
    { step: 2, requires: [1] },
    { step: 3, requires: [] },
    { step: 4, requires: [2, 3] },
    { step: 5, requires: [] },
    { step: 6, requires: [4, 5] },
  ]);
  assert.deepEqual(result.waves, [[1, 3, 5], [2], [4], [6]]);
  assert.equal(result.longest_chain, 4);
  assert.deepEqual(result.fan_in, [4, 6]);
});

test('step index: prefixed and unprefixed single-target aliases conflict', () => {
  const bare = normalizeWrite('src/a.ts', OPTIONS);
  const prefixed = normalizeWrite('agents:src/a.ts', OPTIONS);
  assert.equal(bare.ok, true);
  assert.equal(prefixed.ok, true);
  assert.equal(bare.target, 'agents');
  assert.equal(prefixed.target, 'agents');
  assert.equal(bare.path, 'src/a.ts');
  assert.equal(prefixed.path, 'src/a.ts');
  assert.equal(bare.dir, false);
  assert.equal(prefixed.dir, false);
  assert.equal(bare.deleted, false);
  assert.equal(prefixed.deleted, false);
  assert.equal(bare.identity, prefixed.identity);
  assert.equal(bare.identity, 'agents:src/a.ts');
  assert.equal(writeConflicts(bare, prefixed), true);

  const foreign = normalizeWrite('beta:src/a.ts', OPTIONS);
  assert.equal(foreign.ok, false);
  assert.ok(foreign.errors.length > 0);

  const conflict = validateStepIndex({
    steps: [
      step(1, [], { writes: ['src/a.ts'] }),
      step(2, [], { writes: ['agents:src/a.ts'] }),
    ],
  }, VALIDATION);
  assert.equal(conflict.ok, false);
  assert.ok(
    conflict.errors.some(message => /conflict|overlap|same wave/i.test(message)),
    JSON.stringify(conflict.errors),
  );
  assert.equal(conflict.concurrency_ready, false);
});

test('step index: file and ancestor paths conflict', () => {
  const file = normalizeWrite('src/a', OPTIONS);
  const child = normalizeWrite('src/a/b.ts', OPTIONS);
  const directory = normalizeWrite('src/a/', OPTIONS);
  const sibling = normalizeWrite('src/b', OPTIONS);

  assert.equal(directory.ok, true);
  assert.equal(directory.dir, true);
  assert.equal(directory.path, 'src/a');
  assert.equal(directory.identity, 'agents:src/a');

  assert.equal(writeConflicts(file, child), true);
  assert.equal(writeConflicts(directory, child), true);
  assert.equal(writeConflicts(directory, file), true);
  assert.equal(writeConflicts(file, sibling), false);

  const legal = validateStepIndex({
    steps: [step(1, [], { writes: ['src/a', 'src/b.ts'], resources: ['checkout-a'] })],
  }, VALIDATION);
  assert.equal(legal.ok, true, JSON.stringify(legal.errors));
});

test('step index: multi-target paths and deletions use canonical target identities', () => {
  const alphaWrite = normalizeWrite('alpha:src/x.ts', { targets: MULTI_TARGETS, repository: 'alpha' });
  const alphaDelete = normalizeWrite({ path: 'src/x.ts', deleted: true }, { targets: MULTI_TARGETS, repository: 'alpha' });
  const betaWrite = normalizeWrite('beta:src/x.ts', { targets: MULTI_TARGETS, repository: 'beta' });

  assert.equal(alphaWrite.ok, true);
  assert.equal(alphaWrite.identity, 'alpha:src/x.ts');
  assert.equal(alphaDelete.ok, true);
  assert.equal(alphaDelete.identity, alphaWrite.identity);
  assert.equal(alphaDelete.deleted, true);
  assert.equal(alphaWrite.deleted, false);
  assert.equal(alphaDelete.dir, false);
  assert.equal(writeConflicts(alphaWrite, alphaDelete), true);
  assert.equal(writeConflicts(alphaWrite, betaWrite), false);

  const unprefixed = normalizeWrite('src/x.ts', { targets: MULTI_TARGETS, repository: 'alpha' });
  assert.equal(unprefixed.ok, false);
  assert.ok(unprefixed.errors.length > 0);

  const foreign = normalizeWrite('beta:src/x.ts', { targets: MULTI_TARGETS, repository: 'alpha' });
  assert.equal(foreign.ok, false);
  assert.ok(foreign.errors.length > 0);

  const multi = validateStepIndex({
    steps: [
      step(1, [], { repository: 'alpha', writes: ['alpha:src/x.ts'] }),
      step(2, [], { repository: 'beta', writes: ['beta:src/y.ts'] }),
    ],
    setup: { alpha: 'none', beta: 'none' },
  }, MULTI_VALIDATION);
  assert.equal(multi.ok, true, JSON.stringify(multi.errors));
  assert.equal(multi.concurrency_ready, false);
  assert.ok(multi.reasons.includes('multiple-targets'));
});

test('step index: malformed and mixed indexes refuse', () => {
  const mixed = validateStepIndex({
    steps: [step(1, [], { writes: ['src/a.ts'] }), { step: 2, name: 'Step two' }],
  }, VALIDATION);
  assert.equal(mixed.ok, false);

  const badWrite = validateStepIndex({
    steps: [step(1, [], { writes: ['src/../x'] })],
  }, VALIDATION);
  assert.equal(badWrite.ok, false);

  const futureRequires = validateStepIndex({
    steps: [step(1), step(2, [3])],
  }, VALIDATION);
  assert.equal(futureRequires.ok, false);

  const duplicateRequires = validateStepIndex({
    steps: [step(1), step(2, [1, 1])],
  }, VALIDATION);
  assert.equal(duplicateRequires.ok, false);

  for (const result of [mixed, badWrite, futureRequires, duplicateRequires]) {
    assert.equal(result.concurrency_ready, false);
    assert.ok(result.errors.length > 0);
  }
});

test('step index: legacy indexes remain valid and serial', () => {
  const result = validateStepIndex({
    spec: 'spec.md',
    steps: [1, 2, 3].map(number => ({
      step: number,
      name: `Step ${number}`,
      description: `Legacy step ${number}.`,
      difficulty: 'easy',
      visualDesign: false,
      evidence: [],
    })),
  }, VALIDATION);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.legacy, true);
  assert.deepEqual(result.waves, [[1], [2], [3]]);
  assert.equal(result.concurrency_ready, false);
  assert.ok(result.reasons.includes('legacy-serial'));
});

test('step index: incomplete wave checks report concurrency ready false', () => {
  const base = {
    spec: 'spec.md',
    steps: [step(1), step(2, [1])],
    setup: { agents: 'none' },
  };

  const absent = validateStepIndex(base, VALIDATION);
  assert.equal(absent.ok, true, JSON.stringify(absent.errors));
  assert.equal(absent.concurrency_ready, false);
  assert.ok(absent.reasons.includes('wave-checks-incomplete'));

  const emptyGates = validateStepIndex({
    ...base,
    wave_checks: [
      { after: 1, owner_step: 1, gates: [] },
      { after: 2, owner_step: 2, gates: [] },
    ],
  }, VALIDATION);
  assert.equal(emptyGates.ok, true, JSON.stringify(emptyGates.errors));
  assert.equal(emptyGates.concurrency_ready, false);
  assert.ok(emptyGates.reasons.includes('wave-checks-incomplete'));
});

test('step index: complete wave check map binds gates to owners and barriers', () => {
  const index = sixStepIndex();
  const plan = completePlan();
  const result = validateStepIndex(index, { targets: TARGETS, evidencePlan: plan });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.legacy, false);
  assert.deepEqual(result.waves, [[1, 3, 5], [2], [4], [6]]);
  assert.equal(result.longest_chain, 4);
  assert.deepEqual(result.fan_in, [4, 6]);
  assert.equal(result.concurrency_ready, true);
  assert.deepEqual(result.reasons, []);

  assert.equal(index.wave_checks.length, result.waves.length);
  for (const row of index.wave_checks) {
    const wave = result.waves.find(members => members.includes(row.owner_step));
    assert.ok(wave, `owner step ${row.owner_step} belongs to a nonempty wave`);
    assert.equal(row.after, wave[wave.length - 1]);
    for (const gateId of row.gates) {
      const gate = plan.gates.find(candidate => candidate.id === gateId);
      assert.ok(gate, `gate ${gateId} exists`);
      assert.equal(gate.ownerStep, row.owner_step);
    }
  }

  for (const kind of ['manual', 'deploy']) {
    const rejectedPlan = completePlan();
    rejectedPlan.gates[0].kind = kind;
    const rejected = validateStepIndex(index, { targets: TARGETS, evidencePlan: rejectedPlan });
    assert.equal(rejected.ok, false, `${kind} gates must refuse`);
    assert.ok(rejected.errors.length > 0);
  }
});

test('step index: stale after rows invalidate when requires change', () => {
  const ready = validateStepIndex(sixStepIndex(), { targets: TARGETS, evidencePlan: completePlan() });
  assert.equal(ready.ok, true, JSON.stringify(ready.errors));
  assert.equal(ready.concurrency_ready, true);

  // Step 6 joins wave 2, so owner step 2's wave now ends at 6 while its
  // recorded row still says after 2.
  const moved = sixStepIndex({
    steps: [step(1), step(2, [1]), step(3), step(4, [2, 3]), step(5), step(6, [2])],
  });
  const stale = validateStepIndex(moved, { targets: TARGETS, evidencePlan: completePlan() });
  assert.equal(stale.ok, false);
  assert.ok(
    stale.errors.some(message => /after/.test(message) && /2/.test(message)),
    `errors name the stale row: ${JSON.stringify(stale.errors)}`,
  );
  assert.equal(stale.concurrency_ready, false);
});

test('step index: lint recomputes barriers and rejects stale duplicate missing rows', () => {
  const plan = completePlan();
  const base = sixStepIndex();

  const duplicate = validateStepIndex({
    ...base,
    wave_checks: [...base.wave_checks, { after: 2, owner_step: 2, gates: ['EV-B'] }],
  }, { targets: TARGETS, evidencePlan: plan });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.length > 0);

  const missing = validateStepIndex({
    ...base,
    wave_checks: base.wave_checks.filter(row => row.after !== 4),
  }, { targets: TARGETS, evidencePlan: plan });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length > 0);

  const regenerated = validateStepIndex(sixStepIndex(), { targets: TARGETS, evidencePlan: plan });
  assert.equal(regenerated.ok, true, JSON.stringify(regenerated.errors));
  assert.equal(regenerated.concurrency_ready, true);
});

test('step index: setup none and per-target setup validate; malformed setup refuses', () => {
  const options = { targets: TARGETS, evidencePlan: completePlan() };

  const none = validateStepIndex(sixStepIndex({ setup: { agents: 'none' } }), options);
  assert.equal(none.ok, true, JSON.stringify(none.errors));
  assert.equal(none.concurrency_ready, true);

  const complete = {
    command: 'npm ci --prefix pi/extensions/spec-runtime --ignore-scripts --no-audit --no-fund && npm ci --prefix scripts/jev --ignore-scripts --no-audit --no-fund',
    lockfiles: ['pi/extensions/spec-runtime/package-lock.json', 'scripts/jev/package-lock.json'],
    environment: [],
  };
  const declared = validateStepIndex(sixStepIndex({ setup: { agents: complete } }), options);
  assert.equal(declared.ok, true, JSON.stringify(declared.errors));
  assert.equal(declared.concurrency_ready, true);

  const { setup: _omitted, ...withoutSetup } = sixStepIndex();
  const absent = validateStepIndex(withoutSetup, options);
  assert.equal(absent.ok, true, JSON.stringify(absent.errors));
  assert.equal(absent.concurrency_ready, false);
  assert.ok(absent.reasons.includes('setup-missing'));

  const wrongTarget = validateStepIndex(sixStepIndex({ setup: { beta: 'none' } }), options);
  assert.equal(wrongTarget.ok, true, JSON.stringify(wrongTarget.errors));
  assert.equal(wrongTarget.concurrency_ready, false);
  assert.ok(wrongTarget.reasons.includes('setup-missing'));

  const malformed = [
    { agents: 5 },
    { agents: { command: '', lockfiles: [], environment: [] } },
    { agents: { command: 7, lockfiles: [], environment: [] } },
    { agents: { command: 'npm ci', lockfiles: 'not-an-array', environment: [] } },
    { agents: { command: 'npm ci', lockfiles: [], environment: 'not-an-array' } },
    { agents: { command: 'npm ci', lockfiles: [], environment: [1] } },
    { agents: { command: 'npm ci', lockfiles: [], environment: [], extra: 'unknown' } },
  ];
  for (const setup of malformed) {
    const result = validateStepIndex(sixStepIndex({ setup }), options);
    assert.equal(result.ok, false, `setup ${JSON.stringify(setup)} must refuse`);
    assert.ok(result.errors.length > 0);
  }
});

test('step index: shared resource keys serialize independent steps visibly', () => {
  const shared = stepWaves([
    { step: 1, requires: [], resources: ['checkout-a'] },
    { step: 2, requires: [], resources: ['checkout-a'] },
  ]);
  assert.deepEqual(shared.waves, [[1], [2]]);
  assert.equal(shared.longest_chain, 2);

  const disjoint = stepWaves([
    { step: 1, requires: [], resources: ['checkout-a'] },
    { step: 2, requires: [], resources: ['checkout-b'] },
  ]);
  assert.deepEqual(disjoint.waves, [[1, 2]]);
  assert.equal(disjoint.longest_chain, 1);
});

test('steps lint CLI: valid package exits 0 with JSON', { timeout: CLI_TIMEOUT }, () => {
  const fixture = makeLintFixture();
  try {
    const plan = completePlan();
    writeFileSync(join(fixture.packageDir, 'spec-steps.json'), JSON.stringify(sixStepIndex(), null, 2));
    writeFileSync(join(fixture.packageDir, 'evidence-plan.json'), JSON.stringify({
      version: 2,
      spec: 'spec.md',
      gates: plan.gates,
    }, null, 2));

    const result = runLint(fixture.packageDir);
    assert.equal(result.status, 0, cliFailure(result));
    const document = JSON.parse(result.stdout.trim());
    assert.equal(document.ok, true);
    assert.deepEqual(document.errors, []);
    assert.equal(document.concurrency_ready, true);
    assert.deepEqual(document.waves, [[1, 3, 5], [2], [4], [6]]);
  } finally {
    fixture.cleanup();
  }
});

test('steps lint CLI: invalid index exits 1 with errors', { timeout: CLI_TIMEOUT }, () => {
  const fixture = makeLintFixture();
  try {
    const plan = completePlan();
    writeFileSync(join(fixture.packageDir, 'spec-steps.json'), JSON.stringify(sixStepIndex({
      steps: [
        step(1, [], { writes: ['src/a.ts'] }),
        step(2, [], { writes: ['agents:src/a.ts'] }),
      ],
    }), null, 2));
    writeFileSync(join(fixture.packageDir, 'evidence-plan.json'), JSON.stringify({
      version: 2,
      spec: 'spec.md',
      gates: plan.gates,
    }, null, 2));

    const result = runLint(fixture.packageDir);
    assert.equal(result.status, 1, cliFailure(result));
    const document = JSON.parse(result.stdout.trim());
    assert.equal(document.ok, false);
    assert.ok(document.errors.length > 0);
  } finally {
    fixture.cleanup();
  }
});

test('steps lint CLI: unresolvable package exits 2', { timeout: CLI_TIMEOUT }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'steps-lint-unresolvable-')));
  try {
    const result = runLint(root);
    assert.equal(result.status, 2, cliFailure(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('steps lint CLI: package reference resolves against isolated alternate storage root', { timeout: CLI_TIMEOUT }, () => {
  const fixture = makeLintFixture();
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'steps-lint-empty-root-')));
  try {
    writeFileSync(join(fixture.packageDir, 'spec-steps.json'), JSON.stringify(sixStepIndex(), null, 2));
    writeFileSync(join(fixture.packageDir, 'evidence-plan.json'), JSON.stringify({
      version: 2,
      spec: 'spec.md',
      gates: completePlan().gates,
    }, null, 2));

    const resolved = runLint('demo/linted', '--root', fixture.storage);
    assert.equal(resolved.status, 0, cliFailure(resolved));
    const document = JSON.parse(resolved.stdout.trim());
    assert.equal(document.ok, true);
    assert.deepEqual(document.errors, []);

    const isolated = runLint('demo/linted', '--root', empty);
    assert.equal(isolated.status, 2, cliFailure(isolated));
  } finally {
    fixture.cleanup();
    rmSync(empty, { recursive: true, force: true });
  }
});
