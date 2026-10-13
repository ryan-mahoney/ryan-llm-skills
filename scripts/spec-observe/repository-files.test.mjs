import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync, readFileSync, lstatSync, symlinkSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createDashboardServer } from './dashboard.mjs';
import { setupStorage, createWorkspace } from '../workspaces/store.mjs';

// Real kit-authorized repository HTTP over createDashboardServer: every request
// re-reads the unique fresh kit, resolves the declared realpath and serves only
// Git-known names minus excluded components. Fixtures are temporary Git
// checkouts and disk storage; no internal authorization hook is injected.

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'repository-files-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

// Fixture Git configuration stays local to each invocation; nothing is written
// to the operator's global or system Git configuration. Literal pathspecs keep
// wildcard-looking fixture names staging exactly as written.
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  }).trim();
}

// `tracked` names are forced into the index before ignore rules are written, so
// a tracked name may later match an ignore pattern and must still be listed.
// `links` are tracked symlinks; literal pathspecs stage wildcard-looking names
// exactly as written.
function makeCheckout(base, name, { tracked = {}, untracked = {}, ignore = [], links = {} } = {}) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, bytes] of Object.entries(tracked)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  const addable = [...Object.keys(tracked), ...Object.keys(links)];
  if (addable.length) git(root, 'add', '-f', '--', ...addable);
  for (const [path, bytes] of Object.entries(untracked)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  if (ignore.length) {
    writeFileSync(join(root, '.gitignore'), `${ignore.join('\n')}\n`);
    git(root, 'add', '-f', '--', '.gitignore');
  }
  git(root, '-c', 'user.name=Repository Fixture', '-c', 'user.email=repository@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty');
  return realpathSync(root);
}

function writeKit(workspace, id, repositories) {
  writeFileSync(join(workspace, 'kit.yaml'), [
    'version: 1',
    `id: ${id}`,
    `name: ${id}`,
    ...(repositories.length
      ? ['repositories:', ...repositories.flatMap(({ id: repositoryId, path }) => [
        `  - id: ${repositoryId}`,
        `    path: ${JSON.stringify(path)}`,
      ])]
      : ['repositories: []']),
    '',
  ].join('\n'));
}

const listingPath = (id, repository) => `/api/repository-files?${new URLSearchParams({ id, repository })}`;
const filePath = (id, repository, file) => `/api/repository-file?${new URLSearchParams({ id, repository, file })}`;

async function startServer(t, options) {
  const server = createDashboardServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

function call(port, path, { host, origin, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method,
      headers: { ...(host !== undefined ? { host } : {}), ...(origin !== undefined ? { origin } : {}), ...headers } },
      incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: incoming.statusCode, headers: incoming.headers, bytes, body: bytes.toString('utf8') });
      });
      });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

// Run independently: node --test --test-name-pattern='serves tracked plus untracked-not-ignored' scripts/spec-observe/repository-files.test.mjs
test('repository listing serves tracked plus untracked-not-ignored names and bytes while excluded and ignored names are refused', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const checkout = makeCheckout(base, 'checkout', {
    tracked: {
      'tracked.md': '# Tracked\n',
      'nested/inside.txt': 'nested bytes\n',
      'legacy.log': 'tracked now-ignored bytes\n',
      '.env': 'SECRET_ENV=fixture\n',
    },
    untracked: {
      'untracked.txt': 'untracked bytes\n',
      'notes.md': 'ignored notes bytes\n',
    },
    ignore: ['*.log', 'notes.md'],
  });
  writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const listing = await call(port, listingPath('writer', 'docs'));
  assert.equal(listing.status, 200);
  assert.deepEqual(JSON.parse(listing.body).files.map(entry => entry.name).sort(), [
    '.gitignore', 'legacy.log', 'nested/inside.txt', 'tracked.md', 'untracked.txt',
  ]);

  const served = [
    ['tracked.md', '# Tracked\n'],
    ['nested/inside.txt', 'nested bytes\n'],
    ['untracked.txt', 'untracked bytes\n'],
    ['legacy.log', 'tracked now-ignored bytes\n'],
  ];
  for (const [name, bytes] of served) {
    const read = await call(port, filePath('writer', 'docs', name));
    assert.equal(read.status, 200, name);
    assert.equal(read.body, bytes, name);
  }
  for (const name of ['.env', 'notes.md']) {
    const refused = await call(port, filePath('writer', 'docs', name));
    assert.equal(refused.status, 503, name);
    assert.doesNotMatch(refused.body, /SECRET_ENV=fixture|ignored notes bytes/, name);
  }
});

// Run independently: node --test --test-name-pattern='refuse unknown kit and repository ids' scripts/spec-observe/repository-files.test.mjs
test('repository routes refuse unknown kit and repository ids with the coarse 503 and no checkout bytes', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const checkout = makeCheckout(base, 'checkout', { tracked: { 'secret.txt': 'checkout secret bytes\n' } });
  writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const refusals = [
    listingPath('writer', 'ghost'),
    filePath('writer', 'ghost', 'secret.txt'),
    listingPath('ghost', 'docs'),
    filePath('ghost', 'docs', 'secret.txt'),
  ];
  for (const path of refusals) {
    const refused = await call(port, path);
    assert.equal(refused.status, 503, path);
    assert.doesNotMatch(refused.body, /checkout secret bytes/, path);
  }
});

// Run independently: node --test --test-name-pattern='refuse a non-Git root' scripts/spec-observe/repository-files.test.mjs
test('repository routes refuse a non-Git root and a declared checkout subdirectory', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const plain = join(base, 'plain');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'plain.txt'), 'not a checkout\n');
  const checkout = makeCheckout(base, 'checkout', { tracked: { 'nested/inside.txt': 'nested bytes\n' } });
  writeKit(workspace, 'writer', [
    { id: 'plain', path: plain },
    { id: 'sub', path: join(checkout, 'nested') },
  ]);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const refusals = [
    [listingPath('writer', 'plain'), /not a checkout/],
    [filePath('writer', 'plain', 'plain.txt'), /not a checkout/],
    [listingPath('writer', 'sub'), /nested bytes/],
    [filePath('writer', 'sub', 'inside.txt'), /nested bytes/],
  ];
  for (const [path, secret] of refusals) {
    const refused = await call(port, path);
    assert.equal(refused.status, 503, path);
    assert.doesNotMatch(refused.body, secret, path);
  }
});

// Run independently: node --test --test-name-pattern='kit edits, removal and a duplicate kit id' scripts/spec-observe/repository-files.test.mjs
test('kit edits, removal and a duplicate kit id between requests reauthorize and never serve former checkout bytes', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const alpha = makeCheckout(base, 'alpha', {
    tracked: { 'tracked.md': 'alpha checkout bytes\n' },
    untracked: { 'only-alpha.txt': 'only alpha bytes\n' },
  });
  const beta = makeCheckout(base, 'beta', {
    tracked: { 'tracked.md': 'beta checkout bytes\n' },
    untracked: { 'only-beta.txt': 'only beta bytes\n' },
  });
  writeKit(workspace, 'writer', [{ id: 'docs', path: alpha }]);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const firstListing = await call(port, listingPath('writer', 'docs'));
  assert.equal(firstListing.status, 200);
  assert.ok(JSON.parse(firstListing.body).files.some(entry => entry.name === 'only-alpha.txt'));
  const firstRead = await call(port, filePath('writer', 'docs', 'tracked.md'));
  assert.equal(firstRead.status, 200);
  assert.equal(firstRead.body, 'alpha checkout bytes\n');

  // A kit edit between requests must reauthorize the declared path.
  writeKit(workspace, 'writer', [{ id: 'docs', path: beta }]);
  const editedListing = await call(port, listingPath('writer', 'docs'));
  assert.equal(editedListing.status, 200);
  const editedNames = JSON.parse(editedListing.body).files.map(entry => entry.name);
  assert.ok(editedNames.includes('only-beta.txt'));
  assert.equal(editedNames.includes('only-alpha.txt'), false, 'the former checkout name must not be served from memory');
  const editedRead = await call(port, filePath('writer', 'docs', 'tracked.md'));
  assert.equal(editedRead.status, 200);
  assert.equal(editedRead.body, 'beta checkout bytes\n');
  assert.doesNotMatch(editedRead.body, /alpha checkout bytes/);
  const formerRead = await call(port, filePath('writer', 'docs', 'only-alpha.txt'));
  assert.equal(formerRead.status, 503);
  assert.doesNotMatch(formerRead.body, /only alpha bytes/);

  // Removing the declared repository denies the same id and bytes.
  writeKit(workspace, 'writer', []);
  for (const path of [listingPath('writer', 'docs'), filePath('writer', 'docs', 'tracked.md')]) {
    const refused = await call(port, path);
    assert.equal(refused.status, 503, path);
    assert.doesNotMatch(refused.body, /beta checkout bytes/, path);
  }

  // Removing the kit itself denies the id entirely.
  rmSync(join(workspace, 'kit.yaml'));
  for (const path of [listingPath('writer', 'docs'), filePath('writer', 'docs', 'tracked.md')]) {
    const refused = await call(port, path);
    assert.equal(refused.status, 503, path);
    assert.doesNotMatch(refused.body, /beta checkout bytes/, path);
  }

  // A duplicate kit id makes the id ambiguous; deleting the duplicate restores it.
  writeKit(workspace, 'writer', [{ id: 'docs', path: beta }]);
  await createWorkspace(storageRoot, { id: 'writer-copy' });
  writeKit(join(storageRoot, 'projects', 'writer-copy'), 'writer', []);
  for (const path of [listingPath('writer', 'docs'), filePath('writer', 'docs', 'tracked.md')]) {
    const refused = await call(port, path);
    assert.equal(refused.status, 503, path);
    assert.doesNotMatch(refused.body, /beta checkout bytes/, path);
  }
  rmSync(join(storageRoot, 'projects', 'writer-copy'), { recursive: true, force: true });
  assert.equal((await call(port, listingPath('writer', 'docs'))).status, 200);
  assert.equal((await call(port, filePath('writer', 'docs', 'tracked.md'))).body, 'beta checkout bytes\n');
});

// Run independently: node --test --test-name-pattern='accepts the configured public host' scripts/spec-observe/repository-files.test.mjs
test('repository HTTP accepts the configured public host and refuses lookalikes without disclosing bytes', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const checkout = makeCheckout(base, 'checkout', { tracked: { 'tracked.md': 'public host bytes\n' } });
  writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
  const port = await startServer(t, { agentDir: base, storageRoot, publicHost: 'dashboard.example' });

  const paths = [listingPath('writer', 'docs'), filePath('writer', 'docs', 'tracked.md')];
  const loopback = [];
  for (const path of paths) {
    const response = await call(port, path);
    assert.equal(response.status, 200, path);
    loopback.push(response.body);
  }
  assert.equal(loopback[1], 'public host bytes\n');

  for (const variant of [{ host: 'dashboard.example' }, { host: 'dashboard.example:443', origin: 'https://dashboard.example' }]) {
    for (const [index, path] of paths.entries()) {
      const response = await call(port, path, variant);
      assert.equal(response.status, 200, `${JSON.stringify(variant)} ${path}`);
      assert.equal(response.body, loopback[index], `${JSON.stringify(variant)} ${path}`);
    }
  }

  for (const path of paths) {
    for (const host of ['evil-dashboard.example', 'dashboard.example.evil', 'dashboard.example:4319']) {
      const refused = await call(port, path, { host });
      assert.equal(refused.status, 403, `${host} ${path}`);
      assert.doesNotMatch(refused.body, /public host bytes/, `${host} ${path}`);
    }
  }
});

const EIGHT_MIB = 8 * 1024 * 1024;

// Recursive content/size/mtime snapshot for the non-mutation check: after
// fixture setup, reads must leave the checkout and storage as captured.
function snapshot(directory) {
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
}

// Run independently: node --test --test-name-pattern='tracked symlink and missing metadata' scripts/spec-observe/repository-files.test.mjs
test('repository listing marks tracked symlink and missing metadata unavailable while depth and size boundaries are refused', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const deep = (count, leaf) => join(...Array.from({ length: count }, (_, index) => `d${index + 1}`), leaf);
  const twelve = deep(12, 'ok.txt');
  const thirteen = deep(13, 'no.txt');
  const checkout = makeCheckout(base, 'checkout', {
    tracked: {
      'removed.txt': 'removed bytes\n',
      'inter-link/inner.txt': 'inner bytes\n',
      'real-dir/target.txt': 'target bytes\n',
      'sessions/private.txt': 'private bytes\n',
      [twelve]: 'depth twelve bytes\n',
      [thirteen]: 'depth thirteen bytes\n',
    },
    links: { 'final-link': 'real-dir/target.txt' },
    untracked: { 'ignored.tmp': 'ignored bytes\n' },
    ignore: ['ignored.tmp'],
  });
  rmSync(join(checkout, 'removed.txt'));
  rmSync(join(checkout, 'inter-link'), { recursive: true });
  symlinkSync('real-dir', join(checkout, 'inter-link'));
  writeFileSync(join(checkout, 'exact.bin'), '');
  writeFileSync(join(checkout, 'over.bin'), '');
  truncateSync(join(checkout, 'exact.bin'), EIGHT_MIB);
  truncateSync(join(checkout, 'over.bin'), EIGHT_MIB + 1);
  writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const listing = await call(port, listingPath('writer', 'docs'));
  assert.equal(listing.status, 200);
  const body = JSON.parse(listing.body);
  const byName = new Map(body.files.map(entry => [entry.name, entry]));
  assert.equal(byName.get(twelve)?.available, true);
  assert.equal(byName.get('exact.bin')?.available, true);
  assert.equal(byName.get('exact.bin')?.size, EIGHT_MIB);
  assert.equal(byName.get('over.bin')?.available, false);
  assert.equal(byName.get('over.bin')?.reason, 'Exceeds 8 MiB limit');
  for (const [name, reason] of [['removed.txt', 'Missing file'], ['final-link', 'Symbolic link'], ['inter-link/inner.txt', 'Symbolic link']]) {
    assert.equal(byName.get(name)?.available, false, name);
    assert.equal(byName.get(name)?.reason, reason, name);
  }
  assert.equal(byName.has(thirteen), false, 'over-depth names are omitted');
  assert.equal(byName.has('sessions/private.txt'), false, 'excluded components are omitted');
  assert.equal(body.truncated, true, 'depth omission marks truncated');
  assert.deepEqual(body.errors, [], 'known unavailable entries are not page errors');

  const twelveRead = await call(port, filePath('writer', 'docs', twelve));
  assert.equal(twelveRead.status, 200);
  assert.equal(twelveRead.body, 'depth twelve bytes\n');
  const exact = await call(port, filePath('writer', 'docs', 'exact.bin'));
  assert.equal(exact.status, 200);
  assert.equal(exact.bytes.length, EIGHT_MIB);
  const exactHead = await call(port, filePath('writer', 'docs', 'exact.bin'), { method: 'HEAD' });
  assert.equal(exactHead.status, 200);
  assert.equal(exactHead.bytes.length, 0);

  const refusals = [
    filePath('writer', 'docs', thirteen),
    filePath('writer', 'docs', '../escape.txt'),
    filePath('writer', 'docs', '..\\escape.txt'),
    filePath('writer', 'docs', '/etc/passwd'),
    filePath('writer', 'docs', 'ignored.tmp'),
    filePath('writer', 'docs', 'unknown.txt'),
    filePath('writer', 'docs', 'sessions/private.txt'),
    filePath('writer', 'docs', 'over.bin'),
    filePath('writer', 'docs', 'final-link'),
    filePath('writer', 'docs', 'inter-link/inner.txt'),
    filePath('writer', 'docs', 'removed.txt'),
  ];
  for (const path of refusals) {
    assert.equal((await call(port, path)).status, 503, path);
    assert.equal((await call(port, path, { method: 'HEAD' })).status, 503, `HEAD ${path}`);
  }
});

// Run independently: node --test --test-name-pattern='preserves unusual literal names' scripts/spec-observe/repository-files.test.mjs
test('repository listing preserves unusual literal names exactly once and reads their bytes', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const expected = new Map([
    ['dir with space/file name.txt', 'spaced bytes\n'],
    ['héllo-🚀.txt', 'unicode bytes\n'],
    ['new\nline.txt', 'newline bytes\n'],
    ['star*.txt', 'wildcard bytes\n'],
    ['star.txt', 'plain star bytes\n'],
    ['[bracket].txt', 'bracket bytes\n'],
    ['question?.txt', 'question bytes\n'],
    ['stable.txt', 'stable bytes\n'],
  ]);
  const checkout = makeCheckout(base, 'checkout', { tracked: Object.fromEntries(expected) });
  writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const listing = await call(port, listingPath('writer', 'docs'));
  assert.equal(listing.status, 200);
  const names = JSON.parse(listing.body).files.map(entry => entry.name);
  assert.equal(names.length, new Set(names).size, 'tracked names are emitted once');
  assert.equal(names.filter(name => name === 'stable.txt').length, 1);
  assert.deepEqual([...names].sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected) {
    const read = await call(port, filePath('writer', 'docs', name));
    assert.equal(read.status, 200, name);
    assert.equal(read.bytes.equals(Buffer.from(bytes)), true, name);
  }
  assert.equal((await call(port, filePath('writer', 'docs', 'star*.txt'))).body, 'wildcard bytes\n');
  assert.equal((await call(port, filePath('writer', 'docs', 'star.txt'))).body, 'plain star bytes\n');
});

// Run independently: node --test --test-name-pattern='pages 501 and 10001 names' scripts/spec-observe/repository-files.test.mjs
test('repository listing pages 501 and 10001 names with validated cursors on GET and HEAD', async t => {
  const makePagedFixture = async (base, count) => {
    const storageRoot = join(base, 'storage');
    await setupStorage(storageRoot);
    await createWorkspace(storageRoot, { id: 'writer' });
    const workspace = join(storageRoot, 'projects', 'writer');
    const checkout = makeCheckout(base, 'checkout');
    const padded = index => `bulk-${String(index).padStart(5, '0')}.txt`;
    for (let index = 0; index < count; index += 1) writeFileSync(join(checkout, padded(index)), '');
    writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
    const port = await startServer(t, { agentDir: base, storageRoot });
    return { padded, port };
  };

  const first = await makePagedFixture(fixture(t), 501);
  const page = await call(first.port, listingPath('writer', 'docs'));
  assert.equal(page.status, 200);
  const pageBody = JSON.parse(page.body);
  assert.equal(pageBody.files.length, 500);
  assert.equal(pageBody.files[0].name, first.padded(0));
  assert.equal(pageBody.files.at(-1).name, first.padded(499));
  assert.equal(pageBody.next_cursor, 500);
  assert.equal(pageBody.truncated, true);
  const last = await call(first.port, `${listingPath('writer', 'docs')}&cursor=500`);
  assert.equal(last.status, 200);
  const lastBody = JSON.parse(last.body);
  assert.equal(lastBody.files.length, 1);
  assert.equal(lastBody.files[0].name, first.padded(500));
  assert.equal(lastBody.next_cursor, null);
  assert.equal(lastBody.truncated, false);
  for (const cursor of ['-1', 'abc', '1.5', '10000']) {
    const path = `${listingPath('writer', 'docs')}&cursor=${encodeURIComponent(cursor)}`;
    assert.equal((await call(first.port, path)).status, 503, cursor);
    assert.equal((await call(first.port, path, { method: 'HEAD' })).status, 503, `HEAD ${cursor}`);
  }

  const capped = await makePagedFixture(fixture(t), 10001);
  const cappedFirst = await call(capped.port, listingPath('writer', 'docs'));
  assert.equal(JSON.parse(cappedFirst.body).files.length, 500);
  const cappedLast = await call(capped.port, `${listingPath('writer', 'docs')}&cursor=9500`);
  assert.equal(cappedLast.status, 200);
  const cappedLastBody = JSON.parse(cappedLast.body);
  assert.equal(cappedLastBody.files.length, 500);
  assert.equal(cappedLastBody.files.at(-1).name, capped.padded(9999));
  assert.equal(cappedLastBody.files.some(entry => entry.name === capped.padded(10000)), false);
  assert.equal(cappedLastBody.next_cursor, null);
  assert.equal(cappedLastBody.truncated, true, 'the 10000 cap stays truncated at the final page');
});

// Run independently: node --test --test-name-pattern='kind and sandbox contracts' scripts/spec-observe/repository-files.test.mjs
test('repository responses match kind and sandbox contracts with downloads and a stable checkout snapshot', async t => {
  const base = fixture(t);
  const storageRoot = join(base, 'storage');
  await setupStorage(storageRoot);
  await createWorkspace(storageRoot, { id: 'writer' });
  const workspace = join(storageRoot, 'projects', 'writer');
  const tricky = `it's "quoted"\nname.txt`;
  const unicodeName = 'nested/héllo-🚀.txt';
  const expected = new Map([
    ['readme.md', { type: 'text/plain; charset=utf-8', kind: 'markdown', bytes: Buffer.from('# Readme\n') }],
    ['data.json', { type: 'text/plain; charset=utf-8', kind: 'json', bytes: Buffer.from('{"a":1}\n') }],
    ['notes.txt', { type: 'text/plain; charset=utf-8', kind: 'text', bytes: Buffer.from('plain text\n') }],
    ['pixel.png', { type: 'image/png', kind: 'image', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }],
    ['page.html', { type: 'text/html; charset=utf-8', kind: 'html', bytes: Buffer.from('<h1>Hi</h1>\n') }],
    ['blob.bin', { type: 'application/octet-stream', kind: 'download', bytes: Buffer.from([0, 255, 1, 2]) }],
    ['nested/inside.txt', { type: 'text/plain; charset=utf-8', kind: 'text', bytes: Buffer.from('inside bytes\n') }],
    [unicodeName, { type: 'text/plain; charset=utf-8', kind: 'text', bytes: Buffer.from('unicode download bytes\n') }],
    [tricky, { type: 'text/plain; charset=utf-8', kind: 'text', bytes: Buffer.from('download bytes\n') }],
  ]);
  const checkout = makeCheckout(base, 'checkout', { tracked: Object.fromEntries([...expected].map(([name, value]) => [name, value.bytes])) });
  writeKit(workspace, 'writer', [{ id: 'docs', path: checkout }]);
  const before = snapshot(base);
  const port = await startServer(t, { agentDir: base, storageRoot });

  const listing = await call(port, listingPath('writer', 'docs'));
  assert.equal(listing.status, 200);
  assert.deepEqual(JSON.parse(listing.body).checkout, { repository: 'docs', branch: 'main' });
  const listingHead = await call(port, listingPath('writer', 'docs'), { method: 'HEAD' });
  assert.equal(listingHead.status, 200);
  assert.equal(listingHead.bytes.length, 0);

  for (const [name, value] of expected) {
    const read = await call(port, filePath('writer', 'docs', name));
    assert.equal(read.status, 200, name);
    assert.equal(read.headers['content-type'], value.type, name);
    assert.equal(read.headers['x-package-file-kind'], value.kind, name);
    assert.equal(read.headers['x-frame-options'], 'SAMEORIGIN', name);
    assert.match(read.headers['content-security-policy'], /sandbox allow-scripts/, name);
    assert.match(read.headers['content-security-policy'], /connect-src 'none'/, name);
    assert.doesNotMatch(read.headers['content-security-policy'], /allow-same-origin/, name);
    assert.equal(read.bytes.equals(value.bytes), true, name);
    const head = await call(port, filePath('writer', 'docs', name), { method: 'HEAD' });
    assert.equal(head.status, 200, name);
    assert.equal(head.bytes.length, 0, name);
    assert.equal(head.headers['content-type'], value.type, name);
    assert.equal(head.headers['x-package-file-kind'], value.kind, name);
    assert.match(head.headers['content-security-policy'], /sandbox allow-scripts/, name);
  }

  assert.equal((await call(port, filePath('writer', 'docs', 'blob.bin'))).headers['content-disposition'], 'attachment; filename="blob.bin"; filename*=UTF-8\'\'blob.bin');
  const downloaded = await call(port, `${filePath('writer', 'docs', tricky)}&download=1`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers['content-disposition'], 'attachment; filename="it\'s _quoted__name.txt"; filename*=UTF-8\'\'it%27s%20%22quoted%22%0Aname.txt');
  assert.equal((await call(port, `${filePath('writer', 'docs', 'nested/inside.txt')}&download=1`)).headers['content-disposition'], 'attachment; filename="inside.txt"; filename*=UTF-8\'\'inside.txt');
  const unicodeDownload = await call(port, `${filePath('writer', 'docs', unicodeName)}&download=1`);
  assert.equal(unicodeDownload.status, 200);
  assert.equal(unicodeDownload.headers['content-disposition'], `attachment; filename="h_llo-__.txt"; filename*=UTF-8''h%C3%A9llo-%F0%9F%9A%80.txt`);
  const unicodeHead = await call(port, `${filePath('writer', 'docs', unicodeName)}&download=1`, { method: 'HEAD' });
  assert.equal(unicodeHead.status, 200);
  assert.equal(unicodeHead.bytes.length, 0);
  assert.equal(unicodeHead.headers['content-disposition'], unicodeDownload.headers['content-disposition']);

  for (const method of ['POST', 'PUT']) {
    for (const path of [listingPath('writer', 'docs'), filePath('writer', 'docs', 'readme.md')]) {
      const refused = await call(port, path, { method });
      assert.equal(refused.status, 405, `${method} ${path}`);
      assert.equal(refused.headers.allow, 'GET, HEAD', `${method} ${path}`);
    }
  }

  assert.deepEqual(snapshot(base), before, 'reads leave the checkout and storage bytes and mtimes unchanged');
});
