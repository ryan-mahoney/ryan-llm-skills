// Focused acceptance evidence for the Next steps scan and its dashboard route.
//
// Disposable real storage (setupStorage/createWorkspace) with real directory
// trees; only the clock and one final filesystem refusal boundary are
// controlled. Run independently:
// node --test scripts/spec-observe/next-steps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { scanNextSteps, NEXT_STEPS_LIMITS } from './next-steps.mjs';
import { setupStorage, createWorkspace } from '../workspaces/store.mjs';
import { createDashboardServer } from './dashboard.mjs';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const WINDOW = NEXT_STEPS_LIMITS.windowMs;

async function fixture(t, ids = ['demo']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'next-steps-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = join(root, 'storage');
  await setupStorage(storage);
  const workspaces = [];
  for (const id of ids) workspaces.push(await createWorkspace(storage, { id }));
  return { root, storage, workspaces };
}

const specsDir = (storage, id) => join(storage, 'projects', id, 'specs');

function writeAt(path, content, ms) {
  writeFileSync(path, content);
  utimesSync(path, ms / 1000, ms / 1000);
}

// Each value is either content (written at the default time) or {content, at}.
function packageWith(storage, id, slug, files, at = NOW - 1000) {
  const dir = join(specsDir(storage, id), slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    if (value && typeof value === 'object') writeAt(join(dir, name), value.content, value.at ?? at);
    else writeAt(join(dir, name), value, at);
  }
  return dir;
}

const scanAt = (storage, now = NOW) => scanNextSteps(storage, { now });
const signalOf = (scan, slug) => scan.rows.find(row => row.slug === slug)?.signal;

const proposal = '---\nverdict: COMPATIBLE\ncritique_recommended: false\n---\n\n## Summary\n\nOpening summary.\n';
const critiqueNumbered = ['# Critique', '', '## Assessment', '', 'Assessment opening.', '', '## Recommendations', '',
  '### Must Address', '', '1. **First must.** Details.', '', '### Should Address', '',
  '1. **First should.** Details.', ''].join('\n');
const critiqueLabelled = ['## Recommendations', '', '### Must Address', '', '**M1 — Enforce budgets.** Details.', '',
  '### Should Address', '', '**S1 — Retain metadata.** Details.', '', '### Consider', '',
  '**C1 — Watch formats.** Details.', '**C2. Consider drift.** Details.', ''].join('\n');
const critiqueHeadings = ['## Recommendations', '', '### Must Address', '', '#### Fourth must heading', '', 'Details.', '',
  '### Should Address', '', '#### Fourth should heading', '', 'Details.', ''].join('\n');
const critiqueNone = ['## Recommendations', '', '### Must Address', '', 'None.', '',
  '### Should Address', '', 'None', ''].join('\n');
const critiqueMissing = ['## Recommendations', '', '### Must Address', '', '1. **Only must.** Details.', ''].join('\n');
const critiqueUnknown = ['## Recommendations', '', '### Must Address', '', 'We should rethink the whole thing.', '',
  '### Should Address', '', '1. **Only should.** Details.', ''].join('\n');

test('scan keeps the newest critique over an older proposal', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'alpha', {
    'proposal.md': { content: proposal, at: NOW - 5000 },
    'critique.md': { content: critiqueNumbered, at: NOW - 1000 },
  });
  const scan = await scanAt(storage);
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.rows[0].stage, 'critique');
  assert.equal(scan.rows[0].file, 'critique.md');
  assert.equal(scan.rows[0].signal.state, 'ok');
  assert.deepEqual(scan.rows[0].signal.must_address, ['First must.']);
  assert.deepEqual(scan.rows[0].observed_files.map(item => item.name), ['critique.md', 'proposal.md']);
  assert.equal(scan.rows[0].workspace_id, 'demo');
  assert.equal(scan.rows[0].key, JSON.stringify(['demo', 'package', 'alpha']));
  assert.equal(scan.rows[0].package, join(specsDir(storage, 'demo'), 'alpha'));
  assert.equal(scan.coverage.state, 'complete');
});

test('scan includes a file exactly at the seven-day cutoff and omits one millisecond older', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'edge', { 'proposal.md': { content: proposal, at: NOW - WINDOW } });
  packageWith(storage, 'demo', 'old', { 'proposal.md': { content: proposal, at: NOW - WINDOW - 1 } });
  const scan = await scanAt(storage);
  assert.deepEqual(scan.rows.map(row => row.slug), ['edge']);
});

test('equal mtimes choose the later lifecycle stage and read the tour JSON', async t => {
  const { storage } = await fixture(t);
  const at = NOW - 2000;
  packageWith(storage, 'demo', 'tour', {
    'proposal.md': { content: proposal, at },
    'critique.md': { content: critiqueNumbered, at },
    'spec.md': { content: '# Spec\n', at },
    'work-tour.html': { content: '<h1>HTML must never be read</h1>', at },
    'work-tour.json': { content: JSON.stringify({ verdict: 'ready', gaps: [], commit: 'abc', title: 'Tour', summary: 'Done.' }), at },
  });
  const scan = await scanAt(storage);
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.rows[0].stage, 'work-tour');
  assert.equal(scan.rows[0].file, 'work-tour.html');
  assert.equal(scan.rows[0].signal.state, 'ok');
  assert.equal(scan.rows[0].signal.verdict, 'ready');
  assert.equal(scan.rows[0].signal.gaps, 0);
  assert.equal(scan.rows[0].signal.commit, 'abc');
  assert.equal(scan.rows[0].signal.pr, null, 'absent pr-url.json means no link');
  assert.equal(JSON.stringify(scan).includes('HTML must never be read'), false);
});

test('an invalid PR URL scheme never becomes a link while the tour stays readable', async t => {
  const { storage } = await fixture(t);
  const at = NOW - 2000;
  packageWith(storage, 'demo', 'pr', {
    'work-tour.html': { content: '<h1>tour</h1>', at },
    'work-tour.json': { content: JSON.stringify({ verdict: 'blocked', gaps: ['one'], summary: 'Blocked.' }), at },
    'pr-url.json': { content: JSON.stringify({ targets: { alpha: { url: 'ssh://git@github.com/org/repo/pull/7' } } }), at },
  });
  const scan = await scanAt(storage);
  assert.equal(scan.rows[0].signal.state, 'ok');
  assert.equal(scan.rows[0].signal.gaps, 1);
  assert.equal(scan.rows[0].signal.pr, null);
  assert.ok(scan.coverage.reasons.some(reason => reason.startsWith('pr-malformed:')));
  assert.equal(scan.coverage.state, 'partial');
});

test('the newest 200 selection keeps a later-enumerated newest package', async t => {
  const { storage } = await fixture(t);
  for (let index = 0; index < NEXT_STEPS_LIMITS.rows; index++) {
    packageWith(storage, 'demo', `p${String(index).padStart(3, '0')}`, { 'spec.md': { content: '# Spec\n', at: NOW - 10000 } });
  }
  packageWith(storage, 'demo', 'zzz-newest', { 'spec.md': { content: '# Spec\n', at: NOW - 5000 } });
  const scan = await scanAt(storage);
  assert.equal(scan.rows.length, NEXT_STEPS_LIMITS.rows);
  assert.equal(scan.rows[0].slug, 'zzz-newest');
  assert.ok(scan.coverage.reasons.some(reason => reason.startsWith('rows-truncated:')));
  assert.equal(scan.coverage.state, 'partial');
});

test('catalog workspace-row cap reads at most 100 workspaces and reports total null', async t => {
  const ids = Array.from({ length: NEXT_STEPS_LIMITS.catalog.rows + 1 }, (_, index) => `w${String(index).padStart(3, '0')}`);
  const { storage } = await fixture(t, ids);
  const scan = await scanAt(storage);
  assert.equal(scan.coverage.workspaces.read, NEXT_STEPS_LIMITS.catalog.rows);
  assert.ok(scan.coverage.workspaces.read <= NEXT_STEPS_LIMITS.catalog.rows);
  assert.equal(scan.coverage.workspaces.total, null);
  assert.equal(scan.coverage.state, 'partial');
  assert.ok(scan.coverage.reasons.some(reason => reason.startsWith('catalog-workspace-row-cap:')));
});

test('symlinked package, watched file and specs parent never expose target bytes', async t => {
  const { root, storage } = await fixture(t, ['linkpkg', 'linkfile', 'linkspecs']);
  const secret = 'SECRET-TARGET-BYTES-9f3c';
  // (a) A symlinked package directory inside specs is skipped.
  const outsidePackage = join(root, 'outside-package');
  mkdirSync(outsidePackage, { recursive: true });
  writeAt(join(outsidePackage, 'proposal.md'), `${proposal}${secret}`, NOW - 1000);
  mkdirSync(specsDir(storage, 'linkpkg'), { recursive: true });
  symlinkSync(outsidePackage, join(specsDir(storage, 'linkpkg'), 'linked'));
  // (b) A symlinked watched file is skipped without reading its target.
  const target = join(root, 'secret.md');
  writeAt(target, `${proposal}${secret}`, NOW - 1000);
  mkdirSync(join(specsDir(storage, 'linkfile'), 'real'), { recursive: true });
  symlinkSync(target, join(specsDir(storage, 'linkfile'), 'real', 'proposal.md'));
  // (c) A symlinked specs parent is not traversed.
  const outsideSpecs = join(root, 'outside-specs');
  mkdirSync(join(outsideSpecs, 'nested'), { recursive: true });
  writeAt(join(outsideSpecs, 'nested', 'proposal.md'), `${proposal}${secret}`, NOW - 1000);
  symlinkSync(outsideSpecs, join(storage, 'projects', 'linkspecs', 'specs'));
  const scan = await scanAt(storage);
  assert.equal(scan.rows.length, 0);
  assert.equal(JSON.stringify(scan).includes(secret), false);
});

test('critique titles parse the numbered, labelled and fourth-heading formats', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'numbered', { 'critique.md': { content: critiqueNumbered, at: NOW - 1000 } });
  packageWith(storage, 'demo', 'labelled', { 'critique.md': { content: critiqueLabelled, at: NOW - 1001 } });
  packageWith(storage, 'demo', 'headings', { 'critique.md': { content: critiqueHeadings, at: NOW - 1002 } });
  const scan = await scanAt(storage);
  const numbered = signalOf(scan, 'numbered');
  assert.equal(numbered.state, 'ok');
  assert.deepEqual(numbered.must_address, ['First must.']);
  assert.deepEqual(numbered.should_address, ['First should.']);
  assert.equal(numbered.consider, 0, 'a missing Consider section is zero');
  const labelled = signalOf(scan, 'labelled');
  assert.deepEqual(labelled.must_address, ['Enforce budgets.']);
  assert.deepEqual(labelled.should_address, ['Retain metadata.']);
  assert.equal(labelled.consider, 2, 'Consider titles use the same three formats');
  const headings = signalOf(scan, 'headings');
  assert.deepEqual(headings.must_address, ['Fourth must heading']);
  assert.deepEqual(headings.should_address, ['Fourth should heading']);
});

test('explicit None bodies are zero and stay readable', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'none', { 'critique.md': { content: critiqueNone, at: NOW - 1000 } });
  const scan = await scanAt(storage);
  const signal = signalOf(scan, 'none');
  assert.equal(signal.state, 'ok');
  assert.deepEqual(signal.must_address, []);
  assert.deepEqual(signal.should_address, []);
  assert.equal(signal.consider, 0);
  assert.equal(scan.coverage.state, 'complete');
});

test('missing required headings and unknown nonempty bodies stay unparsed and partial', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'missing', { 'critique.md': { content: critiqueMissing, at: NOW - 1000 } });
  packageWith(storage, 'demo', 'unknown', { 'critique.md': { content: critiqueUnknown, at: NOW - 1001 } });
  const scan = await scanAt(storage);
  assert.equal(signalOf(scan, 'missing').state, 'unparsed');
  assert.match(signalOf(scan, 'missing').reason, /Should Address/);
  assert.equal(signalOf(scan, 'unknown').state, 'unparsed');
  assert.match(signalOf(scan, 'unknown').reason, /unrecognized/);
  assert.ok(scan.coverage.reasons.some(reason => reason.startsWith('signal-unparsed:')));
  assert.equal(scan.coverage.state, 'partial');
});

test('missing or invalid required work-tour.json leaves the row unreadable partial', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'notour', { 'work-tour.html': { content: '<h1>tour</h1>', at: NOW - 1000 } });
  packageWith(storage, 'demo', 'badtour', {
    'work-tour.html': { content: '<h1>tour</h1>', at: NOW - 1001 },
    'work-tour.json': { content: '{', at: NOW - 1001 },
  });
  const scan = await scanAt(storage);
  assert.equal(signalOf(scan, 'notour').state, 'unreadable');
  assert.equal(signalOf(scan, 'badtour').state, 'unreadable');
  assert.ok(scan.coverage.reasons.filter(reason => reason.startsWith('signal-unreadable:')).length >= 2);
  assert.equal(scan.coverage.state, 'partial');
});

test('planned epic eligibility handles absent members, watched members, nonplanned state and refused member checks', async t => {
  const { storage } = await fixture(t);
  const epics = join(storage, 'projects', 'demo', 'epics');
  const writeEpic = (slug, state, packages) => {
    const dir = join(epics, slug);
    mkdirSync(dir, { recursive: true });
    writeAt(join(dir, 'epic.json'), JSON.stringify({
      schema_version: 1, epic: slug, title: `Epic ${slug}`, state,
      packages: packages.map(member => ({ package: member })),
    }), NOW - 2000);
  };
  writeEpic('planned-ok', 'planned', ['absent-one', 'absent-two']);
  writeEpic('planned-watched', 'planned', ['alpha']);
  writeEpic('active', 'active', ['absent-one']);
  writeEpic('refused', 'planned', ['gamma']);
  mkdirSync(join(specsDir(storage, 'demo'), 'alpha'), { recursive: true });
  writeAt(join(specsDir(storage, 'demo'), 'alpha', 'proposal.md'), proposal, NOW - 1000);
  mkdirSync(join(specsDir(storage, 'demo'), 'gamma'), { recursive: true });
  // Deterministic final lstat refusal on the gamma member directory only; no
  // chmod or root assumption is involved.
  const original = fsPromises.lstat;
  const refusedPath = join(specsDir(storage, 'demo'), 'gamma');
  fsPromises.lstat = async path => {
    if (path === refusedPath) {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return original(path);
  };
  syncBuiltinESMExports();
  let scan;
  try { scan = await scanAt(storage); } finally { fsPromises.lstat = original; syncBuiltinESMExports(); }
  const epicRows = scan.rows.filter(row => row.kind === 'epic');
  assert.deepEqual(epicRows.map(row => row.slug), ['planned-ok']);
  assert.deepEqual(epicRows[0].signal.members, ['absent-one', 'absent-two']);
  assert.equal(epicRows[0].signal.wave1.length, 2);
  assert.equal(epicRows[0].workspace_id, 'demo');
  assert.equal(epicRows[0].workspace, 'demo');
  assert.equal(epicRows[0].key, JSON.stringify(['demo', 'epic', 'planned-ok']));
  assert.equal(scan.rows.some(row => row.slug === 'planned-watched'), false, 'a watched member excludes its epic');
  assert.equal(scan.rows.some(row => row.slug === 'active'), false, 'a nonplanned epic is excluded');
  assert.equal(epicRows.some(row => row.slug === 'refused'), false, 'an unreadable member check cannot certify eligibility');
  assert.ok(scan.coverage.reasons.some(reason => reason.includes('epic-member-unknown') && reason.includes('gamma')));
  assert.equal(scan.coverage.state, 'partial');
  assert.equal(scan.coverage.workspaces.read, 0, 'a scoped eligibility reason leaves the workspace unread');
});

test('oversized markdown and tour files are refused with partial coverage', async t => {
  const { storage } = await fixture(t);
  packageWith(storage, 'demo', 'big-proposal', {
    'proposal.md': { content: `${proposal}${'x'.repeat(NEXT_STEPS_LIMITS.markdownBytes)}`, at: NOW - 1000 },
  });
  packageWith(storage, 'demo', 'big-tour', {
    'work-tour.html': { content: '<h1>tour</h1>', at: NOW - 1001 },
    'work-tour.json': { content: `{"verdict":"ready","gaps":[],"summary":"${'x'.repeat(NEXT_STEPS_LIMITS.tourBytes)}"}`, at: NOW - 1001 },
  });
  const scan = await scanAt(storage);
  assert.equal(signalOf(scan, 'big-proposal').state, 'unreadable');
  assert.equal(signalOf(scan, 'big-tour').state, 'unreadable');
  assert.equal(scan.coverage.state, 'partial');
});

test('the shared signal budget refuses reads past its aggregate cap', async t => {
  const { storage } = await fixture(t);
  // 500,000-byte tours: 33 reads fit the 16 MiB budget with the cap+1 sentinel
  // reserved; the 34th must be refused.
  const json = JSON.stringify({ verdict: 'ready', gaps: [], summary: 'x'.repeat(499900) });
  assert.ok(json.length > 493447 && json.length < NEXT_STEPS_LIMITS.tourBytes, `tour fixture is ${json.length} bytes`);
  for (let index = 0; index < 34; index++) {
    packageWith(storage, 'demo', `budget-${String(index).padStart(2, '0')}`, {
      'work-tour.html': { content: '<h1>tour</h1>', at: NOW - 1000 },
      'work-tour.json': { content: json, at: NOW - 1000 },
    });
  }
  const scan = await scanAt(storage);
  assert.equal(scan.rows.length, 34);
  assert.equal(scan.rows.filter(row => row.signal.reason === 'signal-budget-exhausted').length, 1);
  assert.ok(scan.coverage.reasons.some(reason => reason.startsWith('signal-budget:')));
  assert.equal(scan.coverage.state, 'partial');
});

// Real loopback HTTP against the owned server; responses are consumed fully and
// every server is closed before the test finishes.
async function serve(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return server;
}

function httpGet(server, path, { method = 'GET', headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

// The route reads the default clock; freezing it to NOW lets the route share the
// direct scan fixtures without touching production scanner code.
function freezeClock(t) {
  const realNow = Date.now;
  Date.now = () => NOW;
  t.after(() => { Date.now = realNow; });
}

test('GET and HEAD /api/next-steps serve the real scan with canonical identity and remote reads', async t => {
  const { root, storage } = await fixture(t);
  freezeClock(t);
  packageWith(storage, 'demo', 'alpha', {
    'proposal.md': { content: proposal, at: NOW - 5000 },
    'critique.md': { content: critiqueNumbered, at: NOW - 1000 },
  });
  packageWith(storage, 'demo', 'tour', {
    'proposal.md': { content: proposal, at: NOW - 2000 },
    'critique.md': { content: critiqueNumbered, at: NOW - 2000 },
    'spec.md': { content: '# Spec\n', at: NOW - 2000 },
    'work-tour.html': { content: '<h1>tour</h1>', at: NOW - 2000 },
    'work-tour.json': { content: JSON.stringify({ verdict: 'ready', gaps: [], summary: 'Done.' }), at: NOW - 2000 },
  });
  packageWith(storage, 'demo', 'edge', { 'proposal.md': { content: proposal, at: NOW - WINDOW } });
  packageWith(storage, 'demo', 'old', { 'proposal.md': { content: proposal, at: NOW - WINDOW - 1 } });
  const server = await serve(t, createDashboardServer({ agentDir: join(root, 'agent'), storageRoot: storage }));
  const get = await httpGet(server, '/api/next-steps');
  assert.equal(get.status, 200);
  assert.match(get.headers['content-type'], /application\/json/);
  const scan = JSON.parse(get.body);
  assert.equal(scan.schema_version, 1);
  assert.equal(scan.window_ms, NEXT_STEPS_LIMITS.windowMs);
  assert.deepEqual(scan.rows.map(row => row.slug), ['alpha', 'tour', 'edge']);
  const alpha = scan.rows[0];
  assert.equal(alpha.stage, 'critique', 'the newer critique beats the older proposal');
  assert.equal(alpha.workspace_id, 'demo');
  assert.equal(alpha.workspace, 'demo');
  assert.equal(alpha.key, JSON.stringify(['demo', 'package', 'alpha']));
  assert.equal(alpha.package, join(storage, 'projects', 'demo', 'specs', 'alpha'));
  const tour = scan.rows[1];
  assert.equal(tour.stage, 'work-tour', 'equal mtimes choose the later lifecycle stage');
  assert.equal(tour.signal.state, 'ok');
  assert.equal(tour.signal.pr, null);
  assert.equal(scan.rows.some(row => row.slug === 'old'), false, 'one millisecond before the cutoff is omitted');
  const head = await httpGet(server, '/api/next-steps', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '', 'HEAD executes the scan but returns no body');
  const remote = await httpGet(server, '/api/next-steps', { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(remote.status, 200, 'read routes still serve forwarded remote reads');
  assert.equal(JSON.parse(remote.body).schema_version, 1);
});

test('GET and HEAD /api/next-steps answer 503 when storage is unavailable', async t => {
  const { root } = await fixture(t);
  const server = await serve(t, createDashboardServer({ agentDir: join(root, 'agent'), storageRoot: join(root, 'absent-storage') }));
  const get = await httpGet(server, '/api/next-steps');
  assert.equal(get.status, 503);
  const scan = JSON.parse(get.body);
  assert.equal(scan.coverage.state, 'unavailable');
  assert.deepEqual(scan.rows, []);
  const head = await httpGet(server, '/api/next-steps', { method: 'HEAD' });
  assert.equal(head.status, 503);
  assert.equal(head.body, '');
});
