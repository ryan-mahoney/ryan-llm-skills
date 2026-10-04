import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessChecks, collectCi } from './ci.mjs';
import { classifyProjectCheck } from './warden-evidence.mjs';

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
