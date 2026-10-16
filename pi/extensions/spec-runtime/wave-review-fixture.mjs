// Reusable disposable Git/record fixtures for the wave review data-plane tests.
// `makeStageFixture` builds a real Git checkout with committed base/head, a temp
// package outside that checkout, a running run record for `assertLease`, and a
// runtime.test.mjs-style fake-pi.cjs. It exercises no lifecycle orchestration.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Runtime, loadRun, runCompletion } from './runtime.mjs';
import { readReviewState, stageLabel, runStageGates, sealMember, nextReviewAction } from './wave-review.mjs';
import { createOwnership } from './ownership.mjs';
import { makePackageFixture } from './package-fixture.mjs';
import { prepareStepWorkspace } from './step-workspaces.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';

export const REVIEW_LABEL = 'wave-w1-step-001-review-1';
const RUN_ID = 'run-r1';

// The real installed Pi SDK is the only loader for the local index.ts. A missing
// install is a hard case failure (the caller asserts existence), never a skip.
const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_RUNTIME_INDEX = join(here, 'index.ts');
export const SDK_ROOT = process.env.SPEC_PI_SDK || '/home/ryanmahoney/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent';
export const SDK_LOADER = join(SDK_ROOT, 'dist/core/extensions/loader.js');
export const loadSdk = () => import(pathToFileURL(SDK_LOADER).href);

const gitAt = (cwd, args, opts = {}) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });

export function makeStageFixture(t, { id = RUN_ID } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wave-review-fixture-'));
  const checkout = join(root, 'checkout');
  const packageDir = join(root, 'package');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  const git = (args, opts = {}) => gitAt(checkout, args, opts);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Wave Fixture']);
  writeFileSync(join(checkout, '.gitignore'), 'build/\n');
  const write = (rel, content) => {
    mkdirSync(dirname(join(checkout, rel)), { recursive: true });
    writeFileSync(join(checkout, rel), content);
  };
  write('src/a.mjs', 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  write('src/a.mjs', 'export const a = 2;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'head']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const commit = (message = 'mutation') => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']).trim(); };
  // A commit whose ancestry never includes `head`: foreign to a fixer submission.
  const orphan = () => git(['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'orphan']).trim();
  // A descendant of `head` left unchecked out, so HEAD differs from the listed commit.
  const childCommit = () => git(['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'child']).trim();

  const providerExt = join(root, 'provider-ext.ts');
  writeFileSync(providerExt, 'export {};\n');
  const fake = join(root, 'fake-pi.cjs');
  writeFileSync(fake, [
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "if (process.env.SPEC_RUNTIME_ROLE) writeFileSync(join(__dirname, `spawned-${process.env.SPEC_RUNTIME_ROLE}`), 'spawned');",
    "console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] } }));"
  ].join('\n'));
  const marker = role => join(root, `spawned-${role}`);

  const runRecord = (over = {}) => {
    mkdirSync(join(packageDir, 'runtime', 'runs'), { recursive: true });
    writeFileSync(join(packageDir, 'runtime', 'runs', `${id}.json`), JSON.stringify({ id, state: 'running', package: packageDir, checkout, ...over }));
  };
  runRecord();

  const record = (over = {}) => {
    const { stage: stageOver, ...rest } = over;
    const stage = {
      role: 'reviewer', label: REVIEW_LABEL, base, head, round: 1,
      packet: { index: 1, total: 1, ids: ['F1'], pending_after: [], ranges: [], findings: [] },
      ...stageOver
    };
    return {
      package: packageDir, id, checkout, step: join(packageDir, 'step-001-subspec.md'),
      owner_model: 'fixture-provider/team/owner',
      owner_session: 'owner-session', reviewer_session: 'reviewer-session', fixer_session: 'fixer-session',
      review_model: 'fixture-provider/team/reviewer:high', fix_model: 'fixture-provider/team/owner',
      child_extensions: [providerExt],
      stage, ...rest
    };
  };

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, checkout, package: packageDir, id, base, head, providerExt, fake,
    git, write, commit, orphan, childCommit, runRecord, record, marker,
    hasMarker: role => existsSync(marker(role))
  };
}

// --- installed-SDK role harnesses (verification cases 2 and 3) -------------

// Load the local extension with the real installed SDK loader for exactly one
// SPEC_RUNTIME_ROLE value and one native tool inventory. A fresh runtime and an
// EventEmitter-backed event bus are used per load. The run record is written to
// its real path because both the extension factory and assertLease read it from
// disk. The extension's own registered tools are unioned into getAllTools after
// load, matching the real Pi API where they are visible to the role guard.
export async function loadNativeRole(t, { role, builtins = [], record: over = {} } = {}) {
  const loader = await loadSdk();
  const fixture = makeStageFixture(t);
  const record = fixture.record(over);
  fixture.runRecord(record);
  const recordFile = join(fixture.package, 'runtime', 'runs', `${fixture.id}.json`);
  const runtime = loader.createExtensionRuntime();
  // The real Pi event bus exposes only the SDK subscription API; back it with a
  // private emitter and pass `emit` through so fixtures can still drive events.
  const emitter = new EventEmitter();
  const eventBus = { on: (name, handler) => { emitter.on(name, handler); return () => emitter.off(name, handler); }, emit: emitter.emit.bind(emitter) };
  const entries = [];
  const active = [];
  let extension;
  runtime.getAllTools = () => [...builtins, ...(extension ? [...extension.tools.keys()] : [])].map(name => ({ name }));
  runtime.appendEntry = (customType, data) => { entries.push({ customType, data }); };
  runtime.getSettings = () => ({});
  runtime.setActiveTools = names => { active.length = 0; active.push(...names); };
  const previous = { SPEC_RUNTIME_ROLE: process.env.SPEC_RUNTIME_ROLE, SPEC_RUNTIME_RECORD: process.env.SPEC_RUNTIME_RECORD };
  let loaded;
  try {
    if (role) process.env.SPEC_RUNTIME_ROLE = role; else delete process.env.SPEC_RUNTIME_ROLE;
    process.env.SPEC_RUNTIME_RECORD = recordFile;
    loaded = await loader.loadExtensions([SPEC_RUNTIME_INDEX], fixture.checkout, eventBus, runtime);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (loaded.errors.length) throw new Error(`installed SDK failed to load index.ts: ${JSON.stringify(loaded.errors)}`);
  extension = loaded.extensions[0];
  return { fixture, record, recordFile, runtime, eventBus, entries, active, extension, loaded, role };
}

// Invoke every session_start hook with a matching selected model and the minimal
// session-manager / UI surface the role guards read.
export async function startNativeRole(harness, model) {
  const ctx = { model, sessionManager: { getBranch: () => [], getSessionFile: () => null, getSessionId: () => harness.fixture.id }, ui: { notify() {} } };
  for (const hook of harness.extension.handlers.get('session_start') || []) await hook({ type: 'session_start' }, ctx);
}

// The first tool_call hook decision that blocks `name`, or null when every hook
// allows it. Each call advances any stateful guard exactly once.
export function nativeToolBlocked(harness, name, input = {}) {
  for (const hook of harness.extension.handlers.get('tool_call') || []) {
    const reply = hook({ type: 'tool_call', toolName: name, input }, {});
    if (reply && reply.block) return reply;
  }
  return null;
}

// Spawn a real child that loads the local extension for one role and runs its
// session_start hooks, so capability and selector refusals are observed as
// exit-78 process failures rather than in-process throws.
export function runNativeStartChild(t, { role, tools, model, record: over = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wave-native-child-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'runtime', 'runs'), { recursive: true });
  const recordFile = join(root, 'runtime', 'runs', 'fixture.json');
  writeFileSync(recordFile, JSON.stringify({ id: 'fixture', state: 'running', package: root, checkout: root,
    step: join(root, 'step-001-subspec.md'), ...over }));
  const script = join(root, 'start.mjs');
  writeFileSync(script, [
    "import { EventEmitter } from 'node:events';",
    `import { loadExtensions, createExtensionRuntime } from ${JSON.stringify(pathToFileURL(SDK_LOADER).href)};`,
    'const runtime = createExtensionRuntime();',
    `const names = ${JSON.stringify(tools)};`,
    'runtime.getAllTools = () => names.map(name => ({ name }));',
    'runtime.appendEntry = () => {};',
    'runtime.getSettings = () => ({});',
    'runtime.setActiveTools = () => {};',
    'const emitter = new EventEmitter();',
    "const eventBus = { on: (name, handler) => { emitter.on(name, handler); return () => emitter.off(name, handler); }, emit: emitter.emit.bind(emitter) };",
    `const loaded = await loadExtensions([${JSON.stringify(SPEC_RUNTIME_INDEX)}], ${JSON.stringify(root)}, eventBus, runtime);`,
    'if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));',
    'const extension = loaded.extensions[0];',
    `for (const hook of extension.handlers.get('session_start') || []) await hook({ type: 'session_start' }, { model: ${JSON.stringify(model)}, sessionManager: { getBranch: () => [] }, ui: { notify() {} } });`,
    "console.log('SESSION_START_COMPLETED');"
  ].join('\n'));
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, SPEC_RUNTIME_ROLE: role, SPEC_RUNTIME_RECORD: recordFile },
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
  });
}

// --- real wave/lifecycle fixture (step 008) --------------------------------
//
// makeWaveFixture stands up one REAL, disposable wave membership on the host: a
// located package, a committed base, a live package claim in the flock ownership
// registry, a prepared overlayfs attempt (prepareStepWorkspace), a private
// review Git worktree, and a service adapter that substitutes only the
// bwrap/systemd transport. The production Runtime is exposed unchanged: cases
// drive it through Runtime.start/startStage; nothing fabricates wave_bindings and
// nothing calls containedStage directly. No kernel, host or real-systemd claim
// is made: the same containment policy runs in real child processes.

const WAVE_ID = 'w1';
const WAVE_STEP = 1;
const WAVE_ATTEMPT = 'attempt1';
const WAVE_STEP_FILE = 'step-001-subspec.md';

export const WAVE_MODELS = Object.freeze({
  owner: 'fixture-provider/team/owner',
  reviewer: 'fixture-provider/team/reviewer:high'
});

const fixtureGit = (cwd, args, opts = {}) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });

// Copy a directory tree, preserving symlinks and the executable bit. The frozen
// lower carries no .git metadata, so a straight copy is a clean worktree source.
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
    else if (entry.isDirectory()) copyTree(source, destination);
    else if (entry.isFile()) { copyFileSync(source, destination); chmodSync(destination, lstatSync(source).mode & 0o777); }
  }
}

// The contained launch argv is the bwrap overlay wrapper (when layers exist) or
// the bare bootstrap. The transport double runs the trailing bootstrap verbatim.
function unwrapBootstrap(argv) {
  const marker = argv.indexOf('--');
  return marker >= 0 ? argv.slice(marker + 1) : argv.slice();
}

// A scenario-driven native role stub. It reads the REAL run record, imports the
// under-test wave-review.mjs and submits through the production submitStage /
// recordStageFingerprint. `hold` blocks on an fs.watch barrier (no polling).
const FAKE_PI_SOURCE = [
  "import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, watch } from 'node:fs';",
  "import { dirname } from 'node:path';",
  "import { spawnSync } from 'node:child_process';",
  "const root = process.env.SPEC_RUNTIME_FIXTURE_ROOT;",
  "const role = process.env.SPEC_RUNTIME_ROLE;",
  "const log = line => appendFileSync(root + '/children.log', role + ' ' + line + '\\n');",
  "log('started');",
  "const scenario = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_FIXTURE_SCENARIO, 'utf8'));",
  "if (scenario.hold && scenario.hold[role]) {",
  "  writeFileSync(root + '/ready-' + role, '');",
  "  await new Promise(resolve => {",
  "    let watcher = null;",
  "    const done = () => { if (watcher) { try { watcher.close(); } catch {} } resolve(); };",
  "    watcher = watch(root, (event, filename) => { if (filename === 'go-' + role) done(); });",
  "    if (existsSync(root + '/go-' + role)) done();",
  "  });",
  "}",
  "const record = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_RECORD, 'utf8'));",
  "const review = await import(process.env.SPEC_RUNTIME_FIXTURE_WAVE_REVIEW);",
  "const runtimeModule = await import(process.env.SPEC_RUNTIME_FIXTURE_RUNTIME);",
  "const completion = await import(process.env.SPEC_RUNTIME_FIXTURE_COMPLETION);",
  "const cwd = process.cwd();",
  "// The real run record is read, then checkout is retargeted in memory only for",
  "// fingerprint, submission and completion. Ids, models, leases and the durable",
  "// run record are unchanged.",
  "const submitted = { ...record, checkout: cwd };",
  "const applyMutations = mutations => {",
  "  for (const [rel, content] of Object.entries(mutations || {})) {",
  "    const full = cwd + '/' + rel;",
  "    mkdirSync(dirname(full), { recursive: true });",
  "    writeFileSync(full, content);",
  "  }",
  "};",
  "const commit = message => {",
  "  const added = spawnSync('git', ['-C', cwd, 'add', '-A']);",
  "  if (added.status !== 0) return null;",
  "  const committed = spawnSync('git', ['-C', cwd, 'commit', '-qm', message]);",
  "  if (committed.status !== 0) return null;",
  "  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });",
  "  return head.status === 0 ? head.stdout.trim() : null;",
  "};",
  "const stepNumber = Number((/step-(\\d+)-subspec\\.md$/.exec(record.step) || [])[1]);",
  "const completeOwner = async spec => {",
  "  const plan = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_FIXTURE_PACKAGE + '/evidence-plan.json', 'utf8'));",
  "  const gates = plan.gates.filter(gate => Number(gate.ownerStep) === stepNumber);",
  "  const evidence = [];",
  "  for (const gate of gates) {",
  "    const command = gate.command;",
  "    const artifact = gate.artifact || ('evidence/' + gate.id + '.txt');",
  "    const full = process.env.SPEC_RUNTIME_FIXTURE_PACKAGE + '/' + artifact;",
  "    mkdirSync(dirname(full), { recursive: true });",
  "    const before = completion.revision(submitted);",
  "    const run = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });",
  "    writeFileSync(full, ((run.stdout || '') + (run.stderr || '')) || 'ok\\n');",
  "    const after = completion.revision(submitted);",
  "    const receipt = completion.recordVerification(submitted, command, before, after,",
  "      { exit_code: run.status, error: run.error ? String(run.error) : null, full_output_path: full },",
  "      { started_at: new Date().toISOString(), elapsed_ms: 0 });",
  "    evidence.push({ id: gate.id, status: run.status === 0 ? 'passed' : 'failed', receipt_id: receipt.id, proof_boundary: 'owner step 1 focused check' });",
  "  }",
  "  const decisions = (spec.completion || {}).decisions || [];",
  "  await runtimeModule.runCompletion(submitted, {",
  "    outcome: (spec.completion || {}).outcome || 'as-specified',",
  "    decisions, gaps: [], findings: [], introduced: [], strategy: 'implementation-first', evidence",
  "  });",
  "};",
  "const exitCode = scenario.transportExit === true ? 1 : scenario.transportExit?.[role];",
  "if (exitCode) process.exit(typeof exitCode === 'number' ? exitCode : 1);",
  "if (role === 'owner') {",
  "  const spec = scenario.owner || {};",
  "  applyMutations(spec.mutations);",
  "  if (spec.commit !== false) commit('implementation');",
  "  if (spec.completeOwner !== false) await completeOwner(spec);",
  "} else if (role === 'reviewer') {",
  "  review.recordStageFingerprint(submitted);",
  "  review.submitStage(submitted, 'reviewer', (scenario.reviewer || {}).payload);",
  "} else if (role === 'fixer') {",
  "  const spec = scenario.fixer || {};",
  "  applyMutations(spec.mutations);",
  "  const head = spec.commit === false ? null : commit('fix');",
  "  if (spec.autoFix === true) {",
  "    const packet = record.stage?.packet ?? {};",
  "    const payload = {",
  "      commits: head ? [head] : [],",
  "      decisions: (packet.ids ?? []).map(id => ({ id, decision: 'fixed', signature: 'fixture-auto-fix', note: 'fixed by fixture transport' })),",
  "      evidence: [], unresolved: []",
  "    };",
  "    if ((packet.index ?? 1) === 1) payload.triage = { summary: 'fixture auto-fix', fallback: false };",
  "    review.submitStage(submitted, 'fixer', payload);",
  "  } else {",
  "    const payload = spec.payload && typeof spec.payload === 'object' ? { ...spec.payload } : spec.payload;",
  "    if (payload && payload.commit === 'auto' && head) payload.commit = head;",
  "    review.submitStage(submitted, 'fixer', payload);",
  "  }",
  "}",
  "log('submitted');",
  "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'fixture stage submitted' }] } }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');"
].join('\n');

export async function makeWaveFixture(t, { backend = 'overlayfs' } = {}) {
  const pkg = await makePackageFixture({ prefix: 'wave-review-real-', slug: 'wave', repos: ['alpha'] });
  const root = pkg.dir;
  const repo = pkg.repo;
  const packagePath = pkg.packagePath;
  const packageRef = pkg.ref;
  const targetId = pkg.locations?.targets?.[0]?.id ?? 'alpha';

  // Separate the canonical common Git dir from the target worktree before any
  // commit: `repo/.git` becomes a pointer file and `root/common.git` is the one
  // common dir shared by the location record, the preparation target and every
  // later private view.
  const commonGitDir = join(root, 'common.git');
  renameSync(join(repo, '.git'), commonGitDir);
  writeFileSync(join(repo, '.git'), `gitdir: ${commonGitDir}\n`);
  if (pkg.locations?.targets?.[0]) pkg.locations.targets[0].common = commonGitDir;
  try {
    const locationsFile = join(packagePath, 'locations.json');
    const locations = JSON.parse(readFileSync(locationsFile, 'utf8'));
    if (locations?.targets?.[0]) { locations.targets[0].common = commonGitDir; writeFileSync(locationsFile, JSON.stringify(locations, null, 2)); }
  } catch { /* the durable locations record is optional for the fixture foundation */ }

  // Canonical base: the target worktree is committed clean at `base` and never
  // moves again; the implementation commit lands only in the private view.
  const writeTo = (baseDir, rel, content) => { const full = join(baseDir, rel); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); };
  writeTo(repo, 'src/a.mjs', 'export const a = 1;\n');
  writeTo(repo, 'src/b.mjs', 'export const b = 10;\n');
  writeTo(repo, 'src/c.mjs', 'export const c = 100;\n');
  writeTo(repo, 'test/a.test.mjs', "import { a } from '../src/a.mjs';\nexport const ok = a === 1;\n");
  writeTo(repo, 'docs/old.md', '# old\n');
  writeTo(repo, '.gitignore', 'build/\n');
  writeTo(repo, 'build/ignored.txt', 'generated\n');
  writeTo(repo, 'check.mjs', 'process.exit(0);\n');
  fixtureGit(repo, ['add', '-A']);
  fixtureGit(repo, ['commit', '-qm', 'base']);
  const base = fixtureGit(repo, ['rev-parse', 'HEAD']).trim();
  const commonDir = commonGitDir;

  // Card + step/evidence index. A single target means stepTarget() needs no
  // repository; the card carries the canonical verification block, the index
  // declares the wave-owned writes and the merge gate, and evidence-plan.json
  // is the single source of gate obligations.
  const stepFile = join(packagePath, WAVE_STEP_FILE);
  writeFileSync(stepFile, [
    '# Step 001 — wave fixture',
    '',
    'Wave review/fix foundation fixture. The card defines one owned target and',
    'one evidence seam; the tests supply the accepted review/fix behavior.',
    '',
    '```yaml',
    'planning:',
    '  version: 2',
    `  step: ${WAVE_STEP}`,
    `  output_file: ${WAVE_STEP_FILE}`,
    '  verdict: ready',
    '```',
    '',
    '```yaml',
    'verification:',
    '  strategy: implementation-first',
    '  commands:',
    '    - node check.mjs',
    '  test_files:',
    '    - test/a.test.mjs',
    '  cases:',
    '    - node check.mjs exits successfully',
    '```',
    ''
  ].join('\n'));
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify({
    version: 1,
    setup: { [targetId]: 'none' },
    wave_checks: [{ after: WAVE_STEP, owner_step: WAVE_STEP, gates: [] }],
    steps: [{ step: WAVE_STEP, repository: targetId, difficulty: 'hard', requires: [], writes: ['src/a.mjs', 'src/b.mjs', 'test/a.test.mjs'] }]
  }, null, 2));
  writeFileSync(join(packagePath, 'evidence-plan.json'), JSON.stringify({
    version: 2,
    gates: [{ id: 'EV-1', ownerStep: WAVE_STEP, required: true, phase: 'merge', kind: 'deterministic-inspection', command: 'node check.mjs', rejects: ['node check.mjs exits nonzero'], artifact: 'evidence/check.txt' }]
  }, null, 2));

  // Real ownership registry + a live package claim owned by this process.
  const indexDir = join(root, 'runtime-index');
  const ownershipRoot = join(indexDir, 'ownership');
  const ownership = createOwnership({ registryRoot: ownershipRoot });
  const coordinator = { session: `wave-fixture-${process.pid}`, epoch: 1, pid: process.pid, started_at: inspectProcess(process.pid).started_at };
  const acquired = await ownership.acquirePackage({ packageId: packageRef, packagePath, coordinator });
  const packageClaim = acquired.claim;

  // The preparation accepts the already-approved base workspace directly: no
  // outer staging snapshot or digest is required, only the unstaged drain
  // confirmation and `setup: 'none'`.
  const setup = 'none';
  const preparationReceipt = { ok: true, drain: 'confirmed', baseCommit: base, trackedClean: true };
  const capability = backend === 'worktree'
    ? { status: 'unavailable', reason: 'bwrap-absent', fallbackEligible: true }
    : { status: 'supported', reason: 'overlay-supported' };

  const waveRoot = join(indexDir, 'waves', WAVE_ID);
  const workspace = await prepareStepWorkspace({
    packageId: packageRef, attemptId: WAVE_ATTEMPT, baseCommit: base, waveRoot,
    target: { worktree: repo, gitCommonDir: commonDir },
    ownership, coordinator, mode: backend === 'worktree' ? 'auto' : 'overlayfs', capability,
    setup, env: {}, preparationReceipt, phaseToken: `phase-${WAVE_ATTEMPT}`
  });

  // Private review worktree. Overlay: the frozen lower is copied to `view` with
  // a private .git pointer and core.worktree=view. Worktree fallback: the
  // prepared worktree itself is the view and no missing lower is copied.
  const view = workspace.backend === 'worktree' ? workspace.worktree : join(indexDir, 'view');
  if (workspace.backend !== 'worktree') {
    copyTree(workspace.lower, view);
    writeFileSync(join(view, '.git'), `gitdir: ${workspace.gitDir}\n`);
    fixtureGit(view, ['config', 'core.worktree', view]);
  }
  fixtureGit(view, ['config', 'user.email', 'fixture@example.test']);
  fixtureGit(view, ['config', 'user.name', 'Wave Fixture']);
  writeFileSync(join(view, 'src/a.mjs'), 'export const a = 2;\n');
  fixtureGit(view, ['add', '-A']);
  fixtureGit(view, ['commit', '-qm', 'implementation']);
  const implementationHead = fixtureGit(view, ['rev-parse', 'HEAD']).trim();

  // Transport controls: PATH-injected native role stub and a mutable scenario.
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakePi = join(root, 'fake-pi.mjs');
  writeFileSync(fakePi, FAKE_PI_SOURCE);
  const piWrapper = join(binDir, 'pi');
  writeFileSync(piWrapper, `#!/bin/sh\nexec node ${JSON.stringify(fakePi)} "$@"\n`, { mode: 0o755 });
  chmodSync(piWrapper, 0o755);
  const scenarioFile = join(root, 'scenario.json');
  const scenario = {
    owner: { mutations: { 'src/a.mjs': 'export const a = 2;\n' }, commit: false, completeOwner: true },
    reviewer: { payload: null },
    fixer: { mutations: {}, payload: null },
    drainOutcome: 'confirmed',
    hold: {}
  };
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const setScenario = patch => { Object.assign(scenario, patch); writeFileSync(scenarioFile, JSON.stringify(scenario)); return scenario; };

  // Real Runtime with the transport double in place of bwrap/systemd.
  const events = new EventEmitter();
  const launches = [];
  const drains = [];
  const sessions = new Set();
  const children = new Set();
  const adapter = {
    async start({ argv, register }) {
      const bootstrap = unwrapBootstrap(argv);
      // Two real launch shapes reach the transport. A worker bootstrap is
      // `node -e <bootstrap> <requestfile>`: the trailing argv is a JSON
      // request that the fixture retargets in place. A command phase is
      // `/bin/bash -o pipefail -c <command>`: the trailing argv is the shell
      // command itself and must run verbatim against the real Git view.
      const isWorker = bootstrap.length >= 4 && bootstrap[1] === '-e';
      let request = null;
      let requestFile = null;
      if (isWorker) {
        requestFile = bootstrap[bootstrap.length - 1];
        request = JSON.parse(readFileSync(requestFile, 'utf8'));
        request.checkout = view;
        if (request.gitDir) request.gitDir = workspace.gitDir;
        request.env = { ...request.env, PATH: `${binDir}:${request.env?.PATH ?? process.env.PATH ?? ''}`,
          SPEC_RUNTIME_FIXTURE_ROOT: root, SPEC_RUNTIME_FIXTURE_SCENARIO: scenarioFile,
          SPEC_RUNTIME_FIXTURE_PACKAGE: packagePath,
          SPEC_RUNTIME_FIXTURE_RUNTIME: pathToFileURL(join(here, 'runtime.mjs')).href,
          SPEC_RUNTIME_FIXTURE_COMPLETION: pathToFileURL(join(here, 'completion.mjs')).href,
          SPEC_RUNTIME_FIXTURE_WAVE_REVIEW: pathToFileURL(join(here, 'wave-review.mjs')).href };
        writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600 });
      }
      const unit = `wave-fixture-${launches.length + 1}.service`;
      const invocation = `inv-${launches.length + 1}`;
      const child = spawn(bootstrap[0], bootstrap.slice(1), { cwd: view, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr = [];
      child.stderr?.on('data', chunk => stderr.push(String(chunk)));
      children.add(child);
      child.on('close', () => children.delete(child));
      const sessionIndex = request ? request.args.indexOf('--session') : -1;
      const record = { id: `svc-${launches.length + 1}`, unit, invocation, status: 'running', main_pid: child.pid,
        cwd: view, argv, request: requestFile, role: request?.role ?? null, stage: request?.stage ?? null,
        session: sessionIndex >= 0 ? request.args[sessionIndex + 1] ?? null : null,
        get stderr() { return stderr.join(''); } };
      launches.push(record);
      sessions.add(record.id);
      if (typeof register === 'function' && register(record) !== true) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        throw new Error(`service registration rejected: ${record.id}`);
      }
      return { ok: true, status: 'running', unit, invocation, main_pid: child.pid, child, record };
    },
    async stop(service) {
      drains.push({ id: service?.id ?? null, status: 'confirmed' });
      if (service?.id) sessions.delete(service.id);
      const pid = service?.main_pid;
      if (Number.isSafeInteger(pid)) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      const child = [...children].find(candidate => candidate.pid === pid);
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => child.once('close', resolve));
      }
      return { status: 'confirmed' };
    },
    async drain(service) {
      const stopped = await adapter.stop(service);
      const outcome = scenario.drainOutcome ?? 'confirmed';
      const status = outcome === 'unknown' ? 'unknown' : stopped.status;
      drains.push({ id: service?.id ?? null, status });
      return { status };
    },
    async isActive() { return false; }
  };
  const runtime = new Runtime({ location: pkg.location, indexDir, ownershipRoot, ownership, serviceAdapter: adapter,
    notify: event => events.emit('worker', event) });

  // Durable wave record. The member workspace is the prepared workspace as
  // returned; the production binding resolves record.checkout from it directly.
  const waveFile = join(packagePath, 'runtime', 'waves', `${WAVE_ID}.json`);
  let phase = 'implementing';
  let implementationRunId = null;
  const memberWorkspace = workspace;
  const buildWave = () => ({
    version: 1, package_ref: packageRef, claim_token: packageClaim.token,
    coordinator: { session: coordinator.session, epoch: coordinator.epoch, pid: coordinator.pid, started_at: coordinator.started_at },
    generation: 1,
    target: { id: targetId, base_commit: base, common: commonDir, integration_checkout: repo },
    members: { [String(WAVE_STEP)]: { step: WAVE_STEP, attempt_id: WAVE_ATTEMPT, phase, run_id: null, workspace: memberWorkspace } }
  });
  const writeWave = record => { mkdirSync(dirname(waveFile), { recursive: true }); writeFileSync(waveFile, JSON.stringify(record, null, 2)); events.emit('wave', record); return record; };
  writeWave(buildWave());

  const waitIn = role => new Promise(resolve => {
    const target = join(root, `ready-${role}`);
    if (existsSync(target)) return resolve();
    const watcher = watch(root, (event, filename) => { if (filename === `ready-${role}`) { watcher.close(); resolve(); } });
  });
  const release = role => { writeFileSync(join(root, `go-${role}`), ''); };

  t.after(async () => {
    for (const [id] of [...runtime.active]) { try { await runtime.cancel(packagePath, id); } catch {} }
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    }
    await Promise.all([...children].map(child => child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const fixture = {
    root, indexDir, ownershipRoot, ownership, coordinator, packageClaim, packagePath, packageRef, location: pkg.location,
    repo, targetId, base, commonDir, workspace, memberWorkspace, view, gitDir: workspace.gitDir, implementationHead,
    stepFile, waveFile, scenarioFile, fakePi, binDir, launches, drains, sessions, children, events, runtime, adapter,
    get head() { return fixtureGit(view, ['rev-parse', 'HEAD']).trim(); },
    get phase() { return phase; },
    get implementationRunId() { return implementationRunId; },
    git: (args, opts = {}) => fixtureGit(view, args, opts),
    write: (rel, content) => writeTo(view, rel, content),
    readRecord: id => loadRun(packagePath, id),
    wave: {
      file: waveFile,
      read: () => JSON.parse(readFileSync(waveFile, 'utf8')),
      write: patch => writeWave({ ...JSON.parse(readFileSync(waveFile, 'utf8')), ...patch })
    },
    setPhase: next => { phase = next; const record = JSON.parse(readFileSync(waveFile, 'utf8')); record.members[String(WAVE_STEP)].phase = next; return writeWave(record); },
    setScenario, release, waitIn,
    waitForEvent: name => new Promise(resolve => events.once(name, resolve)),
    async start(over = {}) {
      const run = await runtime.start({
        package: packagePath, step: stepFile, owner_model: WAVE_MODELS.owner, editor_model: WAVE_MODELS.owner, attempt_kind: 'implementation',
        wave_id: WAVE_ID, expected_generation: 1, step_number: WAVE_STEP, attempt_id: WAVE_ATTEMPT, phase,
        claim_token: packageClaim.token, coordinator_epoch: coordinator.epoch, ...over
      });
      if (run?.run_id) implementationRunId = run.run_id;
      return run;
    },
    async startStage(input) { return runtime.startStage(input); },
    async completeImplementation(payload) {
      if (!implementationRunId) throw new Error('start() must run before completeImplementation()');
      return runCompletion(loadRun(packagePath, implementationRunId), payload);
    },
    async waitForRun(id, { timeout = 5000 } = {}) {
      const terminal = new Set(['closed', 'cancelled', 'failed', 'exited', 'completed', 'blocked']);
      const readRun = () => { try { return loadRun(packagePath, id); } catch { return null; } };
      const settled = () => { const run = readRun(); return Boolean(run && terminal.has(run.state)); };
      if (settled()) return readRun();
      return new Promise((resolve, reject) => {
        const onEvent = event => { if ((event?.run_id ?? event?.id) === id && settled()) finish(resolve, readRun()); };
        let timer = null;
        const finish = (settle, value) => { if (timer) clearTimeout(timer); events.removeListener('worker', onEvent); settle(value); };
        events.on('worker', onEvent);
        // Close the race where the run reached a terminal state between the
        // pre-listener check and listener registration.
        if (settled()) finish(resolve, readRun());
        else timer = setTimeout(() => {
          const current = readRun();
          finish(reject, new Error(`Timed out after ${timeout}ms waiting for run ${id} to reach a terminal state: ${fixtureFailure(fixture, current)}`));
        }, timeout);
      });
    },
    async drain() {
      for (const service of [...sessions]) { try { await adapter.drain({ id: service }); } catch {} }
      await Promise.all([...children].map(child => child.exitCode === null && child.signalCode === null
        ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve()));
      return { launches: launches.length, drains: drains.length };
    }
  };
  return fixture;
}

// ---------------------------------------------------------------------------
// verification case 8: bounded full-cycle driver (review -> fix -> confirmation
// -> seal). The durable attempt id is fixed; a per-fixture stage_attempt counter
// increments once per stage so a retry never reuses a run identity.

const stageAttempts = new WeakMap();
function nextStageAttempt(f) {
  const next = (stageAttempts.get(f) ?? 0) + 1;
  stageAttempts.set(f, next);
  return next;
}

// Identity fields binding every stage to the wave member's generation and the
// live package claim. Exported so a test can attempt a premature launch.
export function waveIdentity(f) {
  return {
    package: f.packagePath, step: f.stepFile, wave_id: WAVE_ID,
    expected_generation: 1, step_number: WAVE_STEP, attempt_id: WAVE_ATTEMPT,
    claim_token: f.packageClaim.token, coordinator_epoch: f.coordinator.epoch
  };
}

// Compact JSON of the observable child-side and durable facts for a failed,
// blocked, cancelled or timed-out fixture run. Reports the run record, the
// launching service's argv/request facts (no env or secrets), the child stderr,
// the completion receipt when present, checkout HEAD/status and the live claim
// tokens. It captures facts for assertions; it never repairs state.
export function fixtureFailure(f, record = null) {
  const run = record ?? null;
  const launch = [...(f.launches ?? [])].reverse().find(entry => entry.role != null) ?? f.launches?.[f.launches.length - 1] ?? null;
  let request = null;
  if (launch?.request) {
    try {
      const parsed = JSON.parse(readFileSync(launch.request, 'utf8'));
      request = { command: parsed.command ?? null, checkout: parsed.checkout ?? null, role: parsed.role ?? null, stage: parsed.stage ?? null, session: parsed.session ?? null };
    } catch { request = null; }
  }
  const completionPath = f.implementationRunId ? join(f.packagePath, 'runtime', 'runs', `${f.implementationRunId}.json`) : null;
  let completion = null;
  if (completionPath && existsSync(completionPath)) {
    try { const parsed = JSON.parse(readFileSync(completionPath, 'utf8')); completion = { state: parsed.state ?? null, stop_reason: parsed.stop_reason ?? null, error: parsed.error ?? null, result: parsed.result ?? null }; } catch { completion = null; }
  }
  let head = null;
  let status = null;
  try { head = fixtureGit(f.view, ['rev-parse', 'HEAD']).trim(); } catch { head = null; }
  try { status = fixtureGit(f.view, ['status', '--porcelain']).trim(); } catch { status = null; }
  const claims = (() => {
    try {
      return f.ownership.inspectClaims({ packageId: f.packageRef }).claims
        .filter(claim => claim.running === true)
        .map(claim => ({ kind: claim.kind, token: claim.token }));
    } catch { return []; }
  })();
  return JSON.stringify({
    run_id: run?.run_id ?? run?.id ?? launch?.id ?? null,
    state: run?.state ?? null,
    error: run?.error ?? null,
    result: run?.result ?? null,
    stop_reason: run?.stop_reason ?? null,
    argv: launch?.argv ?? null,
    request,
    stderr: launch?.stderr ?? '',
    completion,
    checkout: { head, status },
    claims
  });
}

// Start the owner completion and wait for its terminal record; a non-completing
// implementation never proceeds to review.
export async function initializeWave(f) {
  const run = await f.start();
  const record = await f.waitForRun(run.run_id);
  if (record.state === 'failed' || record.state === 'blocked' || record.state === 'cancelled')
    throw new Error(`implementation run ${run.run_id} ended ${record.state}: ${fixtureFailure(f, record)}`);
  return record;
}

// The durable outcome-table state for the wave member and its implementation run.
export function waveState(f) {
  return readReviewState({
    packageDir: f.packagePath, waveId: WAVE_ID, step: f.stepFile,
    member: f.wave.read().members[String(WAVE_STEP)],
    implementationRunId: f.implementationRunId, ownership: f.ownership
  });
}

// Run the step-owned command gates against the accepted packet's own record, so
// each receipt's observed revision is that packet's commit.
export async function gateAction(f, action) {
  const state = await waveState(f);
  return runStageGates({
    runtime: f.runtime, ownership: f.ownership, identity: waveIdentity(f),
    record: f.readRecord(action.run_id), gates: state.gates, head: action.head
  });
}

// Seal the reviewed head using the durable step index, the location targets and
// the current review state.
export async function sealFixture(f) {
  const state = await waveState(f);
  const index = JSON.parse(readFileSync(join(f.packagePath, 'spec-steps.json'), 'utf8'));
  // The seal pipeline consumes canonical target ids, not the durable location
  // records; project each location down to its id before sealing.
  const targets = JSON.parse(readFileSync(join(f.packagePath, 'locations.json'), 'utf8')).targets
    .map(target => target?.id ?? target).filter(Boolean);
  return sealMember({
    runtime: f.runtime, ownership: f.ownership, identity: waveIdentity(f),
    record: f.readRecord(f.implementationRunId), index, targets, state
  });
}

// Map one canonical action to the phase, canonical label and revisions its stage
// start requires. Fixer packets inherit the reviewed head.
function stageRequest(f, action) {
  const fix = action.action === 'launch-fix-packet';
  const round = action.round ?? 1;
  return {
    fix,
    phase: fix ? 'fixing' : (action.action === 'launch-confirmation' ? 'confirming' : 'reviewing'),
    role: fix ? 'fixer' : 'reviewer',
    round,
    label: action.label ?? stageLabel(WAVE_ID, WAVE_STEP, round),
    base: fix ? f.head : action.base,
    head: fix ? f.head : action.head
  };
}

// Launch one canonical action. `payload` is the review payload; `mutations` are
// the fake fixer's file writes. `hold` returns the run and its pending wait so
// the caller can drive the transport barrier before releasing it.
export async function launchAction(f, action, { payload, mutations, hold = false, allowFailure = false, scenario: scenarioPatch } = {}) {
  if (action.action === 'run-gates') return gateAction(f, action);
  if (action.action === 'seal') return sealFixture(f);
  if (!['launch-review', 'launch-confirmation', 'launch-fix-packet'].includes(action.action))
    throw new Error(`launchAction cannot launch ${action.action}`);
  const req = stageRequest(f, action);
  f.setPhase(req.phase);
  await f.runtime.remountWaveMember({ ...waveIdentity(f), phase: req.phase });
  if (req.fix) {
    f.setScenario({ fixer: { mutations: mutations ?? {}, commit: true, autoFix: true }, hold: hold ? { fixer: true } : {} });
  } else {
    f.setScenario({ reviewer: { payload }, hold: hold ? { reviewer: true } : {} });
  }
  // A scenario patch is applied after the defaults so a caller can substitute an
  // explicit empty fixer payload, a commit:false packet or a transport failure.
  if (scenarioPatch) f.setScenario(scenarioPatch);
  // A held stage must observe a fresh barrier: a stale ready/go pair from an
  // earlier release would let the child proceed before the caller waits on it.
  if (hold) {
    for (const role of ['reviewer', 'fixer']) {
      rmSync(join(f.root, `ready-${role}`), { force: true });
      rmSync(join(f.root, `go-${role}`), { force: true });
    }
  }
  const stage = {
    role: req.role, label: req.label, round: req.round, base: req.base, head: req.head,
    ...(req.fix
      ? { packet: { index: action.packet.index, total: action.packet.total ?? 1, ids: action.packet.ids ?? [],
          pending_after: action.packet.pending_after ?? [], ranges: action.packet.ranges ?? [], findings: action.packet.findings ?? [],
          split: action.packet.split ?? false },
          expected_ids: [...new Set([...(action.packet.ids ?? []), ...(action.packet.pending_after ?? [])])] }
      : { expected_ids: (payload?.findings ?? []).filter(finding => finding.actionable === true).map(finding => finding.id) })
  };
  const run = await f.startStage({
    ...waveIdentity(f), implementation_run_id: f.implementationRunId,
    stage_attempt: nextStageAttempt(f), phase: req.phase, stage,
    review_model: WAVE_MODELS.reviewer
  });
  const wait = f.waitForRun(run.run_id).then(record => {
    if (!allowFailure && (record.state === 'failed' || record.state === 'blocked'))
      throw new Error(`stage ${run.run_id} ended ${record.state}: ${fixtureFailure(f, record)}`);
    return record;
  });
  return hold ? { run, wait } : wait;
}

// Drive the initial implementation review and its planned fix packets up to the
// next confirmation or block. `mutations` is the fixer file map, or a function
// of the planned packet that returns one. Bounded at ten stages; an unexpected
// action throws so a stalled outcome table is never silently accepted.
export async function driveNeedsFix(f, review, mutations = {}) {
  await initializeWave(f);
  let next = nextReviewAction(await waveState(f));
  if (next.action !== 'launch-review')
    throw new Error(`driveNeedsFix expected launch-review, got ${JSON.stringify(next)}`);
  await launchAction(f, next, { payload: review });
  for (let i = 0; i < 10; i += 1) {
    next = nextReviewAction(await waveState(f));
    if (next.action === 'launch-confirmation' || next.action === 'block') return next;
    if (next.action === 'launch-fix-packet') {
      const packetMutations = typeof mutations === 'function' ? mutations(next.packet) : mutations;
      await launchAction(f, next, { mutations: packetMutations });
    } else if (next.action === 'run-gates') {
      await gateAction(f, next);
    } else {
      throw new Error(`driveNeedsFix unexpected action ${JSON.stringify(next)}`);
    }
  }
  throw new Error('driveNeedsFix exceeded ten iterations without a confirmation or block');
}

// ---------------------------------------------------------------------------
// verification case 11: seal-refusal matrix. One real fixture per row, driven
// through implementation completion and a real passing review (except the gate
// and held rows). The row name selects the single violation left for the seal
// to refuse. `makeSealRow` never seals: the caller's `sealFixture` observes the
// refusal against a state the helper did not repair. It also leaves the
// coordinator-visible merged mountpoint empty for the overlay backend.

// A round-1 pass. The fixture owner completion already recorded the step-owned
// merge gate receipt, so no fix packet is needed for gate evidence to be complete.
const SEAL_PASS = { verdict: 'pass', findings: [], fix_verdicts: [], limitations: [] };

function sealFinding(commit) {
  return {
    id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true,
    file: 'src/a.mjs', line: 1, symbol: 'a', signature: 'correctness:a',
    explanation: 'the exported constant is wrong', correction: 'restore the correct constant', commit
  };
}

// Launch the current round's real reviewer stage and wait for its result.
async function sealReview(f, review) {
  const next = nextReviewAction(await waveState(f));
  if (next.action !== 'launch-review')
    throw new Error(`makeSealRow expected launch-review, got ${JSON.stringify(next)}`);
  await launchAction(f, next, { payload: review });
}

export async function makeSealRow(t, row) {
  const f = await makeWaveFixture(t, { backend: row === 'worktree' ? 'worktree' : 'overlayfs' });

  // A failing real merge gate reached through a needs-fix round and its fixer
  // packet: check.mjs is rewritten to exit 1, so the seal's runtime gate receipt
  // exists but does not pass.
  if (row === 'gate') {
    await driveNeedsFix(f, { verdict: 'needs-fix', findings: [sealFinding(f.implementationHead)], fix_verdicts: [], limitations: [] },
      { 'src/a.mjs': 'export const a = 42;\n', 'check.mjs': 'process.exit(1);\n' });
    return { f };
  }

  await initializeWave(f);

  // Held rows: the reviewer is launched but its phase claim is never released.
  // `unknown` additionally kills the running process group so the runtime's
  // drain resolves to `unknown` rather than a live-held claim.
  if (row === 'live' || row === 'unknown') {
    const next = nextReviewAction(await waveState(f));
    if (next.action !== 'launch-review')
      throw new Error(`makeSealRow expected launch-review, got ${JSON.stringify(next)}`);
    if (row === 'unknown') f.setScenario({ drainOutcome: 'unknown' });
    const held = await launchAction(f, next, { payload: SEAL_PASS, hold: true });
    const wait = held.wait.catch(() => {});
    await f.waitIn('reviewer');
    if (row === 'unknown') {
      const pid = f.launches.at(-1)?.main_pid;
      if (Number.isSafeInteger(pid)) {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
      await wait;
    }
    return { f, wait };
  }

  // Pending row: a needs-fix review followed by a syntactically valid fixer
  // packet that decides nothing and commits nothing, so the finding stays
  // pending for the seal to refuse.
  if (row === 'pending') {
    await sealReview(f, { verdict: 'needs-fix', findings: [sealFinding(f.implementationHead)], fix_verdicts: [], limitations: [] });
    const next = nextReviewAction(await waveState(f));
    if (next.action !== 'launch-fix-packet')
      throw new Error(`makeSealRow expected launch-fix-packet, got ${JSON.stringify(next)}`);
    const emptyFix = { commits: [], decisions: [], evidence: [], unresolved: [], triage: { summary: 'no change requested', fallback: false } };
    await launchAction(f, next, { scenario: { fixer: { payload: emptyFix, commit: false, autoFix: false } } });
    return { f };
  }

  // Every remaining row starts from a real accepted passing review.
  await sealReview(f, SEAL_PASS);

  if (row === 'completion') {
    // Remove the actual submission so completionStatus reports handoff_incomplete.
    const completionFile = join(f.packagePath, 'runtime', 'runs', `${f.implementationRunId}-completion.json`);
    if (!existsSync(completionFile))
      throw new Error(`makeSealRow completion row: ${completionFile} was not recorded`);
    rmSync(completionFile, { force: true });
  } else if (row === 'stale') {
    f.write('src/a.mjs', 'export const a = 3;\n');
    f.git(['add', '-A']);
    f.git(['commit', '-qm', 'post-review']);
  } else if (row === 'artifact') {
    // Append to the actual canonical review artifact after the accepted review.
    const artifact = join(f.packagePath, 'reviews', `${stageLabel(WAVE_ID, WAVE_STEP, 1)}-review.md`);
    writeFileSync(artifact, `${readFileSync(artifact, 'utf8')}\n<!-- tampered -->\n`);
  } else if (row === 'untracked') {
    f.write('rogue.txt', 'rogue\n');
  } else if (row === 'tracked') {
    f.write('src/a.mjs', 'export const a = 99;\n');
  } else if (row === 'ignored') {
    f.write('build/out', 'generated\n');
  }

  return { f };
}
