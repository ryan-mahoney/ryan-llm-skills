import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelCatalog, createModelCatalog, CATALOG_HEADERS, CATALOG_LIMITS } from './model-routes.mjs';

function buildTable(rows) {
  const header = CATALOG_HEADERS;
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0)));
  const headerLine = header.map((h, i) => h.padEnd(widths[i])).join('  ');
  const lines = [headerLine];
  for (const row of rows) {
    lines.push(row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  '));
  }
  return lines.join('\n');
}

test('parseModelCatalog parses fixed-width table correctly', t => {
  const rows = [
    ['deepinfra', 'ByteDance/Seed-2.0-code', '256K', '128K', 'yes', 'no'],
    ['deepinfra', 'gpt-oss-120b', '128K', '32K', 'no', 'yes'],
    ['groq', 'gpt-oss-120b', '128K', '32K', 'no', 'yes'],
    ['gmicloud', 'moonshotai/kimi-k3', '1M', '128K', 'yes', 'yes']
  ];
  const text = buildTable(rows);
  const models = parseModelCatalog(text);
  assert.equal(models.length, 4);
  assert.equal(models[0].provider, 'deepinfra');
  assert.equal(models[0].model, 'ByteDance/Seed-2.0-code');
  assert.equal(models[0].context, '256K');
  assert.equal(models[0].max_out, '128K');
  assert.equal(models[0].thinking, true);
  assert.equal(models[0].images, false);
  assert.equal(models[1].model, 'gpt-oss-120b');
  assert.equal(models[2].provider, 'groq');
  assert.equal(models[2].model, 'gpt-oss-120b');
  assert.equal(models[3].provider, 'gmicloud');
  assert.equal(models[3].model, 'moonshotai/kimi-k3');
});

test('parseModelCatalog rejects wrong header', () => {
  const text = 'provider  model  other  max-out  thinking  images\na  b  c  d  e  f';
  assert.throws(() => parseModelCatalog(text), { message: 'Invalid header' });
});

test('parseModelCatalog rejects nonblank line before header', () => {
  const text = 'garbage\nprovider  model  context  max-out  thinking  images\na  b  c  d  yes  no';
  assert.throws(() => parseModelCatalog(text), { message: 'Invalid header' });
});

test('parseModelCatalog rejects invalid capability value', () => {
  const text = buildTable([['a', 'b', '100', '50', 'maybe', 'no']]);
  assert.throws(() => parseModelCatalog(text), { message: 'Invalid yes/no value' });
});

test('parseModelCatalog rejects invalid context token', () => {
  const text = buildTable([['a', 'b', 'abc', '50', 'yes', 'no']]);
  assert.throws(() => parseModelCatalog(text), { message: 'Invalid numeric token' });
});

test('parseModelCatalog rejects duplicate exact pair', () => {
  const text = buildTable([
    ['a', 'b', '100', '50', 'yes', 'no'],
    ['a', 'b', '200', '75', 'no', 'yes']
  ]);
  assert.throws(() => parseModelCatalog(text), { message: 'Duplicate model' });
});

test('parseModelCatalog rejects 5001 rows', () => {
  const rows = Array.from({ length: 5001 }, (_, i) => [`p${i}`, `m${i}`, '100', '50', 'yes', 'no']);
  const text = buildTable(rows);
  assert.throws(() => parseModelCatalog(text), { message: 'Too many models' });
});

test('parseModelCatalog returns empty array for header-only table', () => {
  const text = buildTable([]);
  const models = parseModelCatalog(text);
  assert.deepEqual(models, []);
});

test('createModelCatalog behavior with injected run: concurrent calls share one in-flight promise', async t => {
  let callCount = 0;
  const run = () => { callCount++; return buildTable([['p', 'm', '100', '50', 'yes', 'no']]); };
  const { read } = createModelCatalog({ run, now: () => 1000 });
  const [r1, r2] = await Promise.all([read(), read()]);
  assert.equal(callCount, 1);
  assert.equal(r1, r2);
  assert.equal(r1.state, 'ready');
});

test('createModelCatalog behavior: cached read does not run again', async t => {
  let callCount = 0;
  const run = () => { callCount++; return buildTable([['p', 'm', '100', '50', 'yes', 'no']]); };
  const { read } = createModelCatalog({ run, now: () => 1000 });
  await read();
  assert.equal(callCount, 1);
  await read();
  assert.equal(callCount, 1);
});

test('createModelCatalog behavior: refresh:true triggers another read', async t => {
  let callCount = 0;
  const run = () => { callCount++; return buildTable([['p', 'm', '100', '50', 'yes', 'no']]); };
  const { read } = createModelCatalog({ run, now: () => 1000 });
  await read();
  assert.equal(callCount, 1);
  await read({ refresh: true });
  assert.equal(callCount, 2);
});

test('createModelCatalog behavior: failing run yields failed state and retries', async t => {
  let callCount = 0;
  const run = () => { callCount++; if (callCount === 1) throw new Error('secret-token'); return buildTable([['p', 'm', '100', '50', 'yes', 'no']]); };
  const { read } = createModelCatalog({ run, now: () => 1000 });
  const r1 = await read();
  assert.equal(r1.state, 'failed');
  assert.ok(!JSON.stringify(r1).includes('secret-token'));
  const r2 = await read();
  assert.equal(r2.state, 'ready');
  assert.equal(callCount, 2);
});

test('createModelCatalog behavior: deterministic host and read_at', async t => {
  const run = () => buildTable([['p', 'm', '100', '50', 'yes', 'no']]);
  const { read, host } = createModelCatalog({ run, hostname: 'testbox.local', now: () => 2000 });
  const r = await read();
  assert.equal(host, 'testbox');
  assert.equal(r.read_at, new Date(2000).toISOString());
});

test('default runner invokes pi --list-models only', async t => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  const logPath = join(tmpDir, 'pi.log');
  const piScript = `#!/bin/sh
echo "$PPID" >> "${logPath}"
echo "$@" >> "${logPath}"
cat <<'TABLE'
${buildTable([['deepinfra', 'ByteDance/Seed-2.0-code', '256K', '128K', 'yes', 'no']])}
TABLE
`;
  const piPath = join(tmpDir, 'pi');
  writeFileSync(piPath, piScript);
  chmodSync(piPath, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${origPath ? `:${origPath}` : ''}`;
  try {
    const { read } = createModelCatalog({ hostname: 'testbox.local' });
    const r = await read();
    assert.equal(r.state, 'ready');
    assert.equal(r.models.length, 1);
    assert.equal(r.models[0].model, 'ByteDance/Seed-2.0-code');
    const log = readFileSync(logPath, 'utf8').split('\n').filter(l => l.length > 0);
    assert.equal(log.length, 2);
    assert.equal(log[0], String(process.pid));
    assert.equal(log[1], '--list-models');
  } finally {
    process.env.PATH = origPath;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('nonzero-exit fail-closed', async t => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  const piPath = join(tmpDir, 'pi');
  writeFileSync(piPath, '#!/bin/sh\nexit 3');
  chmodSync(piPath, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${origPath ? `:${origPath}` : ''}`;
  try {
    const { read } = createModelCatalog({ timeoutMs: 1000 });
    const r = await read();
    assert.equal(r.state, 'failed');
  } finally {
    process.env.PATH = origPath;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('timeout fail-closed', async t => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  const piPath = join(tmpDir, 'pi');
  writeFileSync(piPath, '#!/bin/sh\nexec sleep 5');
  chmodSync(piPath, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${origPath ? `:${origPath}` : ''}`;
  try {
    const { read } = createModelCatalog({ timeoutMs: 300 });
    const r = await read();
    assert.equal(r.state, 'failed');
  } finally {
    process.env.PATH = origPath;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
