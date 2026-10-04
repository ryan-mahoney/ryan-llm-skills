import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as typesafe from 'pi-typesafe';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decide, status, collectFacts, classifyEvidence, buildQuestions, recordDecision } from './core.mjs';

const revision = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const facts = { revision, working_tree_digest: digest, dirty: true, incomplete: false, context_incomplete: false, change_excerpt: '-return false\n+return true' };
const input = { schema_version: 1, policy: { broad_suite_owner: 'ci' }, mandatory_gates: ['security-contract'], focused_checks: [{ id: 'target', purpose: 'Rejects duplicate account email', scope: ['accounts.mjs'] }], planned_ci_checks: [{ id: 'broad', purpose: 'All retained suites in CI', scope: ['**'] }] };
const answer = n => ({ type: 'noul', noul: n });
const choice = (selected, confidence = 0.96) => ({ type: 'choice', choice: selected, confidence, probabilities: Object.fromEntries(['must_fix', 'investigate', 'follow_up'].map(k => [k, k === selected ? confidence : (1 - confidence) / 2])) });
function dependencies(answers) {
  return { collectFacts: async () => facts, recordDecision: async () => 'recorded', loadLibrary: async () => ({ ...typesafe, authState: () => ({ usable: true }), createTypeSafe: () => ({}), ask: async () => ({ ok: true, answers }) }) };
}
const verification = { sufficient_context: answer(0.96), local_feedback: answer(0.96), changes_invalidate_prior: answer(0.96), uncovered_ci_need: answer(0.04), check_0: answer(0.96) };

test('retains mandatory gates and broad CI while recommending useful supplied local feedback', async () => {
  const result = await decide('verification', { repo: '/repo', input }, dependencies(verification));
  assert.equal(result.status, 'recommendation');
  assert.deepEqual(result.recommendation, { local: 'focused', focused_check_ids: ['target'], broad_suite: 'ci', mandatory_gates: ['security-contract'], findings: [] });
  assert.equal(result.test_pass_claim, false);
  assert.equal(Object.keys(buildQuestions('verification', input, typesafe)).length, 5);
});

test('stale revision and missing scope cannot turn claimed passes into a skip recommendation', async () => {
  const evidence = [{ id: 'old', revision: 'c'.repeat(40), observed_at: new Date().toISOString(), kind: 'ci', status: 'passed' }];
  const result = await decide('verification', { repo: '/repo', input: { ...input, evidence } }, dependencies({ ...verification, local_feedback: answer(0.01) }));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.recommendation.local, 'main_agent');
  assert.equal(result.evidence[0].trust, 'caller_reported_not_verified');
  assert.ok(result.evidence[0].freshness_reasons.includes('stale_revision'));
  assert.ok(result.evidence[0].freshness_reasons.includes('scope_unknown'));
  assert.ok(result.evidence[0].freshness_reasons.includes('working_tree_mismatch'));
  const current = classifyEvidence({ evidence: [{ ...evidence[0], revision, scope: ['accounts.mjs'], working_tree_digest: digest }] }, facts);
  assert.equal(current[0].freshness, 'current');
  assert.equal(current[0].trust, 'caller_reported_not_verified');
});

test('unavailable library and malformed answer produce safe fallback without upstream error text', async () => {
  const unavailable = await decide('verification', { repo: '/repo', input }, { ...dependencies(verification), loadLibrary: async () => { throw new Error('secret upstream text'); } });
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(unavailable.uncertainty, ['module_unavailable']);
  assert.ok(!JSON.stringify(unavailable).includes('secret upstream text'));
  const malformed = await decide('verification', { repo: '/repo', input }, dependencies({ ...verification, check_0: true }));
  assert.equal(malformed.status, 'unavailable');
  assert.ok(malformed.uncertainty.includes('malformed_response'));
});

test('ambiguous probability and incomplete actual diff block confident local skips', async () => {
  for (const deps of [dependencies({ ...verification, local_feedback: answer(0.5) }), { ...dependencies({ ...verification, local_feedback: answer(0.01) }), collectFacts: async () => ({ ...facts, context_incomplete: true }) }]) {
    const result = await decide('verification', { repo: '/repo', input }, deps);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.recommendation.local, 'main_agent');
  }
});

test('protected and uncertain review findings remain investigation even when model proposes follow-up', async () => {
  const request = { schema_version: 1, findings: [{ id: 'isolation', summary: 'Can read another tenant record', category: 'tenant' }] };
  const answers = { sufficient_context: answer(0.96), defect_0: answer(0.01), protected_0: answer(0.01), evidence_0: answer(0.96), finding_0: { ...choice('follow_up', 0.93), probabilities: { must_fix: 0.02, investigate: 0.03, follow_up: 0.95 } } };
  const result = await decide('review-triage', { repo: '/repo', input: request }, dependencies(answers));
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.recommendation.findings, [{ id: 'isolation', category: 'investigate' }]);
  const lowConfidence = await decide('review-triage', { repo: '/repo', input: { ...request, findings: [{ ...request.findings[0], category: 'other' }] } }, dependencies({ ...answers, finding_0: choice('follow_up', 0.6) }));
  assert.equal(lowConfidence.status, 'uncertain');
  assert.equal(lowConfidence.recommendation.findings[0].category, 'investigate');
});

test('status separates available credential and cached verification from current connectivity', async () => {
  let calls = 0;
  const deps = { loadLibrary: async () => ({ authState: () => ({ usable: true, kind: 'stored', verified: true, verifiedAt: '2026-01-01T00:00:00.000Z' }), createTypeSafe: () => ({ listModels: async () => { calls++; return ['jev']; } }) }) };
  const passive = await status({}, deps);
  assert.equal(passive.credentials, 'available');
  assert.equal(passive.cached_auth_verified, true);
  assert.equal(passive.connectivity, 'not_checked');
  assert.equal(calls, 0);
  assert.equal((await status({ verifyConnectivity: true, offline: true }, deps)).connectivity, 'not_checked');
  assert.equal(calls, 0);
  assert.equal((await status({ verifyConnectivity: true }, deps)).connectivity, 'validated');
  assert.equal(calls, 1);
});

test('mechanical git facts redact credentials, invalidate omitted context, and never execute supplied commands or external diff', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'jev-repo-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'accounts.mjs'), 'return false;\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(join(repo, 'accounts.mjs'), 'const api_key = "sensitive-fixture-value";\nreturn true;\n');
  await writeFile(join(repo, '.env'), 'PASSWORD=sensitive-env-fixture\n');
  await writeFile(join(repo, '.npmrc'), '//registry.example/:_authToken=npm_sensitivefixture012345678901234567890\n');
  await writeFile(join(repo, 'connection.mjs'), 'const url = "postgres://role:password-fixture@db.example/test";\n');
  const marker = join(repo, 'executed');
  git('config', 'diff.external', `touch ${marker}`);
  const first = await collectFacts(repo);
  assert.match(first.change_excerpt, /return true/);
  assert.ok(!first.change_excerpt.includes('sensitive-fixture-value'));
  assert.ok(!first.change_excerpt.includes('sensitive-env-fixture'));
  assert.ok(!first.change_excerpt.includes('npm_sensitivefixture'));
  assert.ok(!first.change_excerpt.includes('password-fixture'));
  assert.ok(!first.change_excerpt.includes('_authToken'));
  assert.equal(first.context_incomplete, true);
  const next = await decide('verification', { repo, input: { ...input, focused_checks: [{ id: 'danger', purpose: 'A command is data only', command: `touch ${marker}` }] }, offline: true }, { recordDecision: async () => 'recorded' });
  assert.equal(next.status, 'unavailable');
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  await writeFile(join(repo, 'accounts.mjs'), 'return 42;\n');
  const second = await collectFacts(repo);
  assert.notEqual(first.working_tree_digest, second.working_tree_digest);
  await Promise.all(['.env', '.npmrc', 'connection.mjs'].map(p => rm(join(repo, p))));
  git('add', 'accounts.mjs'); git('commit', '-m', 'changed behavior');
  const clean = await collectFacts(repo);
  assert.equal(clean.dirty, false);
  assert.equal(clean.context_incomplete, true);
  const committed = await collectFacts(repo, { baseRevision: base });
  assert.match(committed.change_excerpt, /return 42/);
  assert.equal(committed.context_incomplete, false);
  assert.ok(committed.changed_files.includes('accounts.mjs'));
});

test('durable log stores mechanical decision metadata without caller source, IDs or repository paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-log-'));
  const prior = process.env.JEV_STATE_DIR;
  process.env.JEV_STATE_DIR = directory;
  t.after(async () => { if (prior === undefined) delete process.env.JEV_STATE_DIR; else process.env.JEV_STATE_DIR = prior; await rm(directory, { recursive: true, force: true }); });
  const result = await decide('verification', { repo: '/secret-repo-path', input: { ...input, change_summary: 'source-secret-example' } }, dependencies(verification));
  assert.equal(await recordDecision(result, '/secret-repo-path', 'pending'), 'recorded');
  const text = await readFile(join(directory, 'decisions.jsonl'), 'utf8');
  assert.ok(!text.includes('secret-repo-path'));
  assert.ok(!text.includes('source-secret-example'));
  assert.ok(!text.includes('security-contract'));
  assert.equal(JSON.parse(text).revision, revision);
  assert.equal((await stat(join(directory, 'decisions.jsonl'))).mode & 0o777, 0o600);
});

test('official MCP client negotiates stdio and reads structured offline fallback without executing input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = new Client({ name: 'jev-contract-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('./mcp.mjs', import.meta.url).pathname, '--offline'], env: { ...process.env, JEV_STATE_DIR: directory }, stderr: 'pipe' });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(x => x.name), ['jev_verification', 'jev_review_triage', 'jev_status']);
  const reply = await client.callTool({ name: 'jev_verification', arguments: { repo: directory, input } });
  assert.equal(reply.isError, false);
  assert.equal(JSON.parse(reply.content[0].text).status, 'unavailable');
  const invalid = await client.callTool({ name: 'jev_verification', arguments: { repo: directory, input: { schema_version: 1, arbitrary_command: 'exit 1' } } });
  assert.equal(invalid.isError, true);
});

test('unknown broad-suite ownership cannot invent CI or waive required local gates', async () => {
  const { policy, ...request } = input;
  const result = await decide('verification', { repo: '/repo', input: request }, dependencies({ ...verification, local_feedback: answer(0.01) }));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.recommendation.broad_suite, 'operator');
  assert.equal(result.recommendation.local, 'main_agent');
  assert.deepEqual(result.recommendation.mandatory_gates, ['security-contract']);
  assert.ok(result.uncertainty.includes('broad_suite_owner_unknown'));
});

test('budget exhaustion preserves policy and returns unavailable without retry', async () => {
  let calls = 0;
  const deps = dependencies(verification);
  const lib = await deps.loadLibrary();
  deps.loadLibrary = async () => ({ ...lib, ask: async () => { calls++; return { ok: false, errorCode: 'budget', error: 'private upstream message' }; } });
  const result = await decide('verification', { repo: '/repo', input }, deps);
  assert.equal(calls, 1);
  assert.equal(result.status, 'unavailable');
  assert.ok(result.uncertainty.includes('budget'));
  assert.equal(result.recommendation.broad_suite, 'ci');
  assert.deepEqual(result.recommendation.mandatory_gates, ['security-contract']);
  assert.ok(!JSON.stringify(result).includes('private upstream message'));
});

test('a nonsettling judgment returns within the fixed deadline', async () => {
  const deps = dependencies(verification);
  const lib = await deps.loadLibrary();
  deps.loadLibrary = async () => ({ ...lib, ask: async () => new Promise(() => {}) });
  const start = Date.now();
  const result = await decide('verification', { repo: '/repo', input }, deps);
  assert.equal(result.status, 'unavailable');
  assert.ok(result.uncertainty.includes('timeout'));
  assert.ok(Date.now() - start < 6500);
});


test('absence of CI leaves broad testing with the operator while allowing useful focused feedback', async () => {
  const request = { ...input, policy: { broad_suite_owner: 'operator' }, planned_ci_checks: [] };
  const result = await decide('verification', { repo: '/repo', input: request }, dependencies({ ...verification, uncovered_ci_need: answer(0.96) }));
  assert.equal(result.status, 'recommendation');
  assert.equal(result.recommendation.local, 'focused');
  assert.equal(result.recommendation.broad_suite, 'operator');
  assert.deepEqual(result.recommendation.focused_check_ids, ['target']);
  assert.deepEqual(result.recommendation.mandatory_gates, ['security-contract']);
});
