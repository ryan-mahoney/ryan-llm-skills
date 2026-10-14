import { execFile } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import { promisify } from 'node:util';
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
