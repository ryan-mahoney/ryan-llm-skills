#!/usr/bin/env node
// Worktree dashboard preview. The page comes from the preview checkout while
// API authority remains at the canonical public Sentinel endpoint.
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'",
};
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

export function parsePreviewUrl(value) {
  if (typeof value !== 'string' || value === '') throw new Error('PREVIEW_URL must be an HTTPS URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('PREVIEW_URL must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || !url.hostname || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PREVIEW_URL must be an HTTPS origin with an allocated port and no path.');
  }
  return {
    origin: url.origin,
    host: url.host,
    port: url.port,
    canonicalOrigin: `https://${url.hostname}`,
    canonicalHost: url.hostname,
  };
}

function healthHost(host, previewPort) {
  const allowed = new Set(['localhost:3000', '127.0.0.1:3000']);
  if (previewPort && /^\d+$/.test(previewPort)) allowed.add(`127.0.0.1:${previewPort}`);
  return allowed.has(host);
}

export function createPreviewServer({
  previewUrl,
  upstreamBase,
  html,
  htmlPath = new URL('./dashboard.html', import.meta.url),
} = {}) {
  const preview = parsePreviewUrl(previewUrl);
  const upstream = new URL(upstreamBase ?? preview.canonicalOrigin);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('Upstream must be an HTTP origin.');
  }
  let pagePromise;
  const page = () => pagePromise ??= html === undefined ? readFile(htmlPath) : Promise.resolve(Buffer.from(html));

  const previewPort = preview.port;
  return createServer((request, response) => {
    let upstreamRequest;
    const abort = () => upstreamRequest?.destroy();
    const fail = () => {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { ...STATIC_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Sentinel is unavailable. Retry shortly.' }));
      } else if (!response.destroyed) response.destroy();
    };
    const servePage = async () => {
      let content;
      try { content = await page(); } catch { fail(); return; }
      if (response.destroyed) return;
      response.writeHead(200, { ...STATIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : content);
    };
    request.once('aborted', abort);
    response.once('close', () => { if (!response.writableEnded) abort(); });
    try {
      const host = request.headers.host?.toLowerCase();
      const origin = request.headers.origin;
      const url = new URL(request.url, 'http://preview.invalid');
      const health = request.method === 'GET' && url.pathname === '/' && !origin && healthHost(host, previewPort);
      if (health) { void servePage(); return; }
      if (host !== preview.host.toLowerCase()) {
        response.writeHead(403, STATIC_HEADERS); response.end('Preview host rejected'); return;
      }
      if (origin !== undefined && origin !== preview.origin) {
        response.writeHead(403, STATIC_HEADERS); response.end('Preview origin rejected'); return;
      }
      if (!['GET', 'HEAD'].includes(request.method) && origin !== preview.origin) {
        response.writeHead(403, STATIC_HEADERS); response.end('Preview origin required'); return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD')
        && (url.pathname === '/' || url.pathname === '/dashboard.html')) {
        void servePage();
        return;
      }
      if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/package-view/') || url.pathname.startsWith('/workspace-view/'))) {
        response.writeHead(404, STATIC_HEADERS); response.end('Not found'); return;
      }

      const connectionTokens = new Set((request.headers.connection ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean));
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (HOP_HEADERS.has(name.toLowerCase()) || connectionTokens.has(name.toLowerCase()) || value === undefined) continue;
        headers[name] = value;
      }
      headers.host = preview.canonicalHost;
      if (origin === preview.origin) headers.origin = preview.canonicalOrigin;
      const target = new URL(`${url.pathname}${url.search}`, upstream);
      upstreamRequest = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: request.method,
        headers,
      }, upstreamResponse => {
        const upstreamConnectionTokens = new Set((upstreamResponse.headers.connection ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean));
        const responseHeaders = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (HOP_HEADERS.has(name.toLowerCase()) || upstreamConnectionTokens.has(name.toLowerCase()) || value === undefined) continue;
          responseHeaders[name] = value;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.on('error', fail);
        upstreamResponse.pipe(response);
      });
      upstreamRequest.on('error', fail);
      request.pipe(upstreamRequest);
    } catch {
      fail();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const previewUrl = process.env.PREVIEW_URL;
    if (!previewUrl) throw new Error('PREVIEW_URL is required.');
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
    const server = createPreviewServer({ previewUrl });
    server.on('error', error => { console.error(`Dashboard preview: ${error.code ?? error.message}`); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log(`Dashboard preview listening on 0.0.0.0:${port}`));
    const stop = () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
