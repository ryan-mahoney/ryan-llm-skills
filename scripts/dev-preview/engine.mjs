// One detached operation owns a package claim. Docker survives dashboard
// disconnects; the operation receipt survives worker/host interruption.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimOwner } from '../spec-observe/owner-claim.mjs';
import { inspectProcess, processIdentity } from '../spec-observe/process-identity.mjs';
import { openStore, readRecord, saveRecord, publicRecord } from './store.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const runCommand = (command, args, options = {}) => {
  const { onChild, timeout = 30000, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./command.mjs', import.meta.url)), String(timeout), command, ...args],
      { ...execOptions, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failed;
    const collect = kind => chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { failed = Error('Command output exceeded its limit'); child.kill('SIGTERM'); return; }
      if (kind === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => { failed = error; });
    child.once('spawn', () => {
      if (onChild) {
        const identity = processIdentity(child.pid);
        if (!identity) { failed = Error('Command ownership could not be recorded'); child.kill('SIGTERM'); }
        else { try { onChild(identity); } catch (error) { failed = error; child.kill('SIGTERM'); } }
      }
    });
    child.once('close', (code, signal) => {
      try { if (onChild) onChild(null); } catch (error) { failed ??= error; }
      if (failed || code !== 0) reject(Object.assign(failed ?? Error(`Command ended with ${signal ?? code}`), { stdout, stderr }));
      else resolve(stdout);
    });
  });
};
const parse = text => JSON.parse(text || '{}');
export function routeAt(config, dns, port) { return config.Web?.[`${dns}:${port}`]; }
export function ownsRoute(route, port) {
  return route && Object.keys(route.Handlers ?? {}).length === 1
    && route.Handlers['/']?.Proxy === `http://127.0.0.1:${port}`;
}
async function portAvailable(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
// A single public HTTP ingress keeps framework-specific routing in Compose.
export function validateCompose(config, port) {
  let exposed = 0;
  if (!config.services || !Object.keys(config.services).length) throw Error('Compose has no services');
  for (const service of Object.values(config.services)) {
    if (service.network_mode === 'host' || service.container_name) throw Error('Fixed container names and host networking are not supported');
    for (const mapping of service.ports ?? []) {
      if (mapping.host_ip !== '127.0.0.1' || String(mapping.published) !== String(port)
        || (mapping.protocol ?? 'tcp') !== 'tcp') throw Error('Compose must publish only PREVIEW_PORT on 127.0.0.1');
      exposed++;
    }
  }
  if (exposed !== 1) throw Error('Compose must publish exactly one HTTP ingress');
}

export async function executeOperation({ action, context, runtimeRoot }, {
  run = runCommand, available = portAvailable, ready = async url => {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 400) throw Error('HTTP ingress did not become ready');
  }, accepted = () => {}, portRange = [18000, 18999],
} = {}) {
  const db = openStore(runtimeRoot);
  const canonical = await realpath(runtimeRoot);
  let claim;
  try { claim = claimOwner({ database: join(canonical, 'owners.sqlite'), key: context.key }); }
  catch { db.close(); throw Error('A dev server operation is already in progress. Refresh its status.'); }
  let record;
  const directory = join(canonical, context.key);
  const log = async error => {
    // Private diagnostics only; never return command output (which may contain
    // application credentials) through the dashboard API.
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? error}`.slice(-32768);
    await appendFile(join(directory, 'operation.log'), `${new Date().toISOString()} ${output}\n`, { mode: 0o600 });
  };
  const save = () => { record.updated_at = new Date().toISOString(); saveRecord(db, record); };
  const compose = (args, options) => run('docker', ['compose', '-p', record.project, '-f', record.frozen, ...args], {
    ...options, onChild: child => { record.child = child; save(); },
  });
  async function stopInterruptedCommand() {
    if (!record.child) return;
    const identity = record.child;
    const observe = () => {
      const current = inspectProcess(identity.pid);
      if (current.state === 'unknown') throw Error('Interrupted Compose command ownership is unknown');
      return current.state === 'alive' && current.started_at === identity.started_at;
    };
    if (observe()) {
      process.kill(-identity.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 30 && observe(); attempt++) await sleep(100);
      if (observe()) { process.kill(-identity.pid, 'SIGKILL'); await sleep(100); }
      if (observe()) throw Error('Interrupted Compose command is still running');
    }
    record.child = null; save();
  }
  async function unpublish() {
    if (!record.dns || !record.port) return;
    const status = parse(await run('tailscale', ['serve', 'status', '--json']));
    const route = routeAt(status, record.dns, record.port);
    if (!route && !status.TCP?.[record.port]) return;
    if (!ownsRoute(route, record.port)) throw Error('Tailscale route changed; refusing to remove an unowned route');
    await run('tailscale', ['serve', '--https=' + record.port, 'off']);
    const after = parse(await run('tailscale', ['serve', 'status', '--json']));
    if (routeAt(after, record.dns, record.port) || after.TCP?.[record.port]) throw Error('Tailscale route remains active');
  }
  async function cleanup() {
    await stopInterruptedCommand();
    const errors = [];
    try { await unpublish(); } catch (error) { errors.push(error); }
    if (record.frozen) {
      try {
        await compose(['down', '--remove-orphans', '--timeout', '15'], { timeout: 60000 });
        const ids = await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${record.project}`]);
        if (ids.trim()) throw Error('Preview containers remain after shutdown');
      } catch (error) { errors.push(error); }
    }
    if (errors.length) { for (const error of errors) await log(error); throw Error('Cleanup incomplete'); }
    record.port = null; record.url = null; record.state = 'stopped'; record.owner = null; save();
  }
  try {
    record = readRecord(runtimeRoot, context.key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!['start', 'stop'].includes(action)) throw Error('Unsupported preview action');
    if (action === 'stop') {
      if (!record || record.state === 'stopped') { accepted(publicRecord(record)); return; }
      record.state = 'stopping'; record.error = null;
      record.owner = { pid: claim.pid, started_at: claim.started_at }; save();
      accepted(publicRecord(record));
      try { await cleanup(); }
      catch { record.state = 'error'; record.error = 'Could not finish stopping the dev server. Retry Stop; private host logs contain details.'; record.owner = null; save(); }
      return;
    }
    if (record?.port) { accepted(publicRecord(record)); return; }
    record = { key: context.key, ref: context.ref, root: context.root, project: `specdev-${context.key}`,
      state: 'starting', port: null, url: null, error: null, frozen: null,
      owner: { pid: claim.pid, started_at: claim.started_at } };
    save(); accepted(publicRecord(record));
    try {
      const self = parse(await run('tailscale', ['status', '--json']));
      const dns = self.Self?.DNSName?.replace(/\.$/, '');
      if (self.BackendState !== 'Running' || !dns || !/^[a-z0-9.-]+\.ts\.net$/i.test(dns)) throw Error('Tailscale is not connected with a DNS name');
      const existing = await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${record.project}`]);
      if (existing.trim()) throw Error('Containers exist without an active owned receipt; inspect them before starting');
      const serve = parse(await run('tailscale', ['serve', 'status', '--json']));
      let allocator;
      for (let attempt = 0; attempt < 40 && !allocator; attempt++) {
        try { allocator = claimOwner({ database: join(canonical, 'owners.sqlite'), key: 'ports' }); }
        catch { await sleep(50); }
      }
      if (!allocator) throw Error('Port allocation is busy');
      try {
        const leased = new Set(db.prepare('SELECT port FROM previews WHERE port IS NOT NULL').all().map(row => row.port));
        for (let port = portRange[0]; port <= portRange[1]; port++) {
          if (leased.has(port) || serve.TCP?.[port] || Object.keys(serve.Web ?? {}).some(key => key.endsWith(`:${port}`)) || !await available(port)) continue;
          record.port = port; record.dns = dns; record.url = `https://${dns}:${port}`; save(); break;
        }
        if (!record.port) throw Error('No preview port is available');
      } finally { allocator.release(); }
      const env = { ...process.env, PREVIEW_PORT: String(record.port), PREVIEW_URL: record.url,
        PRIMARY_CHECKOUT: context.primary, PREVIEW_WORKTREE: context.worktree };
      // Freeze resolved paths/config for reliable shutdown after source edits or
      // worktree deletion. This private file can contain env_file secrets.
      const resolved = parse(await run('docker', ['compose', '-p', record.project, '--project-directory', context.worktree,
        '-f', context.composeFile, 'config', '--format', 'json'], { env, cwd: context.worktree }));
      validateCompose(resolved, record.port);
      const frozen = join(directory, 'compose.json');
      await writeFile(frozen, JSON.stringify(resolved), { mode: 0o600 });
      record.frozen = frozen; save();
      // $$ preserves literal dollars in resolved config on its second Compose
      // parse, including credentials and container shell expressions.
      await writeFile(frozen, JSON.stringify(resolved).replaceAll('$', '$$$$'), { mode: 0o600 });
      await compose(['up', '--build', '--detach', '--wait', '--wait-timeout', '300'], {
        env, timeout: 15 * 60 * 1000, cwd: context.worktree,
      });
      await ready(`http://127.0.0.1:${record.port}/`);
      const before = parse(await run('tailscale', ['serve', 'status', '--json']));
      if (before.TCP?.[record.port] || Object.keys(before.Web ?? {}).some(key => key.endsWith(`:${record.port}`))) throw Error('Tailscale port became occupied');
      await run('tailscale', ['serve', '--bg', `--https=${record.port}`, `http://127.0.0.1:${record.port}`]);
      const after = parse(await run('tailscale', ['serve', 'status', '--json']));
      if (!ownsRoute(routeAt(after, record.dns, record.port), record.port)) throw Error('Tailscale did not publish the expected route');
      record.state = 'running'; record.owner = null; save();
    } catch (error) {
      await log(error);
      try { await cleanup(); }
      catch { /* Keep the port lease until an explicit stop finishes cleanup. */ }
      record.state = 'error'; record.owner = null;
      record.error = record.port ? 'Dev server startup failed and cleanup is incomplete. Select Stop dev server to retry cleanup.'
        : 'Dev server startup failed. Check the private host operation log, fix the Docker configuration, then retry.';
      save();
    }
  } finally { claim.release(); db.close(); }
}
