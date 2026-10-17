// Test helper: git repositories, a storage root with a workspace kit, and a spec
// package created through spec-location. `location` is the options object the
// runtime and spec-location take (root, pinned hostname and home).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPackage } from '../../../scripts/spec-location/index.mjs';
import { put } from '../../../scripts/spec-location/fixture.mjs';
import { prepareSpecWorktree } from '../../../scripts/spec-location/worktree.mjs';
import { createProcessRegistry } from './waves-fixture-processes.mjs';
import { cleanupPortableHostShims, installPortableHostShims, setShimMode, writeSandboxHome } from './wave-native-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', '..', '..', 'scripts', 'spec-observe', 'cli.mjs');

export async function makePackageFixture({ prefix = 'spec-runtime-test-', slug = 'feature', repos = ['repo'], targets = [repos[0]], executionHost = 'box' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const paths = {};
  for (const id of repos) {
    const path = paths[id] = join(dir, id);
    mkdirSync(path);
    const git = (...args) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'Runtime Test'); git('config', 'user.email', 'runtime@example.invalid');
    writeFileSync(join(path, 'README'), 'fixture\n');
    git('add', 'README'); git('commit', '-qm', 'Initial fixture');
  }
  const root = join(dir, 'storage');
  const workspaceDir = join(root, 'projects', 'demo');
  put(join(workspaceDir, 'kit.yaml'), `version: 1\nid: demo\nname: demo\nexecution_host: ${executionHost}\nrepositories:\n${repos.map(id => `  - id: ${id}\n    path: ${paths[id]}\n`).join('')}`);
  const location = { root, hostname: `${executionHost}.local`, home: dir, env: { XDG_DATA_HOME: join(dir, 'data') } };
  const created = await newPackage({ workspace: 'demo', slug, targets: targets.map(id => ({ id })), ...location });
  if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
  return { dir, repo: paths[repos[0]], paths, root, workspaceDir, location, locations: created.locations,
    packagePath: created.locations.package_dir, ref: created.locations.package_ref };
}

// EV-13 wave-native harness (D-29 packet 1). These seams are the walking
// skeleton's public surface; makeWaveFixture, the loopback provider and the
// coordinator driver are all implemented in their owning modules.

// Base tree files the D-9 fixture commits before any wave runs.
const GITIGNORE = 'node_modules/\n*.log\n';
const README_CONTENT = 'fixture\n';
const LOCK_CONTENT = 'fixture-lock\n';
const DEPS_COMMAND = "node -e \"require('fs').mkdirSync('node_modules/fixture-dep',{recursive:true});require('fs').writeFileSync('node_modules/fixture-dep/version.txt','v1')\"";

// Deterministic gate check: validate each src/step-NN.txt content against the
// step format, then print one JSON line with the file count, the cwd mount
// filesystem type and the installed fixture dependency version.
const CHECK_SCRIPT = [
  "import { existsSync, readFileSync, readdirSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "",
  "const cwd = process.cwd();",
  "const srcDir = join(cwd, 'src');",
  "const names = existsSync(srcDir)",
  "  ? readdirSync(srcDir).filter(name => /^step-\\d\\d\\.txt$/.test(name)).sort()",
  "  : [];",
  "const problems = [];",
  "for (const name of names) {",
  "  const expectedNumber = name.slice(5, 7);",
  "  const text = readFileSync(join(srcDir, name), 'utf8');",
  "  const match = /^step (\\d\\d) (implemented(-defect)?|fixed)\\n$/.exec(text);",
  "  if (!match) problems.push(name + ': content does not match the step format');",
  "  else if (match[1] !== expectedNumber) problems.push(name + ': step number does not match the file name');",
  "}",
  "const depPath = join(cwd, 'node_modules', 'fixture-dep', 'version.txt');",
  "const dep_version = existsSync(depPath) ? readFileSync(depPath, 'utf8').trim() : 'none';",
  "let fstype = 'unknown';",
  "try {",
  "  let best = '';",
  "  for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\\n')) {",
  "    if (!line) continue;",
  "    const fields = line.split(' ');",
  "    const mount = fields[4];",
  "    if (!mount) continue;",
  "    const base = mount.endsWith('/') ? mount : mount + '/';",
  "    if (cwd !== mount && !cwd.startsWith(base)) continue;",
  "    if (mount.length < best.length) continue;",
  "    const dash = fields.indexOf('-');",
  "    const type = dash >= 0 ? fields[dash + 1] : undefined;",
  "    if (!type) continue;",
  "    best = mount;",
  "    fstype = type;",
  "  }",
  "} catch { fstype = 'unknown'; }",
  "console.log(JSON.stringify({ files: names.length, fstype, dep_version }));",
  "process.exitCode = problems.length ? 1 : 0;",
].join('\n') + '\n';

const stepPath = step => `step-${String(step).padStart(3, '0')}-subspec.md`;
const writePath = step => `src/step-${String(step).padStart(2, '0')}.txt`;

// Ready card with strict planning and verification blocks (D-9).
function waveCard(step) {
  const nn = String(step).padStart(2, '0');
  return [
    `# Step ${step}: fixture step`,
    '',
    '<!-- spec-location:begin -->',
    '**Spec location** (fixture; do not edit)',
    '',
    '- Package: `agent-tooling/waves-fixture`',
    '- Targets:',
    '  - `repo`',
    '<!-- spec-location:end -->',
    '',
    `Implement \`${writePath(step)}\`.`,
    '',
    '```yaml',
    'planning:',
    '  version: 2',
    `  step: ${step}`,
    `  output_file: ${stepPath(step)}`,
    '  verdict: ready',
    '```',
    '',
    '```yaml',
    'verification:',
    '  strategy: test-first',
    '  commands:',
    '    - "node checks/fixture-check.mjs"',
    '  test_files:',
    '    - "checks/fixture-check.mjs"',
    '  cases:',
    `    - "${writePath(step)} contains step ${nn} implemented"`,
    '```',
    '',
  ].join('\n');
}

// D-19 promotion interruption seam: a reference-transaction hook on the canonical
// repo records committed lines for the package branch and, when the marker file
// exists, kills the coordinator after the ref commit. Production sets no
// core.hooksPath, so this hook fires without any internal seam.
function installPromotionHook(primary, sandbox, branch) {
  const hooksDir = join(primary, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'reference-transaction');
  const script = [
    '#!/bin/sh',
    `sandbox=${JSON.stringify(sandbox)}`,
    `branch=${JSON.stringify(branch)}`,
    '[ "$1" = committed ] || exit 0',
    'tmp="$sandbox/hook.tmp"',
    ': > "$tmp"',
    'while IFS= read -r line; do',
    '  case "$line" in',
    '    *"$branch"*) printf \'%s\\n\' "$line" >> "$tmp" ;;',
    '  esac',
    'done',
    'if [ -s "$tmp" ]; then',
    '  cat "$tmp" >> "$sandbox/hook.log"',
    '  if [ -e "$sandbox/kill-on-promote" ]; then',
    '    rm -f "$sandbox/kill-on-promote"',
    '    if [ -f "$sandbox/coordinator.pid" ]; then',
    '      kill -9 "$(cat "$sandbox/coordinator.pid")" 2>/dev/null || true',
    '    fi',
    '  fi',
    'fi',
    'rm -f "$tmp"',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
}

export async function makeWaveFixture(options = {}) {
  const targets = Array.isArray(options.targets) && options.targets.length ? options.targets : ['repo'];
  const repos = Array.isArray(options.repos) && options.repos.length ? options.repos : [...new Set(targets)];
  const targetId = targets[0];
  const requestedMembers = Number(options.members);
  const memberCount = Number.isInteger(requestedMembers) && requestedMembers > 0 ? requestedMembers : 5;
  const defectStep = Number.isInteger(options.defectStep) ? options.defectStep : null;
  const chain = options.chain === true;
  const useDeps = options.deps === true || options.setup === 'deps';
  const promotionKill = options.promotionKill === true;
  const executionHost = (hostname().split('.')[0] || 'box');

  const base = await makePackageFixture({
    prefix: options.prefix ?? 'spec-wave-fixture-',
    slug: options.slug ?? 'feature',
    repos,
    targets,
    executionHost,
  });

  // D-9 base commit: README (from makePackageFixture), .gitignore,
  // checks/fixture-check.mjs and, for deps setup, fixture.lock.
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  for (const id of repos) {
    const path = base.paths[id];
    writeFileSync(join(path, '.gitignore'), GITIGNORE);
    mkdirSync(join(path, 'checks'), { recursive: true });
    writeFileSync(join(path, 'checks', 'fixture-check.mjs'), CHECK_SCRIPT);
    if (useDeps) writeFileSync(join(path, 'fixture.lock'), LOCK_CONTENT);
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', 'Fixture base');
  }
  const baseCommit = git(base.paths[targetId], 'rev-parse', 'HEAD').trim();

  // Top-level wave contract: flat (requires []) is one wave; chain (requires
  // [k-1]) yields one single-member wave per step.
  const steps = Array.from({ length: memberCount }, (_, position) => {
    const step = position + 1;
    const file = writePath(step);
    return {
      step,
      path: stepPath(step),
      repository: targetId,
      difficulty: 'medium',
      requires: chain && step > 1 ? [step - 1] : [],
      writes: [targets.length > 1 ? `${targetId}:${file}` : file],
      evidence: [`EV-${step}`],
    };
  });
  const waves = chain
    ? steps.map(entry => [entry.step])
    : [steps.map(entry => entry.step)];
  const waveChecks = waves.map(wave => ({
    after: wave[wave.length - 1],
    owner_step: wave[0],
    gates: [`EV-${wave[0]}`],
  }));
  const setup = targets.length > 1
    ? Object.fromEntries(targets.map(id => [id, 'none']))
    : { [targetId]: useDeps ? { command: DEPS_COMMAND, lockfiles: ['fixture.lock'], environment: [] } : 'none' };
  const index = { version: 1, steps, setup, wave_checks: waveChecks };
  const gates = steps.map(entry => ({
    id: `EV-${entry.step}`,
    ownerStep: entry.step,
    required: true,
    phase: 'merge',
    kind: 'deterministic-inspection',
    description: `Inspect the implemented content of step ${entry.step} to prove CL-${entry.step}.`,
    command: 'node checks/fixture-check.mjs',
    artifact: `evidence/fixture-check-${String(entry.step).padStart(2, '0')}.txt`,
    environment: 'Disposable local fixture repository with no network access.',
    independence: 'Reads fixture files only; does not trust the implementing owner report.',
    effects: 'Writes only its own evidence artifact under the disposable fixture package.',
    authorization: 'Requires only the plan authority to run a local node inspection command.',
    claims: [`CL-${entry.step}`],
    rejects: [`FH-${entry.step}`],
  }));
  const claims = steps.map(entry => ({
    id: `CL-${entry.step}`,
    statement: `The fixture check validates that step ${entry.step} implementation content is present.`,
    phase: 'merge',
    requirements: [`fixture-step-${entry.step}`],
    failureHypotheses: [`FH-${entry.step}`],
    gates: [`EV-${entry.step}`],
  }));
  const failureHypotheses = steps.map(entry => ({
    id: `FH-${entry.step}`,
    statement: `Step ${entry.step} carries an invalid implementation.`,
    claims: [`CL-${entry.step}`],
    gates: [`EV-${entry.step}`],
  }));
  const evidencePlan = {
    version: 2,
    spec: 'spec.md',
    context: { path: 'context.md' },
    posture: {
      risk: 'low',
      rationale: 'Disposable local fixture with easy reversibility and low uncertainty.',
      changeTypes: [],
      boundaries: [],
      impacts: [],
      requiredLayers: [],
      independence: [],
      environments: [],
      reversibility: 'easy',
      uncertainty: 'low',
      qaMode: 'automated',
    },
    claims,
    failureHypotheses,
    gates,
  };

  const packagePath = base.packagePath;
  writeFileSync(join(packagePath, 'context.md'), '# context.md\nfixture\n');
  writeFileSync(join(packagePath, 'spec.md'), '# spec.md\nfixture\n');
  writeFileSync(join(packagePath, 'spec-prepare.md'), '# spec-prepare.md\nfixture\n');
  writeFileSync(join(packagePath, 'evidence-plan.json'), JSON.stringify(evidencePlan, null, 2));
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify(index, null, 2));
  mkdirSync(join(packagePath, 'evidence'), { recursive: true });
  for (const entry of steps) writeFileSync(join(packagePath, entry.path), waveCard(entry.step));

  const projectContext = base.locations?.project_context;
  if (typeof projectContext === 'string') {
    mkdirSync(dirname(projectContext), { recursive: true });
    writeFileSync(projectContext, '# project context\nfixture\n');
  }
  if (options.afterCreate) options.afterCreate({ packagePath, base, index, gates });

  // The integration checkout is the prepared target worktree; spec-location's
  // own prepare API persists the metadata, so locations.json is never hand-edited.
  const prepared = await prepareSpecWorktree(base.locations, base.locations.targets[0], { ...base.location });
  const integrationCheckout = prepared.worktree;

  if (promotionKill) installPromotionHook(base.paths[targetId], base.dir, base.locations.targets[0].branch);

  // Real steps lint with the fixture environment: ready single-target packages
  // report concurrency_ready; a multi-target package reports the serial reason.
  const lint = spawnSync(process.execPath, [cliPath, 'steps', 'lint', base.ref, '--root', base.root], {
    env: { ...process.env, ADJACENT_STORAGE_ROOT: base.root, HOME: base.dir },
    encoding: 'utf8',
  });
  assert.equal(lint.status, 0, `steps lint failed: ${lint.stdout}\n${lint.stderr}`);
  const report = JSON.parse(lint.stdout);
  assert.equal(report.ok, true, `steps lint invalid: ${report.errors.join('; ')}`);
  if (targets.length > 1) assert.ok(report.reasons.includes('multiple-targets'), 'multi-target lint reports multiple-targets');
  else assert.equal(report.concurrency_ready, true, `steps lint not concurrency ready: ${report.reasons.join('; ')}`);

  const expected = new Map([
    ['.gitignore', GITIGNORE],
    ['README', README_CONTENT],
    ['checks/fixture-check.mjs', CHECK_SCRIPT],
  ]);
  // D-9: the deps setup commits fixture.lock into the base tree, so the fixture's
  // own tree contract must list it; the exact integration-tree comparison reads
  // this map and a missing entry surfaces later as an opaque tree diff.
  if (useDeps) expected.set('fixture.lock', LOCK_CONTENT);
  for (const entry of steps) {
    const nn = String(entry.step).padStart(2, '0');
    expected.set(writePath(entry.step), entry.step === defectStep ? `step ${nn} fixed\n` : `step ${nn} implemented\n`);
  }

  // Teardown responsibility is registered before any future operation. Shim and
  // registry cleanup are attempted independently so one failure cannot skip the
  // other, and the sandbox directory removal is always attempted even when those
  // steps fail so a broken shim or registry never leaks the sandbox. The first
  // failure still surfaces to the caller; successful removal is recorded so a
  // repeated cleanup stays a no-op.
  const processRegistry = createProcessRegistry();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    let failure = null;
    try { await cleanupPortableHostShims(join(base.dir, 'shim-state')); } catch (error) { failure = error; }
    try { await processRegistry.cleanup(); } catch (error) { if (!failure) failure = error; }
    let removed = false;
    try { rmSync(base.dir, { recursive: true, force: true }); removed = true; }
    catch (error) { if (!failure) failure = error; }
    if (removed) cleaned = true;
    if (failure) throw failure;
  };

  return {
    dir: base.dir,
    root: base.root,
    ref: base.ref,
    packagePath,
    integrationCheckout,
    baseCommit,
    expected,
    home: base.location.home,
    repo: base.repo,
    paths: base.paths,
    location: base.location,
    locations: base.locations,
    options: { ...options, targets, repos, members: memberCount, defectStep, chain, deps: useDeps, promotionKill },
    processRegistry,
    cleanup,
  };
}

// EV-13 packet 4: the loopback provider lives in wave-native-provider.mjs and
// the detached coordinator driver in wave-native-driver.mjs.
export { startLoopbackProvider, writeLoopbackExtension } from './wave-native-provider.mjs';
export { startCoordinator } from './wave-native-driver.mjs';
export { cleanupPortableHostShims, installPortableHostShims, setShimMode, writeSandboxHome };
// EV-13 bounded run/shim-state diagnostics live in wave-native-diagnostics.mjs so
// every native wave case can register them through this fixture entry point.
export {
  DIAG_TEXT_LIMIT,
  boundedText,
  collectRuntimeRunDiagnostics,
  collectShimStateDiagnostics,
} from './wave-native-diagnostics.mjs';
// EV-14 host/service support lives in wave-linux-support.mjs. The installed-Pi
// resolver moved there unchanged so the native and linux cases share it.
export {
  resolveInstalledPi,
  linuxCommand,
  assertCommand,
  linuxEnvironment,
  linuxPreconditions,
  makeLinuxServices,
} from './wave-linux-support.mjs';
export { makeLinuxOverlayFixture } from './wave-linux-overlay-fixture.mjs';
// EV-14 production symbols the linux cases assert against. They are reexported
// here so both wave test files keep static imports limited to node:* modules
// and this fixture entry point.
export { checkRuntimeHost, createSystemdServiceAdapter } from './linux-resources.mjs';
export { buildOverlayArgv } from './overlay.mjs';
export { importSealedHead } from './step-workspaces.mjs';
// EV-13 native wave case helpers read the durable member workspace shape.
export { memberCheckouts, memberWorkspace } from './wave-native-workspaces.mjs';
// EV-13 native wave elapsed timing reads durable open/integrated transitions.
export { elapsedWaveMs, elapsedWaveSetMs } from './wave-native-timing.mjs';
// EV-14 native Linux wave fixture: sandbox HOME, real environment and the
// actual loopback provider/coordinator pair, with no host modification.
export { bootLinuxWave } from './wave-linux-native-fixture.mjs';
// The ordered native boot teardown lives in wave-native-lifecycle.mjs; the wave
// cases keep a single static import surface through this fixture entry point.
export { registerNativeTeardown } from './wave-native-lifecycle.mjs';
