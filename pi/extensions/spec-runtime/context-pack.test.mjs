// Run alone: node --test pi/extensions/spec-runtime/context-pack.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildContextPack, outline, writeContextPack } from './context-pack.mjs';

test('outline gives top-level declarations and class methods with inclusive ranges', () => {
  const text = ['import x from "y";', 'export function alpha(a) {', '  return a;', '}', 'class Beta {', '  async start(input) {', '    if (input) {', '    }', '  }', '}'].join('\n');
  assert.deepEqual(outline(text).map(({ name, kind, exported, start, end }) => [name, kind, exported, start, end]),
    [['alpha', 'function', true, 2, 4], ['Beta', 'class', false, 5, 5], ['start', 'method', false, 6, 10]]);
});

test('pack carries prerequisite exports, the learning introduced block, anchors, tests and changes since planning', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'pkg'), repo = join(root, 'repo');
  mkdirSync(join(pkg, 'learnings'), { recursive: true }); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'spec-steps.json'), JSON.stringify({ steps: [
    { step: 1, name: 'Owner core', requires: [], writes: ['src/core.mjs', 'src/core.test.mjs'] },
    { step: 2, name: 'Wire it', requires: [1], writes: ['src/wire.mjs', 'src/wire.test.mjs', 'src/new.mjs'] }] }));
  writeFileSync(join(pkg, 'learnings/step-001-learning.md'), ['```yaml', 'learning:', '  outcome: as-specified', '  introduced:', '    - symbol: claim(path)', '      returns: "{ ok, token }"', '  gaps: []', '```'].join('\n'));
  writeFileSync(join(pkg, 'step-002-subspec.md'), '# Step 2');
  utimesSync(join(pkg, 'step-002-subspec.md'), new Date(1000_000_000_000), new Date(1000_000_000_000));
  writeFileSync(join(repo, 'src/core.mjs'), ['const internal = 1;', 'export function claim(path) {', '  return { ok: true };', '}'].join('\n'));
  writeFileSync(join(repo, 'src/wire.mjs'), ['export class Wire {', '  run(record) {', '    return record;', '  }', '}'].join('\n'));
  writeFileSync(join(repo, 'src/wire.test.mjs'), ["test('wire: binds a claim', () => {});", "test('wire: refuses stale', () => {});"].join('\n'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q'); git('-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'add claim core');
  const pack = buildContextPack({ packageDir: pkg, stepPath: join(pkg, 'step-002-subspec.md'), checkout: repo });
  assert.match(pack, /- [0-9a-f]+ add claim core/, 'commit after the card mtime is listed');
  assert.match(pack, /src\/core\.mjs:2 `export function claim\(path\) \{`/);
  assert.doesNotMatch(pack, /internal/, 'unexported declarations are not prerequisite contracts');
  assert.match(pack, /symbol: claim\(path\)\n\s+returns: "\{ ok, token \}"/);
  assert.match(pack, /src\/wire\.mjs:1-1 class Wire \(exported\)\n  - src\/wire\.mjs:2-5 method run/);
  assert.match(pack, /src\/wire\.test\.mjs \(2 lines, 2 tests\)\n  - src\/wire\.test\.mjs:1 wire: binds a claim/);
  assert.match(pack, /- src\/new\.mjs: new file/);
  const written = writeContextPack({ packageDir: pkg, stepPath: join(pkg, 'step-002-subspec.md'), checkout: repo });
  assert.equal(written, join(pkg, 'runtime/context/step-002.md'));
  assert.equal(readFileSync(written, 'utf8'), pack);
});
