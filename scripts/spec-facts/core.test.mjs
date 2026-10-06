import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFacts, createLogSummary, summarizeLog } from './core.mjs';

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'spec-facts-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  return { repo, git };
}

test('Git facts preserve unusual paths and separate staged, unstaged and untracked without refreshing the index', t => {
  const { repo, git } = fixture(t);
  const path = 'space "quote"\nand newline.txt';
  writeFileSync(join(repo, path), 'initial'); git('add', '--', path); git('commit', '-qm', 'Initial');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, path), 'committed'); git('commit', '-qam', 'Change');
  writeFileSync(join(repo, path), 'staged'); git('add', '--', path);
  writeFileSync(join(repo, path), 'unstaged');
  writeFileSync(join(repo, 'untracked'), 'one'); writeFileSync(join(repo, 'another'), 'two');
  const index = readFileSync(join(repo, '.git/index'));
  const facts = gitFacts({ repo, base, limit: 1 });
  assert.deepEqual(facts.staged.entries, [{ status: 'MM', path }]);
  assert.deepEqual(facts.unstaged.entries, [{ status: 'MM', path }]);
  assert.equal(facts.untracked.total, 2); assert.equal(facts.untracked.omitted, 1);
  assert.equal(facts.clean, false);
  assert.deepEqual(facts.range.changed.entries, [{ status: 'M', path }]);
  assert.equal(facts.range.commits_ahead, 1);
  assert.deepEqual(readFileSync(join(repo, '.git/index')), index);
  assert.throws(() => gitFacts({ repo, base: '--output=bad' }), /invalid revision/);
  assert.throws(() => gitFacts({ repo, base: 'absent-revision' }));
  assert.throws(() => gitFacts({ repo, head: base }), /explicit base/);
});

test('Git facts distinguish unborn and detached HEAD and resolve the supplied review range', t => {
  const { repo, git } = fixture(t);
  const unborn = gitFacts({ repo }); assert.equal(unborn.head, null); assert.ok(unborn.branch);
  writeFileSync(join(repo, 'file'), 'one'); git('add', 'file'); git('commit', '-qm', 'Initial');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'file'), 'two'); git('commit', '-qam', 'Second');
  const head = git('rev-parse', 'HEAD'); git('checkout', '-q', '--detach', base);
  const facts = gitFacts({ repo, base, head });
  assert.equal(facts.branch, null); assert.equal(facts.head, base);
  assert.equal(facts.range.head, head); assert.equal(facts.range.changed.total, 1);
});

test('log excerpts retain early diagnostics, context and tail without manufacturing a verdict', async t => {
  const { repo } = fixture(t);
  const content = 'setup\n'.repeat(500) + 'case: rejected command\nAssertion failed: expected rejection\nactual: pending\n' + 'unrelated output\n'.repeat(2000) + '1 test, 1 failure\n';
  const summary = createLogSummary(); summary.write(Buffer.from(content));
  const result = summary.finish();
  assert.equal(result.output_truncated, true); assert.ok(result.output.length < 8000);
  assert.match(result.output, /501: case: rejected command/);
  assert.match(result.output, /502: Assertion failed/);
  assert.match(result.output, /503: actual: pending/);
  assert.ok(result.output.endsWith('1 test, 1 failure\n'));
  assert.equal(result.output_bytes, Buffer.byteLength(content));
  const file = join(repo, 'log'); writeFileSync(file, content);
  const fromFile = await summarizeLog(file);
  assert.equal(fromFile.output, result.output); assert.equal(fromFile.exit_code, null);
  assert.equal(readFileSync(file, 'utf8'), content);
});

test('UTF-8 split chunks and oversized lines have bounded, chunk-independent excerpts', () => {
  const content = Buffer.from('error: résumé\n' + 'x'.repeat(20000) + '\nfailed: Ω\n');
  const whole = createLogSummary(), chunks = createLogSummary(); whole.write(content);
  for (let i = 0; i < content.length; i += 7) chunks.write(content.subarray(i, i + 7));
  assert.deepEqual(chunks.finish(), whole.finish());
  const short = createLogSummary();
  for (const byte of Buffer.from('résumé Ω')) short.write(Buffer.from([byte]));
  assert.equal(short.finish().output, 'résumé Ω');
});

test('unknown output and success-looking text remain excerpts, not success evidence', () => {
  const summary = createLogSummary(); summary.write('mystery\n'.repeat(3000) + 'all passed\n');
  const result = summary.finish();
  assert.equal(result.output_truncated, true);
  assert.equal(result.excerpt_selection.exhaustive, false);
  assert.equal(result.excerpt_selection.pattern_matching_lines, 0);
  assert.equal('exit_code' in result, false); assert.equal('status' in result, false);
  assert.match(result.output, /none captured/);
});

test('CLI reports unreadable logs and invalid options as failures', () => {
  const cli = new URL('./cli.mjs', import.meta.url).pathname;
  for (const args of [['log', '--file', '/nonexistent/spec-facts.log'], ['git', '--limit', '0'], ['git', '--fetch', 'yes']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(JSON.parse(result.stderr).error);
    assert.equal(result.stdout, '');
  }
});
