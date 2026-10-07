import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryDiscovery, discoverRepositories, discoveryConfigPath, saveDiscoveryRoot, DISCOVERY_LIMITS } from './discovery.mjs';

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sentinel-discovery-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'Documents'), agentDir = join(home, 'agent');
  mkdirSync(root); mkdirSync(agentDir);
  const repo = path => { mkdirSync(join(path, '.git'), { recursive: true }); mkdirSync(join(path, '.specs')); return path; };
  return { home, root, agentDir, repo };
}

test('default Documents discovery finds grouped and nested repositories without enrollment', async t => {
  const f = fixture(t);
  const outer = f.repo(join(f.root, 'work', 'outer'));
  const inner = f.repo(join(outer, 'packages', 'inner'));
  f.repo(join(outer, 'node_modules', 'ignored'));
  const outside = f.repo(join(f.home, 'outside'));
  symlinkSync(outside, join(f.root, 'alias'));
  const result = await createRepositoryDiscovery({ agentDir: f.agentDir, home: f.home }).read();
  assert.equal(result.root, f.root);
  assert.deepEqual(result.roots.sort(), [outer, inner].sort());
  assert.deepEqual(result.reasons, []);
});

test('cached discovery refreshes new nested repositories and persists an alternate root', async t => {
  const f = fixture(t); let time = 0;
  const discovery = createRepositoryDiscovery({ agentDir: f.agentDir, home: f.home, now: () => time });
  assert.deepEqual((await discovery.read()).roots, []);
  const added = f.repo(join(f.root, 'new', 'project'));
  assert.deepEqual((await discovery.read()).roots, []);
  time = DISCOVERY_LIMITS.cacheMs;
  assert.deepEqual((await discovery.read()).roots, [added]);
  const alternate = f.repo(join(f.home, 'Elsewhere'));
  await saveDiscoveryRoot(f.agentDir, '~/Elsewhere', f.home);
  assert.deepEqual((await discovery.read()).roots, [alternate]);
  assert.equal((await createRepositoryDiscovery({ agentDir: f.agentDir, home: f.home }).read()).root, alternate);
  assert.equal((await createRepositoryDiscovery({ ...f, root: f.root }).read()).root, f.root);
});

test('directory, depth and entry limits report incomplete discovery', async t => {
  const f = fixture(t);
  f.repo(join(f.root, 'group', 'project'));
  for (const limits of [{ depth: 0 }, { directories: 1 }, { entries: 1 }]) {
    const result = await discoverRepositories(f.root, { limits: { ...DISCOVERY_LIMITS, ...limits } });
    assert.ok(result.reasons.some(reason => /discovery-(depth-)?cap/.test(reason)), JSON.stringify(result));
  }
  const missing = await discoverRepositories(join(f.home, 'missing'));
  assert.match(missing.reasons[0], /discovery-unavailable/);
});

test('invalid or symlinked configuration is reported rather than silently scanning the default', async t => {
  const f = fixture(t);
  mkdirSync(join(f.agentDir, 'spec-sentinel'));
  writeFileSync(discoveryConfigPath(f.agentDir), '{broken');
  assert.match((await createRepositoryDiscovery({ agentDir: f.agentDir, home: f.home }).read()).reasons[0], /discovery-config-unavailable/);
  rmSync(discoveryConfigPath(f.agentDir));
  writeFileSync(join(f.home, 'config'), JSON.stringify({ version: 1, root: f.root }));
  symlinkSync(join(f.home, 'config'), discoveryConfigPath(f.agentDir));
  assert.match((await createRepositoryDiscovery({ agentDir: f.agentDir, home: f.home }).read()).reasons[0], /discovery-config-unavailable/);
});
