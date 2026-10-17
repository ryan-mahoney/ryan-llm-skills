// Behavioral proof regressions for the F13-2b fix findings.
//
// Each case runs against the current production helpers by default. Set
// SPEC_WAVE_PROOF_REVISION to a git revision to run the identical assertions
// against that revision's source: the pre-fix function/expression is read with
// `git show REV:path` and evaluated alone through vm, so the same test body
// proves the regression on the parent and the repair on the working tree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { resolveInstalledPi } from './wave-linux-support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = join(here, '..', '..', '..');
const revision = process.env.SPEC_WAVE_PROOF_REVISION || null;

// Read one module source from the selected revision only (never from the
// working tree in revision mode), so the extraction reflects the pre-fix bytes.
function revisionSource(file) {
  return execFileSync('git', ['show', `${revision}:pi/extensions/spec-runtime/${file}`],
    { cwd: checkout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// Extract one top-level function declaration by its closing brace in column 0.
function extractFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith(`function ${name}(`));
  assert.notEqual(start, -1, `${name} is a top-level function in the selected revision`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.ok(end > start, `${name} has a top-level closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

// Evaluate the extracted declaration in this realm; the functions use only
// builtins, so no module bindings leak in.
function evalFunction(source, name) {
  const fn = vm.runInThisContext(`(${source})`, { filename: `revision:${name}` });
  assert.equal(typeof fn, 'function', `${name} evaluates to a function`);
  return fn;
}

// Extract the right-hand side of the coordinator session-manager assignment.
function extractSessionManagerExpression(source) {
  const line = source.split('\n')
    .find(entry => entry.includes('const sessionManager = SessionManager.inMemory(sessionDir);'));
  assert.ok(line, 'wave-native-driver.mjs still assigns the coordinator session manager');
  const expression = line.slice(line.indexOf('=') + 1, line.lastIndexOf(';')).trim();
  assert.ok(expression.length > 0, 'the coordinator session-manager assignment carries an expression');
  return expression;
}

function rejects(callable, label) {
  assert.throws(callable, error => error instanceof Error && typeof error.message === 'string' && error.message.length > 0, label);
}

// F13-2b-1: the durable member carries its provisioned workspace, not a
// top-level checkout; the implementing run also carries the checkout.
test('wave proof: member checkouts resolve the durable workspace and the implementing run', async () => {
  const member = {
    // waves.mjs records the durable member step as `step`; the run binding
    // carries `step_number`. Both are set so either key resolves this member.
    step: 1,
    step_number: 1,
    attempt: 1,
    attempt_id: 'step-01-attempt-1',
    phase: 'sealed',
    sealed_head: 'b'.repeat(40),
    workspace: {
      backend: 'worktree',
      backendReason: 'userns-denied',
      worktree: '/fixture/member',
      snapshotId: 'snapshot-1',
      baseCommit: 'a'.repeat(40),
    },
  };
  const record = { wave_id: 'wave-1', members: { 1: member } };
  const run = {
    id: 'run-1',
    assignment_id: 'wave-member-1',
    checkout: '/fixture/member',
    state: 'running',
    wave_bindings: { wave_id: 'wave-1', generation: 1, step_number: 1, attempt_id: 'step-01-attempt-1', phase: 'implementing' },
  };
  assert.equal(run.wave_bindings.step_number, member.step, 'the run binding names the member step');
  assert.equal(run.wave_bindings.wave_id, record.wave_id, 'the run binding names the wave');

  if (revision) {
    const memberCheckouts = evalFunction(
      extractFunction(revisionSource('waves.integration.test.mjs'), 'memberCheckouts'), 'memberCheckouts');
    assert.deepEqual(Array.from(memberCheckouts(record)), ['/fixture/member'],
      'member checkouts come from the durable member workspace');
    return;
  }

  const { memberCheckouts, memberWorkspace } = await import('./wave-native-workspaces.mjs');
  assert.deepEqual(Array.from(memberCheckouts(record)), ['/fixture/member'],
    'member checkouts come from the durable member workspace');
  assert.deepEqual(Array.from(memberCheckouts({ members: {} })), [],
    'a record without members resolves no checkouts');
  assert.equal(memberWorkspace(member, run), '/fixture/member',
    'the member workspace is corroborated by the implementing run checkout');
  rejects(() => memberWorkspace({ step: 1, step_number: 1 }, run),
    'a member without a workspace is refused');
  rejects(() => memberWorkspace(member, { ...run, checkout: '/fixture/other' }),
    'an implementing run whose checkout differs from the member workspace is refused');
});

// F13-2b-2: systemctl presents deadlines as compound hour/minute durations.
test('wave proof: systemctl compound durations parse to exact microseconds', async () => {
  const parse = revision
    ? evalFunction(extractFunction(revisionSource('wave-linux-wave-cases.mjs'), 'parseUsecProperty'), 'parseUsecProperty')
    : (await import('./wave-linux-duration.mjs')).parseUsecProperty;
  assert.equal(typeof parse, 'function', 'parseUsecProperty is exported');

  assert.equal(parse('2h 29.800s'), 7_229_800_000, '2h 29.800s is exact microseconds');
  assert.equal(parse('1h 59min 58s'), 7_198_000_000, 'the live deadline presentation is exact microseconds');
  assert.equal(parse('1min 2s'), 62_000_000, 'minutes and seconds compose');
  assert.equal(parse('250ms'), 250_000, 'milliseconds scale to microseconds');
  assert.equal(parse('7198000000'), 7_198_000_000, 'a bare microsecond value is unchanged');
  assert.equal(parse(7198000000), 7_198_000_000, 'a numeric microsecond value is unchanged');
  for (const value of ['infinity', 'n/a', 'unsupported', '-1', '', '9'.repeat(400), '9007199254740992']) {
    assert.ok(Number.isNaN(parse(value)), `${JSON.stringify(value)} is rejected`);
  }
});

// F13-2b-3: the coordinator session must persist under its session directory at
// the integration checkout, so metrics can read the recorded coordinator session.
const installedPi = resolveInstalledPi();

test('wave proof: coordinator session manager persists under the session dir at the integration checkout', async t => {
  assert.equal(installedPi.ok, true,
    `the installed Pi SDK is required for this proof: ${installedPi.reason}`);
  const sdk = await import(pathToFileURL(installedPi.entry).href);
  const { SessionManager } = sdk;
  assert.equal(typeof SessionManager, 'function', 'the installed SDK exports SessionManager');

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wave-proof-coordinator-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionDir = join(root, 'coordinator-fixture-session');
  const integrationCheckout = join(root, 'integration-checkout');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(integrationCheckout, { recursive: true });
  const config = { dir: root, tag: 'fixture', integrationCheckout };

  const manager = revision
    ? vm.runInNewContext(extractSessionManagerExpression(revisionSource('wave-native-driver.mjs')),
      { SessionManager, sessionDir }, { filename: 'revision:coordinator-session-manager' })
    : (await import('./wave-native-driver.mjs')).createCoordinatorSessionManager(SessionManager, config, sessionDir);

  const sessionFile = manager.getSessionFile();
  assert.equal(typeof sessionFile, 'string', 'the coordinator session manager exposes a session file');
  assert.ok(sessionFile.length > 0, 'the coordinator session file is nonempty');
  assert.ok(sessionFile.startsWith(`${sessionDir}${sep}`), `the session file ${sessionFile} lives under ${sessionDir}`);
  assert.equal(manager.getCwd(), config.integrationCheckout, 'the session cwd is the integration checkout');

  // Normal SDK append: the first user message creates the persisted session file.
  manager.appendMessage({ role: 'user', timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'wave proof session append' }] });
  assert.ok(existsSync(sessionFile), 'the SDK persisted the session file at the reported path');
  assert.match(readFileSync(sessionFile, 'utf8'), /wave proof session append/, 'the appended session content is durable');
});
