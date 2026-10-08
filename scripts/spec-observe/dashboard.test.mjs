import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readDashboardState, createDashboardServer } from './dashboard.mjs';

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
function request(server, path, { host = '127.0.0.1:4319', origin, method = 'GET' } = {}) {
  return new Promise(resolve => {
    const response = { status: 200, headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(code, headers = {}) { this.status = code; Object.assign(this.headers, headers); },
      end(body) { resolve({ status: this.status, headers: this.headers, body: String(body ?? '') }); },
    };
    server.emit('request', { url: path, method, headers: { host, ...(origin ? { origin } : {}) }, socket: { localPort: 4319 } }, response);
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
  const context = vm.createContext({ document: {}, Date, Map, Set, JSON });
  vm.runInContext(script.slice(0, script.indexOf("$('run-list').addEventListener")), context);
  const now = new Date().toISOString();
  context.observers = [
    { observer_id: 'old', state: 'closed', published_at: now, snapshot: { workspace: 'w', coverage: { state: 'partial', observed_at: now }, runs: [{ package: 'completed-work' }] } },
    { observer_id: 'current', state: 'observing', published_at: now, snapshot: { workspace: 'w', coverage: { state: 'complete', observed_at: now }, runs: [] } },
  ];
  assert.equal(vm.runInContext('authoritativeObservers(observers)[0].observer_id', context), 'current');
  assert.equal(vm.runInContext('authoritativeObservers(observers)[0].snapshot.runs.length', context), 0);
  context.bad = { observers: [{ snapshot: { runs: [{ actions: [null] }] } }] };
  assert.throws(() => vm.runInContext('normalize(bad)', context));
  context.pending = { observer_id: 'pending', state: 'observing', snapshot: null };
  assert.equal(vm.runInContext('normalize(pending).observers.length', context), 1);
});

test('partial workspace coverage stays in the footer while connection failures use the notice', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { getElementById(id) {
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
  assert.equal(elements.get('notice').textContent, '');
  assert.equal(elements.get('notice').classList.hidden, true);
  assert.match(elements.get('observer-summary').textContent, /Workspace partial \(7 roots skipped\)/);

  vm.runInContext("error='Could not refresh workspace state.';status()", context);
  assert.match(elements.get('notice').textContent, /Could not refresh workspace state/);
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

test('task status renders Markdown while HTML, unsafe links and code remain inert', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { getElementById(id) {
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
  assert.match(elements.get('run-detail').innerHTML, /class="activity status-markdown"><p><strong>Writing<\/strong> the fix/);
  assert.match(elements.get('run-detail').innerHTML, /class="obligation status-markdown"><p>Review <code>worker.js<\/code>/);
});

test('refresh follows the next assignment for an active spec and preserves historical selection', async () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { getElementById(id) {
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
  assert.match(elements.get('run-detail').innerHTML, /Step 1 of 3/);
  next = snapshot([run('one', 1, false, 'completed'), run('two', 2, true, 'running')]);
  await vm.runInContext('refresh()', context);
  assert.match(elements.get('run-detail').innerHTML, /Step 2 of 3/);
  assert.match(elements.get('run-detail').innerHTML, /max="3" value="2"/);
  vm.runInContext("selected=records.find(r=>r.assignment_id==='one').key;renderDetail()", context);
  await vm.runInContext('refresh()', context);
  assert.match(elements.get('run-detail').innerHTML, /Step 1 of 3/);
});

test('timing shows retries independently and freezes offline or completed observations', () => {
  const script = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const fixedNow = Date.parse('2026-10-06T13:00:00Z');
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  }
  const context = vm.createContext({ document: {}, Date: TestDate, Map, Set, JSON });
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
  assert.equal(vm.runInContext('specElapsed(run)', context), '3h 0m 0s', 'fresh observation advances to the current time');
  vm.runInContext('imported=true', context);
  assert.equal(vm.runInContext('specElapsed(run)', context), '2h 0m 0s', 'import freezes the same fresh observation');
});
