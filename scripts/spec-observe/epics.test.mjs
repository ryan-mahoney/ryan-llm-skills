import test from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { makeFixture, put } from '../spec-location/fixture.mjs';
import { EPIC_LIMITS, buildEpics, changedMembers, deriveMemberStatus, epicWaitState, epicWaves, parseEpic, readWorkspaceEpics } from './epics.mjs';

const record = (extra = {}) => ({ schema_version: 1, epic: 'demo', title: 'Demo', state: 'active',
  packages: [{ package: 'a' }, { package: 'b', requires: ['a'] }], ...extra });

test('parseEpic accepts a valid record and keeps allowlisted fields', () => {
  const { epic, error } = parseEpic(record({ plan: 'demo.md', note: 'n', extra: 1,
    packages: [{ package: 'a', note: 'folded' }, { package: 'b', requires: ['a'] }] }), { slug: 'demo' });
  assert.equal(error, undefined);
  assert.deepEqual(epic.packages[0], { package: 'a', requires: [], note: 'folded' });
  assert.equal(epic.plan, 'demo.md');
  assert.equal('extra' in epic, false);
  assert.deepEqual(epic.designs, []);
});

test('parseEpic keeps design references by identity and rejects malformed ones', () => {
  const { epic } = parseEpic(record({ designs: [{ workspace: 'transitops', design: '02-route-ladders-split', path: '/store/projects/transitops/designs/02-route-ladders-split' }, { workspace: 'transitops', design: 'import' }] }), { slug: 'demo' });
  assert.deepEqual(epic.designs, [{ workspace: 'transitops', design: '02-route-ladders-split', path: '/store/projects/transitops/designs/02-route-ladders-split' }, { workspace: 'transitops', design: 'import', path: null }]);
  const bad = (designs, pattern) => assert.match(parseEpic(record({ designs }), { slug: 'demo' }).error ?? '', pattern);
  bad({}, /list of at most 20/);
  bad([{ design: 'x' }], /workspace and design slug/);
  bad([{ workspace: 'w', design: 'Bad Slug' }], /workspace and design slug/);
  bad([{ workspace: 'w', design: '2-route-ladders-split' }], /workspace and design slug/);
  bad([{ workspace: 'w', design: 'ok', path: 'relative' }], /not absolute/);
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
  bad(record({ packages: [{ package: 'a', requires: ['ghost'] }] }), /unknown package ghost/);
  bad(record({ packages: [{ package: 'a', requires: ['a'] }] }), /requires itself/);
  bad(record({ packages: [{ package: 'a', requires: ['c'] }, { package: 'b', requires: ['a'] }, { package: 'c', requires: ['b'] }, { package: 'd' }] }),
    /cycle among a, b, c$/);
  bad(record({ plan: '../../../outside.md' }), /plan escapes/);
  bad(record({ plan: '../../../../outside.md' }), /plan escapes/);
  bad(record({ plan: '/etc/passwd' }), /plan escapes/);
  bad(record({ packages: Array.from({ length: EPIC_LIMITS.members + 1 }, (_, i) => ({ package: `p${i}` })) }), /more than 100/);
  bad(null, /not an object/);
});

test('epicWaves places each member one wave after its latest requirement', () => {
  const member = (name, requires = []) => ({ package: name, requires });
  // d is listed before its requirement c; the wave comes from requires, not array order.
  const { waves } = epicWaves([member('a'), member('d', ['c']), member('b'), member('c', ['a', 'b']), member('e', ['a'])]);
  assert.deepEqual(waves, [['a', 'b'], ['c', 'e'], ['d']]);
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
  const member = (name, fact) => ({ path: `/s/projects/w/specs/${name}`, observed: true, exists: true, ...fact });
  const entry = {
    workspace: 'w', file: '/s/projects/w/epics/demo/epic.json', dir: '/s/projects/w/epics/demo', plan: '/s/projects/w/epics/demo/plan.md',
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
      member('e', { observed: false }),
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
  assert.equal(epic.plan, '/s/projects/w/epics/demo/plan.md');
  assert.deepEqual(epic.coverage, { state: 'partial', reasons: ['member-unobserved: e (w)'] });
  assert.deepEqual(memberships.get('/s/projects/w/specs/c'), { epic: 'demo', workspace: 'w', position: 3, total: 5 });

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
    { package: 'a', requires: [], note: null },
    { package: 'b', requires: ['a'], note: null },
    { package: 'c', requires: ['a'], note: null } ] };
  const member = (name, extra) => ({ path: `/s/projects/w/specs/${name}`, observed: true, exists: true, ...extra });
  const { epics } = buildEpics([{ slug: 'e', dir: '/s/projects/w/epics/e', file: '/s/projects/w/epics/e/epic.json', workspace: 'w', epic, members: [
    member('a', { hasReceipts: true, incomplete: true }),
    member('b', { completion: { completion_basis: 'merged-pr', completed_at: '2026-10-11T00:00:00Z' } }),
    member('c', { prepared: true }) ] }]);
  assert.deepEqual(epics[0].members.map(m => [m.name, m.status, m.waiting_on]), [['a', 'unknown', []], ['b', 'merged', []], ['c', 'prepared', ['a']]]);
  assert.equal(epics[0].summary.unknown, 1);
  assert.equal(epics[0].next, null);
});

// Run alone: node --test --test-name-pattern='epic plan resolves' scripts/spec-observe/epics.test.mjs
test('epic plan resolves to the epic directory first, else the workspace plans folder', async () => {
  const fx = makeFixture();
  try {
    for (const [slug, plan] of [['local', 'plan.md'], ['shared', 'shared.md']]) {
      put(join(fx.workspaceDir, 'epics', slug, 'epic.json'), JSON.stringify(record({ epic: slug, plan, packages: [{ package: 'a' }] })));
    }
    put(join(fx.workspaceDir, 'epics', 'local', 'plan.md'), '# plan\n');
    const { entries } = await readWorkspaceEpics('demo', fx.options);
    const plans = Object.fromEntries(entries.map(entry => [entry.slug, entry.plan]));
    assert.equal(plans.local, join(fx.workspaceDir, 'epics', 'local', 'plan.md'));
    assert.equal(plans.shared, join(fx.workspaceDir, 'plans', 'shared.md'));
  } finally { fx.cleanup(); }
});

test('epic wait wakes on status, attention or launched-session changes, not step progress', () => {
  const member = (name, extra = {}) => ({ name, package: `/s/specs/${name}`, status: 'in-progress', attention: false, step: { position: 1, total: 4 }, ...extra });
  const session = (pkg, display) => ({ assignment_id: 'a1', spec_package: `/s/specs/${pkg}`, display });
  const before = epicWaitState({ members: [member('a'), member('b'), member('c')] }, [session('c', 'live')]);
  const after = epicWaitState({ members: [member('a', { step: { position: 2, total: 4 } }), member('b', { status: 'published' }), member('c')] },
    [session('c', 'ended')]);
  assert.deepEqual(changedMembers(before, after), ['b', 'c']);
  assert.deepEqual(changedMembers(before, before), []);
  assert.deepEqual(changedMembers(before, epicWaitState({ members: [member('a', { attention: true }), member('b'), member('c')] }, [session('c', 'live')])), ['a']);
});
