// Test fixture: a temp storage root with workspace "demo" (repositories alpha
// and beta, both real git repos) and options that pin the host and home.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function gitInit(path) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', path]);
}

export function makeFixture({ executionHost = 'box' } = {}) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'spec-location-')));
  const root = join(tmp, 'storage');
  const alpha = join(tmp, 'alpha');
  const beta = join(tmp, 'beta');
  gitInit(alpha);
  gitInit(beta);
  mkdirSync(join(root, 'projects', 'demo'), { recursive: true });
  const kit = (id, extra = '') => `version: 1\nid: ${id}\nname: ${id}\n${extra}repositories:\n  - id: alpha\n    path: ${alpha}\n  - id: beta\n    path: ${beta}\n`;
  put(join(root, 'projects', 'demo', 'kit.yaml'), kit('demo', executionHost ? `execution_host: ${executionHost}\n` : ''));
  const options = { root, hostname: 'box.local', home: tmp, env: { XDG_DATA_HOME: join(tmp, 'data') } };
  return { tmp, root, alpha, beta, options, kit, workspaceDir: join(root, 'projects', 'demo'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}
