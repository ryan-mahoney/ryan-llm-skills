import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { artifactEnvironment } from './artifact-environment.mjs';

test('artifact scope names only the physical package and rejects unrepresentable broad paths', t => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'); mkdirSync(pkg);
  const link = join(root, 'alias'); symlinkSync(pkg, link);
  assert.deepEqual(artifactEnvironment(link), { PI_WARDEN_HOST_PATHS: pkg });
  assert.throws(() => artifactEnvironment('/'), /bounded/);
  assert.throws(() => artifactEnvironment('relative'), /absolute/);
  const colon = join(root, 'package:other'); mkdirSync(colon);
  assert.throws(() => artifactEnvironment(colon), /bounded/);
});

const warden = process.env.SPEC_PI_WARDEN || join(homedir(), '.pi/agent/npm/node_modules/pi-warden/dist');
test('installed Warden permits declared package artifacts and keeps sibling and symlink escapes guarded', { skip: !existsSync(join(warden, 'guard.js')) && 'Pi Warden unavailable' }, async t => {
  let evaluateAction, hostPaths, defaultConfig;
  try {
    ({ evaluateAction, hostPaths } = await import(pathToFileURL(join(warden, 'guard.js'))));
    ({ defaultConfig } = await import(pathToFileURL(join(warden, 'config.js'))));
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('Installed Warden needs its Pi host peer-dependency resolver'); return;
  }
  const root = mkdtempSync(join(tmpdir(), 'artifact-warden-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'package'), cwd = join(root, 'checkout'), sibling = join(root, 'sibling');
  for (const dir of [pkg, cwd, sibling]) mkdirSync(dir);
  for (const dir of [pkg, sibling]) writeFileSync(join(dir, 'review.md'), 'Prior review');
  symlinkSync(sibling, join(pkg, 'escape'));
  const options = { config: defaultConfig().action, hostPaths: hostPaths(artifactEnvironment(pkg)), traceSample: false };
  const inspect = path => evaluateAction({ tool: 'write', input: { path, content: 'Updated review' }, cwd, task: 'Write the assigned review artifact.' }, options);
  assert.equal((await inspect(join(pkg, 'review.md'))).level, 'allow');
  for (const path of [join(sibling, 'review.md'), join(pkg, 'escape/review.md')]) {
    const verdict = await inspect(path);
    assert.equal(verdict.level, 'confirm');
    assert.match(verdict.reasons.join(' '), /outside.*project/);
  }
});
