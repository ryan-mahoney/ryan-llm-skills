import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { readDashboardState, createDashboardServer, isRemoteRequest, normalizePublicHost } from './dashboard.mjs';
import { COMPLETION_FILE } from './manual-completion.mjs';
import { setupStorage, createWorkspace, addMaterial } from '../workspaces/store.mjs';
import { createDiscussionService } from '../workspaces/discussion.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-dashboard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const observers = join(dir, 'spec-sentinel', 'a'.repeat(64), 'observers');
  mkdirSync(observers, { recursive: true });
  return { dir, observers };
}
const envelope = id => ({ schema_version: 1, observer_id: id, state: 'observing', published_at: new Date().toISOString(), snapshot: { runs: [] } });

test('dashboard enumerates snapshots without following links and preserves read errors', async t => {
  const f = fixture(t);
  writeFileSync(join(f.observers, 'a.json'), JSON.stringify(envelope('a')));
  writeFileSync(join(f.observers, 'b.json'), '{');
  const foreign = join(f.dir, 'foreign.json');
  writeFileSync(foreign, JSON.stringify(envelope('foreign')));
  symlinkSync(foreign, join(f.observers, 'c.json'));
  const state = await readDashboardState(f.dir);
  assert.deepEqual(state.observers.map(observer => observer.observer_id), ['a']);
  assert.equal(state.errors.length, 1);
  assert.equal(state.observers[0].source, join(f.observers, 'a.json'));
});

// Exercise the real request handler without requiring a listening socket, which
// can be prohibited in managed environments. Live browser verification is separate.
// A supplied body installs a throwing async-iterator trap so refusal cases can
// assert the body was never consumed.
function request(server, path, { host = '127.0.0.1:4319', origin, method = 'GET', headers = {}, body } = {}) {
  return new Promise(resolve => {
    const seen = { bodyRead: false };
    const response = { status: 200, headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(code, headers = {}) { this.status = code; Object.assign(this.headers, headers); },
      end(body) { resolve({ status: this.status, headers: this.headers, body: String(body ?? ''), bodyRead: seen.bodyRead }); },
    };
    const incoming = {
      url: path, method,
      headers: { host, ...(origin !== undefined ? { origin } : {}), ...headers },
      socket: { localPort: 4319 },
    };
    if (body !== undefined) {
      incoming[Symbol.asyncIterator] = () => { seen.bodyRead = true; throw new Error('request body must not be read'); };
    }
    server.emit('request', incoming, response);
  });
}

test('dashboard serves only its page and read-only same-origin state endpoint', async t => {
  const f = fixture(t), server = createDashboardServer({ agentDir: f.dir });
  writeFileSync(join(f.observers, 'a.json'), JSON.stringify(envelope('a')));
  const state = await request(server, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).observers[0].observer_id, 'a');
  assert.equal((await request(server, '/api/state', { method: 'POST' })).status, 405);
  assert.equal((await request(server, '/api/state', { host: 'remote.example:4319' })).status, 403);
  assert.equal((await request(server, '/api/state', { origin: 'https://other.example' })).status, 403);
  assert.equal((await request(server, '/etc/passwd')).status, 404);
  const page = await request(server, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<!doctype html>/i);
  assert.match(page.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('thread routes stay local-only through the dashboard seam', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example' });
  assert.equal((await request(server, '/api/threads?workspace_id=alpha')).status, 503);
  for (const variant of [
    { host: 'dashboard.example' },
    { host: 'dashboard.example:443' },
    { headers: { 'x-forwarded-for': '' } },
    { headers: { 'tailscale-user-login': '' } },
  ]) {
    const refused = await request(server, '/api/threads?workspace_id=alpha', variant);
    assert.equal(refused.status, 403, JSON.stringify(variant));
    assert.equal(refused.bodyRead, false, JSON.stringify(variant));
  }
});


test('dashboard uses current workspace snapshots without reviving old completed runs', () => {
  const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const context = vm.createContext({ document: {}, Date, Map, Set, JSON, performance: { now: () => 0 } });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  const now = new Date().toISOString();
  context.observers = [
    { observer_id: 'old', state: 'closed', published_at: now, snapshot: { workspace: 'w', coverage: { state: 'partial', observed_at: now }, runs: [{ package: 'completed-work' }] } },
    { observer_id: 'current', state: 'observing', published_at: now, snapshot: { workspace: 'w', coverage: { state: 'complete', observed_at: now }, runs: [] } },
  ];
  vm.runInContext(`liveAnchor={at:Date.parse(observers[1].snapshot.coverage.observed_at),perf:performance.now()}`, context);
  assert.equal(vm.runInContext('authoritativeObservers(observers)[0].observer_id', context), 'current');
  assert.equal(vm.runInContext('authoritativeObservers(observers)[0].snapshot.runs.length', context), 0);
  context.bad = { observers: [{ snapshot: { runs: [{ actions: [null] }] } }] };
  assert.throws(() => vm.runInContext('normalize(bad)', context));
  context.pending = { observer_id: 'pending', state: 'observing', snapshot: null };
  assert.equal(vm.runInContext('normalize(pending).observers.length', context), 1);
});

test('attempt reasons and unfinished workers distinguish execution from handoff and escape imported text', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ document: {}, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  context.run = { workflow_observed_at: '2026-10-08T13:22:00Z',
    workflow_workers: [{ id: '<img src=x onerror=alert(1)>', kind: 'fixer', state: 'working' }],
    timing: { attempts: [{ step: 6, state: 'completed', attempt_kind: 'verification-continuation', handoff_outcome: 'checkpoint' },
      { step: 6, state: 'failed' }] } };
  const html = vm.runInContext('workflowWorkers(run) + stepTimings(run)', context);
  assert.match(html, /fixer/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Verification continuation/);
  assert.match(html, /Handoff: checkpoint/);
  assert.match(html, /Reason not recorded/);
  assert.throws(() => vm.runInContext('normalize({runs:[{workflow_workers:[null]}]})', context));
  assert.doesNotThrow(() => vm.runInContext('normalize({runs:[{}]})', context));
});

test('partial workspace coverage stays in the footer while connection failures use the notice', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', classList: { toggle(name, value) { this[name] = value; } } });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, Date, Map, Set, JSON, performance: { now: () => 0 } });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  const now = new Date().toISOString();
  const snapshot = { observers: [{ observer_id: 'live', state: 'observing', published_at: now,
    snapshot: { workspace: 'workspace', coverage: { state: 'partial', observed_at: now,
      reasons: ['roots-cap: selected 20 of 27', 'index-entry-invalid: removed test package'] },
    runs: [{ package: '/repo/.specs/feature', coverage: { state: 'complete' } }] } }] };
  vm.runInContext(`payload=${JSON.stringify(snapshot)};liveAnchor={at:Date.parse(${JSON.stringify(now)}),perf:0};status()`, context);
  assert.equal(elements.get('notice').innerHTML, '');
  assert.equal(elements.get('notice').classList.hidden, true);
  assert.match(elements.get('observer-summary').textContent, /Workspace partial \(7 roots skipped\)/);

  vm.runInContext("error='Could not refresh workspace state.';status()", context);
  assert.match(elements.get('notice').innerHTML, /Could not refresh workspace state/);
  assert.equal(elements.get('notice').classList.hidden, false);
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('partial workspace coverage: delayed workspace file responses cannot cross selections or modes', async () => {
  const deferred = [];
  const context = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/workspace-file?')) return new Promise(resolve => deferred.push(resolve));
    if (url.startsWith('/api/workspace?')) return { ok: true, json: async () => ({ id: 'beta' }) };
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha';workspace={id:'alpha'}", context);
  const alphaOpen = vm.runInContext("openWorkspaceFile('briefs/alpha.md')", context);
  assert.equal(deferred.length, 1);
  vm.runInContext("selectWorkspace('beta')", context);
  await flush();
  deferred[0]({ ok: true, headers: { get: () => 'markdown' }, text: async () => '# Alpha brief' });
  await alphaOpen;
  assert.equal(vm.runInContext('workspace.id', context), 'beta');
  assert.equal(vm.runInContext('fileContent', context), null);
  assert.doesNotMatch(vm.runInContext("$('file-viewer').innerHTML", context), /Alpha brief/);

  const departed = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/workspace-file?')) return new Promise(resolve => deferred.push(resolve));
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha';workspace={id:'alpha'}", departed);
  const departedOpen = vm.runInContext("openWorkspaceFile('briefs/alpha.md')", departed);
  vm.runInContext("mode='packages';selected=null", departed);
  deferred[1]({ ok: true, headers: { get: () => 'markdown' }, text: async () => '# Alpha brief' });
  await departedOpen;
  assert.equal(vm.runInContext('fileContent', departed), null);
  assert.doesNotMatch(vm.runInContext("$('file-viewer').innerHTML", departed), /Alpha brief/);
});

test('partial workspace coverage: listing failures cannot overwrite a different selection', async () => {
  let rejectListing = null;
  const context = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/workspace-files?')) return new Promise((resolve, reject) => { rejectListing = reject; });
    if (url.startsWith('/api/workspace?')) return { ok: true, json: async () => ({ id: 'beta' }) };
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha';workspace={id:'alpha'};listingLoaded=false;listingOwner=null", context);
  const listing = vm.runInContext('loadWorkspaceFiles(0)', context);
  assert.ok(rejectListing);
  vm.runInContext("selectWorkspace('beta')", context);
  await flush();
  vm.runInContext("$('package-files').textContent='Beta listing'", context);
  rejectListing(new Error('listing failed'));
  await listing;
  assert.equal(vm.runInContext("$('package-files').textContent", context), 'Beta listing');

  const packageContext = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/package-files?')) return new Promise((resolve, reject) => { rejectListing = reject; });
    return { ok: false };
  } });
  vm.runInContext("mode='packages';records=[{key:'a',package:'/p/a'}];selected='a';listingLoaded=false;listingOwner=null", packageContext);
  const packageListing = vm.runInContext('loadPackageFiles(records[0],0,true)', packageContext);
  vm.runInContext("records.push({key:'b',package:'/p/b'});selected='b';$('package-files').textContent='Beta package listing'", packageContext);
  rejectListing(new Error('listing failed'));
  await packageListing;
  assert.equal(vm.runInContext("$('package-files').textContent", packageContext), 'Beta package listing');
});

test('partial workspace coverage: storage failures and scan diagnostics differ from healthy empty', () => {
  const context = dashboardContext();
  vm.runInContext("mode='workspaces'", context);
  for (const status of ['invalid_root', 'invalid_projects', 'unreadable']) {
    // listWorkspaces copies storage.errors into catalog.errors, so the same error arrives twice.
    const denied = { path: '/store/<root>/projects', message: '<denied>' };
    context.input = { storage: { status, root: '/store/<root>', errors: [denied] }, valid: [], invalid: [], errors: [denied, { path: '/store/<root>', message: 'scan <failed>' }] };
    vm.runInContext('catalog=input;renderWorkspaceList();renderWorkspaceDetail()', context);
    const list = vm.runInContext("$('run-list').innerHTML", context);
    assert.match(list, /Workspace storage unavailable/);
    assert.match(list, /&lt;root&gt;/);
    assert.equal(list.split('&lt;denied&gt;').length - 1, 1);
    assert.match(list, /<span class="mono">\/store\/&lt;root&gt;\/projects<\/span>/);
    assert.match(list, /scan &lt;failed&gt;/);
    assert.doesNotMatch(list, /&quot;(message|path)&quot;/);
    assert.match(list, /data-workspace-retry/);
    assert.doesNotMatch(list, /No workspaces/);
    assert.match(vm.runInContext("$('observation-detail').innerHTML", context), /Repair the configured storage boundary/);
  }
  context.input = { storage: { status: 'ok', root: '/store', errors: [] }, valid: [{ id: 'alpha', directory: '/store/alpha' }], invalid: [], errors: [{ path: '/store', message: 'scan <failed>' }] };
  vm.runInContext('catalog=input;renderWorkspaceList()', context);
  assert.match(vm.runInContext("$('run-list').innerHTML", context), /Workspace catalog incomplete/);
  assert.match(vm.runInContext("$('run-list').innerHTML", context), /data-workspace="alpha"/);
  vm.runInContext('catalog.valid=[];catalog.errors=[];renderWorkspaceList()', context);
  assert.match(vm.runInContext("$('run-list').innerHTML", context), /No workspaces/);
  assert.doesNotMatch(vm.runInContext("$('run-list').innerHTML", context), /unavailable|incomplete/);
});

test('partial workspace coverage: multiple polling ticks coalesce slow catalog and same-selection detail', async () => {
  let resolveCatalog, resolveDetail, catalogs = 0, details = 0;
  const signals = [];
  const context = dashboardContext({ fetch: (url, options) => {
    signals.push(options.signal);
    if (url === '/api/workspaces') {
      catalogs++;
      return new Promise(resolve => { resolveCatalog = resolve; });
    }
    if (url.startsWith('/api/workspace?')) {
      details++;
      return new Promise(resolve => { resolveDetail = resolve; });
    }
    throw Error('unexpected request');
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha'", context);
  const pending = vm.runInContext('loadWorkspaces()', context);
  for (let tick = 0; tick < 3; tick++) await vm.runInContext('loadWorkspaces()', context);
  assert.equal(catalogs, 1);
  const catalogResponse = { ok: true, json: async () => ({ storage: { status: 'ok' }, valid: [{ id: 'alpha' }], invalid: [] }) };
  resolveCatalog(catalogResponse);
  await pending;
  assert.equal(details, 1);
  for (let tick = 0; tick < 3; tick++) {
    const poll = vm.runInContext('loadWorkspaces()', context);
    resolveCatalog(catalogResponse);
    await poll;
  }
  assert.equal(details, 1);
  resolveDetail({ ok: true, json: async () => ({ id: 'alpha', name: 'Settled slow workspace' }) });
  await flush();
  assert.match(vm.runInContext("$('observation-detail').innerHTML", context), /Settled slow workspace/);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
  vm.runInContext('selectWorkspace(selectedWorkspace)', context);
  assert.equal(details, 2, 'refresh resumes after settlement');
  resolveDetail({ ok: false });
  await flush();
  assert.match(vm.runInContext("$('observation-detail').innerHTML", context), /Could not load workspace/);
});

test('partial workspace coverage: detail failure announces an error and offers a selection retry', async () => {
  let fail = true;
  const context = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/workspace?')) return fail ? { ok: false } : { ok: true, json: async () => ({ id: 'alpha', repositories: [] }) };
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';catalog={storage:{status:'ok'},valid:[{id:'alpha',directory:'/w/alpha'}],invalid:[]}", context);
  vm.runInContext("selectWorkspace('alpha')", context);
  await flush();
  const detail = vm.runInContext("$('observation-detail').innerHTML", context);
  assert.match(detail, /Workspace unavailable/);
  assert.match(detail, /Could not load workspace\./);
  assert.match(detail, /data-workspace-detail-retry/);
  assert.doesNotMatch(detail, /data-workspace-retry/);
  assert.equal(vm.runInContext('workspaceDetailError', context), 'Could not load workspace.');
  fail = false;
  vm.runInContext('selectWorkspace(selectedWorkspace)', context);
  await flush();
  assert.equal(vm.runInContext('workspaceDetailError', context), null);
  assert.equal(vm.runInContext('workspace.id', context), 'alpha');
  assert.doesNotMatch(vm.runInContext("$('observation-detail').innerHTML", context), /Workspace unavailable/);
});

test('partial workspace coverage: fresh catalog invalidation drops the selection without fallback', async () => {
  const context = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/workspaces')) return { ok: true, json: async () => ({ storage: { status: 'ok' }, valid: [{ id: 'beta', directory: '/w/beta' }], invalid: [] }) };
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha';workspace={id:'alpha'};fileContent={kind:'markdown',text:'# Alpha brief'};fileSelection='briefs/alpha.md';fileOwner='workspace:alpha';listingOwner='workspace:alpha';listingLoaded=true", context);
  await vm.runInContext('loadWorkspaces()', context);
  assert.equal(vm.runInContext('workspace', context), null);
  assert.match(vm.runInContext('workspaceUnavailable', context), /no longer in the catalog/);
  assert.equal(vm.runInContext('selectedWorkspace', context), 'alpha');
  assert.equal(vm.runInContext('fileContent', context), null);
  assert.equal(vm.runInContext('listingOwner', context), null);
  const detail = vm.runInContext("$('observation-detail').innerHTML", context);
  assert.match(detail, /Workspace unavailable/);
  assert.doesNotMatch(detail, /Alpha brief/);
  assert.doesNotMatch(vm.runInContext("$('run-list').innerHTML", context), /aria-pressed="true"/);
});

test('partial workspace coverage: catalog invalidation wins over a pending detail response', async () => {
  let resolveDetail = null;
  const context = dashboardContext({ fetch: async url => {
    if (url.startsWith('/api/workspace?')) return new Promise(resolve => { resolveDetail = resolve; });
    if (url.startsWith('/api/workspaces')) return { ok: true, json: async () => ({ storage: { status: 'ok' }, valid: [{ id: 'beta', directory: '/w/beta' }], invalid: [] }) };
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha';workspace=null;catalog={storage:{status:'ok'},valid:[{id:'alpha',directory:'/w/alpha'}],invalid:[]}", context);
  vm.runInContext("selectWorkspace('alpha')", context);
  await flush();
  assert.ok(resolveDetail);
  await vm.runInContext('loadWorkspaces()', context);
  assert.match(vm.runInContext('workspaceUnavailable', context), /no longer in the catalog/);
  resolveDetail({ ok: true, json: async () => ({ id: 'alpha' }) });
  await flush();
  assert.equal(vm.runInContext('workspace', context), null);
  assert.match(vm.runInContext('workspaceUnavailable', context), /no longer in the catalog/);
  assert.match(vm.runInContext("$('observation-detail').innerHTML", context), /Workspace unavailable/);
  assert.doesNotMatch(vm.runInContext("$('observation-detail').innerHTML", context), /Alpha/);
});

test('partial workspace coverage: artifact relationships and operator copy stay explicit and escaped', () => {
  const context = dashboardContext();
  const detail = () => context.document.getElementById('observation-detail');
  const list = () => context.document.getElementById('run-list');
  vm.runInContext("mode='workspaces'", context);

  vm.runInContext("catalog={storage:{root:'/store/w <root>',status:'missing_root',errors:[]},valid:[],invalid:[],errors:[]};workspace=null;selectedWorkspace=null;render()", context);
  assert.match(detail().innerHTML, /<code class="mono">node scripts\/workspaces\/cli\.mjs setup<\/code> on the dashboard host/);
  assert.match(detail().innerHTML, /missing_root/);
  assert.match(detail().innerHTML, /\/store\/w &lt;root&gt;/);
  vm.runInContext("catalog.storage.status='missing_projects';render()", context);
  assert.match(detail().innerHTML, /missing_projects/);
  assert.match(detail().innerHTML, /setup/);

  vm.runInContext("catalog={storage:{root:'/store',status:'ok',errors:[]},valid:[],invalid:[],errors:[]};render()", context);
  assert.match(list().innerHTML, /operator creates/i);
  assert.doesNotMatch(list().innerHTML, /cli\.mjs|workspace CLI/i);

  vm.runInContext("selectedWorkspace='writer';workspace={id:'writer',name:'Writer',directory:'/store/projects/writer',kit:{version:1,id:'writer',name:'Writer',repositories:[]},repositories:[],context:[],briefs:[],notes:[],artifacts:[{title:'<img src=x>',kind:'repository',target:{repository_id:'repo',path:'<b>notes.md</b>'},note:'<script>alert(1)</script>',status:'missing',reason:'missing_target',path:'artifacts/abc.json'}],has_workspace_specs:false,attention:[]};render()", context);
  const html = detail().innerHTML;
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /repo · &lt;b&gt;notes\.md&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /missing_target/);
  assert.match(html, /artifacts\/abc\.json/);
  assert.equal((html.match(/Workspace files/g) || []).length, 0);
  assert.match(context.document.getElementById('package-files').innerHTML, /data-refresh-workspace-files/);
});

test('partial workspace coverage: shared listing and opening owners use explicit source routes', async () => {
  const requested = [];
  const context = dashboardContext({ fetch: async url => {
    requested.push(url);
    if (url.startsWith('/api/workspace-files?')) return { ok: true, json: async () => ({ files: [{ name: 'briefs/alpha.md', available: true, size: 3 }] }) };
    if (url.startsWith('/api/workspace-file?')) return { ok: true, headers: { get: () => 'markdown' }, text: async () => '# Alpha' };
    return { ok: false };
  } });
  vm.runInContext("mode='workspaces';selectedWorkspace='alpha';workspace={id:'alpha'};listingLoaded=false;listingOwner=null", context);
  await vm.runInContext('loadWorkspaceFiles(0)', context);
  await vm.runInContext("openWorkspaceFile('briefs/alpha.md')", context);
  assert.ok(requested.some(url => url.startsWith('/api/workspace-files?') && url.includes('id=alpha')));
  assert.ok(requested.some(url => url.startsWith('/api/workspace-file?') && url.includes('id=alpha') && url.includes('file=briefs%2Falpha.md')));
  assert.ok(!requested.some(url => url.startsWith('/api/package-file')));
  const listingHtml = vm.runInContext("$('package-files').innerHTML", context);
  assert.match(listingHtml, /data-workspace-file/);
  assert.doesNotMatch(listingHtml, /data-more-workspace-files/);

  const packageRequested = [];
  const packageContext = dashboardContext({ fetch: async url => { packageRequested.push(url); return { ok: true, json: async () => ({ files: [] }) }; } });
  vm.runInContext("mode='packages';records=[{key:'k',package:'/p'}];selected='k';listingLoaded=false;listingOwner=null", packageContext);
  await vm.runInContext('loadPackageFiles(records[0],0,true)', packageContext);
  assert.ok(packageRequested.some(url => url.startsWith('/api/package-files?') && url.includes('package=%2Fp')));
});

test('dashboard renders spec position and names without inferring accepted completion', () => {
  const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ document: {}, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  context.run = { execution: 'completed', spec_progress: { total_steps: 10, current_position: 3,
    current_step: 3, current_name: '<Build>', accepted_steps: null } };
  const rendered = vm.runInContext('progress(run,true)', context);
  assert.match(rendered, /Step 3 of 10 · &lt;Build&gt;/);
  assert.match(rendered, /max="10" value="3"/);
  assert.match(rendered, /Accepted completion is not observed/);
  assert.doesNotMatch(rendered, /30%|100%|complete<\/span>/);
  context.run = { spec_progress: { total_steps: 0, current_position: null } };
  assert.match(vm.runInContext('progress(run)', context), /No prepared steps/);
  context.run = { spec_progress: { total_steps: 3, current_position: 7 } };
  assert.match(vm.runInContext('progress(run)', context), /Current step unknown · 3 steps/);
  context.run = {};
  assert.match(vm.runInContext('progress(run)', context), /Spec size unknown/);
});

test('Active filter includes a current completed worker when its workflow still owes work', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ document: {}, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  context.run = { execution: 'completed', workflow_state: 'ready', is_current_assignment: true };
  assert.equal(vm.runInContext('activeRun(run)', context), true);
  assert.equal(vm.runInContext('runState(run)', context), 'Ready for next action');
  context.run.is_current_assignment = false;
  assert.equal(vm.runInContext('activeRun(run)', context), false);
  context.run.is_current_assignment = true;
  context.run.workflow_state = 'complete';
  assert.equal(vm.runInContext('activeRun(run)', context), false);
});

// Run independently: node --test --test-name-pattern='operator completion remains' scripts/spec-observe/dashboard.test.mjs
test('operator completion remains available for an unconfirmed running record with incomplete coverage', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = vm.createContext({ document: {}, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  context.run = { execution: 'running', is_current_assignment: true, completion_revision: null,
    coverage: { state: 'partial', reasons: ['lease-missing', 'checkout-unavailable: removed'] } };
  vm.runInContext("payload={action_token:'local-token'}", context);
  assert.doesNotMatch(vm.runInContext('completionControl(run)', context), /disabled/);
  assert.equal(vm.runInContext('runState(run)', context), 'Running unconfirmed');
  vm.runInContext('imported=true', context);
  assert.match(vm.runInContext('completionControl(run)', context), /disabled/);
});

test('task status renders Markdown while HTML, unsafe links and code remain inert', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', querySelectorAll: () => [] });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  context.text = '## Review status\n\n**Editing** the *worker*.\n- Handle `timeout`\n- Preserve output\n\n1. Inspect\n2. Fix\n\n```js\n<img src=x onerror=alert(1)>\n**literal**\n```\n\n[CI](https://example.test/run?a=1&b=2)\n<script>alert(1)</script>\n[bad](javascript:alert)';
  const html = vm.runInContext('statusMarkdown(text)', context);
  assert.match(html, /class="status-heading">Review status/);
  assert.match(html, /<strong>Editing<\/strong> the <em>worker<\/em>/);
  assert.match(html, /<ul><li>Handle <code>timeout<\/code><\/li><li>Preserve output<\/li><\/ul>/);
  assert.match(html, /<ol><li>Inspect<\/li><li>Fix<\/li><\/ol>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\n\*\*literal\*\*/);
  assert.match(html, /href="https:\/\/example.test\/run\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
  assert.doesNotMatch(vm.runInContext('inlineMarkdown(text,false)', context), /<a /, 'cards contain no nested link inside their button');
  context.run = { key: 'current', package: '/repo/.specs/feature', activity: '**Writing** the fix',
    obligation: 'Review `worker.js`', observer: { snapshot: { coverage: {} } } };
  vm.runInContext('records=[run];selected=run.key;renderDetail()', context);
  assert.match(elements.get('observation-detail').innerHTML, /class="activity status-markdown"><p><strong>Writing<\/strong> the fix/);
  assert.match(elements.get('observation-detail').innerHTML, /class="obligation status-markdown"><p>Review <code>worker.js<\/code>/);
});

test('refresh follows the next assignment for an active spec and preserves historical selection', async () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '', scrollTop: 0,
      querySelectorAll: () => [], setAttribute() {}, removeAttribute() {},
      classList: { toggle() {} } });
    return elements.get(id);
  } };
  const now = new Date().toISOString();
  const run = (id, step, current, execution) => ({ repository: '/repo/.git', package: '/repo/.specs/build',
    assignment_id: id, is_current_assignment: current, execution,
    spec_progress: { total_steps: 3, current_position: step }, coverage: { state: 'complete' } });
  const snapshot = runs => ({ observers: [{ observer_id: 'live', state: 'observing', published_at: now,
    snapshot: { workspace: 'w', coverage: { state: 'complete', observed_at: now }, runs } }] });
  let next = snapshot([run('one', 1, true, 'running')]);
  const context = vm.createContext({ document, Date, Map, Set, JSON, AbortController, setTimeout, clearTimeout,
    location: { protocol: 'http:' }, fetch: async () => ({ ok: true, json: async () => next }) });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  await vm.runInContext('refresh()', context);
  next = snapshot([run('one', 1, true, 'completed')]);
  await vm.runInContext('refresh()', context);
  assert.match(elements.get('observation-detail').innerHTML, /Step 1 of 3/);
  next = snapshot([run('one', 1, false, 'completed'), run('two', 2, true, 'running')]);
  await vm.runInContext('refresh()', context);
  assert.match(elements.get('observation-detail').innerHTML, /Step 2 of 3/);
  assert.match(elements.get('observation-detail').innerHTML, /max="3" value="2"/);
  vm.runInContext("selected=records.find(r=>r.assignment_id==='one').key;renderDetail()", context);
  await vm.runInContext('refresh()', context);
  assert.match(elements.get('observation-detail').innerHTML, /Step 1 of 3/);
});

test('timing shows retries independently and freezes offline or completed observations', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const fixedNow = Date.parse('2026-10-06T13:00:00Z');
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const context = vm.createContext({ document: {}, Date: TestDate, Map, Set, JSON, performance: { now: () => 1000 } });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  context.run = { timing: { started_at: '2026-10-06T10:00:00Z', observed_at: '2026-10-06T12:00:00Z',
    attempts: [
      { step: 1, name: '<Build>', state: 'failed', started_at: '2026-10-06T10:00:00Z', finished_at: '2026-10-06T10:05:00Z' },
      { step: 1, name: '<Build>', state: 'running', started_at: '2026-10-06T10:10:00Z' },
      { step: 2, state: 'completed', started_at: '2026-10-06T10:10:00Z' },
    ] } };
  assert.equal(vm.runInContext('specElapsed(run)', context), '2h 0m 0s');
  const html = vm.runInContext('stepTimings(run)', context);
  assert.match(html, /Attempt 1/);
  assert.match(html, /Attempt 2/);
  assert.match(html, /5m 0s/);
  assert.match(html, /1h 50m 0s elapsed/);
  assert.match(html, /Step 1 · &lt;Build&gt;/);
  assert.match(html, /Unknown/);
  context.run.timing.finished_at = '2026-10-06T11:00:00Z';
  assert.equal(vm.runInContext('specElapsed(run)', context), '1h 0m 0s');
  assert.equal(vm.runInContext("duration('bad','2026-10-06T11:00:00Z')", context), 'Unknown');
  assert.throws(() => vm.runInContext('normalize({runs:[{timing:{attempts:[null]}}]})', context));
  const timestamp = new TestDate().toISOString();
  context.run.timing.finished_at = null;
  context.run.observer = { state: 'observing', published_at: timestamp,
    snapshot: { coverage: { observed_at: timestamp } } };
  vm.runInContext(`liveAnchor={at:${fixedNow},perf:1000}`, context);
  assert.equal(vm.runInContext('specElapsed(run)', context), '3h 0m 0s', 'fresh observation advances to the server-relative current time');
  vm.runInContext('imported=true', context);
  assert.equal(vm.runInContext('specElapsed(run)', context), '2h 0m 0s', 'import freezes the same fresh observation');
});

test('recently completed view separates specs from runs, sorts by completion and drops reopened history on refresh', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '', scrollTop: 0,
      querySelectorAll: () => [], classList: { toggle() {} } });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  const now = new Date().toISOString();
  const completed = [
    { repository: '/a/.git', package: '/a/.specs/older', completed_at: '2026-10-06T12:00:00Z', completion_basis: 'ready-pr' },
    { repository: '/z/.git', package: '/z/.specs/newer', completed_at: '2026-10-07T12:00:00Z', completion_basis: 'workflow-checkpoint' },
  ];
  context.state = { observers: [{ observer_id: 'live', state: 'observing', published_at: now,
    snapshot: { workspace: 'w', coverage: { state: 'complete', observed_at: now },
      runs: [{ repository: '/a/.git', package: '/a/.specs/working', execution: 'running' }], recently_completed: completed } }] };
  vm.runInContext('payload=normalize(state);render()', context);
  assert.equal(vm.runInContext('visibleRecords().length', context), 1);
  vm.runInContext("filter='completed';selected=null;render()", context);
  assert.equal(vm.runInContext('visibleRecords()[0].package', context), '/z/.specs/newer');
  assert.equal(vm.runInContext('visibleRecords().length', context), 2);
  assert.match(elements.get('observation-detail').innerHTML, /Workflow marked complete/);
  assert.equal(vm.runInContext('activeRun(visibleRecords()[0]) || attention(visibleRecords()[0])', context), false);
  elements.get('repo-search').value = 'older';
  assert.equal(vm.runInContext('visibleRecords()[0].package', context), '/a/.specs/older');
  elements.get('repo-search').value = '';
  vm.runInContext('payload.observers[0].snapshot.recently_completed=[];render()', context);
  assert.equal(vm.runInContext('visibleRecords().length', context), 0);
  assert.equal(vm.runInContext('selected', context), null);
  assert.match(elements.get('run-list').innerHTML, /No recently completed specs/);
  vm.runInContext('delete payload.observers[0].snapshot.recently_completed;render()', context);
  assert.match(elements.get('filter-note').textContent, /unavailable/);
  context.bad = { runs: [], recently_completed: [{ completed_at: 'invalid', completion_basis: 'workflow-checkpoint' }] };
  assert.throws(() => vm.runInContext('normalize(bad)', context));
});

// Run independently: node --test --test-name-pattern='Attention includes' scripts/spec-observe/dashboard.test.mjs
test('Attention includes current blocked obligations but excludes superseded incidents and generic coverage gaps',()=>{
 const script=readFileSync(new URL('./dashboard.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 const context=vm.createContext({document:{},Date,Map,Set,JSON});vm.runInContext(script.slice(0,script.indexOf("$('run-list').addEventListener")),context);
 context.run={is_current_assignment:true,execution:'completed',workflow_state:'blocked',conditions:[],incidents:[],coverage:{state:'complete'}};
 assert.equal(vm.runInContext('attention(run)',context),true);
 context.run.is_current_assignment=false;context.run.incidents=[{state:'open'}];assert.equal(vm.runInContext('attention(run)',context),false);
 context.run={is_current_assignment:true,execution:'running',conditions:[{kind:'action-outcome-unknown',state:'unknown',severity:'attention',current:false}],coverage:{state:'partial'}};
 assert.equal(vm.runInContext('attention(run)',context),false);context.run.conditions[0].current=true;assert.equal(vm.runInContext('attention(run)',context),true);
 assert.match(vm.runInContext('statusMarkdown("| Name | State |\\n| --- | --- |\\n| **Build** | ready |")',context),/<table/);
 assert.match(vm.runInContext('statusMarkdown("| Name | State |\\n| --- | --- |\\n| **Build** | ready |")',context),/<strong>Build<\/strong>/);
});

// Run independently: node --test --test-name-pattern='isolates package HTML' scripts/spec-observe/dashboard.test.mjs
test('dashboard isolates package HTML and serves only authorized package-relative resources',async t=>{
 const {realpathSync}=await import('node:fs');const f=fixture(t),repo=realpathSync(f.dir),pkg=join(repo,'.specs','feature');mkdirSync(pkg,{recursive:true});mkdirSync(join(repo,'.git'));mkdirSync(join(pkg,'assets'));
 writeFileSync(join(pkg,'work-tour.html'),'<script src="assets/tour.js"></script>');writeFileSync(join(pkg,'assets','tour.js'),'document.body.textContent="Tour"');writeFileSync(join(pkg,'assets','tour.css'),'body{color:red}');
 const value=envelope('a');value.snapshot.runs=[{package:pkg}];writeFileSync(join(f.observers,'a.json'),JSON.stringify(value));const server=createDashboardServer({agentDir:f.dir});
 const prefix='/package-view/'+Buffer.from(pkg).toString('base64url')+'/';const html=await request(server,prefix+'work-tour.html');
 assert.equal(html.status,200);assert.match(html.headers['Content-Security-Policy'],/sandbox allow-scripts;/);assert.doesNotMatch(html.headers['Content-Security-Policy'],/allow-same-origin/);assert.match(html.headers['Content-Security-Policy'],/connect-src 'none'/);
 assert.equal(html.headers['X-Frame-Options'],'SAMEORIGIN');assert.match((await request(server,prefix+'assets/tour.js')).headers['Content-Type'],/javascript/);assert.match((await request(server,prefix+'assets/tour.css')).headers['Content-Type'],/text\/css/);
 assert.notEqual((await request(server,'/api/package-file?'+new URLSearchParams({package:pkg,file:'../../secret'}))).status,200);
 assert.notEqual((await request(server,'/api/package-files?'+new URLSearchParams({package:repo}))).status,200);
});

// Run independently: node --test --test-name-pattern='remote dashboard' scripts/spec-observe/dashboard.test.mjs
test('remote dashboard default server retains exact local acceptance and rejects public-looking hosts', async t => {
  const f = fixture(t), server = createDashboardServer({ agentDir: f.dir });
  const local = await request(server, '/api/state');
  assert.equal(local.status, 200);
  assert.equal(typeof JSON.parse(local.body).action_token, 'string');
  assert.equal(JSON.parse(local.body).completion, undefined);
  assert.equal((await request(server, '/api/state', { host: 'localhost:4319' })).status, 200);
  assert.equal((await request(server, '/api/state', { host: 'remote.example:4319' })).status, 403);
  assert.equal((await request(server, '/api/state', { host: '127.0.0.1:4318' })).status, 403);
  assert.equal((await request(server, '/api/state', { origin: 'http://127.0.0.1:4319' })).status, 200);
  assert.equal((await request(server, '/api/state', { origin: 'https://dashboard.example' })).status, 403);
  assert.equal(isRemoteRequest({ headers: { host: '127.0.0.1:4319' }, socket: { localPort: 4319 } }), false);
  assert.equal(isRemoteRequest({ headers: { host: 'dashboard.example' }, socket: { localPort: 4319 } }), true);
});

test('remote dashboard accepts exact public host bare or :443 with HTTPS origin and refuses lookalikes and invalid names', async t => {
  const f = fixture(t), server = createDashboardServer({ agentDir: f.dir, publicHost: 'Dashboard.Example.' });
  for (const host of ['dashboard.example', 'DASHBOARD.EXAMPLE:443']) {
    const accepted = await request(server, '/api/state', { host });
    assert.equal(accepted.status, 200, host);
    const body = JSON.parse(accepted.body);
    assert.equal(body.completion, 'local-only', host);
    assert.equal(body.action_token, undefined, host);
  }
  const viaOrigin = await request(server, '/api/state', { origin: 'https://DASHBOARD.EXAMPLE' });
  assert.equal(viaOrigin.status, 200);
  assert.equal(JSON.parse(viaOrigin.body).completion, 'local-only');
  assert.equal((await request(server, '/api/state', { host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' })).status, 200, 'loopback acceptance is preserved');
  assert.equal((await request(server, '/api/state', { origin: 'http://dashboard.example' })).status, 403);
  for (const host of ['dashboard.example:4319', 'dashboard.example:8443', 'dashboard.example.evil.test', 'evil.dashboard.example', 'dashboard.example.', 'other.example']) {
    assert.equal((await request(server, '/api/state', { host })).status, 403, host);
  }
  assert.equal((await request(server, '/api/state', { host: 'dashboard.example', origin: 'https://dashboard.example.evil.test' })).status, 403);
  assert.equal(normalizePublicHost(undefined), undefined);
  assert.equal(normalizePublicHost('Example.COM.'), 'example.com');
  for (const value of ['', '.', 'http://dashboard.example', 'dashboard.example:443', 'dashboard.example/path',
    'a..example', '-bad.example', 'bad-.example', 'bad host', `${'a'.repeat(64)}.example`, `${'a.'.repeat(127)}example`]) {
    assert.throws(() => normalizePublicHost(value), value || 'empty');
    assert.throws(() => createDashboardServer({ agentDir: f.dir, publicHost: value }), value || 'empty');
  }
});

test('remote dashboard treats each forwarding marker including empty values as remote without a token', async t => {
  const f = fixture(t), server = createDashboardServer({ agentDir: f.dir });
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'tailscale-user-login']) {
    for (const value of ['', '203.0.113.9', 'proxy.example']) {
      const response = await request(server, '/api/state', { headers: { [name]: value } });
      assert.equal(response.status, 200, `${name}=${value}`);
      const body = JSON.parse(response.body);
      assert.equal(body.completion, 'local-only', `${name}=${value}`);
      assert.equal(body.action_token, undefined, `${name}=${value}`);
      assert.equal(isRemoteRequest({ headers: { host: '127.0.0.1:4319', [name]: value }, socket: { localPort: 4319 } }), true, name);
    }
  }
  const local = await request(server, '/api/state');
  assert.equal(JSON.parse(local.body).completion, undefined);
  assert.equal(typeof JSON.parse(local.body).action_token, 'string');
});

test('remote dashboard refuses completion before reading the body and leaves no completion file', async t => {
  const f = fixture(t), server = createDashboardServer({ agentDir: f.dir });
  const pkg = join(f.dir, 'repo', '.specs', 'feature');
  mkdirSync(pkg, { recursive: true });
  const payload = JSON.stringify({ package: pkg, revision: 'remote-attempt' });
  const local = await request(server, '/api/state');
  const token = JSON.parse(local.body).action_token;
  const forwarded = await request(server, '/api/package-completion', {
    method: 'POST', body: payload,
    headers: { origin: 'http://127.0.0.1:4319', 'x-sentinel-token': token, 'content-type': 'application/json', 'x-forwarded-for': '' },
  });
  assert.equal(forwarded.status, 403, 'an allowed loopback request carrying a forwarding marker is remote');
  assert.equal(forwarded.bodyRead, false, 'the remote refusal never consumes the body');
  assert.equal(existsSync(join(pkg, COMPLETION_FILE)), false);
  const publicServer = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example' });
  const publicHost = await request(publicServer, '/api/package-completion', {
    host: 'dashboard.example', method: 'POST', body: payload,
    headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
  });
  assert.equal(publicHost.status, 403);
  assert.equal(publicHost.bodyRead, false);
  assert.equal(existsSync(join(pkg, COMPLETION_FILE)), false);
  const localPost = await request(server, '/api/package-completion', {
    method: 'POST', body: payload,
    headers: { origin: 'http://127.0.0.1:4319', 'x-sentinel-token': token, 'content-type': 'application/json' },
  });
  assert.equal(localPost.bodyRead, true, 'the body helper is consumed once the request is local');
  assert.equal(localPost.status, 503, 'the unpublished fixture package is not writable');
  assert.equal(existsSync(join(pkg, COMPLETION_FILE)), false);
});

function inlineScript() {
  return readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
}

// Real inline script with only final Date/performance/fetch/location boundaries replaced.
function dashboardContext({ fetch, wallNow = Date.now, perfNow = () => 0, location = { protocol: 'http:' } } = {}) {
  const elements = new Map();
  const document = { activeElement: null, querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', scrollTop: 0, hidden: false,
      focusCalls: 0, listeners: {},
      focus() { this.focusCalls += 1; document.activeElement = this; },
      addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
      querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, append() {}, insertAdjacentHTML() {},
      classList: { toggle() {} } });
    return elements.get(id);
  } };
  const RealDate = Date;
  class TestDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [wallNow()])); }
    static now() { return wallNow(); }
  }
  const context = vm.createContext({ document, Date: TestDate, Map, Set, JSON, performance: { now: perfNow }, fetch,
    AbortController, AbortSignal, setTimeout, clearTimeout, location, URL, URLSearchParams });
  vm.runInContext(inlineScript().slice(0, inlineScript().indexOf("$('run-list').addEventListener")), context);
  return context;
}

// Run independently: node --test --test-name-pattern='server-relative freshness' scripts/spec-observe/dashboard.test.mjs
test('server-relative freshness anchors on refresh and absorbs ±120s client clock skew', async () => {
  const serverT = Date.parse('2026-10-06T12:00:00Z');
  const generated = new Date(serverT).toISOString();
  const fresh = new Date(serverT - 5000).toISOString();
  const old = new Date(serverT - 90000).toISOString();
  const envelope = { generated_at: generated, errors: [], observers: [{ observer_id: 'live', state: 'observing', published_at: fresh,
    snapshot: { runs: [], coverage: { state: 'complete', observed_at: fresh } } }] };
  for (const skew of [120000, -120000]) {
    const context = dashboardContext({ wallNow: () => serverT + skew, perfNow: () => 1000,
      fetch: async () => ({ ok: true, json: async () => envelope }) });
    await vm.runInContext('refresh()', context);
    assert.equal(vm.runInContext(`stale(${JSON.stringify(fresh)})`, context), false, `5s heartbeat is fresh at ${skew}ms client skew`);
    assert.equal(vm.runInContext(`stale(${JSON.stringify(old)})`, context), true, `90s heartbeat is stale at ${skew}ms client skew`);
    assert.equal(vm.runInContext(`age(${JSON.stringify(fresh)})`, context), '5s ago', `age is measured from the receipt anchor at ${skew}ms skew`);
  }
});

test('server-relative freshness uses the 45s boundary and monotonic elapsed time across wall-clock jumps', () => {
  const serverT = Date.parse('2026-10-06T12:00:00Z');
  let wall = serverT, perf = 1000;
  const context = dashboardContext({ wallNow: () => wall, perfNow: () => perf });
  vm.runInContext(`liveAnchor={at:${serverT},perf:1000}`, context);
  const at = seconds => JSON.stringify(new Date(serverT - seconds * 1000).toISOString());
  assert.equal(vm.runInContext(`stale(${at(45)})`, context), false, 'exactly 45 seconds is fresh');
  assert.equal(vm.runInContext(`age(${at(45)})`, context), '45s ago');
  assert.equal(vm.runInContext(`stale(${at(46)})`, context), true, 'greater than 45 seconds is stale');
  assert.equal(vm.runInContext(`age(${at(30)})`, context), '30s ago');
  wall += 3600000;
  assert.equal(vm.runInContext(`stale(${at(30)})`, context), false, 'a wall-clock jump alone does not age the heartbeat');
  perf += 60000;
  assert.equal(vm.runInContext(`age(${at(30)})`, context), '1m ago', 'monotonic elapsed time advances the label');
  assert.equal(vm.runInContext(`stale(${at(30)})`, context), true, 'elapsed time moves the heartbeat past the threshold');
});

test('server-relative freshness treats missing or invalid generated_at as unknown and keeps imports frozen', async () => {
  const localT = Date.parse('2026-10-06T12:00:00Z');
  const heartbeat = new Date(localT).toISOString();
  const body = generated => ({ generated_at: generated, errors: [], observers: [{ observer_id: 'live', state: 'observing', published_at: heartbeat,
    snapshot: { runs: [], coverage: { state: 'complete', observed_at: heartbeat } } }] });
  let next = body(undefined), perf = 1000;
  const context = dashboardContext({ wallNow: () => localT, perfNow: () => perf, fetch: async () => ({ ok: true, json: async () => next }) });
  await vm.runInContext('refresh()', context);
  assert.equal(vm.runInContext(`stale(${JSON.stringify(heartbeat)})`, context), true, 'missing generated_at never establishes freshness');
  assert.equal(vm.runInContext(`age(${JSON.stringify(heartbeat)})`, context), 'Age unknown');
  vm.runInContext(`liveAnchor={at:${localT},perf:1000}`, context);
  assert.equal(vm.runInContext(`stale(${JSON.stringify(heartbeat)})`, context), false, 'a known server time can be fresh');
  next = body('not-a-date');
  await vm.runInContext('refresh()', context);
  assert.equal(vm.runInContext(`stale(${JSON.stringify(heartbeat)})`, context), true, 'invalid generated_at clears the prior anchor');
  assert.equal(vm.runInContext(`age(${JSON.stringify(heartbeat)})`, context), 'Age unknown');
  vm.runInContext(`liveAnchor={at:${localT},perf:1000}`, context);
  context.run = { observer: { state: 'observing', published_at: heartbeat, snapshot: { coverage: { observed_at: heartbeat } } },
    timing: { observed_at: '2026-10-06T12:00:00Z' } };
  assert.equal(vm.runInContext('timingEnd(run)', context), new Date(localT).toISOString(), 'live timing follows the server anchor');
  vm.runInContext('imported=true;liveAnchor=null', context);
  perf += 60000;
  assert.equal(vm.runInContext('timingEnd(run)', context), '2026-10-06T12:00:00Z', 'imports stay frozen as observed');
  assert.equal(vm.runInContext(`stale(${JSON.stringify(heartbeat)})`, context), true, 'imports never establish live freshness');
});

test('remote completion help explains the host-local-only restriction and keeps imported/disconnected precedence', () => {
  const context = dashboardContext();
  context.run = { is_current_assignment: true };
  const help = () => vm.runInContext('completionControl(run)', context);
  vm.runInContext("payload={completion:'local-only'}", context);
  assert.match(help(), /<button id="mark-complete" disabled/);
  assert.match(help(), /Mark complete is available on the host's local dashboard\./);
  vm.runInContext("payload={action_token:'local-token'}", context);
  assert.doesNotMatch(help(), /disabled/);
  assert.match(help(), /Move this package to Recently completed\./);
  vm.runInContext('imported=true', context);
  assert.match(help(), /Completion is available on the live dashboard\./);
  vm.runInContext("imported=false;error='Could not refresh workspace state.'", context);
  assert.match(help(), /Reconnect to the live dashboard to enable completion\./);
  assert.doesNotMatch(help(), /host's local dashboard/);
  context.run = { is_current_assignment: false };
  assert.equal(help(), '');
});

test('workspace HTTP serves catalog, detail, listing and brief bytes and refuses private, traversal and symlinked reads', async t => {
  const f = fixture(t);
  const base = realpathSync(f.dir);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(workspace, 'kit.yaml'), [
    'version: 1',
    'id: writer',
    'name: Writer',
    'repositories:',
    '  - id: docs',
    `    path: ${JSON.stringify(repo)}`,
    '',
  ].join('\n'));
  const brief = await addMaterial(storageRoot, 'writer', { kind: 'brief', title: 'First Brief', content: '# Brief\n' });
  mkdirSync(join(workspace, '.adjacent'), { recursive: true });
  writeFileSync(join(workspace, '.adjacent', 'inner.txt'), 'private');
  mkdirSync(join(workspace, 'sessions'), { recursive: true });
  writeFileSync(join(workspace, 'sessions', 's1.json'), '{}');
  writeFileSync(join(workspace, '.env.local'), 'SECRET=1');
  writeFileSync(join(base, 'outside.txt'), 'outside');
  symlinkSync(join(base, 'outside.txt'), join(workspace, 'link.txt'));
  const server = createDashboardServer({ agentDir: f.dir, storageRoot });
  const detailPath = `/api/workspace?${new URLSearchParams({ id: 'writer' })}`;
  const listingPath = `/api/workspace-files?${new URLSearchParams({ id: 'writer' })}`;
  const filePath = `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: brief.path })}`;

  // Recursive content/mtime snapshot: reads must leave the storage root unchanged.
  const snapshot = directory => {
    const entries = [];
    const digest = value => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    };
    const walk = (current, prefix) => {
      for (const name of readdirSync(current).sort()) {
        const path = join(current, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const info = lstatSync(path);
        if (info.isDirectory()) {
          entries.push(`${relative}:dir:${info.mtimeMs}`);
          walk(path, relative);
        } else {
          entries.push(`${relative}:file:${info.size}:${info.mtimeMs}:${digest(readFileSync(path).toString('base64'))}`);
        }
      }
    };
    walk(directory, '');
    return entries;
  };
  const before = snapshot(storageRoot);

  const catalog = await request(server, '/api/workspaces');
  assert.equal(catalog.status, 200);
  const catalogBody = JSON.parse(catalog.body);
  assert.equal(catalogBody.storage.status, 'ok');
  assert.ok(catalogBody.valid.some(entry => entry.id === 'writer' && entry.directory === workspace));

  const detail = await request(server, detailPath);
  assert.equal(detail.status, 200);
  const detailBody = JSON.parse(detail.body);
  assert.equal(detailBody.id, 'writer');
  assert.equal(detailBody.directory, workspace);
  assert.ok(detailBody.kit.repositories.some(repository => repository.id === 'docs' && repository.path === repo));
  assert.ok(detailBody.briefs.includes(brief.path.slice('briefs/'.length)));
  assert.equal(detailBody.artifacts.length, 0);

  const listing = await request(server, listingPath);
  assert.equal(listing.status, 200);
  const names = JSON.parse(listing.body).files.map(entry => entry.name);
  assert.ok(names.includes(brief.path));
  assert.ok(!names.some(name => name.startsWith('.adjacent/') || name.startsWith('sessions/') || name === '.env.local'));

  const file = await request(server, filePath);
  assert.equal(file.status, 200);
  assert.equal(file.body, '# Brief\n');

  for (let round = 0; round < 2; round += 1) {
    for (const path of ['/api/workspaces', detailPath, listingPath, filePath]) {
      assert.equal((await request(server, path)).status, 200, path);
      assert.equal((await request(server, path, { method: 'HEAD' })).status, 200, path);
    }
  }

  for (const method of ['POST', 'PUT']) {
    const refused = await request(server, detailPath, { method, body: '{}' });
    assert.equal(refused.status, 405, method);
    assert.equal(refused.bodyRead, false, method);
  }

  for (const candidate of ['../x', 'link.txt', '.adjacent/inner.txt', 'sessions/s1.json', '.env.local']) {
    const denied = await request(server, `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: candidate })}`);
    assert.notEqual(denied.status, 200, candidate);
  }

  assert.deepEqual(snapshot(storageRoot), before);

  for (const body of [catalog.body, detail.body, listing.body, file.body]) {
    assert.doesNotMatch(body, /action_token/);
  }

  // A later-invalidated kit denies the same id: authorization reads the fresh catalog.
  writeFileSync(join(workspace, 'kit.yaml'), 'version: 1\nid: writer\nrepositories: [\n');
  assert.notEqual((await request(server, detailPath)).status, 200);
  assert.notEqual((await request(server, filePath)).status, 200);
});

test('workspace HTTP serves identical bodies to accepted public and forwarded hosts and refuses lookalikes', async t => {
  const f = fixture(t);
  const base = realpathSync(f.dir);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(workspace, 'kit.yaml'), [
    'version: 1',
    'id: writer',
    'name: Writer',
    'repositories:',
    '  - id: docs',
    `    path: ${JSON.stringify(repo)}`,
    '',
  ].join('\n'));
  const brief = await addMaterial(storageRoot, 'writer', { kind: 'brief', title: 'First Brief', content: '# Brief\n' });
  const server = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example', storageRoot });
  const paths = [
    '/api/workspaces',
    `/api/workspace?${new URLSearchParams({ id: 'writer' })}`,
    `/api/workspace-files?${new URLSearchParams({ id: 'writer' })}`,
    `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: brief.path })}`,
  ];
  const loopback = [];
  for (const path of paths) {
    const response = await request(server, path);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(response.body, /action_token/, path);
    loopback.push(response.body);
  }
  const variants = [
    { host: 'dashboard.example' },
    { host: 'dashboard.example:443', origin: 'https://dashboard.example' },
    { headers: { 'x-forwarded-for': '' } },
  ];
  for (const variant of variants) {
    for (const [index, path] of paths.entries()) {
      const response = await request(server, path, variant);
      assert.equal(response.status, 200, path);
      assert.equal(response.body, loopback[index], path);
      assert.doesNotMatch(response.body, /action_token/, path);
    }
  }
  for (const path of paths) {
    for (const host of ['evil-dashboard.example', 'dashboard.example.evil', 'dashboard.example:4319']) {
      assert.equal((await request(server, path, { host })).status, 403, `${host} ${path}`);
    }
    assert.equal((await request(server, path, { origin: 'http://dashboard.example' })).status, 403, path);
  }
  const kitBefore = readFileSync(join(workspace, 'kit.yaml'), 'utf8');
  const briefBefore = readFileSync(join(workspace, brief.path), 'utf8');
  for (const method of ['POST', 'PUT']) {
    for (const variant of [{ host: 'dashboard.example' }, { host: 'dashboard.example:443', origin: 'https://dashboard.example' }, { headers: { 'x-forwarded-for': '' } }]) {
      const refused = await request(server, paths[1], { method, body: '{}', ...variant });
      assert.equal(refused.status, 405, `${method} ${JSON.stringify(variant)}`);
      assert.equal(refused.bodyRead, false, `${method} ${JSON.stringify(variant)}`);
    }
  }
  assert.equal(readFileSync(join(workspace, 'kit.yaml'), 'utf8'), kitBefore);
  assert.equal(readFileSync(join(workspace, brief.path), 'utf8'), briefBefore);
  const plain = createDashboardServer({ agentDir: f.dir, storageRoot });
  assert.equal((await request(plain, '/api/workspaces', { host: 'dashboard.example' })).status, 403);
});

// Run independently: node --test --test-name-pattern='workspace HTTP serves reads over a real listening' scripts/spec-observe/dashboard.test.mjs
test('workspace HTTP serves reads over a real listening port-0 server', async t => {
  const f = fixture(t);
  const base = realpathSync(f.dir);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(workspace, 'kit.yaml'), [
    'version: 1',
    'id: writer',
    'name: Writer',
    'repositories:',
    '  - id: docs',
    `    path: ${JSON.stringify(repo)}`,
    '',
  ].join('\n'));
  const brief = await addMaterial(storageRoot, 'writer', { kind: 'brief', title: 'First Brief', content: '# Brief\n' });
  writeFileSync(join(workspace, '.env.local'), 'SECRET=1');
  const server = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example', storageRoot });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  // node:http (not fetch) so the wire Host header can name the accepted
  // public host while the TCP connection stays loopback.
  const { request: httpRequest } = await import('node:http');
  const httpCall = (path, { host, origin, method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method,
      headers: { ...(host !== undefined ? { host } : {}), ...(origin !== undefined ? { origin } : {}), ...headers } },
      incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
    outgoing.on('error', reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
  const detailPath = `/api/workspace?${new URLSearchParams({ id: 'writer' })}`;
  const listingPath = `/api/workspace-files?${new URLSearchParams({ id: 'writer' })}`;
  const filePath = `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: brief.path })}`;
  const paths = ['/api/workspaces', detailPath, listingPath, filePath];

  const loopback = [];
  for (const path of paths) {
    const response = await httpCall(path);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(response.body, /action_token/, path);
    loopback.push(response.body);
  }
  assert.equal(JSON.parse(loopback[0]).storage.status, 'ok');
  assert.equal(JSON.parse(loopback[1]).id, 'writer');
  assert.equal(loopback[3], '# Brief\n');

  for (const variant of [{ host: 'dashboard.example' }, { host: 'dashboard.example:443', origin: 'https://dashboard.example' }, { headers: { 'x-forwarded-for': '' } }]) {
    for (const [index, path] of paths.entries()) {
      const response = await httpCall(path, variant);
      assert.equal(response.status, 200, `${JSON.stringify(variant)} ${path}`);
      assert.equal(response.body, loopback[index], `${JSON.stringify(variant)} ${path}`);
    }
  }

  for (const path of paths) {
    const head = await httpCall(path, { method: 'HEAD' });
    assert.equal(head.status, 200, `HEAD ${path}`);
    assert.equal(head.body, '', `HEAD ${path}`);
    for (const host of ['evil-dashboard.example', 'dashboard.example.evil', 'dashboard.example:4319']) {
      assert.equal((await httpCall(path, { host })).status, 403, `${host} ${path}`);
    }
    assert.equal((await httpCall(path, { origin: 'http://dashboard.example' })).status, 403, path);
  }
  assert.notEqual((await httpCall(`/api/workspace-file?${new URLSearchParams({ id: 'writer', file: '.env.local' })}`)).status, 200);

  const kitBefore = readFileSync(join(workspace, 'kit.yaml'), 'utf8');
  const briefBefore = readFileSync(join(workspace, brief.path), 'utf8');
  const kitMtime = lstatSync(join(workspace, 'kit.yaml')).mtimeMs;
  const briefMtime = lstatSync(join(workspace, brief.path)).mtimeMs;
  for (const method of ['POST', 'PUT']) {
    for (const variant of [{ host: 'dashboard.example' }, { headers: { 'x-forwarded-for': '' } }]) {
      assert.equal((await httpCall(detailPath, { method, body: '{}', ...variant })).status, 405, `${method} ${JSON.stringify(variant)}`);
    }
  }
  assert.equal(readFileSync(join(workspace, 'kit.yaml'), 'utf8'), kitBefore);
  assert.equal(readFileSync(join(workspace, brief.path), 'utf8'), briefBefore);
  assert.equal(lstatSync(join(workspace, 'kit.yaml')).mtimeMs, kitMtime);
  assert.equal(lstatSync(join(workspace, brief.path)).mtimeMs, briefMtime);
});

// Run independently: node --test --test-name-pattern='private thread records' scripts/spec-observe/dashboard.test.mjs
test('generic workspace reads exclude private thread records while dedicated local routes still serve them', async t => {
  const f = fixture(t);
  const base = realpathSync(f.dir);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const brief = await addMaterial(storageRoot, 'writer', { kind: 'brief', title: 'First Brief', content: '# Brief\n' });
  const note = await addMaterial(storageRoot, 'writer', { kind: 'note', title: 'First Note', content: '# Note\n' });
  const spawnCalls = [];
  const service = createDiscussionService({
    root: storageRoot,
    agentDir: join(base, 'agent'),
    spawn: (...args) => {
      spawnCalls.push(args);
      throw new Error('no discussion child may launch');
    },
  });
  t.after(() => service.close());
  const created = await service.create({ workspace_id: 'writer', title: 'Private thread', target: { kind: 'workspace' } });
  // Seed a durable queued prompt into the record the real service reads. The
  // queue stays paused so the scheduler never dispatches it and no Pi child
  // can start during the regression.
  const threadFile = join(workspace, 'threads', `${created.thread_id}.json`);
  const record = JSON.parse(readFileSync(threadFile, 'utf8'));
  const queuedText = 'durable queued prompt text';
  record.queue = [{ id: randomUUID(), text: queuedText, queued_at: new Date().toISOString(), state: 'queued', attempt: 0 }];
  record.queue_paused = true;
  record.updated_at = new Date().toISOString();
  writeFileSync(threadFile, `${JSON.stringify(record)}\n`);
  const listed = await service.list({ workspace_id: 'writer' });
  assert.ok(listed.threads.some(thread => thread.thread_id === created.thread_id && thread.queue[0]?.text === queuedText), 'the durable queued prompt is readable through the service');

  const server = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example', storageRoot, discussion: service });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const { request: httpRequest } = await import('node:http');
  const httpCall = (path, { host, method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method,
      headers: { ...(host !== undefined ? { host } : {}), ...headers } },
      incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
    outgoing.on('error', reject);
    outgoing.end();
  });
  const listingPath = `/api/workspace-files?${new URLSearchParams({ id: 'writer' })}`;
  const threadPath = `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: `threads/${created.thread_id}.json` })}`;
  const briefPath = `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: brief.path })}`;
  const notePath = `/api/workspace-file?${new URLSearchParams({ id: 'writer', file: note.path })}`;

  for (const variant of [undefined, { host: 'dashboard.example' }, { headers: { 'x-forwarded-for': '' } }]) {
    const label = JSON.stringify(variant);
    const listing = await httpCall(listingPath, variant);
    assert.equal(listing.status, 200, label);
    const names = JSON.parse(listing.body).files.map(entry => entry.name);
    assert.equal(names.some(name => name === `threads/${created.thread_id}.json` || name.startsWith('threads/')), false, `generic listing omits thread records ${label}`);
    for (const method of ['GET', 'HEAD']) {
      const denied = await httpCall(threadPath, { ...(variant ?? {}), method });
      assert.notEqual(denied.status, 200, `generic ${method} cannot read a thread record ${label}`);
      assert.doesNotMatch(denied.body, new RegExp(queuedText), `generic ${method} cannot disclose queued prompt text ${label}`);
    }
    const download = await httpCall(`${threadPath}&download=1`, variant);
    assert.notEqual(download.status, 200, `download query cannot read a thread record ${label}`);
    assert.doesNotMatch(download.body, new RegExp(queuedText), `download query cannot disclose queued prompt text ${label}`);
    assert.equal((await httpCall(briefPath, variant)).body, '# Brief\n', `ordinary brief stays readable ${label}`);
    assert.equal((await httpCall(notePath, variant)).body, '# Note\n', `ordinary note stays readable ${label}`);
  }

  // The dedicated thread routes stay local-only on the same server and remain
  // the one supported path to the durable record.
  const remoteThreads = await httpCall(`/api/threads?${new URLSearchParams({ workspace_id: 'writer' })}`, { host: 'dashboard.example' });
  assert.equal(remoteThreads.status, 403, 'a configured public host cannot read threads');
  const forwardedThreads = await httpCall(`/api/threads?${new URLSearchParams({ workspace_id: 'writer' })}`, { headers: { 'x-forwarded-for': '' } });
  assert.equal(forwardedThreads.status, 403, 'a forwarded remote request cannot read threads');
  const localThreads = await httpCall(`/api/threads?${new URLSearchParams({ workspace_id: 'writer' })}`);
  assert.equal(localThreads.status, 200);
  assert.ok(JSON.parse(localThreads.body).threads.some(thread => thread.thread_id === created.thread_id && thread.queue[0]?.text === queuedText), 'a loopback caller still reads the durable record');
  assert.deepEqual(spawnCalls, [], 'no Pi child was started');
});

// Run independently: node --test --test-name-pattern='partial workspace coverage' scripts/spec-observe/dashboard.test.mjs
test('partial workspace coverage: catalog states render through the split-pane owners', async () => {
  const validCatalog = { storage: { root: '/store', status: 'ok', errors: [] },
    valid: [{ id: 'writer', name: 'Writer', directory: '/store/projects/writer',
      kit: { version: 1, id: 'writer', name: 'Writer', repositories: [] }, attention: [] }], invalid: [], errors: [] };
  const context = dashboardContext({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const list = () => context.document.getElementById('run-list');
  const detail = () => context.document.getElementById('observation-detail');
  vm.runInContext("mode='workspaces'", context);

  // Loading with no catalog yet is announced in the list region.
  vm.runInContext('catalog=null;workspace=null;workspaceError=null;selectedWorkspace=null;render()', context);
  assert.match(list().innerHTML, /Loading workspaces/);

  // Missing storage reports the status and shows the setup command as text.
  vm.runInContext("catalog={storage:{root:'/store',status:'missing_root',errors:[]},valid:[],invalid:[],errors:[{path:'/store',message:'missing_root'}]};render()", context);
  assert.match(detail().innerHTML, /missing_root/);
  assert.match(detail().innerHTML, /setup/);
  // The status placeholder error is not repeated beside the status line.
  assert.equal(list().innerHTML.split('missing_root').length - 1, 1);
  vm.runInContext("catalog.storage.status='missing_projects';render()", context);
  assert.match(detail().innerHTML, /missing_projects/);

  // An empty catalog differs from an invalid one.
  vm.runInContext("catalog={storage:{root:'/store',status:'ok',errors:[]},valid:[],invalid:[],errors:[]};render()", context);
  assert.match(list().innerHTML, /No workspaces/i);
  vm.runInContext("catalog.invalid=[{directory:'/store/projects/broken',errors:['kit.yaml: invalid']}];render()", context);
  assert.match(list().innerHTML, /broken/);
  assert.match(list().innerHTML, /kit\.yaml: invalid/);

  // A partial workspace keeps association statuses visible; the ideal case is clean.
  vm.runInContext(`catalog=${JSON.stringify(validCatalog)};selectedWorkspace='writer';workspace={id:'writer',name:'Writer',directory:'/store/projects/writer',kit:{version:1,id:'writer',name:'Writer',repositories:[]},repositories:[{id:'docs',path:'/repo',status:'missing',attention:['unreadable']}],context:[{path:'context/notes.md',status:'outside_root'}],briefs:['2026-10-10-brief.md'],notes:[],artifacts:[{path:'artifacts/a.json',status:'unreadable'}],has_workspace_specs:false,attention:['directory_mismatch']};render()`, context);
  assert.match(detail().innerHTML, /missing/);
  assert.match(detail().innerHTML, /outside_root/);
  assert.match(detail().innerHTML, /unreadable/);
  assert.match(detail().innerHTML, /directory_mismatch/);
  assert.match(detail().innerHTML, /2026-10-10-brief\.md/);
  assert.match(detail().innerHTML, />1 file</);
  assert.match(detail().innerHTML, />0 files</);
  assert.match(detail().innerHTML, />1 record</);
  assert.doesNotMatch(detail().innerHTML, /mark-complete/);
  vm.runInContext("workspace={id:'writer',name:'Writer',directory:'/store/projects/writer',kit:{version:1,id:'writer',name:'Writer',repositories:[]},repositories:[{id:'docs',path:'/repo',status:'ok',attention:[]}],context:[{path:'context/notes.md',status:'ok'}],briefs:[],notes:[],artifacts:[],has_workspace_specs:false,attention:[]};render()", context);
  assert.match(detail().innerHTML, /ok/);
  assert.doesNotMatch(detail().innerHTML, /outside_root|unreadable|directory_mismatch/);

  // A refresh keeps existing rows visible and announces loading in the small note region.
  let release;
  const refreshing = dashboardContext({ fetch: () => new Promise(resolve => { release = resolve; }) });
  vm.runInContext(`mode='workspaces';catalog=${JSON.stringify(validCatalog)};selectedWorkspace='writer';render()`, refreshing);
  const rows = refreshing.document.getElementById('run-list').innerHTML;
  vm.runInContext('loadWorkspaces()', refreshing);
  assert.equal(refreshing.document.getElementById('run-list').innerHTML, rows);
  assert.match(refreshing.document.getElementById('filter-note').textContent, /Loading|Refreshing/);
  release({ ok: true, json: async () => validCatalog });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(refreshing.document.getElementById('run-list').innerHTML, /data-workspace="writer"/);
});

test('partial workspace coverage: stale workspace responses are discarded after selection and mode changes', async () => {
  const pending = new Map(), calls = [];
  const context = dashboardContext({ fetch: url => { const call = String(url); calls.push(call); return new Promise(resolve => pending.set(call, resolve)); } });
  const detail = () => context.document.getElementById('observation-detail');
  const catalog = { storage: { root: '/store', status: 'ok', errors: [] },
    valid: [{ id: 'alpha', name: 'Alpha', directory: '/store/projects/alpha',
      kit: { version: 1, id: 'alpha', name: 'Alpha', repositories: [] }, attention: [] },
    { id: 'beta', name: 'Beta', directory: '/store/projects/beta',
      kit: { version: 1, id: 'beta', name: 'Beta', repositories: [] }, attention: [] }], invalid: [], errors: [] };
  const workspaceDetail = (id, name) => ({ id, name, directory: `/store/projects/${id}`,
    kit: { version: 1, id, name, repositories: [] }, repositories: [], context: [], briefs: [], notes: [], artifacts: [],
    has_workspace_specs: false, attention: [] });
  vm.runInContext(`mode='workspaces';catalog=${JSON.stringify(catalog)};selectedWorkspace=null;workspace=null;render()`, context);

  vm.runInContext("selectWorkspace('alpha');selectWorkspace('beta')", context);
  const alphaCall = calls.find(url => url.includes('id=alpha'));
  const betaCall = calls.find(url => url.includes('id=beta'));
  assert.ok(alphaCall && betaCall, 'both selections request workspace detail');
  pending.get(betaCall)({ ok: true, json: async () => workspaceDetail('beta', 'Beta') });
  await new Promise(resolve => setImmediate(resolve));
  pending.get(alphaCall)({ ok: true, json: async () => workspaceDetail('alpha', 'Alpha') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('selectedWorkspace', context), 'beta');
  assert.match(detail().innerHTML, /Beta/);
  assert.doesNotMatch(detail().innerHTML, /Alpha/);

  // Leaving workspace mode discards a still-pending workspace response.
  vm.runInContext("selectWorkspace('alpha')", context);
  const lateCall = calls.filter(url => url.includes('id=alpha')).pop();
  vm.runInContext("mode='packages';render()", context);
  pending.get(lateCall)({ ok: true, json: async () => workspaceDetail('alpha', 'Alpha') });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(detail().innerHTML, /Alpha/);
});

test('partial workspace coverage: keyboard selection, retry, escaping and package completion stay safe', async () => {
  const fetched = [];
  const context = dashboardContext({ fetch: async url => {
    fetched.push(String(url));
    return { ok: true, headers: { get: () => 'text' }, text: async () => 'body', json: async () => ({}) };
  } });
  const list = () => context.document.getElementById('run-list');
  const detail = () => context.document.getElementById('observation-detail');
  const workspace = { id: 'writer', name: '<img src=x onerror=alert(1)>', directory: '/store/projects/writer',
    kit: { version: 1, id: '<i>', name: '<b>', repositories: [] }, repositories: [], context: [],
    briefs: ['<script>alert(1)</script>.md'], notes: [], artifacts: [], has_workspace_specs: false, attention: [] };
  const catalog = { storage: { root: '/store', status: 'ok', errors: [] },
    valid: [{ id: 'writer', name: workspace.name, directory: workspace.directory, kit: workspace.kit, attention: [] }],
    invalid: [], errors: [] };
  vm.runInContext(`mode='workspaces';catalog=${JSON.stringify(catalog)};selectedWorkspace='writer';workspace=${JSON.stringify(workspace)};render()`, context);

  // Workspace rows are keyboard buttons and announce selection and count.
  assert.match(list().innerHTML, /data-workspace="writer"/);
  assert.match(list().innerHTML, /aria-pressed="true"/);
  assert.match(vm.runInContext("$('run-count').textContent", context), /workspace/i);
  assert.doesNotMatch(detail().innerHTML, /mark-complete/);

  // Every kit and file value is escaped before HTML.
  assert.match(list().innerHTML, /&lt;img/);
  assert.doesNotMatch(list().innerHTML, /<img/);
  assert.match(detail().innerHTML, /&lt;script/);
  assert.doesNotMatch(detail().innerHTML, /<script/i);

  // Retry announces the request failure with a keyboard control.
  vm.runInContext("workspaceError='Could not load workspaces.';render()", context);
  assert.match(list().innerHTML, /data-workspace-retry/);
  assert.match(list().innerHTML, /Retry/);

  // Brief preview uses the workspace file route, never the package route.
  vm.runInContext("workspaceError=null;render();openWorkspaceFile('briefs/2026-10-10-brief.md')", context);
  await new Promise(resolve => setImmediate(resolve));
  const fileCall = fetched.find(url => url.includes('/api/workspace-file') && url.includes('file='));
  assert.ok(fileCall, 'workspace file preview uses /api/workspace-file');
  assert.match(fileCall, /id=writer/);
  assert.match(fileCall, /file=briefs%2F2026-10-10-brief\.md/);
  assert.equal(fetched.some(url => url.includes('/api/package-file')), false);

  // Returning to packages keeps completion semantics for packages only.
  vm.runInContext("mode='packages';payload={action_token:'local-token'};liveAnchor={at:Date.parse('2026-10-10T00:00:00Z'),perf:0};render()", context);
  assert.match(vm.runInContext('completionControl({is_current_assignment:true})', context), /id="mark-complete"/);
});

// ---- Threads UI (step 9): browsing, transcript, composer and stale-response guards ----
const threadId = '11111111-1111-4111-8111-111111111111';
const otherThreadId = '22222222-2222-4222-8222-222222222222';
const threadAt = '2026-10-10T00:00:00.000Z';
function threadRecord(over = {}) {
  return { thread_id: threadId, workspace_id: 'alpha', title: 'Thread one', queue: [], queue_paused: false,
    history_only: false, attention: null, state: 'idle', generation: 1, updated_at: threadAt, ...over };
}
function threadEntry(id, role, text) {
  return { id, type: 'message', timestamp: threadAt, message: { role, content: [{ type: 'text', text }] } };
}
// Direct payload assignment always carries the adj2 server-relative anchor and
// the performance boundary, matching the production freshness contract.
function setThreadContext(context, selected = threadId) {
  vm.runInContext(`mode='workspaces';selectedWorkspace='alpha';workspace={id:'alpha'};error=null;payload={action_token:'local-token'};liveAnchor={at:Date.parse('2026-10-10T00:00:00Z'),perf:performance.now()};selectedThread=${JSON.stringify(selected)}`, context);
}
const threadsBody = context => context.document.getElementById('threads-body').innerHTML;
const buttonTag = (html, id) => html.match(new RegExp(`<button id="${id}"[^>]*>`))?.[0] ?? '';

test('threads UI renders loading, empty, waiting, streaming and interrupted states with controls', () => {
  const context = dashboardContext();
  setThreadContext(context);

  vm.runInContext('threads=null;renderThreads()', context);
  assert.match(threadsBody(context), /Loading threads/);

  vm.runInContext('threads=[];selectedThread=null;renderThreads()', context);
  assert.match(threadsBody(context), /No discussion threads in this workspace yet/);

  const waiting = threadRecord({ queue: [{ id: 'message-1', state: 'queued', text: 'waiting text', queued_at: threadAt, queue_position: 2 }] });
  vm.runInContext(`threads=${JSON.stringify([waiting])};selectedThread=${JSON.stringify(threadId)};threadPartial='';renderThreads()`, context);
  assert.match(threadsBody(context), /Queued/);
  assert.match(threadsBody(context), /queue position 2/);
  assert.match(threadsBody(context), /waiting text/);
  assert.match(threadsBody(context), /id="thread-draft"/);
  assert.match(threadsBody(context), /id="thread-send"/);

  const streaming = threadRecord({ state: 'active' });
  vm.runInContext(`threads=${JSON.stringify([streaming])};threadPartial='partial answer';renderThreads()`, context);
  assert.match(threadsBody(context), /Responding/);
  assert.match(threadsBody(context), /A response is being delivered/);
  assert.match(threadsBody(context), /role="status"/);
  assert.match(threadsBody(context), /partial answer/);
  assert.match(threadsBody(context), /id="thread-stop"/);
  assert.doesNotMatch(threadsBody(context), /id="thread-resume"/);

  // Interrupted delivery is Stop's paused queue: it explains and offers Resume.
  const interrupted = threadRecord({ state: 'paused', queue_paused: true, queue: [{ id: 'message-2', state: 'queued', text: 'after resume', queued_at: threadAt, queue_position: 1 }] });
  vm.runInContext(`threads=${JSON.stringify([interrupted])};threadPartial='';renderThreads()`, context);
  assert.match(threadsBody(context), /Queue paused/);
  assert.match(threadsBody(context), /Pending messages wait until Resume/);
  assert.match(threadsBody(context), /id="thread-resume"/);
  assert.doesNotMatch(threadsBody(context), /id="thread-stop"/);
});

test('threads UI explains attention states and keeps recovery controls', () => {
  const context = dashboardContext();
  setThreadContext(context);
  const cases = [
    ['stalled', /Stalled/, /No child events for ten minutes/, /data-thread-refresh/],
    ['uncertain', /Delivery uncertain/, /may or may not have been delivered/, /data-thread-discard/],
    ['start-failed', /Start failed/, /failed before startup completed/, /data-thread-refresh/],
    ['session-mismatch', /Session mismatch/, /does not match this thread record/, /data-thread-refresh/],
    ['missing-directory', /Execution directory missing/, /execution directory is gone/, /data-thread-refresh/],
    ['live-owner', /Owner not confirmed dead/, /fails closed/, /data-thread-refresh/],
    ['missing-context', /Context missing/, /missing or unreadable/, /data-thread-refresh/],
  ];
  for (const [state, label, explanation, control] of cases) {
    const queue = state === 'uncertain' ? [{ id: 'uncertain-1', state: 'uncertain', text: 'maybe sent', queued_at: threadAt }] : [];
    const record = threadRecord({ state, attention: state, queue });
    vm.runInContext(`threads=${JSON.stringify([record])};selectedThread=${JSON.stringify(threadId)};threadRequestError=null;renderThreads()`, context);
    assert.match(threadsBody(context), label, state);
    assert.match(threadsBody(context), explanation, state);
    assert.match(threadsBody(context), /role="status"/, state);
    assert.match(threadsBody(context), control, state);
  }
  const historyOnly = threadRecord({ history_only: true, state: 'history-only' });
  vm.runInContext(`threads=${JSON.stringify([historyOnly])};renderThreads()`, context);
  assert.match(threadsBody(context), /History only/);
  assert.match(threadsBody(context), /sending and resuming are unavailable/);
  assert.doesNotMatch(threadsBody(context), /id="thread-draft"/);
  assert.doesNotMatch(threadsBody(context), /id="thread-resume"/);
});

test('threads UI storage-missing and request-error expose retry plus the polite live region', () => {
  const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /id="thread-announcer"[^>]*role="status"[^>]*aria-live="polite"/);
  const context = dashboardContext();
  setThreadContext(context);

  vm.runInContext("threads=null;threadsError='Discussion service unavailable on this host.';catalog={storage:{status:'missing_root'}};renderThreads()", context);
  assert.match(threadsBody(context), /Workspace thread storage is unavailable/);
  assert.match(threadsBody(context), /missing_root/);
  assert.match(threadsBody(context), /cli\.mjs setup/);
  assert.match(threadsBody(context), /data-thread-retry="list"/);

  vm.runInContext(`threadsError=null;threads=${JSON.stringify([threadRecord()])};selectedThread=${JSON.stringify(threadId)};threadRequestError='The transcript could not be loaded.';renderThreads()`, context);
  assert.match(threadsBody(context), /The transcript could not be loaded/);
  assert.match(threadsBody(context), /id="thread-error-retry"/);
  assert.match(threadsBody(context), /role="alert"/);

  vm.runInContext("announceThread('Thread notice: delivery uncertain')", context);
  assert.equal(context.document.getElementById('thread-announcer').textContent, 'Thread notice: delivery uncertain');
});

test('threads UI failed send keeps the draft, reuses its retry id and restores composer focus', async () => {
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    if (String(url).startsWith('/api/thread/send')) { posts.push(JSON.parse(init.body)); return { ok: false, status: 503, json: async () => ({ error: 'Discussion service unavailable.' }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord({ state: 'active' })])};threadDraft='please keep this draft'`, context);
  await vm.runInContext('sendThreadMessage()', context);
  assert.equal(vm.runInContext('threadDraft', context), 'please keep this draft');
  assert.match(context.document.getElementById('thread-head-box').innerHTML, /Discussion service unavailable/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'please keep this draft');
  assert.match(posts[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(vm.runInContext('threadSendId', context), posts[0].id);
  const composer = context.document.getElementById('thread-draft');
  assert.ok(composer.focusCalls >= 1, 'failed send restores focus to the composer');
  assert.equal(context.document.activeElement, composer);
  await vm.runInContext('sendThreadMessage()', context);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].id, posts[0].id, 'retry keeps the client message id for dedupe');
});

test('threads UI announces send, stop, resume and discard through the polite live region', async () => {
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path !== '/api/thread/history' && path !== '/api/threads' && path !== '/api/state') {
      posts.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord({ state: 'active' })], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    if (path === '/api/thread/send') return { ok: true, json: async () => ({ thread: threadRecord(), message_id: 'message-1', state: 'queued', duplicate: false }) };
    if (path === '/api/thread/stop') return { ok: true, json: async () => ({ thread: threadRecord({ state: 'paused', queue_paused: true }) }) };
    if (path === '/api/thread/resume') return { ok: true, json: async () => ({ thread: threadRecord() }) };
    if (path === '/api/thread/discard') return { ok: true, json: async () => ({ thread: threadRecord(), message_id: 'uncertain-1', state: 'discarded', duplicate: false }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  const announcer = context.document.getElementById('thread-announcer');

  vm.runInContext(`threads=${JSON.stringify([threadRecord({ state: 'active' })])};threadDraft='hello'`, context);
  await vm.runInContext('sendThreadMessage()', context);
  assert.equal(announcer.textContent, 'Message queued.');
  assert.equal(vm.runInContext('threadDraft', context), '');
  await vm.runInContext('stopSelectedThread()', context);
  assert.equal(announcer.textContent, 'Stop requested. The thread queue is paused.');
  await vm.runInContext('resumeSelectedThread()', context);
  assert.equal(announcer.textContent, 'Thread resumed.');
  vm.runInContext("threads=[Object.assign({},threads[0],{attention:'uncertain',state:'uncertain',queue:[{id:'uncertain-1',state:'uncertain',text:'maybe',queued_at:'2026-10-10T00:00:00.000Z'}]})];renderThreads()", context);
  await vm.runInContext("discardThreadMessage('uncertain-1',false)", context);
  assert.equal(announcer.textContent, 'Uncertain message discarded.');

  const mutations = posts.filter(call => call.method === 'POST');
  assert.equal(mutations.length, 4);
  for (const call of mutations) {
    assert.equal(call.headers['X-Sentinel-Token'], 'local-token');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.body.workspace_id, 'alpha');
    assert.equal(call.body.thread_id, threadId);
  }
});

test('threads UI sends on Enter and preserves the newline on Shift+Enter', async () => {
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/send') { posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ thread: threadRecord(), message_id: 'message-1', state: 'queued', duplicate: false }) }; }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord({ state: 'active' })], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 503, json: async () => ({}) };
  } });
  context.setInterval = () => 0;
  context.clearInterval = () => {};
  context.EventSource = class { constructor(url) { this.url = String(url); } addEventListener() {} close() {} };
  vm.runInContext(inlineScript().slice(inlineScript().indexOf("$('run-list').addEventListener")), context);
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord({ state: 'active' })])};threadDraft='send with enter';renderThreads()`, context);

  const keydown = context.document.getElementById('run-detail').listeners.keydown[0];
  assert.equal(typeof keydown, 'function');
  let prevented = false;
  keydown({ target: { id: 'thread-draft' }, key: 'Enter', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Enter submits the composer');
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'send with enter');
  let preventCalls = 0;
  keydown({ target: { id: 'thread-draft' }, key: 'Enter', shiftKey: true, preventDefault() { preventCalls += 1; } });
  await flush();
  assert.equal(preventCalls, 0, 'Shift+Enter keeps the textarea newline behavior');
  assert.equal(posts.length, 1, 'Shift+Enter does not send');
});

test('threads UI disables only the affected control while an action is pending', () => {
  const context = dashboardContext();
  setThreadContext(context);
  const render = (record, pending) => {
    vm.runInContext(`threads=${JSON.stringify([record])};selectedThread=${JSON.stringify(threadId)};threadDraft='draft text';threadPending=${pending};threadRequestError=null;renderThreads()`, context);
    return threadsBody(context);
  };

  const active = threadRecord({ state: 'active' });
  let html = render(active, 'null');
  assert.doesNotMatch(buttonTag(html, 'thread-send'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'thread-stop'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'thread-refresh'), /disabled/);

  html = render(active, "'send'");
  assert.match(buttonTag(html, 'thread-send'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'thread-stop'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'thread-refresh'), /disabled/);

  html = render(active, "'stop'");
  assert.match(buttonTag(html, 'thread-stop'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'thread-send'), /disabled/);

  html = render(threadRecord({ state: 'paused', queue_paused: true }), "'resume'");
  assert.match(buttonTag(html, 'thread-resume'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'thread-send'), /disabled/);

  const uncertain = threadRecord({ attention: 'uncertain', state: 'uncertain', queue: [{ id: 'uncertain-1', state: 'uncertain', text: 'maybe', queued_at: threadAt }] });
  html = render(uncertain, "'discard'");
  assert.match(html, /<button data-thread-discard="uncertain-1" disabled>/);
  assert.doesNotMatch(buttonTag(html, 'thread-refresh'), /disabled/);
});

test('threads UI discards a delayed list response after a newer workspace selection', async () => {
  const pending = new Map();
  const context = dashboardContext({ fetch: url => new Promise(resolve => pending.set(String(url), resolve)) });
  setThreadContext(context);
  const alpha = threadRecord({ title: 'Alpha thread' });
  const beta = threadRecord({ thread_id: otherThreadId, title: 'Beta thread' });

  const first = vm.runInContext('loadThreads()', context);
  const alphaCall = [...pending.keys()].find(url => url.includes('workspace_id=alpha'));
  assert.ok(alphaCall, 'alpha list request is in flight');
  vm.runInContext("selectedWorkspace='beta'", context);
  const second = vm.runInContext('loadThreads()', context);
  const betaCall = [...pending.keys()].find(url => url.includes('workspace_id=beta'));
  assert.ok(betaCall, 'beta list request is in flight');

  pending.get(betaCall)({ ok: true, json: async () => ({ threads: [beta], invalid: [] }) });
  await second;
  await flush();
  pending.get(alphaCall)({ ok: true, json: async () => ({ threads: [alpha], invalid: [] }) });
  await first;
  assert.equal(vm.runInContext('threads.length', context), 1);
  assert.equal(vm.runInContext('threads[0].thread_id', context), otherThreadId);
  assert.match(threadsBody(context), /Beta thread/);
  assert.doesNotMatch(threadsBody(context), /Alpha thread/);
});

test('threads UI delayed history and SSE frames cannot cross a selected-thread change', async () => {
  const sources = [];
  const pending = new Map();
  const context = dashboardContext({ fetch: url => new Promise(resolve => pending.set(String(url), resolve)) });
  context.EventSource = class { constructor(url) { this.url = String(url); this.handlers = {}; sources.push(this); }
    addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
    emit(type, data) { for (const handler of this.handlers[type] ?? []) handler({ data: JSON.stringify(data) }); }
    close() { this.closed = true; } };
  context.EventSource.CLOSED = 2;
  setThreadContext(context, null);
  const alpha = threadRecord({ title: 'Alpha thread' });
  const beta = threadRecord({ thread_id: otherThreadId, title: 'Beta thread' });
  vm.runInContext(`threads=${JSON.stringify([alpha, beta])};renderThreads()`, context);

  vm.runInContext(`selectThread(${JSON.stringify(threadId)})`, context);
  const alphaHistory = [...pending.keys()].find(url => url.includes('/api/thread/history') && url.includes(threadId));
  assert.ok(alphaHistory, 'alpha history request is in flight');
  vm.runInContext(`selectThread(${JSON.stringify(otherThreadId)})`, context);
  const betaHistory = [...pending.keys()].find(url => url.includes('/api/thread/history') && url.includes(otherThreadId));
  assert.ok(betaHistory, 'beta history request is in flight');
  const transcript = () => context.document.getElementById('thread-transcript-box').innerHTML;

  pending.get(betaHistory)({ ok: true, json: async () => ({ header: null, entries: [threadEntry('entry-b', 'assistant', 'beta response')], leaf_id: 'entry-b', incomplete_tail: false, skipped_lines: 0, truncated: false }) });
  await flush();
  pending.get(alphaHistory)({ ok: true, json: async () => ({ header: null, entries: [threadEntry('entry-a', 'assistant', 'alpha response')], leaf_id: 'entry-a', incomplete_tail: false, skipped_lines: 0, truncated: false }) });
  await flush();
  assert.match(transcript(), /beta response/);
  assert.doesNotMatch(transcript(), /alpha response/);
  assert.equal(vm.runInContext('threadHistoryEntries.map(entry => entry.id).join(",")', context), 'entry-b');

  const staleSource = sources.find(source => source.url.includes(threadId));
  const liveSource = sources.find(source => source.url.includes(otherThreadId));
  assert.ok(staleSource && liveSource, 'one stream per selected thread');
  staleSource.emit('delta', { thread_id: threadId, generation: 1, type: 'delta', event: { type: 'message_update', delta: 'stale text' } });
  assert.doesNotMatch(transcript(), /stale text/);
  assert.equal(vm.runInContext('threadPartial', context), '');
  liveSource.emit('delta', { thread_id: otherThreadId, generation: 2, type: 'delta', event: { type: 'message_update', delta: 'live text' } });
  assert.match(transcript(), /live text/);
  liveSource.emit('settled', { thread_id: otherThreadId, generation: 2, type: 'settled', event: { type: 'agent_settled' } });
  assert.equal(context.document.getElementById('thread-announcer').textContent, 'Response settled; the next waiting message can deliver.');
});

test('threads UI escapes hostile titles and content and renders safe markdown only', () => {
  const context = dashboardContext();
  setThreadContext(context);
  const hostile = threadRecord({ title: 'Thread <img src=x onerror=alert(1)>', queue: [{ id: 'message-1', state: 'queued', text: '<script>alert(1)</script>', queued_at: threadAt }] });
  const entries = [threadEntry('entry-user', 'user', '<script>alert(2)</script>'), threadEntry('entry-assistant', 'assistant', '**bold** plan with <img src=x> and [link](javascript:alert(3))')];
  vm.runInContext(`threads=${JSON.stringify([hostile])};selectedThread=${JSON.stringify(threadId)};threadHistoryEntries=${JSON.stringify(entries)};threadHasOlder=false;renderThreads()`, context);
  const body = threadsBody(context);
  assert.doesNotMatch(body, /<img\b/);
  assert.doesNotMatch(body, /<script/i);
  assert.doesNotMatch(body, /javascript:alert/);
  assert.match(body, /&lt;img/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /<strong>bold<\/strong>/);
  assert.match(body, /link/);
  assert.ok(vm.runInContext('Number.isFinite(liveAnchor.at)', context), 'direct payload assignment keeps the server-relative anchor');
});

// ---- Threads UI (step 10): brief editor, assignment preview/launch and explicit result dispatch ----
test('threads UI handoff controls stay hidden without the local dashboard', () => {
  const context = dashboardContext();
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};imported=true;renderThreads()`, context);
  assert.doesNotMatch(threadsBody(context), /id="thread-brief-save"/);
  vm.runInContext('imported=false;payload={};renderThreads()', context);
  const html = threadsBody(context);
  assert.doesNotMatch(html, /id="thread-brief-save"/);
  assert.doesNotMatch(html, /id="thread-assignment-launch"/);
  assert.match(html, /available on the host/);
});

test('threads UI save brief keeps both fields, disables only save and reuses the retry request id', async () => {
  const posts = [];
  let release;
  let saveCalls = 0;
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/save-brief') {
      posts.push(JSON.parse(init.body));
      saveCalls += 1;
      if (saveCalls === 1) return new Promise(resolve => { release = resolve; });
      if (saveCalls === 2) return { ok: false, status: 503, json: async () => ({ error: 'Discussion service unavailable.' }) };
      return { ok: true, json: async () => ({ thread: threadRecord(), brief: '/storage/briefs/brief.md', handoff: { request_id: JSON.parse(init.body).request_id }, duplicate: false }) };
    }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefTitle='Keep the brief';threadBriefContent='Keep the content';renderThreads()`, context);
  const pending = vm.runInContext('saveThreadBrief()', context);
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Keep the brief');
  assert.equal(posts[0].content, 'Keep the content');
  assert.match(posts[0].request_id, /^[0-9a-f-]{36}$/);
  const pendingHtml = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(buttonTag(pendingHtml, 'thread-brief-save'), /disabled/);
  assert.match(pendingHtml, /value="Keep the brief"/);
  assert.match(pendingHtml, /Keep the content/);
  release({ ok: false, status: 503, json: async () => ({ error: 'Discussion service unavailable.' }) });
  await pending;
  assert.equal(vm.runInContext('threadBriefTitle', context), 'Keep the brief');
  assert.equal(vm.runInContext('threadBriefContent', context), 'Keep the content');
  const failedHtml = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(failedHtml, /Discussion service unavailable/);
  assert.match(failedHtml, /role="alert"/);
  assert.ok(context.document.getElementById('thread-brief-save').focusCalls >= 1, 'failed save returns focus to the save control');
  await vm.runInContext('saveThreadBrief()', context);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].request_id, posts[0].request_id, 'retry after the failure keeps the request id for dedupe');
  assert.equal(vm.runInContext('threadBriefRequestId', context), null, 'a refused retry does not publish a saved brief id');
});

test('threads UI save-brief conflict keeps both fields and shows the conflict text', async () => {
  const context = dashboardContext({ fetch: async url => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/save-brief') return { ok: false, status: 409, json: async () => ({ error: 'Discussion request conflicts with current state.' }) };
    return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefTitle='Conflicted title';threadBriefContent='Conflicted body';renderThreads()`, context);
  await vm.runInContext('saveThreadBrief()', context);
  assert.equal(vm.runInContext('threadBriefTitle', context), 'Conflicted title');
  assert.equal(vm.runInContext('threadBriefContent', context), 'Conflicted body');
  const html = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(html, /conflicts with current state/);
  assert.match(html, /role="alert"/);
});

test('threads UI preview shows the resolved target, brief, model and contract digest', async () => {
  const digest = 'a'.repeat(64);
  const previews = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/preview-assignment') {
      const body = JSON.parse(init.body);
      previews.push(body);
      return { ok: true, json: async () => ({ record: { assignment_id: body.assignment_id, repository_id: 'adjacent-repo', execution_dir: '/srv/work', brief: '/storage/briefs/brief-ready.md', model: 'pi-medium' }, piArgs: ['--mode', 'rpc'], contractDigest: digest, briefBytes: 'bytes' }) };
    }
    return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefRequestId='33333333-3333-4333-8333-333333333333';threadBriefSavedTitle='Ready';threadBriefSavedContent='Do the work';threadBriefTitle='Ready';threadBriefContent='Do the work';renderThreads()`, context);
  await vm.runInContext('previewThreadAssignment()', context);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].request_id, '33333333-3333-4333-8333-333333333333');
  assert.equal(previews[0].instructions, 'Do the work');
  assert.match(previews[0].assignment_id, /^[0-9a-f-]{36}$/);
  const html = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(html, /Assignment preview/);
  assert.match(html, /adjacent-repo/);
  assert.match(html, /pi-medium/);
  assert.match(html, new RegExp(digest));
  assert.doesNotMatch(buttonTag(html, 'thread-assignment-launch'), /disabled/);
  assert.match(context.document.getElementById('thread-announcer').textContent, /Assignment preview ready/);
});

test('threads UI stale launch keeps the preview and requires a new preview', async () => {
  const digest = 'b'.repeat(64);
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/launch-assignment') { posts.push(JSON.parse(init.body)); return { ok: false, status: 409, json: async () => ({ error: 'Discussion request conflicts with current state.' }) }; }
    return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefRequestId='44444444-4444-4444-8444-444444444444';threadBriefSavedTitle='Ready';threadBriefSavedContent='Do it';threadBriefTitle='Ready';threadBriefContent='Do it';threadAssignmentId='55555555-5555-4555-8555-555555555555';threadPreview={requestId:'44444444-4444-4444-8444-444444444444',assignmentId:'55555555-5555-4555-8555-555555555555',digest:${JSON.stringify(digest)},record:{assignment_id:'55555555-5555-4555-8555-555555555555',repository_id:'adjacent-repo',execution_dir:'/srv/work',brief:'/storage/briefs/brief-ready.md',model:'pi-medium'},piArgs:[]};threadPreviewStale=false;renderThreads()`, context);
  await vm.runInContext('launchThreadAssignment()', context);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].expectedDigest, digest, 'launch binds the preview digest');
  assert.equal(vm.runInContext('threadPreviewStale', context), true);
  assert.equal(vm.runInContext('threadPreview && threadPreview.digest', context), digest, 'the reviewed preview stays visible');
  const html = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(html, new RegExp(digest));
  assert.match(buttonTag(html, 'thread-assignment-launch'), /disabled/);
  assert.match(html, /Re-preview required/);
  assert.match(html, /Preview again before launching/);
  assert.ok(context.document.getElementById('thread-brief-preview').focusCalls >= 1, 'stale refusal returns focus to the preview control');
});

test('threads UI launch sends expectedDigest and renders a read-only result card', async () => {
  const digest = 'c'.repeat(64);
  const assignmentId = '77777777-7777-4777-8777-777777777777';
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/launch-assignment') {
      const body = JSON.parse(init.body);
      posts.push(body);
      return { ok: true, json: async () => ({ thread: threadRecord(), handoff: { request_id: body.request_id }, assignment: { assignment_id: assignmentId, state: 'live', attention: [], tmux_session: 'adj-1' }, observation: { state: 'live', attention: [] } }) };
    }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefRequestId='88888888-8888-4888-8888-888888888888';threadBriefSavedTitle='Ship';threadBriefSavedContent='Ship the fix';threadBriefTitle='Ship';threadBriefContent='Ship the fix';threadAssignmentId=${JSON.stringify(assignmentId)};threadPreview={requestId:'88888888-8888-4888-8888-888888888888',assignmentId:${JSON.stringify(assignmentId)},digest:${JSON.stringify(digest)},record:{assignment_id:${JSON.stringify(assignmentId)},repository_id:'adjacent-repo',execution_dir:'/srv/work',brief:'/storage/briefs/brief-ship.md',model:'pi-medium'},piArgs:[]};threadPreviewStale=false;renderThreads()`, context);
  await vm.runInContext('launchThreadAssignment()', context);
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].expectedDigest, digest);
  assert.equal(posts[0].instructions, 'Ship the fix');
  assert.equal(posts[0].request_id, '88888888-8888-4888-8888-888888888888');
  assert.equal(context.document.getElementById('thread-announcer').textContent, 'Assignment launched.');
  const html = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(html, /Assignment result/);
  assert.match(html, /id="thread-assignment-link"/);
  assert.match(html, new RegExp(assignmentId));
  assert.match(html, /id="thread-discuss-result"/);
  assert.equal(posts.length, 1, 'the result card never auto-fetches or relaunches the assignment');
});

test('threads UI assignment link reaches the read-only result detail without dispatching', async () => {
  const calls = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    calls.push({ path, method: init.method ?? 'GET' });
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 503, json: async () => ({}) };
  } });
  context.setInterval = () => 0;
  context.clearInterval = () => {};
  context.EventSource = class { constructor() {} addEventListener() {} close() {} };
  setThreadContext(context);
  const assignmentId = '99999999-9999-4999-8999-999999999999';
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadResult={assignment:{assignment_id:${JSON.stringify(assignmentId)},state:'live',attention:[],tmux_session:'adj-9'},observation:{state:'live',attention:[]}};renderThreads()`, context);
  const html = threadsBody(context);
  const href = html.match(/id="thread-assignment-link"[^>]*href="([^"]+)"/)?.[1] ?? html.match(/href="([^"]+)"[^>]*id="thread-assignment-link"/)?.[1];
  assert.equal(href, `#thread-assignment-${assignmentId}`, 'the link fragment names the assignment destination');
  assert.ok(html.includes(`id="thread-assignment-${assignmentId}"`), 'the result card renders the matching destination anchor');
  assert.match(html, /State: live/);
  assert.match(html, /tmux session adj-9/);
  vm.runInContext(inlineScript().slice(inlineScript().indexOf("$('run-list').addEventListener")), context);
  const clicks = context.document.getElementById('run-detail').listeners.click;
  assert.ok(Array.isArray(clicks) && clicks.length >= 2, 'detail click handlers are attached');
  await flush();
  calls.length = 0;
  // Exercise every registered detail listener rather than one numeric index:
  // the no-send/no-fetch contract belongs to the delegated dispatch as a
  // whole, whichever listener owns the assignment link.
  // The synthetic target answers the ordinary delegated lookups for the link
  // (its id selector and the plain anchor selector) with itself and leaves
  // every unrelated action selector unmatched, so a handler written as
  // closest('#thread-assignment-link') is actually exercised instead of being
  // skipped like an unrecognized click.
  const assignmentLink = {
    id: 'thread-assignment-link',
    closest(selector) {
      return selector === 'a' || selector === '#thread-assignment-link' ? this : null;
    },
  };
  let navigationPrevented = false;
  for (const click of clicks) {
    assert.equal(typeof click, 'function');
    click({ target: assignmentLink, preventDefault() { navigationPrevented = true; } });
  }
  await flush();
  assert.equal(navigationPrevented, false, 'following the assignment link keeps the default fragment navigation');
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'following the assignment link launches and sends nothing');
  assert.equal(calls.filter(call => String(call.path).startsWith('/api/thread')).length, 0, 'following the assignment link fetches nothing');
});

test('threads UI whitespace-surrounded brief title saves trimmed and keeps Preview enabled', async () => {
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/save-brief') { posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ thread: threadRecord(), brief: '/storage/briefs/brief.md', handoff: { request_id: JSON.parse(init.body).request_id }, duplicate: false }) }; }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefTitle='  Padded Title  ';threadBriefContent='Body text';renderThreads()`, context);
  await vm.runInContext('saveThreadBrief()', context);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Padded Title');
  assert.equal(vm.runInContext('threadBriefTitle', context), 'Padded Title', 'the editor normalizes to the saved title when untouched mid-request');
  assert.equal(vm.runInContext('threadBriefSavedTitle', context), 'Padded Title');
  const html = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.doesNotMatch(buttonTag(html, 'thread-brief-preview'), /disabled/, 'Preview stays enabled after a whitespace-surrounded save');
  assert.doesNotMatch(html, /unsaved changes/);
});

test('threads UI brief edits made during the save request are preserved', async () => {
  let release;
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/save-brief') { posts.push(JSON.parse(init.body)); return new Promise(resolve => { release = resolve; }); }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefTitle='  Submitted Title  ';threadBriefContent='Body text';renderThreads()`, context);
  const pending = vm.runInContext('saveThreadBrief()', context);
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Submitted Title');
  vm.runInContext(`threadBriefTitle='Edited mid-flight';renderThreadHandoff()`, context);
  release({ ok: true, json: async () => ({ thread: threadRecord(), brief: '/storage/briefs/brief.md', handoff: { request_id: posts[0].request_id }, duplicate: false }) });
  await pending;
  assert.equal(vm.runInContext('threadBriefSavedTitle', context), 'Submitted Title');
  assert.equal(vm.runInContext('threadBriefTitle', context), 'Edited mid-flight', 'mid-request edits survive the save');
  const html = context.document.getElementById('thread-handoff-box').innerHTML;
  assert.match(buttonTag(html, 'thread-brief-preview'), /disabled/, 'the newer edit correctly reads as unsaved');
});

test('threads UI Discuss result fills the composer without sending or launching', async () => {
  const calls = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    calls.push({ path, method: init.method ?? 'GET' });
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord({ state: 'active' })], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 503, json: async () => ({}) };
  } });
  setThreadContext(context);
  const assignmentId = '66666666-6666-4666-8666-666666666666';
  vm.runInContext(`threads=${JSON.stringify([threadRecord({ state: 'active' })])};threadDraft='';threadResult={assignment:{assignment_id:${JSON.stringify(assignmentId)},state:'live',attention:[]},observation:{state:'live',attention:[]}};renderThreads()`, context);
  vm.runInContext('discussThreadResult()', context);
  const draft = vm.runInContext('threadDraft', context);
  assert.match(draft, new RegExp(assignmentId));
  assert.match(draft, /state live/);
  assert.equal(context.document.getElementById('thread-draft').value, draft, 'the composer shows the result summary');
  assert.equal(context.document.activeElement, context.document.getElementById('thread-draft'));
  assert.match(context.document.getElementById('thread-announcer').textContent, /Nothing is sent/);
  await flush();
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'Discuss result never dispatches');
});

test('threads UI saves the brief on Enter and preserves the Shift+Enter newline', async () => {
  const posts = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/save-brief') { posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ thread: threadRecord(), brief: '/storage/briefs/brief.md', handoff: { request_id: JSON.parse(init.body).request_id }, duplicate: false }) }; }
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    return { ok: false, status: 503, json: async () => ({}) };
  } });
  context.setInterval = () => 0;
  context.clearInterval = () => {};
  context.EventSource = class { constructor() {} addEventListener() {} close() {} };
  vm.runInContext(inlineScript().slice(inlineScript().indexOf("$('run-list').addEventListener")), context);
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadBriefTitle='Keyboard brief';threadBriefContent='line one';renderThreads()`, context);
  const keydown = context.document.getElementById('run-detail').listeners.keydown[0];
  let prevented = false;
  keydown({ target: { id: 'thread-brief-title' }, key: 'Enter', shiftKey: false, preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true, 'Enter in the brief title saves the brief');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Keyboard brief');
  let shiftPrevented = false;
  keydown({ target: { id: 'thread-brief-content' }, key: 'Enter', shiftKey: true, preventDefault() { shiftPrevented = true; } });
  await flush();
  assert.equal(shiftPrevented, false, 'Shift+Enter keeps the textarea newline');
  assert.equal(posts.length, 1);
  // The mocked state poll above fails and would otherwise clear the action-token
  // gate; this test owns the brief keyboard behavior only.
  vm.runInContext('error=null', context);
  keydown({ target: { id: 'thread-brief-content' }, key: 'Enter', shiftKey: false, preventDefault() { prevented = true; } });
  await flush();
  assert.equal(posts.length, 2, 'Enter in the brief content saves the brief');
});

// ---- Threads UI (step 9 fix): mutation identity guards, selected reconcile, stalled Stop ----
test('threads UI deferred send completion after a thread change keeps the new draft', async () => {
  const resolvers = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/send') return new Promise(resolve => resolvers.push(() => resolve({ ok: true, json: async () => ({ thread: threadRecord(), message_id: 'message-1', state: 'queued', duplicate: false }) })));
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord({ title: 'Alpha thread' }), threadRecord({ thread_id: otherThreadId, title: 'Beta thread' })], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  const alpha = threadRecord({ title: 'Alpha thread' });
  const beta = threadRecord({ thread_id: otherThreadId, title: 'Beta thread' });
  vm.runInContext(`threads=${JSON.stringify([alpha, beta])};threadDraft='alpha text';renderThreads()`, context);
  const sending = vm.runInContext('sendThreadMessage()', context);
  await flush();
  assert.equal(resolvers.length, 1);
  // Select the other thread and type its own draft while the POST awaits.
  vm.runInContext(`selectThread(${JSON.stringify(otherThreadId)})`, context);
  await flush();
  vm.runInContext("threadDraft='beta unsent text';renderThreadControls()", context);
  resolvers[0]();
  await sending;
  await flush();
  await flush();
  assert.equal(vm.runInContext('selectedThread', context), otherThreadId);
  assert.equal(vm.runInContext('threadDraft', context), 'beta unsent text');
  assert.equal(context.document.getElementById('thread-announcer').textContent, '');
  assert.equal(vm.runInContext('threadRequestError', context), null);
});

test('threads UI stale send completion keeps a newer action pending', async () => {
  const resolvers = [];
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/send' || path === '/api/thread/stop') return new Promise(resolve => resolvers.push(() => resolve({ ok: true, json: async () => ({ thread: threadRecord({ state: 'active' }), message_id: 'message-1', state: 'queued', duplicate: false }) })));
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord({ state: 'active' })], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord({ state: 'active' })])};threadDraft='send me';renderThreads()`, context);
  const sending = vm.runInContext('sendThreadMessage()', context);
  await flush();
  assert.equal(vm.runInContext('threadPending', context), 'send');
  const stopping = vm.runInContext('stopSelectedThread()', context);
  await flush();
  assert.equal(vm.runInContext('threadPending', context), 'stop');
  resolvers[0]();
  await sending;
  await flush();
  assert.equal(vm.runInContext('threadPending', context), 'stop');
  resolvers[1]();
  await stopping;
  await flush();
  assert.equal(vm.runInContext('threadPending', context), null);
});

test('threads UI send success keeps text typed during the request', async () => {
  let resolveSend;
  const context = dashboardContext({ fetch: async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/thread/send') return new Promise(resolve => { resolveSend = () => resolve({ ok: true, json: async () => ({ thread: threadRecord(), message_id: 'message-1', state: 'queued', duplicate: false }) }); });
    if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [threadRecord()], invalid: [] }) };
    if (path === '/api/thread/history') return { ok: true, json: async () => ({ header: null, entries: [], leaf_id: null, incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadDraft='first text';renderThreads()`, context);
  const sending = vm.runInContext('sendThreadMessage()', context);
  await flush();
  assert.match(vm.runInContext('threadSendId', context), /^[0-9a-f-]{36}$/);
  // Typing continues while the POST awaits; the late success must not drop it.
  vm.runInContext("threadDraft='first text plus more'", context);
  resolveSend();
  await sending;
  await flush();
  assert.equal(vm.runInContext('threadDraft', context), 'first text plus more');
  assert.equal(vm.runInContext('threadSendId', context), null);
  assert.equal(context.document.getElementById('thread-announcer').textContent, 'Message queued.');
});

test('threads UI list refresh reconciles the selected controls without replacing transcript or draft', async () => {
  let listed = [threadRecord({ title: 'Ready thread' })];
  const context = dashboardContext({ fetch: async url => {
    if (String(url).split('?')[0] === '/api/threads') return { ok: true, json: async () => ({ threads: listed, invalid: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  assert.equal(typeof context.EventSource, 'undefined', 'SSE stays unavailable in this VM');
  setThreadContext(context);
  const headBox = () => context.document.getElementById('thread-head-box').innerHTML;
  const controlsBox = () => context.document.getElementById('thread-controls-box').innerHTML;
  const entries = [threadEntry('entry-1', 'user', 'keep this transcript'), threadEntry('entry-2', 'assistant', 'keep this answer')];
  vm.runInContext(`threads=${JSON.stringify([threadRecord({ title: 'Ready thread' })])};selectedThread=${JSON.stringify(threadId)};threadHistoryEntries=${JSON.stringify(entries)};threadDraft='unsent draft';threadPartial='';renderThreads()`, context);
  assert.doesNotMatch(threadsBody(context), /id="thread-stop"/);
  // The incremental reconcile path must leave the transcript renderer untouched.
  vm.runInContext('let transcriptRenders=0;const origTranscriptRender=renderThreadTranscript;renderThreadTranscript=function(){transcriptRenders++;return origTranscriptRender();}', context);
  // Ready to streaming through polling alone, with a fresh queue position.
  listed = [threadRecord({ title: 'Ready thread', state: 'active',
    queue: [{ id: 'message-1', state: 'queued', text: 'waiting text', queued_at: threadAt, queue_position: 2 }] })];
  await vm.runInContext('loadThreads()', context);
  await flush();
  assert.match(headBox(), /Responding/);
  assert.match(controlsBox(), /id="thread-stop"/);
  assert.match(controlsBox(), /queue position 2/);
  assert.match(controlsBox(), /waiting text/);
  assert.equal(vm.runInContext('threadDraft', context), 'unsent draft');
  assert.equal(vm.runInContext('threadHistoryEntries.length', context), 2);
  assert.equal(vm.runInContext('transcriptRenders', context), 0);
  assert.equal(context.document.activeElement, null);
  // Streaming to settled removes Stop while the transcript and draft stay.
  listed = [threadRecord({ title: 'Ready thread', state: 'idle' })];
  await vm.runInContext('loadThreads()', context);
  await flush();
  assert.match(headBox(), /pill good">Ready/);
  assert.doesNotMatch(controlsBox(), /id="thread-stop"/);
  assert.equal(vm.runInContext('threadDraft', context), 'unsent draft');
  assert.equal(vm.runInContext('threadHistoryEntries.length', context), 2);
  assert.equal(vm.runInContext('transcriptRenders', context), 0);
});

test('threads UI stalled owner keeps Stop while a released stall shows Refresh only', () => {
  const context = dashboardContext();
  setThreadContext(context);
  const owned = threadRecord({ state: 'stalled', attention: 'stalled', owns_response: true });
  vm.runInContext(`threads=${JSON.stringify([owned])};selectedThread=${JSON.stringify(threadId)};threadRequestError=null;renderThreads()`, context);
  let html = threadsBody(context);
  assert.match(html, /Stalled/);
  assert.match(html, /id="thread-stop"/);
  assert.doesNotMatch(html, /id="thread-resume"/);
  const released = threadRecord({ state: 'stalled', attention: 'stalled', owns_response: false });
  vm.runInContext(`threads=${JSON.stringify([released])};renderThreads()`, context);
  html = threadsBody(context);
  assert.match(html, /Stalled/);
  assert.doesNotMatch(html, /id="thread-stop"/);
  assert.match(html, /data-thread-refresh/);
});

// Run independently: node --test --test-name-pattern='owned responses keep Stop' scripts/spec-observe/dashboard.test.mjs
test('threads UI owned responses keep Stop through uncertain, refusal and paused attention', () => {
  const context = dashboardContext();
  setThreadContext(context);
  const cases = [
    ['owned uncertain', { state: 'uncertain', attention: 'uncertain', owns_response: true }, true],
    ['owned policy refusal', { state: 'policy-refusal', attention: 'policy-refusal', owns_response: true }, true],
    ['owned paused', { state: 'paused', attention: null, queue_paused: true, owns_response: true }, true],
    ['unowned uncertain', { state: 'uncertain', attention: 'uncertain', owns_response: false }, false],
    ['unowned policy refusal', { state: 'policy-refusal', attention: 'policy-refusal', owns_response: false }, false],
    ['unowned paused', { state: 'paused', attention: null, queue_paused: true, owns_response: false }, false],
  ];
  for (const [label, overrides, expected] of cases) {
    vm.runInContext(`threads=${JSON.stringify([threadRecord(overrides)])};selectedThread=${JSON.stringify(threadId)};threadRequestError=null;threadDraft='keep me';renderThreads()`, context);
    const html = threadsBody(context);
    assert.equal(/id="thread-stop"/.test(html), expected, label);
    assert.equal(vm.runInContext('threadDraft', context), 'keep me', `${label} keeps the composer draft`);
    assert.equal(context.document.getElementById('thread-draft').value, 'keep me', `${label} keeps the composer text`);
    if (overrides.queue_paused === true) {
      assert.match(html, /id="thread-resume"/, `${label} keeps Resume`);
      assert.equal(/id="thread-stop"/.test(html), overrides.owns_response, `${label} cancellation follows ownership`);
    }
  }

  // The SSE snapshot path applies the same ownership facts through
  // applyThreadLive: a paused snapshot that still owns the response keeps Stop.
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};renderThreads()`, context);
  vm.runInContext(`handleThreadFrame('snapshot', ${JSON.stringify({ thread_id: threadId, generation: 3, state: 'paused', queue: [], attention: null, partial: '', owns_response: true, queue_paused: true, last_persisted_id: null, watermark: 9 })})`, context);
  const snapshotHtml = context.document.getElementById('thread-controls-box').innerHTML;
  assert.match(snapshotHtml, /id="thread-stop"/, 'a snapshot owner keeps Stop while paused');
  assert.match(snapshotHtml, /id="thread-resume"/, 'a snapshot paused owner keeps Resume');
});

// Run independently: node --test --test-name-pattern='reconnect snapshots replace' scripts/spec-observe/dashboard.test.mjs
test('threads UI reconnect snapshots replace obsolete partial text and keep the composer draft', async () => {
  const context = dashboardContext({ fetch: async url => {
    if (String(url).startsWith('/api/thread/history')) return { ok: true, json: async () => ({ header: null, entries: [threadEntry('entry-done', 'assistant', 'completed persisted answer')], leaf_id: 'entry-done', incomplete_tail: false, skipped_lines: 0, truncated: false }) };
    return { ok: false, status: 404, json: async () => ({}) };
  } });
  setThreadContext(context);
  const transcript = () => context.document.getElementById('thread-transcript-box').innerHTML;
  vm.runInContext(`threads=${JSON.stringify([threadRecord()])};threadHistoryEntries=${JSON.stringify([threadEntry('entry-old','assistant','older history')])};threadPartial='obsolete long partial text';threadDraft='draft to keep';renderThreads();renderThreadTranscript()`, context);
  assert.match(transcript(), /obsolete long partial text/);
  assert.equal(context.document.getElementById('thread-draft').value, 'draft to keep');

  // Selection stays immutable: a snapshot for another thread changes nothing.
  vm.runInContext(`handleThreadFrame('snapshot', ${JSON.stringify({ thread_id: otherThreadId, generation: 1, state: 'idle', queue: [], attention: null, partial: 'intruder', owns_response: false, queue_paused: false, last_persisted_id: null, watermark: 4 })})`, context);
  assert.equal(vm.runInContext('threadPartial', context), 'obsolete long partial text', 'a snapshot for another thread is ignored');

  // A shorter reconnect snapshot is authoritative over the obsolete partial.
  vm.runInContext(`handleThreadFrame('snapshot', ${JSON.stringify({ thread_id: threadId, generation: 1, state: 'active', queue: [], attention: null, partial: 'short', owns_response: true, queue_paused: false, last_persisted_id: null, watermark: 5 })})`, context);
  assert.equal(vm.runInContext('threadPartial', context), 'short', 'a shorter snapshot replaces the obsolete partial');
  assert.doesNotMatch(transcript(), /obsolete long partial text/);
  assert.match(transcript(), /short/);
  assert.equal(vm.runInContext('threadDraft', context), 'draft to keep');
  assert.equal(context.document.getElementById('thread-draft').value, 'draft to keep', 'the composer draft survives reconnect replacement');

  // An empty reconnect snapshot clears the stale partial and refreshes the
  // persisted tail when the watermark moved past the local history.
  vm.runInContext(`threadPartial='stale text replaced by persisted history';renderThreadTranscript()`, context);
  vm.runInContext(`handleThreadFrame('snapshot', ${JSON.stringify({ thread_id: threadId, generation: 2, state: 'idle', queue: [], attention: null, partial: '', owns_response: false, queue_paused: false, last_persisted_id: 'entry-done', watermark: 6 })})`, context);
  assert.equal(vm.runInContext('threadPartial', context), '');
  await flush();
  assert.match(transcript(), /completed persisted answer/);
  assert.doesNotMatch(transcript(), /stale text replaced by persisted history/);
  assert.equal(vm.runInContext('threadDraft', context), 'draft to keep');
});

// ---- Step 7 Agents view: read-only assignment supervision projection ----
function agentAssignment(overrides = {}) {
  return {
    assignment_id: '11111111-1111-4111-8111-111111111111',
    spec_package: '/repo/.specs/feature',
    workflow_id: 'wf-1',
    recordedState: 'live',
    observedState: 'live',
    display: 'live',
    unrecorded: false,
    quiet: false,
    attachedCount: null,
    hasControl: false,
    workersUnconfirmed: false,
    nextAction: 'Attach command',
    safeAction: 'Attach command',
    attention: [],
    coverage: 'complete',
    coverageReasons: [],
    ...overrides,
  };
}

function agentEnvelope({ assignments, runs = [], assignment_coverage = null, observed = '2026-10-06T12:00:00.000Z', generated_at = observed }) {
  return {
    generated_at,
    errors: [],
    observers: [{
      observer_id: 'agent-observer', state: 'observing', published_at: observed,
      snapshot: {
        workspace: 'agent-workspace', runs, recently_completed: [],
        coverage: { state: 'complete', reasons: [], observed_at: observed },
        ...(assignment_coverage === null ? {} : { assignment_coverage }),
        assignments,
      },
    }],
  };
}

test('assignment dashboard projection distinguishes display states with safe actions and no write controls', async () => {
  const observed = '2026-10-06T12:00:00.000Z';
  const displays = [
    ['live', 'Live'], ['live-unrecorded', 'Live (unrecorded)'], ['launching', 'Launching'],
    ['launch-unconfirmed', 'Launch unconfirmed'], ['exited-unrecorded', 'Exited (unrecorded)'],
    ['terminal-lost', 'Terminal lost'], ['unknown', 'Unknown'], ['ended', 'Ended'], ['launch-failed', 'Launch failed'],
  ];
  const assignments = displays.map(([display], index) => agentAssignment({
    assignment_id: `1111111${index}-1111-4111-8111-11111111111${index}`,
    display,
    observedState: display,
    coverage: display === 'unknown' ? 'partial' : 'complete',
    nextAction: display === 'live' ? 'Attach command' : `adjacent locate 1111111${index}-1111-4111-8111-11111111111${index}`,
  }));
  const context = dashboardContext({ wallNow: () => Date.parse(observed), perfNow: () => 0,
    fetch: async () => ({ ok: true, json: async () => agentEnvelope({ assignments }) }) });
  await vm.runInContext('refresh()', context);
  vm.runInContext("mode='agents';render()", context);
  const list = context.document.getElementById('run-list').innerHTML;
  for (const [, label] of displays) assert.ok(list.includes(label), `list shows ${label}`);
  assert.match(list, /Recently ended/, 'ended rows are grouped separately');
  assert.ok(list.includes(assignments[0].assignment_id), 'the full assignment id is shown');
  assert.ok(!list.includes('mark-complete') && !list.includes('data-takeover') && !list.includes('data-resume'));
  vm.runInContext("selectedAssignment=assignments.find(a=>a.display==='live').key;render()", context);
  const detail = context.document.getElementById('observation-detail').innerHTML;
  assert.match(detail, /Execution/);
  assert.match(detail, /Lifecycle/);
  assert.match(detail, /Declared evidence/);
  assert.match(detail, /Attach command/);
  assert.ok(!/<button/.test(detail), 'assignment detail contains no write controls');
  assert.doesNotMatch(detail, /transcript/i, 'no transcript surface is rendered');
});

test('assignment dashboard projection shows declared evidence commit and scope and keeps unassessed evidence explicit', async () => {
  const observed = '2026-10-06T12:00:00.000Z';
  const commit = 'a'.repeat(40);
  const recorded = { package: '/repo/.specs/feature', workflow_id: 'wf-1', execution: 'running',
    coverage: { state: 'complete', reasons: [] },
    evidence: { state: 'recorded', verdict: 'ready', commit, source: 'work-tour.json', scope: 'declared-artifact', observed_at: observed, reason: null } };
  const context = dashboardContext({ wallNow: () => Date.parse(observed), perfNow: () => 0,
    fetch: async () => ({ ok: true, json: async () => agentEnvelope({ assignments: [agentAssignment()], runs: [recorded] }) }) });
  await vm.runInContext('refresh()', context);
  vm.runInContext("mode='agents';collect();render()", context);
  const detail = context.document.getElementById('observation-detail').innerHTML;
  assert.ok(detail.includes(commit), 'the declared commit is shown explicitly');
  assert.match(detail, /declared-artifact/);
  assert.match(detail, /Declared artifact scope only/);
  assert.doesNotMatch(detail, /current HEAD|deployment approval/i);

  const notAssessed = { package: '/repo/.specs/feature', workflow_id: 'wf-1', execution: 'completed',
    coverage: { state: 'complete', reasons: [] },
    evidence: { state: 'not-assessed', verdict: null, commit: null, source: 'work-tour.json', scope: 'declared-artifact', observed_at: observed, reason: null } };
  const other = dashboardContext({ wallNow: () => Date.parse(observed), perfNow: () => 0,
    fetch: async () => ({ ok: true, json: async () => agentEnvelope({ assignments: [agentAssignment({ display: 'ended', recordedState: 'ended', observedState: 'ended' })], runs: [notAssessed] }) }) });
  await vm.runInContext('refresh()', other);
  vm.runInContext("mode='agents';collect();render()", other);
  assert.match(other.document.getElementById('observation-detail').innerHTML, /No declared artifact was assessed/);
});

test('assignment dashboard projection keeps quiet and attached informational and workers-unconfirmed explicit', async () => {
  const observed = '2026-10-06T12:00:00.000Z';
  const run = { package: '/repo/.specs/feature', workflow_id: 'wf-1', execution: 'failed', workflow_state: 'running',
    coverage: { state: 'partial', reasons: ['lease-missing'] }, evidence: null };
  const context = dashboardContext({ wallNow: () => Date.parse(observed), perfNow: () => 0,
    fetch: async () => ({ ok: true, json: async () => agentEnvelope({ assignments: [agentAssignment({
      quiet: true, attachedCount: 2, workersUnconfirmed: true, attention: ['workers-unconfirmed', 'lease-missing'],
    })], runs: [run] }) }) });
  await vm.runInContext('refresh()', context);
  vm.runInContext("mode='agents';collect();render()", context);
  const detail = context.document.getElementById('observation-detail').innerHTML;
  assert.match(detail, /quiet/i);
  assert.match(detail, /informational/i);
  assert.match(detail, /presence only/i);
  assert.match(detail, /Workers unconfirmed/);
  assert.match(detail, /workers-unconfirmed/);
});

test('remote dashboard serves only read-only assignment projections without tokens or write controls', async () => {
  const observed = '2026-10-06T12:00:00.000Z';
  const context = dashboardContext({ wallNow: () => Date.parse(observed), perfNow: () => 0,
    fetch: async () => ({ ok: true, json: async () => agentEnvelope({ assignments: [agentAssignment()] }) }) });
  await vm.runInContext('refresh()', context);
  vm.runInContext("mode='agents';render()", context);
  const list = context.document.getElementById('run-list').innerHTML;
  assert.ok(list.includes(agentAssignment().assignment_id));
  const detail = context.document.getElementById('observation-detail').innerHTML;
  assert.ok(!/<button/.test(detail), 'no write controls on assignment detail');
  assert.doesNotMatch(detail, /api\/package-completion|X-Sentinel-Token/);
  assert.doesNotMatch(detail, /transcript/i);
});

test('server-relative freshness anchors assignment ages on the refresh generated_at', async () => {
  const serverT = Date.parse('2026-10-06T12:00:00Z');
  const observed = new Date(serverT - 10000).toISOString();
  const context = dashboardContext({ wallNow: () => serverT + 120000, perfNow: () => 1000,
    fetch: async () => ({ ok: true, json: async () => agentEnvelope({ assignments: [agentAssignment()], observed, generated_at: new Date(serverT).toISOString() }) }) });
  await vm.runInContext('refresh()', context);
  assert.equal(vm.runInContext('liveAnchor.at', context), serverT);
  vm.runInContext("mode='agents';render()", context);
  assert.ok(context.document.getElementById('run-list').innerHTML.includes('10s ago'), 'age uses the server anchor, not the client clock');
});

test('assignment dashboard projection drops a stale selection when the next snapshot no longer contains it', async () => {
  const observed = '2026-10-06T12:00:00.000Z';
  let body = agentEnvelope({ assignments: [agentAssignment()] });
  const context = dashboardContext({ wallNow: () => Date.parse(observed), perfNow: () => 0,
    fetch: async () => ({ ok: true, json: async () => body }) });
  await vm.runInContext('refresh()', context);
  vm.runInContext("mode='agents';render();selectedAssignment=assignments[0].key", context);
  const stale = vm.runInContext('selectedAssignment', context);
  body = agentEnvelope({ assignments: [agentAssignment({ assignment_id: '22222222-2222-4222-8222-222222222222' })] });
  await vm.runInContext('refresh()', context);
  assert.notEqual(vm.runInContext('selectedAssignment', context), stale, 'the stale key is refused');
  assert.equal(vm.runInContext('assignments.some(a=>a.key===selectedAssignment)', context), true, 'selection resolves to a live row');
});
