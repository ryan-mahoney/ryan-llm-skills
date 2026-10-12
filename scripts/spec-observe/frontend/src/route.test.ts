import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHash, parseHash, routeHistoryMode, type RouteState } from './route';
import {
  clearIncompatibleFields,
  firstUnmatchedTargetId,
  inWorkspaceScope,
  needsWorkspacePicker,
  requiresWorkspace,
  scopeLabel,
  targetRepositoryId,
  withWorkspace,
  type CatalogEntry,
} from './scope';

test('route round trip preserves every supported field including encoded slash, spaces and non-ASCII text', () => {
  const route: RouteState = {
    dest: 'files',
    ws: 'alpha',
    id: 'fixture/browser',
    tab: 'activity',
    source: 'spec',
    path: 'docs/café notes.md',
    filter: 'open',
    q: '',
  };
  assert.deepEqual(parseHash(formatHash(route)), route);
  assert.equal(
    formatHash(route),
    '#/files?ws=alpha&id=fixture%2Fbrowser&tab=activity&source=spec&path=docs%2Fcaf%C3%A9+notes.md&filter=open&q=',
  );
  assert.deepEqual(
    parseHash('#/files?ws=alpha&id=fixture%2Fbrowser&tab=activity&source=spec&path=docs%2Fcaf%C3%A9+notes.md&filter=open&q='),
    route,
  );
  assert.deepEqual(parseHash('#/specs?q=&id='), { dest: 'specs', id: '', q: '' });
});

test('unknown destinations and parameters canonicalize to the Specs landing route', () => {
  assert.deepEqual(parseHash(''), { dest: 'specs' });
  assert.deepEqual(parseHash('#/'), { dest: 'specs' });
  assert.deepEqual(parseHash('#/unknown?id=7&ws=alpha'), { dest: 'specs' });
  assert.deepEqual(parseHash('#/specs?zoom=2&id=fixture%2Fbrowser'), { dest: 'specs', id: 'fixture/browser' });
  assert.equal(formatHash({ dest: 'unknown' } as unknown as RouteState), '#/specs');
  assert.equal(formatHash({ dest: 'specs', zoom: '2' } as unknown as RouteState), '#/specs');
  assert.equal(formatHash({ dest: 'specs', id: undefined }), '#/specs');
  assert.equal(formatHash({ dest: 'specs', q: '' }), '#/specs?q=');
  assert.equal(formatHash(parseHash('#/specs?zoom=2&id=fixture%2Fbrowser')), '#/specs?id=fixture%2Fbrowser');
});

test('history policy pushes deliberate field changes and replaces query, filter, equal and fallback selections', () => {
  const base: RouteState = { dest: 'specs', ws: 'alpha', id: 'pkg', tab: 'overview', source: 'spec', path: 'a/b', filter: 'active', q: 'needle' };
  assert.equal(routeHistoryMode(base, { ...base, dest: 'epics' }), 'push');
  assert.equal(routeHistoryMode(base, { ...base, ws: 'beta' }), 'push');
  assert.equal(routeHistoryMode(base, { ...base, id: 'other' }), 'push');
  assert.equal(routeHistoryMode(base, { ...base, tab: 'activity' }), 'push');
  assert.equal(routeHistoryMode(base, { ...base, source: 'workspace' }), 'push');
  assert.equal(routeHistoryMode(base, { ...base, path: 'c/d' }), 'push');
  assert.equal(routeHistoryMode(base, { ...base, q: 'other' }), 'replace');
  assert.equal(routeHistoryMode(base, { ...base, filter: 'completed', q: 'other' }), 'replace');
  assert.equal(routeHistoryMode(base, { ...base }), 'replace');
  assert.equal(routeHistoryMode(base, { ...base, id: 'fallback' }, { fallback: true }), 'replace');
});

const catalog: CatalogEntry[] = [
  { id: 'alpha', directory: '/data/physical' },
  { id: 'physical', directory: '/data/alpha' },
];

test('runs and epics match the selected entry directory basename while assignments match the kit id only', () => {
  assert.equal(inWorkspaceScope({ workspace: 'physical' }, 'run', 'alpha', catalog), true);
  assert.equal(inWorkspaceScope({ workspace: 'alpha' }, 'run', 'alpha', catalog), false);
  assert.equal(inWorkspaceScope({ workspace: 'physical' }, 'epic', 'alpha', catalog), true);
  assert.equal(inWorkspaceScope({ workspace: 'alpha' }, 'epic', 'alpha', catalog), false);
  assert.equal(inWorkspaceScope({ workspace_id: 'alpha' }, 'assignment', 'alpha', catalog), true);
  assert.equal(inWorkspaceScope({ workspace_id: 'physical' }, 'assignment', 'alpha', catalog), false);
  assert.equal(inWorkspaceScope({ workspace: 'physical' }, 'assignment', 'alpha', catalog), false);
  assert.equal(inWorkspaceScope({ workspace: 'physical', workspace_id: 'physical' }, 'assignment', 'alpha', catalog), false);
  assert.equal(inWorkspaceScope({ workspace: 'physical' }, 'run', 'missing', catalog), false);
});

test('a neighboring kit whose id equals the entry basename cannot cross-match either record kind', () => {
  assert.equal(inWorkspaceScope({ workspace: 'alpha' }, 'run', 'physical', catalog), true);
  assert.equal(inWorkspaceScope({ workspace: 'physical' }, 'run', 'physical', catalog), false);
  assert.equal(inWorkspaceScope({ workspace: 'alpha' }, 'epic', 'physical', catalog), true);
  assert.equal(inWorkspaceScope({ workspace: 'physical' }, 'epic', 'physical', catalog), false);
  assert.equal(inWorkspaceScope({ workspace_id: 'physical' }, 'assignment', 'physical', catalog), true);
  assert.equal(inWorkspaceScope({ workspace_id: 'alpha' }, 'assignment', 'physical', catalog), false);
  assert.equal(inWorkspaceScope({ workspace: 'alpha', workspace_id: 'alpha' }, 'assignment', 'physical', catalog), false);
});

test('portfolio scope retains unmatched records with the unmatched record target repository label', () => {
  assert.equal(inWorkspaceScope({ workspace: 'elsewhere' }, 'run', undefined, catalog), true);
  assert.equal(inWorkspaceScope({ workspace_id: 'elsewhere' }, 'assignment', undefined, catalog), true);
  assert.equal(inWorkspaceScope({ workspace: 'elsewhere' }, 'run', 'alpha', catalog), false);
  // Kit id (alpha), directory basename (physical) and target repository id
  // (agents) are three distinct identities; the portfolio qualification must
  // use the unmatched record's target repository id, never the kit identity.
  const unmatchedRun = { workspace: 'elsewhere', targets: [{ id: 'agents', primary: '/data/agents' }] };
  assert.equal(targetRepositoryId(unmatchedRun), 'agents');
  assert.equal(targetRepositoryId({ workspace: 'elsewhere' }), undefined);
  assert.equal(firstUnmatchedTargetId([unmatchedRun], 'run', catalog), 'agents');
  assert.equal(firstUnmatchedTargetId([{ workspace: 'physical', targets: [{ id: 'agents' }] }], 'run', catalog), undefined);
  assert.equal(firstUnmatchedTargetId([{ workspace_id: 'alpha', targets: [{ id: 'agents' }] }], 'assignment', catalog), undefined);
  assert.equal(scopeLabel(undefined, catalog, 'agents'), 'All workspaces · agents');
  assert.equal(scopeLabel(undefined, catalog), 'All workspaces');
  assert.equal(scopeLabel(undefined, []), 'All workspaces');
  assert.equal(scopeLabel(undefined, [], 'agents'), 'All workspaces · agents');
  assert.equal(scopeLabel('alpha', catalog), 'alpha');
  assert.equal(scopeLabel('alpha', [{ id: 'alpha', directory: '/data/physical', name: 'Alpha kit' }]), 'Alpha kit');
  assert.equal(scopeLabel('missing', catalog), 'missing');
});

test('workspace-required destinations request a picker and scope changes clear incompatible selection', () => {
  for (const dest of ['conversations', 'designs', 'files'] as const) {
    assert.equal(requiresWorkspace(dest), true);
    assert.equal(needsWorkspacePicker({ dest }), true);
    assert.equal(needsWorkspacePicker({ dest, ws: 'alpha' }), false);
  }
  for (const dest of ['specs', 'epics', 'agents', 'workspaces'] as const) {
    assert.equal(requiresWorkspace(dest), false);
    assert.equal(needsWorkspacePicker({ dest }), false);
  }
  const route: RouteState = {
    dest: 'files',
    ws: 'alpha',
    id: 'pkg',
    tab: 'overview',
    source: 'spec',
    path: 'docs/a.md',
    filter: 'open',
    q: 'needle',
  };
  const original = { ...route };
  assert.deepEqual(withWorkspace(route, 'beta'), { dest: 'files', ws: 'beta', tab: 'overview', filter: 'open', q: 'needle' });
  assert.deepEqual(clearIncompatibleFields(route), { dest: 'files', ws: 'alpha', tab: 'overview', filter: 'open', q: 'needle' });
  assert.deepEqual(route, original);
});
