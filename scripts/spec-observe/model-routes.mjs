import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../workspaces/store.mjs';
const execFileAsync = promisify(execFile);

export const CATALOG_HEADERS = Object.freeze(['provider', 'model', 'context', 'max-out', 'thinking', 'images']);
export const CATALOG_LIMITS = Object.freeze({ models: 5000, timeoutMs: 20000, maxBuffer: 4 * 1024 * 1024 });
const CATALOG_TOKEN_PATTERN = /^\d+(?:\.\d+)?[KM]?$/;

function validateSafe(value, maxLen, fieldName) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
    throw new Error(`Invalid ${fieldName}`);
  }
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) <= 32) {
      throw new Error(`Invalid ${fieldName}`);
    }
  }
  if (value.startsWith('-')) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return true;
}

function validateNumericToken(value) {
  if (!CATALOG_TOKEN_PATTERN.test(value)) {
    throw new Error('Invalid numeric token');
  }
}

function validateYesNo(value) {
  if (value !== 'yes' && value !== 'no') {
    throw new Error('Invalid yes/no value');
  }
  return value === 'yes';
}

export function parseModelCatalog(text) {
  const lines = text.split(/\r?\n/);
  const nonBlankLines = [];
  let headerFound = false;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (!headerFound) {
      headerFound = true;
      nonBlankLines.push(line);
    } else {
      nonBlankLines.push(line);
    }
  }

  if (!headerFound || nonBlankLines.length === 0) {
    throw new Error('Missing header');
  }

  const headerLine = nonBlankLines[0];
  const headerTokens = headerLine.trim().split(/\s+/);

  if (headerTokens.length !== CATALOG_HEADERS.length) {
    throw new Error('Invalid header');
  }

  for (let i = 0; i < CATALOG_HEADERS.length; i++) {
    if (headerTokens[i] !== CATALOG_HEADERS[i]) {
      throw new Error('Invalid header');
    }
  }

  const offsets = [];
  let offset = 0;
  for (let i = 0; i < CATALOG_HEADERS.length; i++) {
    const token = CATALOG_HEADERS[i];
    const tokenStart = headerLine.indexOf(token, offset);
    if (tokenStart === -1) {
      throw new Error('Invalid header');
    }
    offsets.push(tokenStart);
    offset = tokenStart + token.length;
  }

  const models = [];
  const seenPairs = new Set();

  for (let i = 1; i < nonBlankLines.length; i++) {
    const line = nonBlankLines[i];
    if (line.trim().length === 0) continue;

    if (models.length >= CATALOG_LIMITS.models) {
      throw new Error('Too many models');
    }

    const provider = line.slice(offsets[0], offsets[1]).trim();
    const model = line.slice(offsets[1], offsets[2]).trim();
    const context = line.slice(offsets[2], offsets[3]).trim();
    const max_out = line.slice(offsets[3], offsets[4]).trim();
    const thinking = line.slice(offsets[4], offsets[5]).trim();
    const images = line.slice(offsets[5]).trim();

    validateSafe(provider, 100, 'provider');
    validateSafe(model, 300, 'model');
    validateNumericToken(context);
    validateNumericToken(max_out);
    const thinkingBool = validateYesNo(thinking);
    const imagesBool = validateYesNo(images);

    const pairKey = provider + '\u0000' + model;
    if (seenPairs.has(pairKey)) {
      throw new Error('Duplicate model');
    }
    seenPairs.add(pairKey);

    models.push({ provider, model, context, max_out, thinking: thinkingBool, images: imagesBool });
  }

  return models;
}

export function createModelCatalog({ run, hostname, now, timeoutMs } = {}) {
  now = now ?? Date.now;
  hostname = hostname ?? osHostname();
  timeoutMs = timeoutMs ?? CATALOG_LIMITS.timeoutMs;
  const host = hostname.split('.')[0];

  let cached = null;
  let inFlight = null;

  async function read({ refresh = false } = {}) {
    if (!refresh && cached !== null && cached.state === 'ready') {
      return cached;
    }

    if (inFlight !== null) {
      return inFlight;
    }

    if (inFlight === null) {
      const pending = (async () => {
        try {
          let stdout;
          if (run === undefined) {
            stdout = (await execFileAsync('pi', ['--list-models'], {
              timeout: timeoutMs,
              maxBuffer: CATALOG_LIMITS.maxBuffer,
              encoding: 'utf8',
              killSignal: 'SIGKILL',
              shell: false
            })).stdout;
          } else {
            stdout = await run();
          }

          if (typeof stdout !== 'string') {
            throw new Error('Model catalog read failed');
          }

          const models = parseModelCatalog(stdout);
          const providers = [...new Set(models.map(m => m.provider))].length;
          cached = {
            state: 'ready',
            host,
            read_at: new Date(now()).toISOString(),
            models,
            providers
          };
          return cached;
        } catch (error) {
          cached = null;
          return {
            state: 'failed',
            host,
            failed_at: new Date(now()).toISOString(),
            reason: 'catalog-unavailable'
          };
        }
      })();
      inFlight = pending;
      pending.finally(() => { if (inFlight === pending) inFlight = null; });
    }

    return inFlight;
  }

  return { host, read };
}

export const PREFERRED_LIMITS = Object.freeze({ records: 200, bytes: 65536, provider: 100, model: 300, body: 8192 });

export function createPreferredModels({ agentDir, now } = {}) {
  now = now ?? Date.now;
  const file = join(agentDir, 'spec-sentinel', 'preferred-models.json');
  const dir = join(agentDir, 'spec-sentinel');

  const read = async () => {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > PREFERRED_LIMITS.bytes) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const value = JSON.parse(text);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      if (value.version !== 1) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      if (!Array.isArray(value.preferred)) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      if (value.preferred.length > PREFERRED_LIMITS.records) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      const seenKeys = new Set();
      for (const entry of value.preferred) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return { state: 'failed', reason: 'preferences-unavailable' };
        }
        try {
          validateSafe(entry.provider, PREFERRED_LIMITS.provider, 'provider');
          validateSafe(entry.model, PREFERRED_LIMITS.model, 'model');
        } catch {
          return { state: 'failed', reason: 'preferences-unavailable' };
        }
        const pairKey = entry.provider + '\u0000' + entry.model;
        if (seenKeys.has(pairKey)) {
          return { state: 'failed', reason: 'preferences-unavailable' };
        }
        seenKeys.add(pairKey);
      }
      if (value.preferred.length > 0 && value.updated_at === null) {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      if (value.updated_at !== null) {
        if (typeof value.updated_at !== 'string') {
          return { state: 'failed', reason: 'preferences-unavailable' };
        }
        if (new Date(value.updated_at).toISOString() !== value.updated_at) {
          return { state: 'failed', reason: 'preferences-unavailable' };
        }
      }
      return { state: 'ready', preferred: value.preferred, updated_at: value.updated_at };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { state: 'ready', preferred: [], updated_at: null };
      }
      return { state: 'failed', reason: 'preferences-unavailable' };
    } finally {
      await handle?.close();
    }
  };

  let queue = Promise.resolve();
  const mutate = async ({ provider, model, preferred }) => {
    try {
      validateSafe(provider, PREFERRED_LIMITS.provider, 'provider');
      validateSafe(model, PREFERRED_LIMITS.model, 'model');
    } catch {
      return { state: 'failed', reason: 'preferences-unavailable' };
    }
    const current = await read();
    if (current.state === 'failed') {
      return { state: 'failed', reason: 'preferences-unavailable' };
    }
    const pair = { provider, model };
    const existingIndex = current.preferred.findIndex((p) => {
      return p.provider === provider && p.model === model;
    });
    if (preferred === false) {
      if (existingIndex < 0) {
        return { state: 'ready', preferred: current.preferred, updated_at: current.updated_at };
      }
      const newPreferred = current.preferred.slice();
      newPreferred.splice(existingIndex, 1);
      const nowIso = new Date(now()).toISOString();
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const content = JSON.stringify({ version: 1, preferred: newPreferred, updated_at: nowIso });
        await writeFileAtomic(file, content);
      } catch {
        return { state: 'failed', reason: 'preferences-unavailable' };
      }
      return { state: 'ready', preferred: newPreferred, updated_at: nowIso };
    }
    if (existingIndex >= 0) {
      return { state: 'ready', preferred: current.preferred, updated_at: current.updated_at };
    }
    if (current.preferred.length >= PREFERRED_LIMITS.records) {
      return { state: 'failed', reason: 'preference-limit' };
    }
    const newPreferred = current.preferred.slice();
    newPreferred.push(pair);
    const nowIso = new Date(now()).toISOString();
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const content = JSON.stringify({ version: 1, preferred: newPreferred, updated_at: nowIso });
      await writeFileAtomic(file, content);
    } catch {
      return { state: 'failed', reason: 'preferences-unavailable' };
    }
    return { state: 'ready', preferred: newPreferred, updated_at: nowIso };
  };
  const setPreference = input => {
    const run = queue.then(() => mutate(input));
    queue = run.then(() => {}, () => {});
    return run;
  };

  return { read, setPreference };
}

async function boundedBodyReader(stream, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;

    function end() {
      if (finished) return;
      finished = true;
      stream.off('data', onData);
      stream.off('end', end);
      stream.off('error', end);
      resolve({ data: Buffer.concat(chunks) });
    }

    function onData(chunk) {
      if (finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        finished = true;
        stream.off('data', onData);
        stream.off('end', end);
        stream.off('error', end);
        stream.destroy();
        resolve({ error: 'oversize' });
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }

    stream.on('data', onData);
    stream.on('end', end);
    stream.on('error', end);
  });
}

async function jsonResponder(response, statusCode, body, isHead, headers) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  if (!isHead) {
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  } else {
    response.end();
  }
}

export function createModelRoutes({ agentDir, actionToken, catalog } = {}) {
  const preferences = createPreferredModels({ agentDir });
  catalog ??= createModelCatalog();

  return async (request, response, url, { remote, expectedOrigin } = {}) => {
    const path = url.pathname;
    if (path !== '/api/models/preferred' && path !== '/api/models/catalog') {
      return false;
    }

    const isGetHead = request.method === 'GET' || request.method === 'HEAD';
    if (path === '/api/models/catalog') {
      if (!isGetHead) {
        await jsonResponder(response, 405, { error: 'Method not allowed.' }, false, { Allow: 'GET, HEAD' });
        return true;
      }
      const result = await catalog.read({ refresh: url.searchParams.get('refresh') === '1' });
      if (result.state === 'failed') {
        await jsonResponder(response, 503, { error: 'Catalog data unavailable. Retry shortly.', reason: 'catalog-unavailable', host: result.host, failed_at: result.failed_at }, false);
        return true;
      }
      await jsonResponder(response, 200, { host: result.host, read_at: result.read_at, providers: result.providers, models: result.models }, request.method === 'HEAD');
      return true;
    }

    if (path === '/api/models/preferred') {
      if (request.method === 'POST') {
        if (remote === true) {
          await jsonResponder(response, 403, { error: 'Remote writes not allowed.' }, false);
          return true;
        }
        const originHeader = request.headers.origin?.toLowerCase();
        const requiredOrigin = (expectedOrigin ?? `http://${request.headers.host}`).toLowerCase();
        if (originHeader !== requiredOrigin) {
          await jsonResponder(response, 403, { error: 'Same-origin check failed.' }, false);
          return true;
        }
        if (typeof actionToken !== 'string') {
          await jsonResponder(response, 403, { error: 'Missing action token.' }, false);
          return true;
        }
        if (request.headers['x-sentinel-token'] !== actionToken) {
          await jsonResponder(response, 403, { error: 'Invalid token.' }, false);
          return true;
        }
        if (request.headers['content-type'] !== 'application/json') {
          await jsonResponder(response, 403, { error: 'Content-Type must be application/json.' }, false);
          return true;
        }
        const contentLength = request.headers['content-length'];
        if (contentLength !== undefined) {
          if (!/\d+$/.test(contentLength)) {
            await jsonResponder(response, 400, { error: 'Malformed content-length.' }, false);
            return true;
          }
          const len = Number(contentLength);
          if (len > PREFERRED_LIMITS.body) {
            await jsonResponder(response, 413, { error: 'Payload too large.' }, false);
            return true;
          }
        }
        const { data, error } = await boundedBodyReader(request, PREFERRED_LIMITS.body);
        if (error === 'oversize') {
          await jsonResponder(response, 413, { error: 'Payload too large.' }, false);
          return true;
        }
        let body;
        try {
          body = JSON.parse(data.toString('utf8'));
        } catch {
          await jsonResponder(response, 400, { error: 'Malformed JSON.' }, false);
          return true;
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          await jsonResponder(response, 400, { error: 'Body must be a plain object.' }, false);
          return true;
        }
        const keys = Object.keys(body);
        if (keys.length !== 3 || !keys.includes('provider') || !keys.includes('model') || !keys.includes('preferred')) {
          await jsonResponder(response, 400, { error: 'Unexpected keys.' }, false);
          return true;
        }
        if (typeof body.preferred !== 'boolean') {
          await jsonResponder(response, 400, { error: 'preferred must be boolean.' }, false);
          return true;
        }
        try {
          validateSafe(body.provider, PREFERRED_LIMITS.provider, 'provider');
          validateSafe(body.model, PREFERRED_LIMITS.model, 'model');
        } catch {
          await jsonResponder(response, 400, { error: 'Invalid identifiers.' }, false);
          return true;
        }
        const result = await preferences.setPreference({ provider: body.provider, model: body.model, preferred: body.preferred });
        if (result.state === 'failed' && result.reason === 'preference-limit') {
          await jsonResponder(response, 400, { error: 'Preference limit reached.' }, false);
          return true;
        }
        if (result.state === 'failed' && result.reason === 'preferences-unavailable') {
          await jsonResponder(response, 503, { error: 'Preferences data unavailable. Retry shortly.', reason: 'preferences-unavailable' }, false);
          return true;
        }
        await jsonResponder(response, 200, { preferred: result.preferred, updated_at: result.updated_at }, false);
        return true;
      }

      if (!isGetHead) {
        await jsonResponder(response, 405, { error: 'Method not allowed.' }, false, { Allow: 'GET, HEAD, POST' });
        return true;
      }
      const result = await preferences.read();
      if (result.state === 'failed') {
        await jsonResponder(response, 503, { error: 'Preferences data unavailable. Retry shortly.', reason: 'preferences-unavailable' }, request.method === 'HEAD');
        return true;
      }
      await jsonResponder(response, 200, { preferred: result.preferred, updated_at: result.updated_at }, request.method === 'HEAD');
      return true;
    }

    return false;
  };
}
