import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readDashboardState, createDashboardServer, isRemoteRequest, normalizePublicHost } from './dashboard.mjs';
import { COMPLETION_FILE } from './manual-completion.mjs';

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
  const context = vm.createContext({ document, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  const now = new Date().toISOString();
  const snapshot = { observers: [{ observer_id: 'live', state: 'observing', published_at: now,
    snapshot: { workspace: 'workspace', coverage: { state: 'partial', observed_at: now,
      reasons: ['roots-cap: selected 20 of 27', 'index-entry-invalid: removed test package'] },
    runs: [{ package: '/repo/.specs/feature', coverage: { state: 'complete' } }] } }] };
  vm.runInContext(`payload=${JSON.stringify(snapshot)};status()`, context);
  assert.equal(elements.get('notice').innerHTML, '');
  assert.equal(elements.get('notice').classList.hidden, true);
  assert.match(elements.get('observer-summary').textContent, /Workspace partial \(7 roots skipped\)/);

  vm.runInContext("error='Could not refresh workspace state.';status()", context);
  assert.match(elements.get('notice').innerHTML, /Could not refresh workspace state/);
  assert.equal(elements.get('notice').classList.hidden, false);
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
    AbortController, setTimeout, clearTimeout, location });
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
