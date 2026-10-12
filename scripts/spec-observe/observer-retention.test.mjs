import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OBSERVER_RETENTION_MS, observerExpired, pruneExpiredObservers } from './observer-retention.mjs';
// Run independently: node --test scripts/spec-observe/observer-retention.test.mjs
const at = Date.parse('2026-10-12T12:00:00.000Z');
const old = new Date(at - OBSERVER_RETENTION_MS * 2);
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'observer-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function snapshot(dir, name, publishedAt, { mtime = new Date(), content = null } = {}) {
  const path = join(dir, name);
  writeFileSync(path, content ?? JSON.stringify({ published_at: new Date(publishedAt).toISOString() }));
  utimesSync(path, mtime, mtime);
  return path;
}
test('observerExpired returns false exactly at the retention boundary and true one millisecond beyond', () => {
  assert.equal(observerExpired({ published_at: new Date(at - OBSERVER_RETENTION_MS).toISOString() }, at), false);
  assert.equal(observerExpired({ published_at: new Date(at - OBSERVER_RETENTION_MS - 1).toISOString() }, at), true);
});
test('observerExpired returns false for missing, non-string and unparseable published_at', () => {
  assert.equal(observerExpired({}, at), false);
  assert.equal(observerExpired({ published_at: 123 }, at), false);
  assert.equal(observerExpired({ published_at: 'not-a-date' }, at), false);
});
test('pruneExpiredObservers removes an expired snapshot and returns its basename', async t => {
  const dir = tempDir(t);
  snapshot(dir, 'expired.json', at - OBSERVER_RETENTION_MS - 1, { mtime: old });
  assert.deepEqual(await pruneExpiredObservers(dir, { at }), ['expired.json']);
  assert.equal(existsSync(join(dir, 'expired.json')), false);
});
test('pruneExpiredObservers keeps fresh, own, unclassifiable and non-json entries', async t => {
  const dir = tempDir(t);
  snapshot(dir, 'fresh-live.json', at - 1000);
  snapshot(dir, 'fresh-old-mtime.json', at - 1000, { mtime: old });
  const own = snapshot(dir, 'own-expired.json', at - OBSERVER_RETENTION_MS - 1, { mtime: old });
  snapshot(dir, 'broken.json', at, { mtime: old, content: '{' });
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'ignored');
  utimesSync(notes, old, old);
  assert.deepEqual(await pruneExpiredObservers(dir, { at, except: own }), []);
  for (const name of ['fresh-live.json', 'fresh-old-mtime.json', 'own-expired.json', 'broken.json', 'notes.txt'])
    assert.equal(existsSync(join(dir, name)), true);
});
test('pruneExpiredObservers returns an empty list for a missing directory', async t => {
  const dir = tempDir(t);
  assert.deepEqual(await pruneExpiredObservers(join(dir, 'missing'), { at }), []);
});
