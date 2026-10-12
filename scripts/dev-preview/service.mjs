// Package preview capability. Docker owns application orchestration; this
// module resolves trusted package locations and dispatches detached operations.
import { fork, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseKit } from '../workspaces/kit.mjs';
import { checkPackage } from '../spec-location/index.mjs';
import { readRecord, publicRecord, defaultRuntimeRoot } from './store.mjs';
import { runCommand, routeAt, ownsRoute } from './engine.mjs';

const exec = promisify(execFile);
export const previewKey = ref => createHash('sha256').update(ref).digest('hex').slice(0, 24);
export function failure(message, status = 409) {
  return Object.assign(new Error(message), { publicMessage: message, status });
}

export async function resolvePreview({ root, ref }, { storageRoot, host = hostname() } = {}) {
  const workspace = dirname(dirname(root));
  const parsed = parseKit(await readFile(join(workspace, 'kit.yaml'), 'utf8'));
  if (!parsed.ok) throw failure('Workspace configuration is invalid.');
  const config = parsed.kit.preview;
  if (!config) return null;
  const locations = JSON.parse(await readFile(join(root, 'locations.json'), 'utf8'));
  const target = locations.targets?.find(item => item.id === config.repository);
  if (!target) return null;
  if (parsed.kit.execution_host?.split('.')[0].toLowerCase() !== host.split('.')[0].toLowerCase()) {
    throw failure('Start this dev server on the workspace execution host.');
  }
  if (!target.worktree) throw failure('Create the package worktree before starting its dev server.');
  const checked = await checkPackage(ref, { root: storageRoot, hostname: host });
  if (!checked.ok) throw failure('Package locations need repair before starting the dev server.');
  const worktree = await realpath(target.worktree);
  const primary = await realpath(target.primary);
  if (worktree === primary) throw failure('The dev server requires a separate package worktree.');
  const git = async (...args) => (await exec('git', ['-C', worktree, ...args], { timeout: 5000 })).stdout.trim();
  const common = await realpath(await git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (common !== await realpath(target.common) || await git('branch', '--show-current') !== target.branch) {
    throw failure('The package worktree no longer matches its recorded repository and branch.');
  }
  const composeFile = await realpath(resolve(worktree, config.compose_file)).catch(() => null);
  if (!composeFile || !composeFile.startsWith(worktree + sep) || !(await stat(composeFile)).isFile()) {
    throw failure('The configured Compose file is missing or outside the package worktree.');
  }
  return { key: previewKey(ref), ref, root, worktree, primary, composeFile };
}

export function createPreviewService({ storageRoot, runtimeRoot = defaultRuntimeRoot(), host, run = runCommand } = {}) {
  const options = { storageRoot, host };
  const observations = new Map();
  async function observe(record) {
    const cached = observations.get(record.key);
    if (cached?.version === record.updated_at && Date.now() - cached.at < 1500) return cached.value;
    let error = null;
    try {
      const ids = (await run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${record.project}`])).trim().split(/\s+/).filter(Boolean);
      if (!ids.length) throw Error('No containers');
      const states = (await run('docker', ['inspect', '--format', '{{json .State}}', ...ids])).trim().split('\n').map(JSON.parse);
      if (states.some(state => !state.Running || state.Health && state.Health.Status !== 'healthy')) throw Error('Containers not ready');
      const serve = JSON.parse(await run('tailscale', ['serve', 'status', '--json']));
      if (!ownsRoute(routeAt(serve, record.dns, record.port), record.port)) throw Error('Route missing');
      const response = await fetch(`http://127.0.0.1:${record.port}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (response.status < 200 || response.status >= 400) throw Error('HTTP ingress unavailable');
    } catch { error = 'The dev server or its Tailscale route is unavailable. Stop it, then start again.'; }
    observations.set(record.key, { at: Date.now(), version: record.updated_at, value: error });
    return error;
  }
  async function status(input) {
    const record = readRecord(runtimeRoot, previewKey(input.ref));
    // Retain cleanup access after configuration/worktree removal. No new start
    // is permitted until the current package configuration resolves again.
    let context, reason;
    try { context = await resolvePreview(input, options); }
    catch (error) { reason = error.publicMessage ?? 'Dev server configuration is unavailable.'; }
    if (!context && !reason && !record?.port) return { configured: false };
    const result = publicRecord(record, { reason, startable: Boolean(context) });
    if (result.state === 'running') {
      const error = await observe(record);
      if (error) return { ...result, state: 'error', url: null, error, can_start: false, can_stop: true };
    }
    return result;
  }
  async function dispatch(input, action) {
    let context;
    if (action === 'start') {
      context = await resolvePreview(input, options);
      if (!context) throw failure('This package has no configured dev server.');
    } else {
      const record = readRecord(runtimeRoot, previewKey(input.ref));
      if (!record || record.state === 'stopped') return status(input);
      // Stop uses the frozen, owned configuration even if the checkout vanished.
      context = { key: previewKey(input.ref), ref: input.ref, root: input.root };
    }
    return new Promise((resolveResult, reject) => {
      let settled = false;
      const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      });
      const timer = setTimeout(() => {
        settled = true; if (child.connected) child.disconnect(); child.unref();
        reject(failure('Dev server operation is still being accepted. Refresh its status.', 503));
      }, 15000);
      const finish = () => { settled = true; clearTimeout(timer); if (child.connected) child.disconnect(); child.unref(); };
      child.once('error', () => { finish(); reject(failure('Could not launch the dev server operation.', 503)); });
      child.once('message', message => {
        finish();
        if (message.error) reject(failure(message.error, 409));
        else resolveResult(message.value);
      });
      child.once('exit', () => { if (!settled) { finish(); reject(failure('Dev server operation failed to start.', 503)); } });
      child.send({ action, context, runtimeRoot });
    });
  }
  return { status, start: input => dispatch(input, 'start'), stop: input => dispatch(input, 'stop') };
}
