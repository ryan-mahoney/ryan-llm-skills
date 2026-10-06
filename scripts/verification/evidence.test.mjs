import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessChecks, collectCi } from './ci.mjs';
import { patchWarden } from './install-warden.mjs';
import { classifyProjectCheck, classifySpecArtifact } from './warden-evidence.mjs';

const head = 'a'.repeat(40);
const passing = { name: 'Required regression', bucket: 'pass', link: 'https://example.test/check' };
const base = { revision: head, clean: true, pr: { headRefOid: head, state: 'OPEN' }, checks: [passing], required: [passing] };

test('CI requires matching clean revision and actual identified checks', () => {
  assert.equal(assessChecks(base).status, 'passed');
  assert.equal(assessChecks({ ...base, clean: false }).status, 'stale');
  assert.equal(assessChecks({ ...base, pr: { ...base.pr, headRefOid: 'b'.repeat(40) } }).status, 'stale');
  assert.equal(assessChecks({ ...base, required: [] }).status, 'unverified');
  assert.equal(assessChecks({ ...base, required: [], named: ['Required regression'] }).status, 'passed');
  assert.equal(assessChecks({ ...base, named: ['Missing gate'] }).status, 'unverified');
  assert.equal(assessChecks({ ...base, checks: [passing, passing], named: [passing.name] }).status, 'unverified');
  assert.equal(assessChecks({ ...base, required: [{ ...passing, bucket: 'fail' }, passing] }).status, 'unverified');
});

test('pending, skipped, failed and cancelled required checks never pass', () => {
  for (const [bucket, expected] of [['pending', 'pending'], ['skipping', 'unverified'], ['fail', 'failed'], ['cancel', 'failed'], ['unexpected', 'unverified']]) {
    assert.equal(assessChecks({ ...base, required: [{ ...passing, bucket }] }).status, expected);
  }
});

test('CI collection detects head movement while reading checks', () => {
  let views = 0;
  const run = (command, args) => {
    if (command === 'git') return args.includes('rev-parse') ? head : '';
    if (args.includes('view')) return JSON.stringify({ ...base.pr, headRefOid: ++views === 1 ? head : 'b'.repeat(40), url: 'https://example.test/pr/1' });
    return JSON.stringify([passing]);
  };
  const receipt = collectCi({ repo: '/tmp', named: [] }, run);
  assert.equal(receipt.status, 'stale');
  assert.equal(receipt.head_verified, false);
});

test('Warden recognizes Elixir wrappers from successful execution and failure summaries', () => {
  for (const command of ['mix precommit', 'bin/test-all --seed 42', 'mise run test:elixir --cover']) {
    assert.equal(classifyProjectCheck('bash', { command }, false, '14 tests, 0 failures\n'), 'check-pass');
    assert.equal(classifyProjectCheck('bash', { command }, true, '14 tests, 0 failures\n'), 'check-fail');
    assert.equal(classifyProjectCheck('bash', { command }, false, '4 tests, 1 failure\n10 tests, 0 failures\n'), 'check-fail');
    assert.equal(classifyProjectCheck('bash', { command }, false, 'partition started\n'), 'unknown');
  }
  assert.equal(classifyProjectCheck('bash', { command: 'mix test --help' }, false, ''), 'unknown');
  assert.equal(classifyProjectCheck('bash', { command: 'echo "mix precommit"' }, false, '14 tests, 0 failures'), undefined);
  assert.equal(classifyProjectCheck('bash', { command: 'mix precommit | tail -1' }, false, '14 tests, 0 failures'), undefined);
  assert.equal(classifyProjectCheck('bash', { command: 'gh pr checks' }, false, 'pass'), undefined);
});

test('Warden accepts only a current clean checkout receipt from the dedicated command', t => {
  const repo = mkdtempSync(join(tmpdir(), 'verification-evidence-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial fixture']);
  const revision = git(['rev-parse', 'HEAD']);
  const input = { command: `node ${fileURLToPath(new URL('./ci.mjs', import.meta.url))} --repo ${repo}` };
  const receipt = { schema_version: 1, type: 'verification_evidence', kind: 'ci', status: 'passed', repo, revision, checkout_clean: true, head_verified: true, checks: [{ name: 'Required regression', status: 'pass' }] };
  assert.equal(classifyProjectCheck('bash', input, false, JSON.stringify(receipt), repo), 'check-pass');
  assert.equal(classifyProjectCheck('bash', { command: 'node ~/.agents/scripts/verification/ci.mjs --repo "$PWD"' }, false, JSON.stringify(receipt), repo), 'check-pass');
  assert.equal(classifyProjectCheck('bash', input, false, JSON.stringify({ ...receipt, revision: head }), repo), 'unknown');
  assert.equal(classifyProjectCheck('bash', input, false, JSON.stringify({ ...receipt, checks: [] }), repo), 'unknown');
  writeFileSync(join(repo, 'uncommitted'), 'new behavior');
  assert.equal(classifyProjectCheck('bash', input, false, JSON.stringify(receipt), repo), 'unknown');
});

test('spec metadata exemptions keep executable, config, arbitrary and escaped paths protected', t => {
  const repo = mkdtempSync(join(tmpdir(), 'warden-artifacts-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const path of ['.specs/project-context.md', '.specs/feature/ledger.md', '.specs/feature/pr-rebase-log.md', '.specs/feature/learnings/step-003-learning.md', '.specs/feature/step-003-subspec.md', '.specs/feature/reviews/step-003-fix.md', '.specs/feature/merge-evidence.json'])
    assert.equal(classifySpecArtifact('write', { path }, repo), 'unknown', path);
  for (const path of ['src/app.js', 'test/app.test.js', 'package.json', '.specs/feature/evidence/check.mjs', '.specs/feature/package.json', '.specs/feature/fixture.json', '.specs/feature/arbitrary.md', '.specs/feature/../../src/app.js'])
    assert.equal(classifySpecArtifact('edit', { path }, repo), undefined, path);
  mkdirSync(join(repo, '.specs/feature'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  symlinkSync(join(repo, 'src'), join(repo, '.specs/feature/reviews'));
  assert.equal(classifySpecArtifact('write', { path: '.specs/feature/reviews/step-003-fix.md' }, repo), undefined);
  assert.equal(classifySpecArtifact('apply_patch', { path: '.specs/feature/ledger.md' }, repo), undefined);
});

test('installed Warden preserves check freshness through observed metadata batch and real mutations invalidate it', async t => {
  let source;
  try { source = readFileSync(join(homedir(), '.pi/agent/npm/node_modules/pi-warden/dist/done.js'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Pi Warden not installed'); throw error; }
  source = patchWarden(source, new URL('./warden-evidence.mjs', import.meta.url).href);
  // Execute installed classifier/state hooks without loading unrelated judge/UI
  // dependencies (Pi supplies those peers; plain node may not resolve them).
  const names = ['classifyToolResult', 'emptyEvidence', 'recordOutcome', 'freshChecks', 'needsDoneCheck'];
  const functions = names.map(name => {
    const match = new RegExp(`export function ${name}\\([\\s\\S]*?\\n}`).exec(source);
    assert.ok(match, `installed hook ${name} exists`);
    return match[0].replace('export ', '');
  }).join('\n');
  const warden = new Function('classifyProjectCheck', 'classifySpecArtifact', 'commandOf', 'redact', 'isOutsideProject', 'CHECK_COMMAND', 'checkSummary', 'isReadOnlyCommand',
    functions + `; return { ${names.join(', ')} };`)(classifyProjectCheck, classifySpecArtifact,
      (tool, input) => tool === 'bash' ? { command: input.command, shell: true } : undefined,
      value => value, () => false, /node --test/, () => undefined, () => false);
  const repo = mkdtempSync(join(tmpdir(), 'warden-state-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const state = warden.emptyEvidence();
  const record = (tool, input, failed = false) => warden.recordOutcome(state, warden.classifyToolResult(tool, input, failed, '', repo), input, tool);
  record('edit', { path: 'src/app.js' });
  record('bash', { command: 'node --test app.test.mjs' }, true);
  const failure = state.checks[0];
  record('bash', { command: 'node --test app.test.mjs' });
  for (const path of ['ledger.md', 'pr-rebase-log.md', 'pr-message.md', 'pr-url.json', 'merge-evidence.json', 'work-tour.json', 'work-tour.html'])
    record('write', { path: `.specs/feature/${path}` });
  assert.equal(state.mutations, 1);
  assert.equal(warden.freshChecks(state).length, 2);
  assert.equal(state.checks[0], failure);
  assert.equal(failure.passed, false);
  assert.equal(warden.needsDoneCheck(state), false);
  record('edit', { path: '.specs/feature/evidence/check.mjs' });
  assert.deepEqual(warden.freshChecks(state), []);
  assert.equal(warden.needsDoneCheck(state), true);
  record('bash', { command: 'node --test app.test.mjs' }, true);
  record('write', { path: '.specs/feature/ledger.md' });
  assert.equal(warden.needsDoneCheck(state), true);
  assert.equal(warden.freshChecks(state)[0].passed, false);
});

test('Warden installer upgrades known v1 once and refuses unfamiliar classifiers', () => {
  const source = `// shared-project-verification-v1
import { classifyProjectCheck } from "file:///old.mjs";
export function classifyToolResult(tool, input, failed, output, cwd) {
    const projectCheck = classifyProjectCheck(tool, input, failed, output, cwd);
    if (projectCheck !== undefined) return projectCheck;
    return "mutation";
}`;
  const patched = patchWarden(source, 'file:///adapter.mjs');
  assert.equal(patchWarden(patched, 'file:///adapter.mjs'), patched);
  assert.equal(patched.includes('shared-project-verification-v1'), false);
  assert.equal((patched.match(/import /g) ?? []).length, 1);
  assert.throws(() => patchWarden('unfamiliar source', 'file:///adapter.mjs'), /Unrecognized/);
  assert.throws(() => patchWarden(source.replace('    const projectCheck', '  const projectCheck'), 'file:///adapter.mjs'), /partial upgrade/);
});
