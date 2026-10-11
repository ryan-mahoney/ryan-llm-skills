import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, rename, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execute } from './cli.mjs';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const installed = spawnSync('which', ['unison'], { encoding: 'utf8' });
const UNISON = installed.status === 0 ? installed.stdout.trim() : null;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'adjacent-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = join(root, 'client-private-data');
  const host = join(root, 'host-private-data');
  const config = join(root, 'private-config', 'sync.json');
  const bin = join(root, 'bin');
  const remoteState = join(root, 'remote-state');
  for (const path of [client, host, dirname(config), bin, remoteState]) await mkdir(path, { recursive: true, mode: 0o700 });
  const values = { schema_version: 1, local_root: client, remote_root: host, ssh_host: 'private-ssh-alias', unison: UNISON || 'unison', remote_unison: UNISON || 'unison' };
  await writeFile(config, JSON.stringify(values), { mode: 0o600 });
  const ssh = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const server = args.indexOf('-server');
const env = { ...process.env, UNISON: ${JSON.stringify(remoteState)} };
const result = server !== -1
  ? spawnSync(${JSON.stringify(UNISON)}, args.slice(server), { env, stdio: 'inherit' })
  : spawnSync('/bin/sh', ['-c', args.at(-1)], { env, stdio: 'inherit' });
process.exitCode = result.status ?? 3;
`;
  await writeFile(join(bin, 'ssh'), ssh, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(root, 'xdg') };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--config', config], { env, encoding: 'utf8', timeout: 20_000 });
  return { root, client, host, config, values, bin, env, run };
}

test('init publishes an owner-only template outside Git and never overwrites it', async t => {
  const f = await fixture(t);
  await unlink(f.config);
  assert.equal(f.run('init').status, 0);
  assert.equal((await stat(f.config)).mode & 0o777, 0o600);
  const template = await readFile(f.config, 'utf8');
  assert.equal(f.run('init').status, 3);
  assert.equal(await readFile(f.config, 'utf8'), template);
  const checkout = join(f.root, 'checkout');
  await mkdir(checkout);
  spawnSync('git', ['init', checkout]);
  const denied = spawnSync(process.execPath, [CLI, 'init', '--config', join(checkout, 'private.json')], { encoding: 'utf8' });
  assert.equal(denied.status, 3);
  assert.match(denied.stderr, /outside Git checkouts/);
  assert.equal((await readdir(checkout)).includes('private.json'), false);
});

test('config errors and dependency errors never disclose private values', async t => {
  const f = await fixture(t);
  f.values.unison = join(f.root, 'private-missing-command');
  await writeFile(f.config, JSON.stringify(f.values));
  const missing = f.run('status');
  assert.equal(missing.status, 3);
  assert.match(missing.stdout, /install Unison/);
  assert.equal((missing.stdout + missing.stderr).includes(f.root), false);
  f.values.remote_root = '/private-host-data\nforce = /';
  await writeFile(f.config, JSON.stringify(f.values));
  const injection = f.run('preview');
  assert.equal(injection.status, 3);
  assert.equal((injection.stdout + injection.stderr).includes('private-host-data'), false);
  assert.equal((await readdir(dirname(f.config))).includes('sync-state'), false);
  const alias = join(f.root, 'data-symlink');
  await symlink(dirname(f.config), alias);
  f.values.local_root = alias;
  f.values.remote_root = f.host;
  await writeFile(f.config, JSON.stringify(f.values));
  assert.match(f.run('status').stderr, /outside the synced data folder/);
});

test('the installed symlink runs the CLI and SSH failures stay private', { skip: !UNISON }, async t => {
  const f = await fixture(t);
  const link = join(f.root, 'adjacent-sync');
  await symlink(CLI, link);
  const help = spawnSync(link, ['--help'], { env: f.env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: adjacent-sync/);
  await writeFile(join(f.bin, 'ssh'), '#!/bin/sh\necho "private-host.example /private-account secret-token" >&2\nexit 255\n', { mode: 0o700 });
  const failed = f.run('status');
  assert.equal(failed.status, 3);
  assert.match(failed.stdout, /host: connection or Unison check failed/);
  assert.doesNotMatch(failed.stdout + failed.stderr, /private-host\.example|private-account|secret-token/);
  assert.match(f.run('status', '--verbose').stderr, /private-host\.example/);
});

test('real Unison previews without transfers, then syncs additions, edits, renames and deletions with state excluded', { skip: !UNISON }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.client, 'client-note.md'), 'client original');
  await writeFile(join(f.host, 'host-note.md'), 'host original');
  const excluded = ['.sentinel/local.json', '.adjacent/state.sqlite3', 'projects/example/threads/local.json', 'projects/example/sessions/local.json', 'projects/example/assignments/local.json', 'projects/example/specs/a/runtime/local.json', 'projects/example/captures/app/ux-qa/runs/session.json', 'kit.yaml.lock', '.DS_Store'];
  // Only spec-package runtime is host-owned; a runtime folder in research sources syncs.
  await mkdir(join(f.client, 'projects/example/sources/runtime'), { recursive: true });
  await writeFile(join(f.client, 'projects/example/sources/runtime/notes.md'), 'research');
  for (const path of excluded) {
    await mkdir(dirname(join(f.host, path)), { recursive: true });
    await writeFile(join(f.host, path), 'host-owned');
  }
  const preview = f.run('preview');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /client-note.md/);
  assert.match(preview.stdout, /host-note.md/);
  assert.match(preview.stdout, /No files were transferred/);
  assert.equal((await readdir(f.client)).includes('host-note.md'), false);
  assert.equal((await readdir(f.host)).includes('client-note.md'), false);
  assert.doesNotMatch(preview.stdout + preview.stderr, /private-ssh-alias/);
  assert.equal((preview.stdout + preview.stderr).includes(f.root), false);
  const first = f.run('run');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(await readFile(join(f.client, 'host-note.md'), 'utf8'), 'host original');
  assert.equal(await readFile(join(f.host, 'client-note.md'), 'utf8'), 'client original');
  for (const path of excluded) await assert.rejects(stat(join(f.client, path)), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.host, 'projects/example/sources/runtime/notes.md'), 'utf8'), 'research');
  await writeFile(join(f.client, 'client-note.md'), 'client edited');
  await rename(join(f.host, 'host-note.md'), join(f.host, 'renamed-host-note.md'));
  const reorganized = f.run('run');
  assert.equal(reorganized.status, 0, reorganized.stdout + reorganized.stderr);
  assert.equal(await readFile(join(f.host, 'client-note.md'), 'utf8'), 'client edited');
  await assert.rejects(stat(join(f.client, 'host-note.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.client, 'renamed-host-note.md'), 'utf8'), 'host original');
  await unlink(join(f.client, 'client-note.md'));
  const deleted = f.run('run');
  assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
  await assert.rejects(stat(join(f.host, 'client-note.md')), { code: 'ENOENT' });
  for (const path of excluded) assert.equal(await readFile(join(f.host, path), 'utf8'), 'host-owned');
  assert.equal((await readdir(join(dirname(f.config), 'sync-state'))).some(name => name.endsWith('.prf')), false);
  assert.equal((await stat(join(dirname(f.config), 'sync-state'))).mode & 0o777, 0o700);
});

test('preview enumerates conflicts without accepting changes and run reports unresolved conflicts', { skip: !UNISON }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.client, 'conflict.md'), 'client content');
  await writeFile(join(f.host, 'conflict.md'), 'different host content');
  await writeFile(join(f.client, 'new.md'), 'new content');
  const preview = f.run('preview');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /new.md/);
  assert.equal(await readFile(join(f.client, 'conflict.md'), 'utf8'), 'client content');
  assert.equal(await readFile(join(f.host, 'conflict.md'), 'utf8'), 'different host content');
  await assert.rejects(stat(join(f.host, 'new.md')), { code: 'ENOENT' });
  const result = f.run('run');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(await readFile(join(f.host, 'new.md'), 'utf8'), 'new content');
  assert.equal(await readFile(join(f.host, 'conflict.md'), 'utf8'), 'different host content');
});

test('a timed-out process cannot keep the command waiting indefinitely', async () => {
  const result = await execute(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeout: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 3);
});
