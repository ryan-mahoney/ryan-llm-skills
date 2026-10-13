export type Destination =
  | 'specs'
  | 'epics'
  | 'agents'
  | 'conversations'
  | 'files'
  | 'designs'
  | 'workspaces'
  | 'launch';

export type RouteState = {
  dest: Destination;
  ws?: string;
  id?: string;
  tab?: string;
  source?: string;
  path?: string;
  filter?: string;
  q?: string;
  // Launch-flow context: set only by the hidden launch destination and kept
  // separate from the workspace-directory fields above.
  thread?: string;
  target?: string;
  package?: string;
  skill?: string;
};

export type RouteMode = 'push' | 'replace';
export type RouteListener = (route: RouteState) => void;

export const DESTINATIONS: readonly Destination[] = [
  'specs',
  'epics',
  'agents',
  'conversations',
  'files',
  'designs',
  'workspaces',
  'launch',
];

export const SUPPORTED_PARAMS = ['ws', 'id', 'tab', 'source', 'path', 'filter', 'q', 'thread', 'target', 'package', 'skill'] as const;
export type SupportedParam = (typeof SUPPORTED_PARAMS)[number];

const HISTORY_FIELDS: readonly (keyof RouteState)[] = ['dest', 'ws', 'id', 'tab', 'source', 'path', 'thread', 'target', 'package', 'skill'];

const isDestination = (value: unknown): value is Destination =>
  typeof value === 'string' && (DESTINATIONS as readonly string[]).includes(value);

export function parseHash(hash: string): RouteState {
  const fragment = (typeof hash === 'string' ? hash : '').replace(/^#/, '');
  const queryIndex = fragment.indexOf('?');
  const destPart = (queryIndex === -1 ? fragment : fragment.slice(0, queryIndex)).replace(/^\/+|\/+$/g, '');
  if (!isDestination(destPart)) return { dest: 'specs' };
  const route: RouteState = { dest: destPart };
  if (queryIndex === -1) return route;
  const params = new URLSearchParams(fragment.slice(queryIndex + 1));
  for (const name of SUPPORTED_PARAMS) {
    if (params.has(name)) (route as Record<SupportedParam, string>)[name] = params.get(name) ?? '';
  }
  return route;
}

export function formatHash(route: RouteState): string {
  const dest = isDestination(route?.dest) ? route.dest : 'specs';
  const params = new URLSearchParams();
  for (const name of SUPPORTED_PARAMS) {
    const value = route?.[name];
    if (typeof value === 'string') params.set(name, value);
  }
  const query = params.toString();
  return query ? `#/${dest}?${query}` : `#/${dest}`;
}

export function routeHistoryMode(prev: RouteState, next: RouteState, options: { fallback?: boolean } = {}): RouteMode {
  if (options.fallback === true) return 'replace';
  for (const field of HISTORY_FIELDS) if (prev?.[field] !== next?.[field]) return 'push';
  return 'replace';
}

// Busy-denial agent link: the Agents list keys rows by the observed
// assignment key (JSON.stringify([observerWorkspace, assignment_id])) and
// replaces an unmatched id selection with the first visible row. A raw
// conflicting UUID therefore misdirects inspection whenever an unrelated
// row exists first. Use the matching observed key when available; before
// observation fall back to a workspace-scoped q=conflictingUUID route so
// the list filters instead of selecting an unrelated agent.
export function busyAgentsHref(
  ws: string,
  conflictingId: string | undefined,
  assignments: Array<{ assignment_id?: unknown; key?: unknown }> = [],
): string {
  const base = `#/agents?ws=${encodeURIComponent(ws)}`;
  if (typeof conflictingId !== 'string' || !conflictingId) return base;
  const match = assignments.find(
    assignment => assignment.assignment_id === conflictingId
      && typeof assignment.key === 'string' && assignment.key,
  );
  if (match && typeof (match as { key: unknown }).key === 'string') {
    return `${base}&id=${encodeURIComponent((match as { key: string }).key)}`;
  }
  return `${base}&q=${encodeURIComponent(conflictingId)}`;
}

const listeners = new Set<RouteListener>();
let bound = false;
let observedKey: string | null = null;

const readHash = (): string => (typeof location === 'undefined' ? '' : location.hash);

const emit = (hash: string): void => {
  const route = parseHash(hash);
  const key = formatHash(route);
  if (key === observedKey) return;
  observedKey = key;
  for (const listener of [...listeners]) listener(route);
};

const onRouteEvent = (): void => {
  const hash = formatHash(parseHash(readHash()));
  if (typeof location !== 'undefined' && location.hash !== hash) {
    try {
      history.replaceState(null, '', hash);
    } catch {
      location.hash = hash;
    }
  }
  emit(hash);
};

export function navigate(route: RouteState, mode: RouteMode = 'push'): void {
  if (typeof window === 'undefined' || typeof location === 'undefined') return;
  const hash = formatHash(route);
  if (location.hash === hash) return;
  try {
    if (mode === 'replace') history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  } catch {
    location.hash = hash;
  }
  emit(hash);
}

export function subscribeRoute(listener: RouteListener): () => void {
  listeners.add(listener);
  if (typeof window !== 'undefined' && typeof location !== 'undefined') {
    if (!bound) {
      bound = true;
      window.addEventListener('hashchange', onRouteEvent);
      window.addEventListener('popstate', onRouteEvent);
    }
    observedKey = formatHash(parseHash(readHash()));
  }
  listener(parseHash(readHash()));
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && bound) {
      window.removeEventListener('hashchange', onRouteEvent);
      window.removeEventListener('popstate', onRouteEvent);
      bound = false;
      observedKey = null;
    }
  };
}
