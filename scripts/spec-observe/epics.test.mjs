import test from 'node:test';
import assert from 'node:assert/strict';

import { EPIC_LIMITS, buildEpics, deriveMemberStatus, parseEpic } from './epics.mjs';

const record = (extra = {}) => ({ schema_version: 1, epic: 'demo', title: 'Demo', state: 'active',
  packages: [{ package: 'a' }, { package: 'b', requires: ['a'] }], ...extra });

test('parseEpic accepts a valid record and keeps allowlisted fields', () => {
  const { epic, error } = parseEpic(record({ plan: '../_plans/demo.md', note: 'n', extra: 1,
    packages: [{ package: 'a', repository: '/repo/other', note: 'folded' }, { package: 'b', requires: ['a'] }] }), { slug: 'demo' });
  assert.equal(error, undefined);
  assert.deepEqual(epic.packages[0], { package: 'a', repository: '/repo/other', requires: [], note: 'folded' });
  assert.equal(epic.plan, '../_plans/demo.md');
  assert.equal('extra' in epic, false);
});

test('parseEpic rejects each invalid class with a short reason', () => {
  const bad = (value, pattern, slug = 'demo') => assert.match(parseEpic(value, { slug }).error ?? '', pattern);
  bad(record(), /does not match directory/, 'other');
  bad(record({ epic: 'Demo' }), /valid slug/, 'Demo');
  bad(record({ schema_version: 2 }), /schema_version/);
  bad(record({ state: 'done' }), /state/);
  bad(record({ title: '' }), /title/);
  bad(record({ packages: [{ package: 'a' }, { package: 'a' }] }), /duplicate package a/);
  bad(record({ packages: [{ package: '../x' }] }), /package name/);
  bad(record({ packages: [{ package: 'a', repository: 'relative' }] }), /not absolute/);
  bad(record({ packages: [{ package: 'a', requires: ['ghost'] }] }), /unknown package ghost/);
  bad(record({ packages: [{ package: 'a', requires: ['a'] }] }), /requires itself/);
  bad(record({ plan: '../../../outside.md' }), /plan escapes/);
  bad(record({ plan: '/etc/passwd' }), /plan escapes/);
  bad(record({ packages: Array.from({ length: EPIC_LIMITS.members + 1 }, (_, i) => ({ package: `p${i}` })) }), /more than 100/);
  bad(null, /not an object/);
});

test('deriveMemberStatus follows the contract table', () => {
  const status = input => deriveMemberStatus({ observed: true, exists: true, ...input }).status;
  assert.equal(status({ observed: false }), 'unobserved');
  assert.equal(status({ exists: false }), 'missing');
  assert.equal(status({ prepared: false }), 'proposed');
  assert.equal(status({ prepared: true }), 'prepared');
  assert.equal(status({ prepared: true, hasReceipts: true }), 'in-progress');
  assert.equal(status({ hasReceipts: true, completion: { completion_basis: 'ready-pr' } }), 'published');
  assert.equal(status({ completion: { completion_basis: 'workflow-checkpoint' } }), 'published');
  assert.equal(status({ hasReceipts: true, completion: { completion_basis: 'merged-pr' } }), 'merged');
  assert.equal(status({ completion: { completion_basis: 'manual' } }), 'complete');
});

test('attention comes only from the current run of an in-progress member', () => {
  const base = { exists: true, hasReceipts: true };
  const attention = run => deriveMemberStatus({ ...base, run }).attention;
  assert.equal(attention({ workflow_state: 'blocked' }), true);
  assert.equal(attention({ workflow_state: 'decision-required' }), true);
  assert.equal(attention({ conditions: [{ severity: 'attention', state: 'open' }] }), true);
  assert.equal(attention({ conditions: [{ severity: 'attention', state: 'resolved' }, { severity: 'info', state: 'open' }] }), false);
  assert.equal(attention(null), false);
  assert.equal(deriveMemberStatus({ ...base, completion: { completion_basis: 'merged-pr' }, run: { workflow_state: 'blocked' } }).attention, false);
});

test('buildEpics derives summary, waiting_on and next from member facts', () => {
  const member = (name, fact) => ({ path: `/r/.specs/${name}`, repository: '/r', observed: true, exists: true, ...fact });
  const entry = {
    repository: '/r', file: '/r/.specs/_epics/demo/epic.json', dir: '/r/.specs/_epics/demo',
    epic: { epic: 'demo', title: 'Demo', state: 'active', note: null, plan: 'plan.md', packages: [
      { package: 'a', requires: [], note: null }, { package: 'b', requires: ['a'], note: null },
      { package: 'c', requires: ['b'], note: null }, { package: 'd', requires: ['b'], note: 'later' },
      { package: 'e', requires: [], note: null },
    ] },
    members: [
      member('a', { completion: { completion_basis: 'merged-pr', completed_at: '2026-10-01T00:00:00.000Z', merge: { url: 'https://github.com/o/r/pull/1' } } }),
      member('b', { hasReceipts: true, run: { assignment_id: 'x', workflow_state: 'blocked', spec_progress: { current_position: 2, total_steps: 5 } } }),
      member('c', { prepared: true }),
      member('d', { exists: false }),
      member('e', { observed: false, repository: '/elsewhere' }),
    ],
  };
  const { epics, memberships } = buildEpics([entry]);
  const [epic] = epics;
  assert.deepEqual(epic.summary, { total: 5, merged: 1, complete: 0, published: 0, in_progress: 1, prepared: 1, proposed: 0, missing: 1, unobserved: 1, unknown: 0, attention: 1 });
  assert.deepEqual(epic.members.map(m => [m.name, m.status, m.waiting_on]), [
    ['a', 'merged', []], ['b', 'in-progress', []], ['c', 'prepared', ['b']], ['d', 'missing', ['b']], ['e', 'unobserved', []]]);
  assert.deepEqual(epic.members[1].step, { position: 2, total: 5 });
  assert.equal(epic.members[0].pr_url, 'https://github.com/o/r/pull/1');
  assert.equal(epic.next, null, 'the only prepared member still waits on an unlanded dependency');
  assert.equal(epic.plan, '/r/.specs/_epics/demo/plan.md');
  assert.deepEqual(epic.coverage, { state: 'partial', reasons: ['member-unobserved: e (/elsewhere)'] });
  assert.deepEqual(memberships.get('/r/.specs/c'), { epic: 'demo', repository: '/r', position: 3, total: 5 });

  entry.members[1] = member('b', { completion: { completion_basis: 'manual', completed_at: '2026-10-02T00:00:00.000Z' } });
  const landed = buildEpics([entry]).epics[0];
  assert.equal(landed.next, 'c', 'first prepared member in array order once its requirements landed');
  assert.deepEqual(landed.members[2].waiting_on, []);
});

// Run alone: node --test --test-name-pattern='incomplete receipts' scripts/spec-observe/epics.test.mjs
test('incomplete receipts yield unknown unless a completion is recorded, and landed members wait on nothing', () => {
  assert.equal(deriveMemberStatus({ exists: true, prepared: true, hasReceipts: false, incomplete: true }).status, 'unknown');
  assert.equal(deriveMemberStatus({ exists: true, incomplete: true, completion: { completion_basis: 'merged-pr' } }).status, 'merged');
  const epic = { epic: 'e', title: 'E', state: 'active', plan: null, note: null, packages: [
    { package: 'a', repository: null, requires: [], note: null },
    { package: 'b', repository: null, requires: ['a'], note: null },
    { package: 'c', repository: null, requires: ['a'], note: null } ] };
  const member = (name, extra) => ({ path: `/r/.specs/${name}`, repository: '/r', observed: true, exists: true, ...extra });
  const { epics } = buildEpics([{ slug: 'e', dir: '/r/.specs/_epics/e', file: '/r/.specs/_epics/e/epic.json', repository: '/r', epic, members: [
    member('a', { hasReceipts: true, incomplete: true }),
    member('b', { completion: { completion_basis: 'merged-pr', completed_at: '2026-10-11T00:00:00Z' } }),
    member('c', { prepared: true }) ] }]);
  assert.deepEqual(epics[0].members.map(m => [m.name, m.status, m.waiting_on]), [['a', 'unknown', []], ['b', 'merged', []], ['c', 'prepared', ['a']]]);
  assert.equal(epics[0].summary.unknown, 1);
  assert.equal(epics[0].next, null);
});
