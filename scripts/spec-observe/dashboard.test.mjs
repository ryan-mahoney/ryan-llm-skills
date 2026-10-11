import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readDashboardState, createDashboardServer, isRemoteRequest, normalizePublicHost } from './dashboard.mjs';
import { COMPLETION_FILE } from './manual-completion.mjs';
import { setupStorage, createWorkspace, addMaterial } from '../workspaces/store.mjs';

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
    context.input = { storage: { status, root: '/store/<root>', errors: ['<denied>'] }, valid: [], invalid: [], errors: ['scan <failed>'] };
    vm.runInContext('catalog=input;renderWorkspaceList();renderWorkspaceDetail()', context);
    const list = vm.runInContext("$('run-list').innerHTML", context);
    assert.match(list, /Workspace storage unavailable/);
    assert.match(list, /&lt;root&gt;/);
    assert.match(list, /&lt;denied&gt;/);
    assert.match(list, /scan &lt;failed&gt;/);
    assert.match(list, /data-workspace-retry/);
    assert.doesNotMatch(list, /No workspaces/);
    assert.match(vm.runInContext("$('observation-detail').innerHTML", context), /Repair the configured storage boundary/);
  }
  context.input = { storage: { status: 'ok', root: '/store', errors: [] }, valid: [{ id: 'alpha', directory: '/store/alpha' }], invalid: [], errors: ['scan <failed>'] };
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
  assert.match(detail().innerHTML, /setup/);
  assert.match(detail().innerHTML, /missing_root/);
  assert.match(detail().innerHTML, /\/store\/w &lt;root&gt;/);
  assert.doesNotMatch(detail().innerHTML, /cli\.mjs|workspace CLI/i);
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
  const document = { querySelectorAll: () => [], getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', scrollTop: 0, hidden: false,
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
  vm.runInContext("catalog={storage:{root:'/store',status:'missing_root',errors:[]},valid:[],invalid:[],errors:[]};render()", context);
  assert.match(detail().innerHTML, /missing_root/);
  assert.match(detail().innerHTML, /setup/);
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
