import type { WireRecord } from './model';
import type { Destination, RouteState } from './route';

export type CatalogEntry = WireRecord & { id: string; directory: string };
export type ScopeRecordKind = 'run' | 'epic' | 'assignment';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const basename = (directory: unknown): string => String(directory ?? '').split('/').filter(Boolean).pop() ?? '';

export function resolveCatalogEntry(catalog: CatalogEntry[], wsId: string): CatalogEntry | undefined {
  return (catalog ?? []).find(entry => entry?.id === wsId);
}

export function inWorkspaceScope(
  record: WireRecord,
  kind: ScopeRecordKind,
  routeWorkspaceId: string | undefined,
  catalog: CatalogEntry[],
): boolean {
  if (!routeWorkspaceId) return true;
  const entry = resolveCatalogEntry(catalog, routeWorkspaceId);
  if (!entry) return false;
  if (kind === 'assignment') return record?.workspace_id === entry.id;
  return record?.workspace === basename(entry.directory);
}

export function scopeLabel(routeWorkspaceId: string | undefined, catalog: CatalogEntry[]): string {
  const entries = catalog ?? [];
  if (!routeWorkspaceId) {
    const first = entries[0];
    if (!first) return 'All workspaces';
    const label = text(first.id) ?? (basename(first.directory) || text(first.directory) || 'unknown');
    return `All workspaces · ${label}`;
  }
  const entry = resolveCatalogEntry(entries, routeWorkspaceId);
  if (!entry) return routeWorkspaceId;
  return text(entry.name) ?? text(entry.id) ?? routeWorkspaceId;
}

export function requiresWorkspace(dest: Destination): boolean {
  return dest === 'conversations' || dest === 'designs' || dest === 'files';
}

export function needsWorkspacePicker(route: RouteState): boolean {
  return requiresWorkspace(route.dest) && !route.ws;
}

export function clearIncompatibleFields(route: RouteState): RouteState {
  const next: RouteState = { dest: route.dest };
  if (route.ws !== undefined) next.ws = route.ws;
  if (route.tab !== undefined) next.tab = route.tab;
  if (route.filter !== undefined) next.filter = route.filter;
  if (route.q !== undefined) next.q = route.q;
  return next;
}

export function withWorkspace(route: RouteState, wsId: string | undefined): RouteState {
  const next = clearIncompatibleFields(route);
  if (wsId) next.ws = wsId;
  else delete next.ws;
  return next;
}
