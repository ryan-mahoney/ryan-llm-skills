import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createSnapshotPublisher } from './sentinel-snapshot.mjs';
import { OBSERVER_RETENTION_MS } from '../../../scripts/spec-observe/observer-retention.mjs';
// Run independently: node --test pi/extensions/spec-runtime/sentinel-snapshot.test.mjs
const at = Date.parse('2026-10-12T12:00:00.000Z');
const now = () => at;
function publisherFixture(t) {
  const agentDir = mkdtempSync(join(tmpdir(), 'sentinel-snapshot-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return createSnapshotPublisher({ agentDir, scope: 'retention-test', now });
}
test('observing publish resolves and writes a parseable observer envelope', async t => {
  const publisher = publisherFixture(t);
  await publisher.publish({ state: 'observing', mode: 'watch', snapshot: { runs: [] } });
  const value = JSON.parse(readFileSync(publisher.path, 'utf8'));
  assert.equal(value.schema_version, 1);
  assert.equal(typeof value.observer_id, 'string');
  assert.equal(value.state, 'observing');
});
test('closed publish keeps the observer identity and schema version', async t => {
  const publisher = publisherFixture(t);
  await publisher.publish({ state: 'observing', mode: 'watch', snapshot: { runs: [] } });
  const first = JSON.parse(readFileSync(publisher.path, 'utf8'));
  await publisher.publish({ state: 'closed', mode: 'watch', snapshot: { runs: [] } });
  const second = JSON.parse(readFileSync(publisher.path, 'utf8'));
  assert.equal(second.observer_id, first.observer_id);
  assert.equal(second.schema_version, 1);
  assert.equal(second.state, 'closed');
});
test('publish prunes an expired sibling and keeps a fresh sibling', async t => {
  const publisher = publisherFixture(t);
  await publisher.publish({ state: 'observing', mode: 'watch', snapshot: { runs: [] } });
  const directory = dirname(publisher.path);
  const expired = join(directory, 'expired-observing.json');
  const fresh = join(directory, 'fresh-observing.json');
  writeFileSync(expired, JSON.stringify({ published_at: new Date(at - OBSERVER_RETENTION_MS - 1).toISOString() }));
  writeFileSync(fresh, JSON.stringify({ published_at: new Date(at).toISOString() }));
  utimesSync(expired, new Date(at - OBSERVER_RETENTION_MS * 2), new Date(at - OBSERVER_RETENTION_MS * 2));
  utimesSync(fresh, new Date(at), new Date(at));
  await publisher.publish({ state: 'observing', mode: 'watch', snapshot: { runs: [] } });
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(fresh), true);
});
