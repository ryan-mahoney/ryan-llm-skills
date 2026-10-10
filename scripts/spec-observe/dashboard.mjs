#!/usr/bin/env node
// Local sentinel presentation with one explicit package-completion write action.
// Never imports transcripts or invokes models/workers.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorizePackage, listPackageFiles, readPackageFile } from './package-files.mjs';
import { fetchWorkspace, listWorkspaces, resolveStorageRoot, storageStatus } from '../workspaces/store.mjs';
import { applyManualCompletions, writeManualCompletion } from './manual-completion.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 12 * 1024 * 1024, MAX_FILES = 200;
async function entries(path, accept, limit) {
  const found = [];
  if (!(await lstat(path)).isDirectory()) throw new Error('Expected a regular directory');
  const handle = await opendir(path);
  let scanned = 0;
  for await (const entry of handle) {
    if (++scanned > limit) return { found, truncated: true };
    if (accept(entry)) found.push(entry.name);
  }
  return { found, truncated: false };
}

export async function readDashboardState(agentDir) {
  const result = { schema_version: 1, generated_at: new Date().toISOString(), observers: [], errors: [], truncated: false };
  const root = join(agentDir, 'spec-sentinel');
  const error = (source, failure) => {
    if (result.errors.length < 20) result.errors.push({ source, message: failure.code ?? failure.message ?? 'Read failed' });
  };
  let directories;
  try { directories = await entries(root, entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name), 200); }
  catch (failure) { if (failure.code !== 'ENOENT') error(root, failure); return result; }
  result.truncated ||= directories.truncated;
  const files = [];
  for (const name of directories.found) {
    const directory = join(root, name, 'observers');
    try {
      const listed = await entries(directory, entry => entry.isFile() && /^[a-f0-9-]+\.json$/.test(entry.name), MAX_FILES);
      result.truncated ||= listed.truncated;
      for (const file of listed.found) {
        const source = join(directory, file);
        try { files.push({ source, modified: (await lstat(source)).mtimeMs }); }
        catch (failure) { error(source, failure); }
      }
    } catch (failure) { if (failure.code !== 'ENOENT') error(directory, failure); }
    if (files.length >= MAX_FILES) { result.truncated = true; break; }
  }
  files.sort((a, b) => b.modified - a.modified);
  result.truncated ||= files.length > MAX_FILES;
  let bytes = 0;
  for (const { source } of files.slice(0, MAX_FILES)) {
    let handle;
    try {
      handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE) throw new Error('Snapshot is not a bounded regular file');
      if (bytes + info.size > MAX_TOTAL) { result.truncated = true; break; }
      const buffer = Buffer.alloc(Math.min(MAX_FILE, MAX_TOTAL - bytes) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE || bytes + bytesRead > MAX_TOTAL) { result.truncated = true; break; }
      bytes += bytesRead;
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (value.schema_version !== 1 || typeof value.observer_id !== 'string'
        || !['observing', 'off', 'closed'].includes(value.state)
        || !Number.isFinite(Date.parse(value.published_at))
        || (value.snapshot != null && !Array.isArray(value.snapshot.runs))) throw new Error('Unsupported snapshot format');
      result.observers.push({ ...value, source });
    } catch (failure) { error(source, failure); }
    finally { await handle?.close(); }
  }
  return applyManualCompletions(result);
}

export function normalizePublicHost(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error('Public host must be a DNS name');
  let host = value.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) throw new Error('Public host must not be empty');
  if (host.includes('/')) throw new Error('Public host must not include a path');
  if (host.includes(':')) throw new Error('Public host must not include a scheme or port');
  const labels = host.split('.');
  if (labels.some(label => label.length === 0)) throw new Error('Public host must not contain empty labels');
  if (labels.some(label => label.length > 63)) throw new Error('Public host labels must not exceed 63 characters');
  if (labels.some(label => label.startsWith('-') || label.endsWith('-'))) throw new Error('Public host labels must not begin or end with a hyphen');
  if (!labels.every(label => /^[a-z0-9-]+$/.test(label))) throw new Error('Public host must be a DNS name');
  if (host.length > 253) throw new Error('Public host must not exceed 253 characters');
  return host;
}

// Locality classification only: acceptance is applied by the server before this
// runs, and this predicate grants no authorization. Presence means an own header
// key, including empty values.
export function isRemoteRequest(request) {
  const { localPort } = request.socket ?? {};
  const headers = request.headers ?? {};
  if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(headers.host)) return true;
  if (Object.hasOwn(headers, 'origin')
    && ![`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`].includes(headers.origin)) return true;
  return ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'tailscale-user-login']
    .some(name => Object.hasOwn(headers, name));
}

// Components that workspace read routes never list or serve. Any `.env.`
// variant (for example `.env.local`) is excluded by prefix.
const WORKSPACE_EXCLUDED = new Set(['.adjacent', 'sessions', '.git', '.env', 'node_modules', '_build', 'deps']);
function workspaceExclude(component) {
  return WORKSPACE_EXCLUDED.has(component) || component.startsWith('.env.');
}

export function createDashboardServer({ agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'), publicHost, storageRoot } = {}) {
  let cached, read;
  const actionToken = randomBytes(32).toString('hex');
  const publicName = normalizePublicHost(publicHost);
  const workspaceRoot = storageRoot ?? resolveStorageRoot(process.env, homedir());
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'");
    const host = request.headers.host;
    const { localPort } = request.socket;
    const lowerHost = typeof host === 'string' ? host.toLowerCase() : host;
    const acceptedHost = [`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(host)
      || (publicName != null && (lowerHost === publicName || lowerHost === `${publicName}:443`));
    if (!acceptedHost) {
      response.writeHead(403); response.end('Local access only'); return;
    }
    const origin = request.headers.origin;
    const acceptedOrigin = [`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`].includes(origin)
      || (publicName != null && typeof origin === 'string' && origin.toLowerCase() === `https://${publicName}`);
    if (origin && !acceptedOrigin) {
      response.writeHead(403); response.end('Same-origin access only'); return;
    }
    const remote = isRemoteRequest(request);
    const url = new URL(request.url, `http://${host}`), path = url.pathname;
    const completionRequest = path === '/api/package-completion' && request.method === 'POST';
    if (!['GET', 'HEAD'].includes(request.method) && !completionRequest) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    try {
      if (completionRequest) {
        if (remote || request.headers.origin !== `http://${host}` || request.headers['x-sentinel-token'] !== actionToken
          || request.headers['content-type'] !== 'application/json') {
          response.writeHead(403); response.end('Completion requires the local dashboard'); return;
        }
        let bytes = 0; const chunks = [];
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 8192) { response.writeHead(413); response.end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400); response.end(); return; }
        const state = await readDashboardState(agentDir);
        const root = await authorizePackage(state, input?.package);
        const record = await writeManualCompletion(root);
        cached = null;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ completed_at: record.completed_at }));
      } else if (path === '/api/state') {
        if (!cached || Date.now() - cached.at > 1000) {
          read ??= readDashboardState(agentDir).then(value => { cached = { at: Date.now(), value }; }).finally(() => { read = null; });
          await read;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(remote
          ? { ...cached.value, completion: 'local-only' }
          : { ...cached.value, action_token: actionToken }));
      } else if (path === '/api/package-files' || path === '/api/package-file' || path.startsWith('/package-view/')) {
        const state = await readDashboardState(agentDir);
        const view = path.startsWith('/package-view/') ? path.slice('/package-view/'.length).split('/') : null;
        const requestedPackage = view ? Buffer.from(view.shift(), 'base64url').toString('utf8') : url.searchParams.get('package');
        const requestedFile = view ? view.map(decodeURIComponent).join('/') : url.searchParams.get('file');
        const root = await authorizePackage(state, requestedPackage);
        if (path === '/api/package-files') {
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(request.method === 'HEAD' ? undefined : JSON.stringify(await listPackageFiles(root, url.searchParams.has('cursor')?Number(url.searchParams.get('cursor')):0)));
        } else {
          const file = await readPackageFile(root, requestedFile);
          response.setHeader('Content-Type', view && /\.(?:js|mjs)$/i.test(requestedFile) ? 'text/javascript; charset=utf-8' : view && /\.css$/i.test(requestedFile) ? 'text/css; charset=utf-8' : file.type);
          response.setHeader('X-Package-File-Kind', file.kind);
          response.setHeader('X-Frame-Options', 'SAMEORIGIN');
          response.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
          if (file.kind === 'download' || url.searchParams.has('download')) response.setHeader('Content-Disposition', 'attachment; filename="package-file"');
          response.end(request.method === 'HEAD' ? undefined : file.bytes);
        }
      } else if (path === '/api/workspaces') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ storage: await storageStatus(workspaceRoot), ...(await listWorkspaces(workspaceRoot)) }));
      } else if (path === '/api/workspace') {
        const id = url.searchParams.get('id');
        if (typeof id !== 'string' || id === '') throw new Error('Workspace id is required');
        const catalog = await listWorkspaces(workspaceRoot);
        if (catalog.valid.filter(entry => entry.kit && entry.kit.id === id).length !== 1) throw new Error('Workspace is unavailable');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(await fetchWorkspace(workspaceRoot, id)));
      } else if (path === '/api/workspace-files') {
        const id = url.searchParams.get('id');
        if (typeof id !== 'string' || id === '') throw new Error('Workspace id is required');
        const match = (await listWorkspaces(workspaceRoot)).valid.filter(entry => entry.kit && entry.kit.id === id);
        if (match.length !== 1) throw new Error('Workspace is unavailable');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(await listPackageFiles(match[0].directory, url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : 0, { exclude: workspaceExclude })));
      } else if (path === '/api/workspace-file') {
        const id = url.searchParams.get('id');
        if (typeof id !== 'string' || id === '') throw new Error('Workspace id is required');
        const match = (await listWorkspaces(workspaceRoot)).valid.filter(entry => entry.kit && entry.kit.id === id);
        if (match.length !== 1) throw new Error('Workspace is unavailable');
        const file = await readPackageFile(match[0].directory, url.searchParams.get('file'), { exclude: workspaceExclude });
        response.setHeader('Content-Type', file.type);
        response.setHeader('X-Package-File-Kind', file.kind);
        response.setHeader('X-Frame-Options', 'SAMEORIGIN');
        response.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
        if (file.kind === 'download' || url.searchParams.has('download')) response.setHeader('Content-Disposition', 'attachment; filename="package-file"');
        response.end(request.method === 'HEAD' ? undefined : file.bytes);
      } else if (path === '/' || path === '/dashboard.html') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(request.method === 'HEAD' ? undefined : await readFile(join(here, 'dashboard.html')));
      } else { response.writeHead(404); response.end('Not found'); }
    } catch { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Dashboard data unavailable. Retry shortly.' })); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let port = 4319, agentDir, publicHost;
  const args = process.argv.slice(2);
  try {
    while (args.length) {
      const option = args.shift(), value = args.shift();
      if (option === '--port' && value != null && /^\d+$/.test(value)) port = Number(value);
      else if (option === '--agent-dir' && value) agentDir = resolve(value);
      else if (option === '--public-host' && value != null) publicHost = normalizePublicHost(value);
      else throw new Error('Usage: node dashboard.mjs [--port 4319] [--agent-dir PATH] [--public-host NAME]');
    }
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535');
    const server = createDashboardServer({ agentDir, publicHost });
    server.on('error', error => {
      if (process.send) process.send({ type: 'error', error: error.code ?? error.message });
      else console.error(`Sentinel dashboard: ${error.code ?? error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      if (process.send) process.send({ type: 'ready', url });
      else console.log(`Sentinel dashboard: ${url}\nReads existing snapshots; start /spec-sentinel in Pi for live data.`);
    });
    const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    process.on('disconnect', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
