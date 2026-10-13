// Run independently: node --test scripts/design/cli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { parseDesign, lintScreen, screenStatus, DESIGN_LIMITS } from './schema.mjs';
import { lintDesign, referenceLine, resolveDesignSystem, vendorTailwind, TAILWIND } from './cli.mjs';

const record = (extra = {}) => ({ schema_version: 1, design: 'demo', title: 'Demo', viewport: { posture: 'desktop-only', widths: [1280] },
  screens: [
    { step: 1, id: 'overview', title: 'Overview', person: 'Planner', job: 'Pick the worst route', kind: 'decision', state: 'ideal' },
    { step: 2, id: 'overview-empty', title: 'Overview, nothing imported', person: 'Planner', job: 'Import a feed', kind: 'action', state: 'empty', shell_from: 1, primary_action: 'Import feed' },
  ], ...extra });

const fixture = t => { const dir = mkdtempSync(join(tmpdir(), 'design-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('parseDesign accepts a valid index, derives file names and keeps allowlisted fields', () => {
  const { design, error } = parseDesign(record({ deviations: [{ screen: 1, token: 'row height', from: '44px', to: '36px', reason: 'dense comparison' }], extra: true }), { slug: 'demo' });
  assert.equal(error, undefined);
  assert.equal(design.screens[0].file, 'screens/01-overview.html');
  assert.equal(design.screens[1].shell_from, 1);
  assert.equal(design.deviations.length, 1);
  assert.equal('extra' in design, false);
});

test('parseDesign accepts numbered design package slugs with a two-digit prefix', () => {
  assert.equal(parseDesign(record({ design: '01-home-split' }), { slug: '01-home-split' }).error, undefined);
  assert.match(parseDesign(record({ design: '1-home-split' }), { slug: '1-home-split' }).error ?? '', /valid slug/);
  assert.match(parseDesign(record({ design: '01-home-split' }), { slug: '02-home-split' }).error ?? '', /does not match directory/);
});

test('parseDesign accepts the kit-shaped design_system and the legacy absolute form, and rejects malformed ones', () => {
  const parse = design_system => parseDesign(record({ design_system }), { slug: 'demo' });
  assert.deepEqual(parse({ repository: 'cms', paths: ['public/design-system/index.html', 'app/design-system.css'] }).design.design_system,
    { repository: 'cms', paths: ['public/design-system/index.html', 'app/design-system.css'] });
  assert.deepEqual(parse({ path: '/abs/index.html', tokens: '/abs/tokens.css' }).design.design_system, { path: '/abs/index.html', tokens: '/abs/tokens.css' });
  for (const bad of [{ repository: 'cms', paths: [] }, { repository: 'cms' }, { repository: 'cms', paths: ['/etc/passwd'] }, { repository: 'cms', paths: ['../x'] }, { paths: ['a'] }]) {
    assert.match(parse(bad).error ?? '', /design_system/);
  }
});

test('resolveDesignSystem resolves paths through the workspace kit and rejects an unknown repository', async t => {
  const root = fixture(t), workspace = join(root, 'transit'), dir = join(workspace, 'designs', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, 'kit.yaml'), 'version: 1\nid: transit\nname: Transit\nrepositories:\n  - id: cms\n    path: /abs/cms\n    role: primary\n');
  writeFileSync(join(dir, 'design.json'), JSON.stringify(record({ design_system: { repository: 'cms', paths: ['public/index.html'] } })));
  assert.deepEqual(await resolveDesignSystem(dir), { repository: 'cms', paths: ['/abs/cms/public/index.html'] });
  writeFileSync(join(dir, 'design.json'), JSON.stringify(record({ design_system: { repository: 'other', paths: ['x'] } })));
  await assert.rejects(resolveDesignSystem(dir), /not in the workspace kit/);
  writeFileSync(join(dir, 'design.json'), JSON.stringify(record({ design_system: { path: '/abs/i.html', tokens: '/abs/t.css' } })));
  assert.deepEqual(await resolveDesignSystem(dir), { repository: null, paths: ['/abs/i.html', '/abs/t.css'] });
});

test('parseDesign rejects each invalid class with a short reason', () => {
  const bad = (value, pattern, slug = 'demo') => assert.match(parseDesign(value, { slug }).error ?? '', pattern);
  bad(record(), /does not match directory/, 'other');
  bad(record({ schema_version: 2 }), /schema_version/);
  bad(record({ viewport: { posture: 'mobile', widths: [390] } }), /posture/);
  bad(record({ viewport: { posture: 'responsive', widths: [1280] } }), /at least two widths/);
  bad(record({ viewport: { posture: 'desktop-only', widths: [100] } }), /between 320 and 3840/);
  bad(record({ screens: [{ ...record().screens[0], step: 2 }] }), /steps must run 1\.\.N/);
  bad(record({ screens: [{ ...record().screens[0], job: '' }] }), /job is missing/);
  bad(record({ screens: [{ ...record().screens[0], kind: 'list' }] }), /kind/);
  bad(record({ screens: [{ ...record().screens[0], file: 'screens/other.html' }] }), /file must be screens\/01-overview\.html/);
  bad(record({ screens: [record().screens[0], { ...record().screens[1], shell_from: 2 }] }), /earlier step/);
  bad(record({ screens: [record().screens[0], { ...record().screens[1], id: 'overview' }] }), /duplicate screen id/);
  bad(record({ deviations: [{ screen: 9, token: 'x', from: 'a', to: 'b', reason: 'r' }] }), /existing step/);
  bad(record({ screens: [] }), /screens is empty/);
});

test('lintScreen fails external resources, network and forms, and warns on self-reference and marketing copy', () => {
  const levels = html => lintScreen(html).map(f => `${f.level}:${f.rule}`);
  assert.deepEqual(levels('<html><head><script src="vendor/tailwind.js"></script></head><body><h1>Routes</h1></body></html>'), []);
  assert.ok(levels('<script src="https://cdn.tailwindcss.com"></script><h1>Routes</h1>').includes('fail:external-tailwind'));
  assert.ok(levels('<style></style><img src="//example.com/a.png"><link href="https://fonts.googleapis.com/x" rel="stylesheet">').filter(l => l === 'fail:external-resource').length === 2);
  assert.ok(levels('<style>@import url("https://x/y.css")</style>').includes('fail:external-resource'));
  assert.ok(levels('<style></style><form action="/save"></form>').includes('fail:form-action'));
  assert.ok(levels('<style></style><script>fetch("/api")</script>').includes('fail:network'));
  const warned = levels('<style></style><p>Empty state: a seamless, intuitive view at a glance</p><nav data-state="empty"></nav>');
  assert.ok(warned.includes('warn:self-reference') && warned.includes('warn:marketing') && warned.includes('warn:switcher'));
  assert.ok(!warned.some(l => l.startsWith('fail')));
  assert.deepEqual(levels('<style></style><p>Powerful</p>'), ['warn:marketing']);
  assert.ok(levels('<p>hello</p>').includes('warn:unstyled'));
  assert.ok(lintScreen('x', { bytes: DESIGN_LIMITS.screenBytes + 1 }).some(f => f.rule === 'size'));
});

test('screenStatus derives produced and captured from file presence only', async () => {
  const { design } = parseDesign(record(), { slug: 'demo' });
  const present = new Set(['screens/01-overview.html', 'captures/01-overview@1280.png']);
  const status = await screenStatus(design, async rel => present.has(rel));
  assert.equal(status.screens[0].produced, true);
  assert.deepEqual(status.screens[0].captured, { 1280: true });
  assert.equal(status.screens[1].produced, false);
  assert.deepEqual(status.summary, { total: 2, produced: 1, captured: 1 });
});

test('lintDesign reads a package on disk and referenceLine binds identity, path and digest', async t => {
  const root = fixture(t), dir = join(root, 'projects', 'transit', 'designs', 'demo');
  mkdirSync(join(dir, 'screens'), { recursive: true });
  writeFileSync(join(dir, 'design.json'), JSON.stringify(record()));
  const html = '<!doctype html><html><head><script src="../vendor/tailwind.js"></script></head><body><h1>Routes</h1></body></html>';
  writeFileSync(join(dir, 'screens', '01-overview.html'), html);
  const lint = await lintDesign(dir);
  assert.equal(lint.outcome, 'pass');
  assert.equal(lint.summary.produced, 1);
  assert.equal(lint.screens[1].produced, false);
  const ref = await referenceLine(dir, 1);
  assert.equal(ref.workspace, 'transit');
  assert.equal(ref.sha256, createHash('sha256').update(html).digest('hex'));
  assert.match(ref.line, /^Design reference: transit\/demo step 1 → .*screens\/01-overview\.html sha256:[0-9a-f]{64}$/);
  await assert.rejects(referenceLine(dir, 2), /not produced yet/);
  writeFileSync(join(dir, 'screens', '01-overview.html'), '<script src="https://cdn.tailwindcss.com"></script>');
  assert.equal((await lintDesign(dir)).outcome, 'fail');
  writeFileSync(join(dir, 'design.json'), '{');
  assert.match((await lintDesign(dir)).error, /unreadable/);
});

test('vendorTailwind caches the pinned runtime once and refuses a digest mismatch', async t => {
  const root = fixture(t), cache = join(root, 'cache'), dir = join(root, 'demo');
  mkdirSync(dir);
  const bytes = Buffer.from('runtime');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, arrayBuffer: async () => bytes }; };
  await assert.rejects(vendorTailwind(dir, { fetchImpl, cache }), /pinned digest/);
  fetches = 0;
  const pin = { ...TAILWIND, sha256: createHash('sha256').update(bytes).digest('hex') };
  const first = await vendorTailwind(dir, { fetchImpl, cache, pin });
  assert.equal(readFileSync(first.path, 'utf8'), 'runtime');
  assert.equal(readFileSync(join(cache, `tailwind-${TAILWIND.version}.js`), 'utf8'), 'runtime');
  await vendorTailwind(dir, { fetchImpl, cache, pin });
  assert.equal(fetches, 1);
  // A cached file whose digest differs from the pin is refused rather than copied.
  writeFileSync(join(cache, `tailwind-${TAILWIND.version}.js`), 'tampered');
  await assert.rejects(vendorTailwind(dir, { fetchImpl, cache, pin }), /does not match the pinned digest/);
});
