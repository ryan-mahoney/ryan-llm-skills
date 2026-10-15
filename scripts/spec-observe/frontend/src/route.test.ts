import assert from 'node:assert/strict';
import { test } from 'node:test';
import { busyAgentsHref, formatHash, parseHash, routeHistoryMode, subscribeRoute, type RouteState } from './route';
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

test('unknown destinations and parameters canonicalize to the Next steps landing route', () => {
  assert.deepEqual(parseHash(''), { dest: 'next-steps' });
  assert.deepEqual(parseHash('#/'), { dest: 'next-steps' });
  assert.deepEqual(parseHash('#/unknown?id=7&ws=alpha'), { dest: 'next-steps' });
  assert.deepEqual(parseHash('#/specs?zoom=2&id=fixture%2Fbrowser'), { dest: 'specs', id: 'fixture/browser' });
  assert.equal(formatHash({ dest: 'unknown' } as unknown as RouteState), '#/next-steps');
  assert.equal(formatHash({ dest: 'specs', zoom: '2' } as unknown as RouteState), '#/specs');
  assert.equal(formatHash({ dest: 'specs', id: undefined }), '#/specs');
  assert.equal(formatHash({ dest: 'specs', q: '' }), '#/specs?q=');
  assert.equal(formatHash(parseHash('#/specs?zoom=2&id=fixture%2Fbrowser')), '#/specs?id=fixture%2Fbrowser');
});

test('valid destinations and scope/query parameters keep their behavior despite the Next steps fallback', () => {
  assert.deepEqual(parseHash('#/specs?ws=alpha&filter=attention'), { dest: 'specs', ws: 'alpha', filter: 'attention' });
  const nextSteps: RouteState = { dest: 'next-steps', ws: 'alpha', filter: 'critique', q: 'needle' };
  const nextStepsHash = '#/next-steps?ws=alpha&filter=critique&q=needle';
  assert.deepEqual(parseHash(nextStepsHash), nextSteps);
  assert.equal(formatHash(nextSteps), nextStepsHash);
  assert.equal(formatHash(parseHash(nextStepsHash)), nextStepsHash);
  assert.equal(formatHash({ dest: 'next-steps', ws: 'alpha' }), '#/next-steps?ws=alpha');
  assert.deepEqual(parseHash('#/unknown?ws=alpha'), { dest: 'next-steps' });
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

type FakeDom = {
  location: { hash: string };
  replaced: string[];
  dispatch: (type: 'hashchange' | 'popstate') => void;
  listenerTypes: () => string[];
  restore: () => void;
};

function installFakeDom(hash: string): FakeDom {
  const previous = ['window', 'location', 'history'].map(name => ({
    name,
    present: name in globalThis,
    value: Reflect.get(globalThis, name),
  }));
  const handlers = new Map<string, Set<() => void>>();
  const location = { hash };
  const replaced: string[] = [];
  Object.assign(globalThis, {
    window: {
      addEventListener: (type: string, handler: () => void) => {
        const entries = handlers.get(type) ?? new Set<() => void>();
        entries.add(handler);
        handlers.set(type, entries);
      },
      removeEventListener: (type: string, handler: () => void) => {
        handlers.get(type)?.delete(handler);
      },
    },
    location,
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        replaced.push(url);
        location.hash = url;
      },
    },
  });
  return {
    location,
    replaced,
    dispatch: type => {
      const entries = handlers.get(type);
      if (entries) for (const handler of entries) handler();
    },
    listenerTypes: () => [...handlers.entries()].filter(([, entries]) => entries.size > 0).map(([type]) => type).sort(),
    restore: () => {
      for (const entry of previous) {
        if (entry.present) Object.assign(globalThis, { [entry.name]: entry.value });
        else Reflect.deleteProperty(globalThis, entry.name);
      }
    },
  };
}

test('native hash events replace unsupported parameters without re-emitting unchanged supported state', () => {
  const dom = installFakeDom('#/files?ws=fixture&id=fixture%2Fbrowser&unknown=ignored');
  const observed: RouteState[] = [];
  const unsubscribe = subscribeRoute(value => observed.push(value));
  try {
    assert.deepEqual(observed, [{ dest: 'files', ws: 'fixture', id: 'fixture/browser' }]);
    dom.dispatch('hashchange');
    assert.deepEqual(dom.replaced, ['#/files?ws=fixture&id=fixture%2Fbrowser']);
    assert.equal(dom.location.hash, '#/files?ws=fixture&id=fixture%2Fbrowser');
    assert.equal(observed.length, 1, 'canonicalizing an unsupported parameter must not re-emit unchanged supported state');
  } finally {
    unsubscribe();
    dom.restore();
  }
  assert.deepEqual(dom.listenerTypes(), []);
});

test('native hash and popstate inputs normalize unknown destinations and unsupported parameters to canonical routes', () => {
  const dom = installFakeDom('#/specs?ws=fixture&id=first');
  const observed: RouteState[] = [];
  const unsubscribe = subscribeRoute(value => observed.push(value));
  try {
    dom.location.hash = '#/unknown?id=7&ws=fixture';
    dom.dispatch('hashchange');
    assert.deepEqual(dom.replaced, ['#/next-steps']);
    assert.equal(dom.location.hash, '#/next-steps');
    assert.deepEqual(observed.at(-1), { dest: 'next-steps' });

    dom.location.hash = '#/epics?ws=fixture&id=second&unsupported=1';
    dom.dispatch('popstate');
    assert.deepEqual(dom.replaced, ['#/next-steps', '#/epics?ws=fixture&id=second']);
    assert.deepEqual(observed.at(-1), { dest: 'epics', ws: 'fixture', id: 'second' });

    dom.location.hash = '#/specs?ws=fixture&id=first';
    dom.dispatch('popstate');
    assert.deepEqual(dom.replaced, ['#/next-steps', '#/epics?ws=fixture&id=second']);
    assert.deepEqual(observed.at(-1), { dest: 'specs', ws: 'fixture', id: 'first' });
  } finally {
    unsubscribe();
    dom.restore();
  }
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

test('launch destination round-trips its context, step and assignment fields', () => {
  const route: RouteState = {
    dest: 'launch',
    ws: 'fixture',
    tab: 'brief',
    thread: 'thread-1',
    target: 'repo-a',
    package: 'fixture/pkg',
    skill: 'general',
  };
  assert.deepEqual(parseHash(formatHash(route)), route);
  assert.equal(
    formatHash(route),
    '#/launch?ws=fixture&tab=brief&thread=thread-1&target=repo-a&package=fixture%2Fpkg&skill=general',
  );
  assert.deepEqual(parseHash('#/launch?ws=fixture&tab=review&id=assignment-1'), {
    dest: 'launch',
    ws: 'fixture',
    tab: 'review',
    id: 'assignment-1',
  });
});

test('launch route carries the planning stop through hash round trip, history pushes and scope clearing', () => {
  const route: RouteState = {
    dest: 'launch',
    ws: 'fixture',
    tab: 'review',
    thread: 'thread-1',
    target: 'repo-a',
    package: 'fixture/pkg',
    skill: 'spec-architect-critics',
    stop: 'critique',
  };
  assert.deepEqual(parseHash(formatHash(route)), route);
  assert.equal(
    formatHash(route),
    '#/launch?ws=fixture&tab=review&thread=thread-1&target=repo-a&package=fixture%2Fpkg&skill=spec-architect-critics&stop=critique',
  );
  assert.equal(routeHistoryMode(route, { ...route, stop: 'prepared' }), 'push');
  assert.equal(routeHistoryMode(route, { ...route }), 'replace');
  assert.deepEqual(clearIncompatibleFields(route), { dest: 'launch', ws: 'fixture', tab: 'brief' });
  assert.deepEqual(withWorkspace(route, 'other'), { dest: 'launch', ws: 'other', tab: 'brief' });
});

test('launch requires a workspace and scope changes clear context back to the brief', () => {
  assert.equal(requiresWorkspace('launch'), true);
  assert.equal(needsWorkspacePicker({ dest: 'launch' }), true);
  assert.equal(needsWorkspacePicker({ dest: 'launch', ws: 'fixture' }), false);
  const route: RouteState = {
    dest: 'launch',
    ws: 'fixture',
    tab: 'review',
    id: 'assignment-1',
    thread: 'thread-1',
    target: 'repo-a',
    package: 'fixture/pkg',
    skill: 'general',
  };
  const original = { ...route };
  assert.deepEqual(clearIncompatibleFields(route), { dest: 'launch', ws: 'fixture', tab: 'brief' });
  assert.deepEqual(withWorkspace(route, 'other'), { dest: 'launch', ws: 'other', tab: 'brief' });
  assert.deepEqual(route, original, 'normalizing a launch route must not mutate the caller state');
  assert.equal(routeHistoryMode(route, { ...route }), 'replace');
  assert.equal(routeHistoryMode(route, { ...route, target: 'repo-b' }), 'push');
  assert.equal(routeHistoryMode(route, { ...route, thread: 'thread-2' }), 'push');
  assert.equal(routeHistoryMode(route, { ...route, tab: 'brief' }), 'push');
});

test('a launch route without required workspace state invents nothing on mount', () => {
  const route: RouteState = { dest: 'launch' };
  assert.deepEqual(parseHash('#/launch'), route);
  assert.equal(parseHash('#/launch').ws, undefined);
  assert.deepEqual(clearIncompatibleFields(route), { dest: 'launch', tab: 'brief' });
  assert.deepEqual(route, { dest: 'launch' });
});

test('busy denial links the observed key when available and filters by UUID before observation', () => {
  const conflicting = 'b42f1903-9508-46c1-a4aa-a0842dbce617';
  const unrelatedKey = JSON.stringify(['fixture', 'run-1']);
  const conflictingKey = JSON.stringify(['fixture', conflicting]);
  const assignments = [
    { assignment_id: 'run-1', key: unrelatedKey },
    { assignment_id: conflicting, key: conflictingKey },
  ];
  // Matching observed key wins even though an unrelated row sorts first.
  assert.equal(
    busyAgentsHref('fixture', conflicting, assignments),
    `#/agents?ws=fixture&id=${encodeURIComponent(conflictingKey)}`,
  );
  // Conflicting assignment absent: workspace-scoped q route, never a raw id.
  assert.equal(
    busyAgentsHref('fixture', conflicting, [{ assignment_id: 'run-1', key: unrelatedKey }]),
    `#/agents?ws=fixture&q=${encodeURIComponent(conflicting)}`,
  );
  assert.equal(
    busyAgentsHref('fixture', conflicting, []),
    `#/agents?ws=fixture&q=${encodeURIComponent(conflicting)}`,
  );
  // No conflict: plain workspace route.
  assert.equal(busyAgentsHref('fixture', undefined, assignments), '#/agents?ws=fixture');
  assert.equal(busyAgentsHref('fixture', '', assignments), '#/agents?ws=fixture');
});
