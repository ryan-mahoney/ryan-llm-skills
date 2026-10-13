import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPreviewServer, parsePreviewUrl } from './preview-server.mjs';

const PREVIEW_URL = 'https://restory-box.tail57a257.ts.net:18042';
const PREVIEW_ORIGIN = 'https://restory-box.tail57a257.ts.net:18042';
const PREVIEW_HOST = 'restory-box.tail57a257.ts.net:18042';

async function start(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

test('preview URL must be the allocated public HTTPS origin', () => {
  assert.deepEqual(parsePreviewUrl(PREVIEW_URL), {
    origin: PREVIEW_ORIGIN,
    host: PREVIEW_HOST,
    port: '18042',
    canonicalOrigin: 'https://restory-box.tail57a257.ts.net',
    canonicalHost: 'restory-box.tail57a257.ts.net',
  });
  for (const value of ['http://restory-box.test:18042', 'https://restory-box.test',
    'https://restory-box.test:18042/path', 'https://user@restory-box.test:18042']) {
    assert.throws(() => parsePreviewUrl(value), /PREVIEW_URL/);
  }
});

test('preview gates host and origin while allowing only root health probes', async t => {
  const app = createPreviewServer({ previewUrl: PREVIEW_URL, upstreamBase: 'http://127.0.0.1:9', html: '<h1>worktree</h1>' });
  const base = await start(app, t);
  const hostMismatch = await request(base, '/api/state', { headers: { host: 'restory-box.tail57a257.ts.net:18043' } });
  assert.equal(hostMismatch.status, 403);
  const originMismatch = await request(base, '/api/state', {
    headers: { host: PREVIEW_HOST, origin: 'https://attacker.example' },
  });
  assert.equal(originMismatch.status, 403);
  const mutationWithoutOrigin = await request(base, '/api/action', {
    method: 'POST', headers: { host: PREVIEW_HOST, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(mutationWithoutOrigin.status, 403);
  const putWithoutOrigin = await request(base, '/api/action', {
    method: 'PUT', headers: { host: PREVIEW_HOST }, body: 'x',
  });
  assert.equal(putWithoutOrigin.status, 403);
  const innerHealth = await request(base, '/', { headers: { host: '127.0.0.1:3000' } });
  assert.equal(innerHealth.status, 200);
  assert.equal(innerHealth.body, '<h1>worktree</h1>');
  const outerHealth = await request(base, '/', { headers: { host: '127.0.0.1:18042' } });
  assert.equal(outerHealth.status, 200);
  const arbitrary = await request(base, '/debug', { headers: { host: PREVIEW_HOST } });
  assert.equal(arbitrary.status, 404);
});

test('missing dashboard HTML returns an error instead of a successful readiness response', async t => {
  const missingDirectory = mkdtempSync(join(tmpdir(), `sentinel-preview-${randomUUID()}-`));
  t.after(() => rmSync(missingDirectory, { recursive: true, force: true }));
  const app = createPreviewServer({
    previewUrl: PREVIEW_URL,
    upstreamBase: 'http://127.0.0.1:9',
    htmlPath: join(missingDirectory, 'missing.html'),
  });
  const base = await start(app, t);
  const result = await request(base, '/', { headers: { host: PREVIEW_HOST } });
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.body), { error: 'Sentinel is unavailable. Retry shortly.' });
});

test('mutation proxy rewrites to canonical public origin and preserves action token', async t => {
  let observed;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      url: request.url,
      host: request.headers.host,
      origin: request.headers.origin,
      token: request.headers['x-sentinel-token'],
      body: Buffer.concat(chunks).toString(),
    };
    if (request.url.startsWith('/workspace-view/')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'" });
      response.end(request.method === 'HEAD' ? undefined : '<h1>workspace view</h1>');
      return;
    }
    if (request.url.startsWith('/package-view/')) {
      response.writeHead(200, { 'Content-Type': /\.css$/.test(request.url) ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : '/* view */');
      return;
    }
    response.writeHead(202, { 'Content-Type': 'application/json', 'Content-Security-Policy': 'default-src none' });
    response.end('{"accepted":true}');
  });
  const upstreamBase = await start(upstream, t);
  const app = createPreviewServer({ previewUrl: PREVIEW_URL, upstreamBase, html: '<h1>worktree</h1>' });
  const base = await start(app, t);
  const result = await request(base, '/api/package-preview?x=1', {
    method: 'POST',
    headers: {
      host: PREVIEW_HOST,
      origin: PREVIEW_ORIGIN,
      'content-type': 'application/json',
      'x-sentinel-token': 'live-token',
    },
    body: '{"action":"start"}',
  });
  assert.equal(result.status, 202);
  assert.equal(result.headers['content-security-policy'], 'default-src none');
  assert.deepEqual(JSON.parse(result.body), { accepted: true });
  assert.deepEqual(observed, {
    method: 'POST',
    url: '/api/package-preview?x=1',
    host: 'restory-box.tail57a257.ts.net',
    origin: 'https://restory-box.tail57a257.ts.net',
    token: 'live-token',
    body: '{"action":"start"}',
  });
  const view = `/workspace-view/${Buffer.from('studio').toString('base64url')}/marker.html`;
  const forwarded = await request(base, view, { headers: { host: PREVIEW_HOST, origin: PREVIEW_ORIGIN } });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(forwarded.headers['content-security-policy'], "sandbox allow-scripts; default-src 'none'");
  assert.equal(forwarded.body, '<h1>workspace view</h1>');
  assert.equal(observed.url, view);
  assert.equal(observed.host, 'restory-box.tail57a257.ts.net');
  const forwardedHead = await request(base, view, { method: 'HEAD', headers: { host: PREVIEW_HOST, origin: PREVIEW_ORIGIN } });
  assert.equal(forwardedHead.status, 200);
  assert.equal(forwardedHead.body, '');
  assert.equal(observed.method, 'HEAD');
  const forwardedScript = await request(base, '/package-view/abc/marker.js', { headers: { host: PREVIEW_HOST, origin: PREVIEW_ORIGIN } });
  assert.match(forwardedScript.headers['content-type'], /javascript/);
  const forwardedStyle = await request(base, '/package-view/abc/marker.css', { headers: { host: PREVIEW_HOST, origin: PREVIEW_ORIGIN } });
  assert.match(forwardedStyle.headers['content-type'], /text\/css/);
});

test('SSE proxy streams promptly and cancels upstream when the client disconnects', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstream = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write('data: first\n\n');
    response.on('close', upstreamClosed);
  });
  const upstreamBase = await start(upstream, t);
  const app = createPreviewServer({ previewUrl: PREVIEW_URL, upstreamBase, html: '<h1>worktree</h1>' });
  const base = await start(app, t);
  const target = new URL('/api/threads/events', base);
  const req = httpRequest(target, { headers: { host: PREVIEW_HOST } });
  const first = new Promise((resolve, reject) => {
    req.on('response', response => {
      assert.equal(response.headers['content-type'], 'text/event-stream');
      response.once('data', chunk => resolve({ response, text: chunk.toString() }));
      response.on('error', reject);
    });
    req.on('error', reject);
  });
  req.end();
  const received = await first;
  assert.match(received.text, /data: first/);
  req.destroy();
  await closed;
});
