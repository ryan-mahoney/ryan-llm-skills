// Test helper: git repositories, a storage root with a workspace kit, and a spec
// package created through spec-location. `location` is the options object the
// runtime and spec-location take (root, pinned hostname and home).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPackage } from '../../../scripts/spec-location/index.mjs';
import { put } from '../../../scripts/spec-location/fixture.mjs';

export async function makePackageFixture({ prefix = 'spec-runtime-test-', slug = 'feature', repos = ['repo'], targets = [repos[0]] } = {}) {
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
  put(join(workspaceDir, 'kit.yaml'), `version: 1\nid: demo\nname: demo\nexecution_host: box\nrepositories:\n${repos.map(id => `  - id: ${id}\n    path: ${paths[id]}\n`).join('')}`);
  const location = { root, hostname: 'box.local', home: dir, env: { XDG_DATA_HOME: join(dir, 'data') } };
  const created = await newPackage({ workspace: 'demo', slug, targets: targets.map(id => ({ id })), ...location });
  if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
  return { dir, repo: paths[repos[0]], paths, root, workspaceDir, location, locations: created.locations,
    packagePath: created.locations.package_dir, ref: created.locations.package_ref };
}
