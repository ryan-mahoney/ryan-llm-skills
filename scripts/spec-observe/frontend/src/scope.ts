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

export function targetRepositoryId(record: WireRecord): string | undefined {
  const targets = (record as { targets?: unknown })?.targets;
  if (!Array.isArray(targets) || targets.length === 0) return undefined;
  return text((targets[0] as { id?: unknown })?.id);
}

export const matchesCatalogEntry = (
  record: WireRecord,
  kind: ScopeRecordKind,
  entry: CatalogEntry,
): boolean => {
  if (kind === 'assignment') return record?.workspace_id === entry.id;
  return record?.workspace === basename(entry.directory);
};

export function firstUnmatchedTargetId(
  records: WireRecord[],
  kind: ScopeRecordKind,
  catalog: CatalogEntry[],
): string | undefined {
  for (const record of records ?? []) {
    if ((catalog ?? []).some(entry => entry && matchesCatalogEntry(record, kind, entry))) continue;
    const targetId = targetRepositoryId(record);
    if (targetId) return targetId;
  }
  return undefined;
}

export function scopeLabel(
  routeWorkspaceId: string | undefined,
  catalog: CatalogEntry[],
  unmatchedTargetId?: unknown,
): string {
  const entries = catalog ?? [];
  if (!routeWorkspaceId) {
    const label = text(unmatchedTargetId);
    if (!label) return 'All workspaces';
    return `All workspaces · ${label}`;
  }
  const entry = resolveCatalogEntry(entries, routeWorkspaceId);
  if (!entry) return routeWorkspaceId;
  return text(entry.name) ?? text(entry.id) ?? routeWorkspaceId;
}

export function requiresWorkspace(dest: Destination): boolean {
  return dest === 'conversations' || dest === 'designs' || dest === 'files' || dest === 'launch';
}

export function needsWorkspacePicker(route: RouteState): boolean {
  return requiresWorkspace(route.dest) && !route.ws;
}

export function clearIncompatibleFields(route: RouteState): RouteState {
  const next: RouteState = { dest: route.dest };
  if (route.ws !== undefined) next.ws = route.ws;
  // A launch draft belongs to one workspace: changing scope or workspace
  // clears thread/package/target/assignment context and returns to the brief
  // stage instead of reusing another workspace's context.
  if (route.dest === 'launch') {
    next.tab = 'brief';
    return next;
  }
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

export function catalogEntryForRecord(
  record: WireRecord,
  kind: ScopeRecordKind,
  catalog: CatalogEntry[],
  preferredId?: string,
): CatalogEntry | undefined {
  const matches = (catalog ?? []).filter(entry => entry && matchesCatalogEntry(record, kind, entry));
  if (!matches.length) return undefined;
  const preferred = preferredId === undefined ? undefined : matches.find(entry => entry.id === preferredId);
  if (preferred) return preferred;
  return matches.length === 1 ? matches[0] : undefined;
}

export function workspaceRelativePath(directory: string, absolutePath: string): string | null {
  const dir = text(directory)?.replace(/\/+$/, '');
  const path = text(absolutePath);
  if (!dir || !path) return null;
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  if (!relative) return null;
  const segments = relative.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) return null;
  return relative;
}
