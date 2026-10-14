import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync, existsSync, readdirSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readDashboardState, createDashboardServer, isRemoteRequest, normalizePublicHost } from './dashboard.mjs';
import { COMPLETION_FILE } from './manual-completion.mjs';
import { setupStorage, createWorkspace, addMaterial } from '../workspaces/store.mjs';
import { createDiscussionService } from '../workspaces/discussion.mjs';

// The inline dashboard VM and fake-DOM tests were retired with the legacy page.
// Their model contracts live in frontend/src/model.test.ts, with app interactions
// covered by the browser fixture; these tests keep the real Node/API security seams.
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
  assert.equal(typeof JSON.parse(state.body).action_token, 'string');
  assert.equal((await request(server, '/api/state', { method: 'POST' })).status, 405);
  assert.equal((await request(server, '/api/state', { host: 'remote.example:4319' })).status, 403);
  assert.equal((await request(server, '/api/state', { origin: 'https://other.example' })).status, 403);
  assert.equal((await request(server, '/etc/passwd')).status, 404);
  const page = await request(server, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<!doctype html>/i);
  assert.match(page.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('state route serves fresh observers and omits expired ones', async t => {
  const f = fixture(t), server = createDashboardServer({ agentDir: f.dir });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const fixtures = [
    ['fade.json', { ...envelope('fresh-observing') }, 2000],
    ['beef.json', { ...envelope('fresh-closed'), state: 'closed' }, 1000],
    ['cab.json', { ...envelope('expired-observing'), published_at: twoHoursAgo }, 3000],
    ['dead.json', { ...envelope('expired-closed'), state: 'closed', published_at: twoHoursAgo }, 4000],
  ];
  for (const [name, value, mtime] of fixtures) {
    const path = join(f.observers, name);
    writeFileSync(path, JSON.stringify(value));
    utimesSync(path, mtime, mtime);
  }
  const response = await request(server, '/api/state');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).observers.map(observer => observer.observer_id), ['fresh-observing', 'fresh-closed']);
});

test('thread routes authorize the configured operator host and refuse forwarding headers alone', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example' });
  assert.equal((await request(server, '/api/threads?workspace_id=alpha')).status, 503);
  for (const host of ['dashboard.example', 'dashboard.example:443']) {
    assert.equal((await request(server, '/api/threads?workspace_id=alpha', {host})).status, 503, 'an authorized endpoint reaches the unavailable discussion service');
  }
  for (const variant of [
    { headers: { 'x-forwarded-for': '' } },
    { headers: { 'tailscale-user-login': '' } },
  ]) {
    const refused = await request(server, '/api/threads?workspace_id=alpha', variant);
    assert.equal(refused.status, 403, JSON.stringify(variant));
    assert.equal(refused.bodyRead, false, JSON.stringify(variant));
  }
});

// Run independently: node --test --test-name-pattern='isolates package HTML' scripts/spec-observe/dashboard.test.mjs
test('dashboard isolates package HTML and serves only authorized package-relative resources',async t=>{
 const {realpathSync}=await import('node:fs');const f=fixture(t),repo=realpathSync(f.dir),storageRoot=join(repo,'storage'),pkg=join(storageRoot,'projects','demo','specs','feature');
 await setupStorage(storageRoot);mkdirSync(pkg,{recursive:true});writeFileSync(join(storageRoot,'projects','demo','kit.yaml'),'version: 1\nid: demo\nname: demo\nrepositories:\n  - id: alpha\n    path: /tmp/alpha\n');mkdirSync(join(pkg,'assets'));
 writeFileSync(join(pkg,'work-tour.html'),'<script src="assets/tour.js"></script>');writeFileSync(join(pkg,'assets','tour.js'),'document.body.textContent="Tour"');writeFileSync(join(pkg,'assets','tour.css'),'body{color:red}');
 const value=envelope('a');value.snapshot.runs=[{package:pkg,workspace:'demo'}];writeFileSync(join(f.observers,'a.json'),JSON.stringify(value));const server=createDashboardServer({agentDir:f.dir,storageRoot});
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
    assert.match(body.thread_action_token, /^[a-f0-9]{64}$/, host);
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

// Real inline script with only final Date/performance/fetch/location boundaries replaced.

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
  const plainBefore = readFileSync(join(workspace, 'kit.yaml'), 'utf8');
  for (const path of paths) {
    const response = await request(plain, path);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(response.body, /action_token/, path);
    assert.equal(response.body, loopback[index], path);
  }
  const plainKitAfter = readFileSync(join(workspace, 'kit.yaml'), 'utf8');
  assert.equal(plainKitAfter, plainBefore);
});

test('workspace HTTP design routes serve JSON and return 405 for non-GET/HEAD', async t => {
  const f = fixture(t);
  const base = realpathSync(f.dir);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'studio' });
  const workspace = join(storageRoot, 'projects', 'studio');
  mkdirSync(join(workspace, 'designs', 'demo', 'screens'), { recursive: true });
  writeFileSync(join(workspace, 'designs', 'demo', 'screens', '01-overview.html'), 'content');
  writeFileSync(join(workspace, 'designs', 'demo', 'design.json'), '{"screens":[{"id":"01-overview","produced":true,"captured":{"1280":true}}]}');
  writeFileSync(join(workspace, 'kit.yaml'), 'version: 1\nid: studio\nname: Studio\nrepositories: []\n');
  const server = createDashboardServer({ agentDir: f.dir, storageRoot });
  const path = `/api/workspace-designs?${new URLSearchParams({ id: 'studio' })}`;
  const response = await request(server, path);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.designs[0].path, 'designs/demo');
  assert.equal(body.designs[0].screens[0].produced, true);
  assert.deepEqual(body.designs[0].screens[0].captured, { 1280: true });
  assert.equal(body.designs[0].screens[1].produced, false);
  assert.deepEqual(body.designs[0].summary, { total: 2, produced: 1, captured: 1 });
  assert.ok(body.errors.some(e => e.name === 'designs/broken/design.json' && /screens is empty/.test(e.message)));
  assert.notEqual((await request(server, `/api/workspace-designs?${new URLSearchParams({ id: 'ghost' })}`)).status, 200);
  const screen = await request(server, `/api/workspace-file?${new URLSearchParams({ id: 'studio', file: 'designs/demo/screens/01-overview.html' })}`);
  assert.equal(screen.status, 200);
  assert.match(screen.headers['Content-Security-Policy'], /font-src 'self'/);
  assert.match(screen.headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.doesNotMatch(screen.headers['Content-Security-Policy'], /allow-same-origin/);
  const view = `/workspace-view/${Buffer.from('studio').toString('base64url')}/`;
  const marker = await request(server, `${view}marker.html`);
  assert.equal(marker.status, 200);
  assert.match(marker.headers['Content-Security-Policy'], /sandbox allow-scripts;/);
  assert.match(marker.headers['Content-Security-Policy'], /font-src 'self'/);
  assert.match(marker.headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.doesNotMatch(marker.headers['Content-Security-Policy'], /allow-same-origin/);
  assert.equal(marker.headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(marker.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(marker.headers['Cache-Control'], 'no-store');
  assert.match((await request(server, `${view}marker.js`)).headers['Content-Type'], /javascript/);
  assert.match((await request(server, `${view}marker.css`)).headers['Content-Type'], /text\/css/);
  const markerHead = await request(server, `${view}marker.html`, { method: 'HEAD' });
  assert.equal(markerHead.status, 200);
  assert.equal(markerHead.body, '');
  assert.equal((await request(server, `${view}marker.html`, { method: 'POST' })).status, 405);
  const kit = await request(server, `${view}kit.yaml`);
  assert.equal(kit.status, 200);
  assert.match(kit.body, /studio/);
  assert.notEqual((await request(server, `/workspace-view/${Buffer.from('ghost').toString('base64url')}/kit.yaml`)).status, 200);
  assert.notEqual((await request(server, '/workspace-view//kit.yaml')).status, 200);
  for (const refusedPath of [`${view}threads/discussion.txt`, `${view}.env.local`, `${view}escape.txt`, `${view}big.bin`,
    `${view}%2e%2e%2foutside.txt`, `${view}%2e%2e%5coutside.txt`, `${view}outside%00.txt`]) {
    const refused = await request(server, refusedPath);
    assert.notEqual(refused.status, 200, refusedPath);
    assert.doesNotMatch(refused.body, /OUTSIDE-SECRET|THREAD-SECRET|ENV-SECRET/, refusedPath);
  }
});

async function httpJson(port, path, { method = 'GET', host, origin, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {};
    if (host !== undefined) headers.host = host;
    if (origin !== undefined) headers.origin = origin;
    if (token !== undefined) headers['x-sentinel-token'] = token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startModelServer(t, server) {
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('model routes: real server persists loopback and public-host writes', async t => {
  const f = fixture(t);
  const fakeCatalog = {
    host: 'testbox',
    read: async () => ({
      state: 'ready',
      host: 'testbox',
      read_at: '2026-01-01T00:00:00.000Z',
      providers: 1,
      models: [{ provider: 'deepinfra', model: 'ByteDance/Seed-2.0-code', context: '256K', max_out: '128K', thinking: true, images: false }]
    })
  };
  const server = createDashboardServer({ agentDir: f.dir, publicHost: 'dashboard.example', modelCatalog: fakeCatalog });
  const port = await startModelServer(t, server);
  const loopbackHost = '127.0.0.1:' + port;

  const state = await httpJson(port, '/api/state');
  const token = JSON.parse(state.body).action_token;

  const loopbackPost = await httpJson(port, '/api/models/preferred', { method: 'POST', origin: 'http://' + loopbackHost, token, body: { provider: 'deepinfra', model: 'ByteDance/Seed-2.0-code', preferred: true } });
  assert.equal(loopbackPost.status, 200);
  const loopbackData = JSON.parse(loopbackPost.body);
  assert.deepEqual(loopbackData.preferred, [{ provider: 'deepinfra', model: 'ByteDance/Seed-2.0-code' }]);
  assert.ok(typeof loopbackData.updated_at === 'string');

  const filePath = join(f.dir, 'spec-sentinel', 'preferred-models.json');
  const fileData = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.deepEqual(fileData.preferred, [{ provider: 'deepinfra', model: 'ByteDance/Seed-2.0-code' }]);

  const publicState = await httpJson(port, '/api/state', { host: 'dashboard.example' });
  const publicToken = JSON.parse(publicState.body).thread_action_token;

  const publicPost = await httpJson(port, '/api/models/preferred', { method: 'POST', host: 'dashboard.example', origin: 'https://dashboard.example', token: publicToken, body: { provider: 'other', model: 'other-model', preferred: true } });
  assert.equal(publicPost.status, 200);

  const listed = await httpJson(port, '/api/models/preferred');
  assert.equal(listed.status, 200);
  const listedData = JSON.parse(listed.body);
  assert.deepEqual(listedData.preferred, [{ provider: 'deepinfra', model: 'ByteDance/Seed-2.0-code' }, { provider: 'other', model: 'other-model' }]);
});

test('model routes: oversize and method refusals leave the file unchanged', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });
  const port = await startModelServer(t, server);

  const state = await httpJson(port, '/api/state');
  const token = JSON.parse(state.body).action_token;
  const loopbackHost = '127.0.0.1:' + port;

  const filePath = join(f.dir, 'spec-sentinel', 'preferred-models.json');
  const dirPath = join(f.dir, 'spec-sentinel');
  mkdirSync(dirPath, { mode: 0o700, recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, preferred: [{ provider: 'a', model: 'm' }], updated_at: new Date(1000).toISOString() }));
  const seededBytes = readFileSync(filePath, 'utf8');

  const oversizedPost = await httpJson(port, '/api/models/preferred', { method: 'POST', origin: 'http://' + loopbackHost, token, body: { provider: 'a', model: 'x'.repeat(9000), preferred: true } });
  assert.equal(oversizedPost.status, 413);
  assert.equal(readFileSync(filePath, 'utf8'), seededBytes);

  const longModelPost = await httpJson(port, '/api/models/preferred', { method: 'POST', origin: 'http://' + loopbackHost, token, body: { provider: 'a', model: 'x'.repeat(301), preferred: true } });
  assert.equal(longModelPost.status, 400);
  assert.equal(readFileSync(filePath, 'utf8'), seededBytes);

  const put = await httpJson(port, '/api/models/preferred', { method: 'PUT', host: loopbackHost });
  assert.equal(put.status, 405);
  assert.equal(put.headers['allow'], 'GET, HEAD, POST');
  assert.equal(readFileSync(filePath, 'utf8'), seededBytes);
});

test('model routes: 201st unique addition refuses without changing bytes', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });
  const port = await startModelServer(t, server);

  const state = await httpJson(port, '/api/state');
  const token = JSON.parse(state.body).action_token;
  const loopbackHost = '127.0.0.1:' + port;

  const filePath = join(f.dir, 'spec-sentinel', 'preferred-models.json');
  const dirPath = join(f.dir, 'spec-sentinel');
  mkdirSync(dirPath, { mode: 0o700, recursive: true });

  const preferred = Array.from({ length: 200 }, (_, i) => ({ provider: `p${i}`, model: `m${i}` }));
  const seededBytes = JSON.stringify({ version: 1, preferred, updated_at: new Date(1000).toISOString() });
  writeFileSync(filePath, seededBytes);

  const add201Post = await httpJson(port, '/api/models/preferred', { method: 'POST', origin: 'http://' + loopbackHost, token, body: { provider: 'p200', model: 'm200', preferred: true } });
  assert.equal(add201Post.status, 400);
  assert.equal(readFileSync(filePath, 'utf8'), seededBytes);

  const removePost = await httpJson(port, '/api/models/preferred', { method: 'POST', origin: 'http://' + loopbackHost, token, body: { provider: 'p0', model: 'm0', preferred: false } });
  assert.equal(removePost.status, 200);
  const finalData = JSON.parse(removePost.body);
  assert.equal(finalData.preferred.length, 199);
});

test('model routes: catalog GET/HEAD returns state-less result', async t => {
  const f = fixture(t);
  const catalogReadOptions = [];
  const fakeCatalog = {
    host: 'testbox',
    read: async (options) => {
      catalogReadOptions.push(options);
      return {
        state: 'ready',
        host: 'testbox',
        read_at: '2026-01-01T00:00:00.000Z',
        providers: 1,
        models: [{ provider: 'deepinfra', model: 'ByteDance/Seed-2.0-code', context: '256K', max_out: '128K', thinking: true, images: false }]
      };
    }
  };
  const server = createDashboardServer({ agentDir: f.dir, modelCatalog: fakeCatalog });

  const r = await request(server, '/api/models/catalog');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.equal(body.state, undefined);
  assert.equal(body.host, 'testbox');
  assert.equal(body.models.length, 1);

  await request(server, '/api/models/catalog?refresh=1');
  assert.deepEqual(catalogReadOptions[1], { refresh: true });

  const head = await request(server, '/api/models/catalog', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('model routes: catalog HEAD and preference HEAD return empty body', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir, modelCatalog: { host: 'testbox', read: async () => ({ state: 'ready', host: 'testbox', read_at: '2026-01-01T00:00:00.000Z', providers: 0, models: [] }) } });

  const catalogHead = await request(server, '/api/models/catalog', { method: 'HEAD' });
  assert.equal(catalogHead.status, 200);
  assert.equal(catalogHead.body, '');

  const prefHead = await request(server, '/api/models/preferred', { method: 'HEAD' });
  assert.equal(prefHead.status, 200);
  assert.equal(prefHead.body, '');
});

test('model routes: preferred GET returns empty by default', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });

  const r = await request(server, '/api/models/preferred');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.preferred, []);
  assert.equal(body.updated_at, null);
});

test('model routes: observer requests with x-forwarded-for still return 200', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });

  const r = await request(server, '/api/models/preferred', { headers: { 'x-forwarded-for': '' } });
  assert.equal(r.status, 200);
});

test('model routes: catalog failure yields 503', async t => {
  const f = fixture(t);
  const fakeCatalog = {
    host: 'testbox',
    read: async () => ({
      state: 'failed',
      host: 'testbox',
      failed_at: '2026-01-01T00:00:00.000Z',
      reason: 'catalog-unavailable'
    })
  };
  const server = createDashboardServer({ agentDir: f.dir, modelCatalog: fakeCatalog });

  const r = await request(server, '/api/models/catalog');
  assert.equal(r.status, 503);
  const body = JSON.parse(r.body);
  assert.equal(body.reason, 'catalog-unavailable');
  assert.equal(body.host, 'testbox');
  assert.ok(body.failed_at);
});

test('model routes: authorization refusals do not read body', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });

  const state = await request(server, '/api/state');
  const token = JSON.parse(state.body).action_token;

  const badRequests = [
    { headers: { 'x-forwarded-for': '', origin: 'http://127.0.0.1:4319', 'x-sentinel-token': token, 'content-type': 'application/json' } },
    { headers: { origin: 'https://other.example', 'x-sentinel-token': token, 'content-type': 'application/json' } },
    { headers: { origin: 'http://127.0.0.1:4319', 'content-type': 'application/json' } },
    { headers: { origin: 'http://127.0.0.1:4319', 'x-sentinel-token': 'wrong', 'content-type': 'application/json' } },
    { headers: { origin: 'http://127.0.0.1:4319', 'x-sentinel-token': token, 'content-type': 'text/plain' } },
  ];

  for (const req of badRequests) {
    const r = await request(server, '/api/models/preferred', { method: 'POST', body: '{}', ...req });
    assert.equal(r.status, 403);
    assert.equal(r.bodyRead, false);
  }

  const filePath = join(f.dir, 'spec-sentinel', 'preferred-models.json');
  assert.equal(existsSync(filePath), false);
});

test('model routes: body validation rejects without changing file', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });
  const port = await startModelServer(t, server);
  const loopbackHost = '127.0.0.1:' + port;

  const state = await httpJson(port, '/api/state');
  const token = JSON.parse(state.body).action_token;

  const filePath = join(f.dir, 'spec-sentinel', 'preferred-models.json');
  mkdirSync(join(f.dir, 'spec-sentinel'), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ version: 1, preferred: [{ provider: 'a', model: 'm' }], updated_at: new Date(1000).toISOString() }));
  const seededBytes = readFileSync(filePath, 'utf8');

  const badBodies = [
    ['provider-only', { provider: 'a' }],
    ['extra-key', { provider: 'a', model: 'm', preferred: true, extra: 1 }],
    ['non-bool', { provider: 'a', model: 'm', preferred: 'yes' }],
    ['empty-provider', { provider: '', model: 'm', preferred: true }],
    ['leading-dash', { provider: '-bad', model: 'm', preferred: true }],
  ];

  for (const [name, body] of badBodies) {
    const r = await httpJson(port, '/api/models/preferred', { method: 'POST', origin: 'http://' + loopbackHost, token, body });
    assert.equal(r.status, 400, name);
    assert.equal(readFileSync(filePath, 'utf8'), seededBytes);
  }
});

test('model routes: 405 with Allow header', async t => {
  const f = fixture(t);
  const server = createDashboardServer({ agentDir: f.dir });

  const r = await request(server, '/api/models/preferred', { method: 'PUT' });
  assert.equal(r.status, 405);
  assert.equal(r.headers['Allow'], 'GET, HEAD, POST');

  const r2 = await request(server, '/api/models/catalog', { method: 'POST' });
  assert.equal(r2.status, 405);
  assert.equal(r2.headers['Allow'], 'GET, HEAD');
});