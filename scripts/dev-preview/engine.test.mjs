// Run individual cases: node --test --test-name-pattern='<case name>' scripts/dev-preview/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { processIdentity, inspectProcess } from '../spec-observe/process-identity.mjs';
import { executeOperation, validateCompose, runCommand } from './engine.mjs';
import { readRecord, publicRecord, openStore, saveRecord } from './store.mjs';
import { resolvePreview, createPreviewService, previewKey } from './service.mjs';
import { makeFixture, put } from '../spec-location/fixture.mjs';
import { newPackage, recordWorktree } from '../spec-location/index.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'preview-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { runtimeRoot: join(root, 'runtime'), context: { key: 'package-a', ref: 'demo/a', root, primary: root, worktree: root, composeFile: join(root, 'compose.yaml') } };
}
function commands({ failUp = false, failDown = false, conflictAfterReady = false } = {}) {
  const dns = 'host.tailnet.ts.net', unrelated = { Handlers: { '/': { Proxy: 'http://127.0.0.1:4444' } } };
  const config = { Web: { [`${dns}:443`]: unrelated }, TCP: { 443: { HTTPS: true } } };
  const calls = []; let ingressPort;
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'tailscale') {
      if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: dns + '.' } });
      if (args[1] === 'status') return JSON.stringify(config);
      const port = Number(args.find(value => value.startsWith('--https=')).split('=')[1]);
      if (args.includes('off')) { delete config.Web[`${dns}:${port}`]; delete config.TCP[port]; }
      else { config.Web[`${dns}:${port}`] = { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } }; config.TCP[port] = { HTTPS: true }; }
      return '';
    }
    if (args[0] === 'ps') return '';
    if (args.includes('config')) {
      ingressPort = Number(options.env.PREVIEW_PORT);
      return JSON.stringify({ services: { app: { environment: { SECRET: '$literal' }, ports: [{ host_ip: '127.0.0.1', published: ingressPort, target: 80 }] } } });
    }
    if (args.includes('up') && failUp) throw Object.assign(Error('build failed'), { stderr: 'secret build output' });
    if (args.includes('down') && failDown) throw Error('shutdown failed');
    return '';
  };
  const ready = async () => { if (conflictAfterReady) config.Web[`${dns}:${ingressPort}`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } }; };
  return { run, ready, available: async () => true, portRange: [18000, 18003], calls, config, unrelated, dns };
}

test('preview lifecycle freezes config, publishes only ready ingress, and stops only its owned route', async t => {
  const f = fixture(t), runtime = commands();
  await executeOperation({ ...f, action: 'start' }, runtime);
  const running = readRecord(f.runtimeRoot, f.context.key);
  assert.equal(running.state, 'running'); assert.equal(running.port, 18000);
  assert.equal(publicRecord(running).url, 'https://host.tailnet.ts.net:18000');
  assert.equal(JSON.parse(readFileSync(running.frozen)).services.app.environment.SECRET, '$$literal');
  assert.deepEqual(runtime.config.Web[`${runtime.dns}:443`], runtime.unrelated);
  await executeOperation({ ...f, context: { key: f.context.key }, action: 'stop' }, runtime);
  const stopped = readRecord(f.runtimeRoot, f.context.key);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.port, null); assert.equal(stopped.url, null);
  assert.deepEqual(runtime.config.Web, { [`${runtime.dns}:443`]: runtime.unrelated });
  assert.ok(runtime.calls.some(call => call.command === 'docker' && call.args.includes('down') && call.args.includes(running.frozen)));
});

test('preview failed build rolls back containers and releases its port without publishing diagnostics', async t => {
  const f = fixture(t), runtime = commands({ failUp: true });
  await executeOperation({ ...f, action: 'start' }, runtime);
  const record = readRecord(f.runtimeRoot, f.context.key);
  assert.equal(record.state, 'error'); assert.equal(record.port, null);
  assert.equal(publicRecord(record).can_start, true, 'clean rollback allows retry after fixing configuration');
  assert.ok(runtime.calls.some(call => call.args.includes('down')));
  assert.equal(Object.keys(runtime.config.Web).length, 1);
  assert.doesNotMatch(JSON.stringify(publicRecord(record)), /secret build output/);
  assert.match(readFileSync(join(f.runtimeRoot, f.context.key, 'operation.log'), 'utf8'), /secret build output/);
});

test('preview failed cleanup retains lease and permits later stop using frozen configuration', async t => {
  const f = fixture(t), runtime = commands({ failUp: true, failDown: true });
  await executeOperation({ ...f, action: 'start' }, runtime);
  const failed = readRecord(f.runtimeRoot, f.context.key);
  assert.equal(failed.state, 'error'); assert.equal(failed.port, 18000);
  assert.equal(publicRecord(failed).can_stop, true);
  await executeOperation({ ...f, context: { key: f.context.key }, action: 'stop' }, commands());
  assert.equal(readRecord(f.runtimeRoot, f.context.key).port, null);
});

test('preview allocator skips Serve ports, occupied listeners, and other package leases', async t => {
  const f = fixture(t), runtime = commands();
  runtime.config.TCP[18000] = { HTTPS: true };
  runtime.available = async port => port !== 18001;
  await executeOperation({ ...f, action: 'start' }, runtime);
  await executeOperation({ ...f, context: { ...f.context, key: 'package-b', ref: 'demo/b' }, action: 'start' }, runtime);
  assert.equal(readRecord(f.runtimeRoot, 'package-a').port, 18002);
  assert.equal(readRecord(f.runtimeRoot, 'package-b').port, 18003);
});

test('preview refuses to overwrite or remove a Serve route claimed while ingress became ready', async t => {
  const f = fixture(t), runtime = commands({ conflictAfterReady: true });
  await executeOperation({ ...f, action: 'start' }, runtime);
  assert.equal(readRecord(f.runtimeRoot, f.context.key).state, 'error');
  assert.equal(readRecord(f.runtimeRoot, f.context.key).port, 18000);
  assert.equal(runtime.config.Web[`${runtime.dns}:18000`].Handlers['/'].Proxy, 'http://127.0.0.1:9999');
  assert.equal(runtime.calls.some(call => call.command === 'tailscale' && call.args.includes('off')), false);
});

test('preview public state detects a reused process identity and retains cleanup access', () => {
  const state = publicRecord({ state: 'starting', port: 18000, owner: { pid: process.pid, started_at: 'old process identity' } });
  assert.equal(state.state, 'error'); assert.equal(state.can_stop, true); assert.equal(state.can_start, false);
  assert.match(state.error, /interrupted/);
});

test('preview ingress policy refuses public bindings, extra ports, host networking and fixed container names', () => {
  const ingress = { host_ip: '127.0.0.1', published: 18000, target: 80 };
  assert.doesNotThrow(() => validateCompose({ services: { proxy: { ports: [ingress] }, database: {} } }, 18000));
  for (const service of [
    { ports: [{ ...ingress, host_ip: '0.0.0.0' }] }, { ports: [{ ...ingress, published: 18001 }] },
    { ports: [ingress, ingress] }, { ports: [{ ...ingress, protocol: 'udp' }] },
    { ports: [ingress], network_mode: 'host' }, { ports: [ingress], container_name: 'shared' }, {},
  ]) assert.throws(() => validateCompose({ services: { app: service } }, 18000));
});

async function recordedFixture(t) {
  const f = makeFixture(); t.after(f.cleanup);
  execFileSync('git', ['-C', f.alpha, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial']);
  const created = await newPackage({ ...f.options, workspace: 'demo', slug: 'preview', targets: [{ id: 'alpha' }] });
  assert.equal(created.ok, true);
  const worktree = join(f.tmp, 'worktree');
  execFileSync('git', ['-C', f.alpha, 'worktree', 'add', '-qb', 'spec-preview', worktree]);
  assert.equal((await recordWorktree('demo/preview', 'alpha', worktree, f.options)).ok, true);
  put(join(f.workspaceDir, 'kit.yaml'), f.kit('demo', 'execution_host: box\npreview:\n  repository: alpha\n  compose_file: compose.yaml\n'));
  put(join(worktree, 'compose.yaml'), 'services: {}\n');
  const input = { root: join(f.workspaceDir, 'specs', 'preview'), ref: 'demo/preview' };
  const options = { storageRoot: f.root, host: 'box.local' };
  return { f, worktree, input, options };
}

test('preview configuration resolves recorded worktrees and refuses wrong hosts or escaping Compose symlinks', async t => {
  const { f, worktree, input, options } = await recordedFixture(t);
  assert.equal((await resolvePreview(input, options)).worktree, worktree);
  await assert.rejects(resolvePreview(input, { ...options, host: 'elsewhere' }), /execution host/);
  rmSync(join(worktree, 'compose.yaml')); put(join(f.tmp, 'outside.yaml'), 'services: {}\n');
  symlinkSync(join(f.tmp, 'outside.yaml'), join(worktree, 'compose.yaml'));
  await assert.rejects(resolvePreview(input, options), /outside the package worktree/);
});


test('preview operation claims reject a second action until startup releases ownership', async t => {
  const f = fixture(t), runtime = commands();
  let releaseReady, reachedReady;
  const waiting = new Promise(resolve => { releaseReady = resolve; });
  const reached = new Promise(resolve => { reachedReady = resolve; });
  runtime.ready = async () => { reachedReady(); await waiting; };
  const first = executeOperation({ ...f, action: 'start' }, runtime);
  try {
    await reached;
    await assert.rejects(executeOperation({ ...f, action: 'stop' }, commands()), /already in progress/);
    assert.equal(readRecord(f.runtimeRoot, f.context.key).state, 'starting');
  } finally { releaseReady(); await first; }
  await executeOperation({ ...f, action: 'stop' }, runtime);
  assert.equal(readRecord(f.runtimeRoot, f.context.key).state, 'stopped');
});


test('preview interrupted command is terminated before cleanup releases its port lease', async t => {
  const f = fixture(t), runtime = commands();
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
  await once(child.stdout, 'data');
  const identity = processIdentity(child.pid);
  assert.ok(identity, 'the detached process identity is observable');
  const exited = once(child, 'exit');
  const db = openStore(f.runtimeRoot);
  try { saveRecord(db, { key: f.context.key, state: 'starting', project: 'specdev-package-a', port: 18000,
    dns: runtime.dns, url: `https://${runtime.dns}:18000`, frozen: join(f.runtimeRoot, 'compose.json'),
    owner: { pid: process.pid, started_at: 'previous worker identity' }, child: identity }); }
  finally { db.close(); }
  const run = runtime.run;
  runtime.run = async (command, args, options) => {
    if (command === 'docker' && args.includes('down')) {
      assert.equal(inspectProcess(child.pid).state, 'dead', 'interrupted build must be gone before shutdown');
      assert.equal(readRecord(f.runtimeRoot, f.context.key).port, 18000, 'lease remains until cleanup completes');
    }
    return run(command, args, options);
  };
  await executeOperation({ ...f, context: { key: f.context.key }, action: 'stop' }, runtime);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGTERM');
  const stopped = readRecord(f.runtimeRoot, f.context.key);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.port, null); assert.equal(stopped.child, null);
});

test('preview running observation withdraws unavailable containers or missing Serve routes while preserving cleanup receipt', async t => {
  const { f, input, options } = await recordedFixture(t);
  const http = createServer((request, response) => { response.writeHead(200); response.end('ready'); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const port = http.address().port, runtimeRoot = join(f.tmp, 'runtime'), key = previewKey(input.ref);
  const record = { key, ref: input.ref, root: input.root, state: 'running', project: 'specdev-' + key, port,
    dns: 'host.tailnet.ts.net', url: `https://host.tailnet.ts.net:${port}`, updated_at: 'revision-one' };
  const db = openStore(runtimeRoot); try { saveRecord(db, record); } finally { db.close(); }
  for (const condition of ['healthy', 'stopped-container', 'missing-route']) {
    const run = async (command, args) => {
      if (command === 'docker' && args[0] === 'ps') return 'container-id';
      if (command === 'docker' && args[0] === 'inspect') return JSON.stringify({ Running: condition !== 'stopped-container', Health: { Status: 'healthy' } });
      return JSON.stringify({ Web: condition === 'missing-route' ? {} : {
        [`${record.dns}:${port}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } },
      } });
    };
    const service = createPreviewService({ ...options, runtimeRoot, run });
    const observed = await service.status(input);
    assert.equal(observed.state, condition === 'healthy' ? 'running' : 'error', condition);
    assert.equal(observed.url, condition === 'healthy' ? record.url : null, condition);
    assert.equal(observed.can_stop, true, condition); assert.equal(observed.can_start, false, condition);
    assert.equal(readRecord(runtimeRoot, key).state, 'running', 'observation does not discard owned runtime receipt');
    assert.equal(readRecord(runtimeRoot, key).port, port);
  }
});

test('preview configuration removal hides cleaned failures but retains cleanup for allocated resources', async t => {
  const { f, input, options } = await recordedFixture(t);
  const runtimeRoot = join(f.tmp, 'runtime'), key = previewKey(input.ref);
  put(join(f.workspaceDir, 'kit.yaml'), f.kit('demo', 'execution_host: box\n'));
  const db = openStore(runtimeRoot);
  try {
    saveRecord(db, { key, state: 'error', port: null, error: 'Prior failed build' });
    const service = createPreviewService({ ...options, runtimeRoot });
    assert.deepEqual(await service.status(input), { configured: false });
    saveRecord(db, { key, state: 'error', port: 18000, error: 'Cleanup needed' });
    const active = await service.status(input);
    assert.equal(active.configured, true); assert.equal(active.can_stop, true); assert.equal(active.can_start, false);
  } finally { db.close(); }
});


test('preview command timeout stops nested processes before rejecting and clearing child ownership', async t => {
  const f = fixture(t), marker = join(f.context.root, 'nested-marker');
  const leaderPid = join(f.context.root, 'leader.pid'), nestedPid = join(f.context.root, 'nested.pid');
  const nested = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(nestedPid)}, String(process.pid)); process.on('SIGTERM', () => {}); let count = 0; const write = () => fs.writeFileSync(${JSON.stringify(marker)}, String(++count)); write(); setInterval(write, 25);`;
  const parent = `const {spawn} = require('node:child_process'); require('node:fs').writeFileSync(${JSON.stringify(leaderPid)}, String(process.pid)); process.on('SIGTERM', () => {}); spawn(process.execPath, ['-e', ${JSON.stringify(nested)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
  const identities = [];
  const operation = runCommand(process.execPath, ['-e', parent], { timeout: 600, onChild: identity => identities.push(identity) });
  let deadline;
  try {
    await Promise.race([
      assert.rejects(operation),
      new Promise((resolve, reject) => { deadline = setTimeout(() => reject(Error('timeout failed to settle within 3 seconds')), 3000); }),
    ]);
    clearTimeout(deadline);
    assert.ok(identities[0]?.pid, 'the supervisor owns the command group');
    assert.equal(identities.at(-1), null, 'ownership clears only after rejection');
    const after = readFileSync(marker, 'utf8');
    // A live descendant keeps changing this marker even when its PID appears as
    // a zombie or is recycled. The two commands intentionally ignore SIGTERM.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(readFileSync(marker, 'utf8'), after, 'nested application code cannot keep running after timeout rejection');
  } finally {
    clearTimeout(deadline);
    // Clean up even when a broken supervisor leaves the nested commands alive.
    for (const file of [leaderPid, nestedPid]) {
      try { process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL'); } catch {}
    }
    await operation.catch(() => {});
  }
});

test('preview command preserves Unicode configuration across stdout chunk boundaries', async () => {
  const source = `process.stdout.write('{"name":"'); process.stdout.write(Buffer.from([0xe2])); setTimeout(() => { process.stdout.write(Buffer.from([0x82, 0xac])); process.stdout.write('"}'); }, 100);`;
  const output = await runCommand(process.execPath, ['-e', source], { timeout: 2000 });
  assert.deepEqual(JSON.parse(output), { name: '€' });
});
