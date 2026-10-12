import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogRead, materialContents, unavailableArtifacts, workspaceAnnouncements } from './workspace-state';

test('structured catalog failures retain absent rows and expose partial readable results', () => {
  const retained = { valid: [{ id: 'A', directory: '/projects/A' }, { id: 'B', directory: '/projects/B' }] };
  const diagnostic = { path: '/storage/projects', message: 'EACCES' };
  for (const status of ['unreadable', 'invalid_root', 'invalid_projects', 'missing_root']) {
    const read = catalogRead({ storage: { status, errors: [diagnostic] }, valid: [], errors: [diagnostic] }, retained);
    assert.equal(read.degraded, true, status);
    assert.deepEqual(read.catalog.valid, retained.valid, status);
  }
  for (const failures of [{ errors: [diagnostic] }, { storage: { status: 'ok', errors: [diagnostic] } }]) {
    const read = catalogRead({ storage: { status: 'ok', errors: [] }, valid: [{ id: 'B', directory: '/projects/B', name: 'updated' }, { id: 'C', directory: '/projects/C' }], ...failures }, retained);
    assert.equal(read.degraded, true);
    assert.deepEqual(read.catalog.valid, [{ id: 'B', directory: '/projects/B', name: 'updated' }, { id: 'C', directory: '/projects/C' }, { id: 'A', directory: '/projects/A' }]);
  }
});

test('complete empty catalogs and missing_projects setup diagnostics establish absence', () => {
  const retained = { valid: [{ id: 'A', directory: '/projects/A' }] };
  for (const value of [
    { storage: { status: 'ok', errors: [] }, valid: [], errors: [] },
    { storage: { status: 'missing_projects', errors: [] }, valid: [], errors: [{ path: '/storage/projects', message: 'missing_projects' }] },
  ]) {
    assert.equal(catalogRead(value, retained).degraded, false);
    assert.deepEqual(catalogRead(value, retained).catalog.valid, []);
  }
  assert.equal(catalogRead({ storage: { status: 'missing_projects' }, valid: [], errors: [{ message: 'EACCES' }] }, retained).degraded, true);
});

// Run: node --import tsx --test src/destinations/workspace-state.test.ts
test('unavailable artifacts degrade coverage but legitimate external URLs do not', () => {
  const artifacts = [
    { path: 'malformed.json', status: 'unreadable', reason: 'malformed JSON' },
    { kind: 'repository', path: 'missing.json', status: 'missing' },
    { kind: 'repository', path: 'outside.json', status: 'outside_root' },
    { kind: 'repository', path: 'repository.json', status: 'repository_unavailable' },
    { kind: 'repository', path: 'healthy.json', status: 'ok' },
    { kind: 'url', target: 'https://example.com', status: 'external' },
  ];
  assert.deepEqual(unavailableArtifacts({ artifacts }).map(item => item.path),
    ['malformed.json', 'missing.json', 'outside.json', 'repository.json']);
  assert.deepEqual(unavailableArtifacts({ artifacts: artifacts.slice(4) }), []);
});

test('unread material collections never claim an observed empty count', () => {
  const workspace = { briefs: [], notes: [], attention: ['briefs_unreadable', 'notes_unreadable'] };
  assert.equal(materialContents(workspace, 'briefs'), 'Briefs unavailable — collection could not be read');
  assert.equal(materialContents(workspace, 'notes'), 'Notes unavailable — collection could not be read');
  assert.equal(materialContents({ briefs: [], notes: [] }, 'briefs'), '0 saved briefs');
  assert.equal(materialContents({ notes: ['note.md'] }, 'notes'), '1 saved note');
});

test('picker unchanged delayed polls announce checking once and retain meaningful recovery', () => {
  const announce = workspaceAnnouncements();
  assert.equal(announce('', 'Choose a workspace.'), 'Choose a workspace.');
  assert.equal(announce('', 'Checking workspaces.', 'catalog'), 'Checking workspaces.');
  assert.equal(announce('', 'Choose a workspace.'), 'Choose a workspace.');
  for (let poll = 0; poll < 3; poll++) {
    assert.equal(announce('', 'Checking workspaces.', 'catalog'), '');
    assert.equal(announce('', 'Choose a workspace.'), '');
  }
  assert.equal(announce('', 'Workspaces could not be read.'), 'Workspaces could not be read.');
  assert.equal(announce('', 'Choose a workspace.'), 'Choose a workspace.');
  assert.equal(announce('', 'Workspace coverage incomplete.'), 'Workspace coverage incomplete.');
});

test('shared announcement policy keeps workspace identity and pane transition priority', () => {
  const announce = workspaceAnnouncements();
  assert.equal(announce('Workspace A available.', 'Choose a workspace.'), 'Workspace A available.');
  assert.equal(announce('Checking workspace A.', 'Choose a workspace.', 'A'), 'Checking workspace A.');
  assert.equal(announce('Workspace A available.', 'Choose a workspace.'), 'Workspace A available.');
  assert.equal(announce('Checking workspace A.', 'Choose a workspace.', 'A'), '');
  assert.equal(announce('Workspace A available.', 'Choose a workspace.'), '');
  assert.equal(announce('Checking workspace B.', 'Choose a workspace.', 'B'), 'Checking workspace B.');
  assert.equal(announce('Workspace B coverage is incomplete.', 'Choose a workspace.'), 'Workspace B coverage is incomplete.');
});
