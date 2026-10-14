import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync, existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseModelCatalog, createModelCatalog, CATALOG_HEADERS, CATALOG_LIMITS, createPreferredModels, PREFERRED_LIMITS } from './model-routes.mjs';

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

test('createPreferredModels: missing file resolves to empty', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r = await prefs.read();
  assert.equal(r.state, 'ready');
  assert.deepEqual(r.preferred, []);
  assert.equal(r.updated_at, null);
});

test('createPreferredModels: persist and modes', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r1 = await prefs.setPreference({ provider: 'a', model: 'm1', preferred: true });
  assert.equal(r1.state, 'ready');
  assert.equal(r1.preferred.length, 1);

  const r2 = await prefs.setPreference({ provider: 'b', model: 'm2', preferred: true });
  assert.equal(r2.state, 'ready');
  assert.equal(r2.preferred.length, 2);

  const filePath = join(agentDir, 'spec-sentinel', 'preferred-models.json');
  assert.ok(existsSync(filePath));
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(data.version, 1);
  assert.deepEqual(data.preferred, [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }]);
  assert.ok(data.updated_at.endsWith('Z'));

  const dirMode = lstatSync(join(agentDir, 'spec-sentinel')).mode & 0o777;
  assert.equal(dirMode, 0o700);
  const fileMode = lstatSync(filePath).mode & 0o777;
  assert.equal(fileMode, 0o600);
});

test('createPreferredModels: concurrency', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  await Promise.all([
    prefs.setPreference({ provider: 'p1', model: 'm1', preferred: true }),
    prefs.setPreference({ provider: 'p2', model: 'm2', preferred: true })
  ]);

  const filePath = join(agentDir, 'spec-sentinel', 'preferred-models.json');
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(data.preferred.length, 2);

  const prefs2 = createPreferredModels({ agentDir, now: () => 2000 });
  const r = await prefs2.read();
  assert.equal(r.state, 'ready');
  assert.equal(r.preferred.length, 2);
});

test('createPreferredModels: idempotent add/remove', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r1 = await prefs.setPreference({ provider: 'a', model: 'm', preferred: true });
  const data1 = readFileSync(join(agentDir, 'spec-sentinel', 'preferred-models.json'), 'utf8');
  const r2 = await prefs.setPreference({ provider: 'a', model: 'm', preferred: true });
  assert.equal(r2.updated_at, r1.updated_at);
  assert.equal(readFileSync(join(agentDir, 'spec-sentinel', 'preferred-models.json'), 'utf8'), data1);
});

test('createPreferredModels: remove', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  await prefs.setPreference({ provider: 'a', model: 'm1', preferred: true });
  await prefs.setPreference({ provider: 'b', model: 'm2', preferred: true });
  const r = await prefs.setPreference({ provider: 'a', model: 'm1', preferred: false });
  assert.equal(r.state, 'ready');
  assert.equal(r.preferred.length, 1);
  assert.equal(r.preferred[0].provider, 'b');
});

test('createPreferredModels: retry after failed write', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  const dirPath = join(agentDir, 'spec-sentinel');
  t.after(() => { if (existsSync(dirPath)) chmodSync(dirPath, 0o700); rmSync(agentDir, { recursive: true, force: true }); });

  mkdirSync(dirPath, { mode: 0o700 });
  const filePath = join(dirPath, 'preferred-models.json');

  const tmpPath = join(agentDir, 'tmp.json');
  writeFileSync(tmpPath, '{"test":true}');
  symlinkSync(tmpPath, filePath);

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r1 = await prefs.setPreference({ provider: 'a', model: 'm', preferred: true });
  assert.equal(r1.state, 'failed');

  unlinkSync(filePath);
  const r2 = await prefs.setPreference({ provider: 'a', model: 'm', preferred: true });
  assert.equal(r2.state, 'ready');
  assert.ok(existsSync(filePath));

  // A read-only sentinel directory makes the atomic publish itself fail rather
  // than the read, proving write-failure reporting and queue recovery.
  chmodSync(dirPath, 0o500);
  let r3;
  try {
    r3 = await prefs.setPreference({ provider: 'b', model: 'n', preferred: true });
  } finally {
    chmodSync(dirPath, 0o700);
  }
  assert.equal(r3.state, 'failed');
  assert.equal(r3.reason, 'preferences-unavailable');

  const r4 = await prefs.setPreference({ provider: 'b', model: 'n', preferred: true });
  assert.equal(r4.state, 'ready');
  assert.deepEqual(r4.preferred, [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'n' }]);
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).preferred, [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'n' }]);
});

test('createPreferredModels: refuse and preserve', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const dirPath = join(agentDir, 'spec-sentinel');
  mkdirSync(dirPath, { mode: 0o700 });
  const filePath = join(dirPath, 'preferred-models.json');

  const cases = [
    ['corrupt', '{'],
    ['version2', '{"version":2,"preferred":[{"provider":"a","model":"m"}],"updated_at":null}'],
    ['duplicate', '{"version":1,"preferred":[{"provider":"a","model":"m"},{"provider":"a","model":"m"}],"updated_at":null}'],
    ['oversize', JSON.stringify({ version: 1, preferred: [{ provider: 'a', model: 'b'.repeat(PREFERRED_LIMITS.bytes) }], updated_at: new Date(0).toISOString() })],
  ];

  for (const [name, bytes] of cases) {
    writeFileSync(filePath, bytes);
    const prefs = createPreferredModels({ agentDir, now: () => 1000 });
    const r = await prefs.read();
    assert.equal(r.state, 'failed', `${name}: state`);
    assert.equal(r.reason, 'preferences-unavailable', `${name}: reason`);
    assert.equal(readFileSync(filePath, 'utf8'), bytes, `${name}: bytes preserved`);
    unlinkSync(filePath);
  }

  const targetPath = join(agentDir, 'target.json');
  const targetBytes = '{"valid":true}';
  writeFileSync(targetPath, targetBytes);
  symlinkSync(targetPath, filePath);
  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r = await prefs.read();
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, 'preferences-unavailable');
  assert.equal(readFileSync(targetPath, 'utf8'), targetBytes);
  assert.ok(lstatSync(filePath).isSymbolicLink());
  unlinkSync(filePath);

  execFileSync('mkfifo', [filePath]);
  const prefs2 = createPreferredModels({ agentDir, now: () => 1000 });
  const r2 = await prefs2.read();
  assert.equal(r2.state, 'failed');
  assert.equal(r2.reason, 'preferences-unavailable');
  unlinkSync(filePath);
});

test('createPreferredModels: capacity', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const dirPath = join(agentDir, 'spec-sentinel');
  mkdirSync(dirPath, { mode: 0o700 });
  const filePath = join(dirPath, 'preferred-models.json');

  const preferred = Array.from({ length: 200 }, (_, i) => ({ provider: `p${i}`, model: `m${i}` }));
  const content = JSON.stringify({ version: 1, preferred, updated_at: new Date(1000).toISOString() });
  writeFileSync(filePath, content);

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r = await prefs.setPreference({ provider: 'p200', model: 'm200', preferred: true });
  assert.equal(r.state, 'failed');
  assert.equal(r.reason, 'preference-limit');
  assert.equal(readFileSync(filePath, 'utf8'), content);

  const r2 = await prefs.setPreference({ provider: 'p0', model: 'm0', preferred: false });
  assert.equal(r2.state, 'ready');
  assert.equal(r2.preferred.length, 199);
});

test('createPreferredModels: identifier guard', async t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'model-routes-test-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const prefs = createPreferredModels({ agentDir, now: () => 1000 });
  const r = await prefs.setPreference({ provider: '', model: 'm', preferred: true });
  assert.equal(r.state, 'failed');
  assert.equal(existsSync(join(agentDir, 'spec-sentinel', 'preferred-models.json')), false);
});
