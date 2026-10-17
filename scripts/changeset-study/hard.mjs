// Realistic spec-step workloads extracted from Git history (the `hard` phase).
// Each task starts from a real parent revision, uses the real later source as
// gold and the real later test files as hidden acceptance. Source trees are the
// relative-import closure of the hidden tests, so the extracted subtree is the
// minimal module set those tests load. See PROTOCOL.md, "Hard phase".
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const here = dirname(fileURLToPath(import.meta.url));
const SR = 'pi/extensions/spec-runtime';
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const shown = new Map();
function show(rev, path) {
  const key = `${rev}:${path}`;
  if (!shown.has(key)) { try { shown.set(key, git(['show', key])); } catch { shown.set(key, null); } }
  return shown.get(key);
}

// Pinned third-party packages, mounted read-only at /node_modules. The versions
// are the spec-runtime lockfile's; cli.mjs verifies them before provisioning.
export const hardDependencies = Object.freeze({ chokidar: '5.0.0', readdirp: '5.1.1' });

// Hard-phase limits, preregistered in PROTOCOL.md before any run.
export const hardLimits = Object.freeze({
  cell_ms: 1200000, model_calls: 96, max_output_tokens: 32000, call_ms: 300000,
  command_ms: 180000, grade_ms: 300000, review_input: 'diff',
});

const importPattern = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
export function closure(rev, entries) {
  const seen = new Set(), queue = [...entries];
  while (queue.length) {
    const path = normalize(queue.shift());
    if (seen.has(path)) continue;
    const text = show(rev, path);
    if (text === null) continue;
    seen.add(path);
    for (const match of text.matchAll(importPattern)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith('.')) queue.push(join(dirname(path), spec));
    }
  }
  return [...seen].sort();
}

const oracle = ({ tests, flags, checks }) => `
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const tests = ${JSON.stringify(tests)};
// The candidate is read-only; hidden tests run on a private copy in /tmp.
rmSync('/tmp/grade', { recursive: true, force: true });
cpSync('/work', '/tmp/grade', { recursive: true });
for (const [path, text] of Object.entries(tests)) { mkdirSync(dirname('/tmp/grade/' + path), { recursive: true }); writeFileSync('/tmp/grade/' + path, text); }
${checks ?? ''}
const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...${JSON.stringify(flags)}, ...Object.keys(tests)], { cwd: '/tmp/grade', stdio: 'inherit', env: { ...process.env, PI_WARDEN_ENABLED: '1' } });
if (run.status !== 0) { console.error('Hidden tests failed: status ' + run.status + ' signal ' + run.signal); process.exit(1); }
`;

const readme = (rev, note) => `Extracted subtree of the agents repository at revision ${rev}: the modules and tests
that ${note} load. Other repository directories are omitted. Third-party packages
(chokidar, readdirp) are preinstalled read-only at /node_modules. There is no network.
Tests use node:test, for example: node --test pi/extensions/spec-runtime/<file>.test.mjs
`;

function historical({ id, family, spec, initial, fix, entries, extra = [], hiddenTests, check, protectedFiles, flags = [], checks, context = 'discovery', note }) {
  const paths = [...new Set([...closure(initial, entries), ...closure(fix, entries), ...extra])].sort();
  const files = Object.fromEntries(paths.flatMap(path => { const text = show(initial, path); return text === null ? [] : [[path, text]]; }));
  files['README.md'] = readme(initial, note);
  const changed = git(['diff', '--name-only', initial, fix, '--', ...paths]).split('\n').filter(Boolean);
  const gold = Object.fromEntries(changed.filter(path => !hiddenTests.includes(path)).map(path => [path, show(fix, path)]));
  const tests = Object.fromEntries(hiddenTests.map(path => [path, show(fix, path)]));
  if (Object.values(tests).some(text => text === null)) throw new Error(`Missing hidden test in ${id}`);
  return { id, family, origin: 'historical', context, spec, files, gold, check, protected: protectedFiles,
    hidden: oracle({ tests, flags, checks }), limits: hardLimits, dependencies: hardDependencies,
    provenance: { initial, fix, changed, hidden_tests: hiddenTests, hidden_flags: flags } };
}

const specText = name => readFileSync(join(here, 'hard-specs', `${name}.md`), 'utf8');
const pattern = names => `--test-name-pattern=${names.join('|')}`;

// Test-name filters, each with the reason it is excluded from hidden acceptance.
const SKIP = Object.freeze({
  // Kernel OverlayFS composition needs nested unprivileged user namespaces, which the
  // study sandbox does not provide (bwrap: "No permissions to create a new namespace").
  native: '--test-skip-pattern=^wave runtime: composition ',
  // Pre-existing failures at both the initial and gold revisions of a task; they were
  // fixed later by the admission task's commits (077cba9).
  locks: '--test-skip-pattern=writes no lock fields$',
  repeated: '--test-skip-pattern=^repeated starts return the same run',
  // White-box: rewrites the gold source text `copyTreeInto(lower, worktree);` and checks
  // a marker path the gold implementation chose; the task spec cannot fairly require it.
  interrupted: '--test-skip-pattern=^wave workspaces: interrupted fallback publication',
});
const W = 'PI_WARDEN_ENABLED=1 ';
const runtimeNote = 'the spec-runtime tests (run with PI_WARDEN_ENABLED=1, as in the original verification environment)';

const lifecycleChecks = `
import { readFileSync as read } from 'node:fs';
const fail = message => { console.error('Module boundary check failed: ' + message); process.exit(1); };
const dir = '/tmp/grade/${SR}/';
let runtime, lifecycle;
try { runtime = read(dir + 'runtime.mjs', 'utf8'); lifecycle = read(dir + 'wave-lifecycle.mjs', 'utf8'); } catch (error) { fail(error.message); }
if (runtime.split('\\n').length > 1550) fail('runtime.mjs has more than 1,550 lines');
if (!/from\\s*['"]\\.\\/wave-lifecycle\\.mjs['"]/.test(runtime)) fail('runtime.mjs does not import ./wave-lifecycle.mjs');
if (/from\\s*['"]\\.\\/runtime\\.mjs['"]|import\\(\\s*['"]\\.\\/runtime\\.mjs/.test(lifecycle)) fail('wave-lifecycle.mjs imports runtime.mjs');
for (const name of ['targetSetup', 'declaredEnvironment', 'shQuote', 'waveSetupScript', 'readSetupReceipt', 'waitForSetupClose', 'buildWaveStaging', 'gitList', 'partitionUntracked', 'sanitizeTransport', 'environmentFacts']) {
  const definition = new RegExp('function\\\\s+' + name + '\\\\s*\\\\(');
  if (definition.test(runtime)) fail(name + ' is still defined in runtime.mjs');
  if (!definition.test(lifecycle)) fail(name + ' is not defined in wave-lifecycle.mjs');
}
for (const name of ['TRANSPORT_ENV_NAMES', 'ROOT_BOOTSTRAP']) {
  const definition = new RegExp('\\\\b(const|let|var)\\\\s+' + name + '\\\\b');
  if (definition.test(runtime)) fail(name + ' is still defined in runtime.mjs');
  if (!definition.test(lifecycle)) fail(name + ' is not defined in wave-lifecycle.mjs');
}
const runtimeModule = await import(dir + 'runtime.mjs'), lifecycleModule = await import(dir + 'wave-lifecycle.mjs');
if (typeof runtimeModule.environmentFacts !== 'function' || runtimeModule.environmentFacts !== lifecycleModule.environmentFacts) fail('runtime.mjs must re-export environmentFacts from wave-lifecycle.mjs');
for (const method of ['containedRoot', 'ensureWaveDeadline', 'drainContainedService', 'prepareWaveMember', 'remountWaveMember'])
  if (typeof runtimeModule.Runtime?.prototype?.[method] !== 'function') fail('Runtime.' + method + ' is missing');
`;

export function hard() {
  return [
    historical({ id: 'hard-dependency-handoff', family: 'card-feature-delivery', spec: specText('handoff'),
      initial: '7067f79834b1b3ffe4647a7d5715ec273ff920c0', fix: '2b397d75e9c63f732b66de715abe6659152a334f',
      entries: [`${SR}/runtime.test.mjs`, `${SR}/dependency-handoff.mjs`],
      extra: ['pi/agents/spec-step-owner.md', 'pi/agents/spec-step-editor.md', `${SR}/package.json`],
      hiddenTests: [`${SR}/runtime.test.mjs`], flags: [SKIP.native], note: runtimeNote, protectedFiles: [],
      check: W + `node --test --test-name-pattern='CURRENT handoff|editor packets use separate|length-limited final response|prompt construction failure|editor packet context' ${SR}/runtime.test.mjs` }),
    historical({ id: 'hard-admission-overlap', family: 'concurrency-race', spec: specText('admission'),
      initial: '9050066c5bada5ab7fafb6bf5e8c58d9d9a29f54', fix: '7067f79834b1b3ffe4647a7d5715ec273ff920c0',
      entries: [`${SR}/runtime.test.mjs`], extra: [`${SR}/package.json`],
      hiddenTests: [`${SR}/runtime.test.mjs`], flags: [SKIP.native], note: runtimeNote, protectedFiles: [],
      check: W + `node --test --test-name-pattern='repeated starts return the same run|a live coordinator refuses a second dispatch' ${SR}/runtime.test.mjs` }),
    historical({ id: 'hard-wave-recovery', family: 'recovery-state-machine', spec: specText('wave-recovery'),
      initial: '6454af1583e0e50363a77c93607caa8585d20579', fix: 'b3bf6e42fb78d791354d5f43c9af830b3549d15e',
      entries: [`${SR}/wave-integration.test.mjs`], extra: [`${SR}/package.json`],
      hiddenTests: [`${SR}/wave-integration.test.mjs`], note: runtimeNote, protectedFiles: [],
      check: W + `node --test ${SR}/wave-integration.test.mjs` }),
    historical({ id: 'hard-fallback-setup', family: 'cross-module-fix', spec: specText('fallback-setup'),
      initial: '4ad5e667b7dd430031bf543ab5c5a24196a8d7e8', fix: '6c62bf29d485ee685914e8bd6189390cde20ee63',
      entries: [`${SR}/step-workspaces.test.mjs`, `${SR}/runtime.test.mjs`], extra: [`${SR}/package.json`],
      hiddenTests: [`${SR}/step-workspaces.test.mjs`, `${SR}/runtime.test.mjs`],
      flags: [SKIP.native, SKIP.locks, SKIP.interrupted], note: runtimeNote, protectedFiles: [],
      check: W + `node --test --test-name-pattern='^wave workspaces:' ${SR}/step-workspaces.test.mjs` }),
    historical({ id: 'hard-lifecycle-extract', family: 'mechanical-refactor', spec: specText('lifecycle-extract'),
      initial: '8a7b6ba78f0ac6bf9d40b91cce179037e7ea96fa', fix: '0cc124100e98eb213f400c31980bebd61359507f',
      entries: [`${SR}/runtime.test.mjs`, `${SR}/wave-lifecycle.mjs`], extra: [`${SR}/package.json`],
      hiddenTests: [`${SR}/runtime.test.mjs`], flags: [SKIP.locks, SKIP.repeated], checks: lifecycleChecks,
      note: runtimeNote, protectedFiles: [],
      check: W + `node --test '${SKIP.locks}' '${SKIP.repeated}' ${SR}/runtime.test.mjs` }),
    historical({ id: 'hard-context-calibration', family: 'small-module-fix', spec: specText('calibration'), context: 'prepared',
      initial: '7de432cd7f49159781259488ae14fbfcdd69e2c9', fix: '60a06c9bc0e807d83f39d6f4d7e3af4114cee581',
      entries: ['pi/extensions/context-budget/policy.test.mjs'], hiddenTests: ['pi/extensions/context-budget/policy.test.mjs'],
      note: 'the context-budget policy tests', protectedFiles: [],
      check: 'node --test pi/extensions/context-budget/policy.test.mjs' }),
  ];
}
