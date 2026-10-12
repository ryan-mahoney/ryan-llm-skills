import type { WireRecord } from '../model';
import type { CatalogEntry } from '../scope';

export type WorkspaceCatalog = { storage?: WireRecord; valid: CatalogEntry[]; invalid?: WireRecord[]; errors?: WireRecord[] };

// A successful HTTP read can still describe an incomplete storage listing.
// missing_projects has a producer-generated diagnostic, but is the setup empty state.
export function catalogRead(value: WorkspaceCatalog, retained: WorkspaceCatalog | null) {
  const status = value.storage?.status;
  const degraded = (status !== 'ok' && status !== 'missing_projects')
    || Boolean(value.storage?.errors?.length)
    || Boolean(value.errors?.some(error => status !== 'missing_projects' || error.message !== 'missing_projects'));
  return {
    degraded,
    catalog: degraded ? {
      ...value,
      valid: [...value.valid, ...(retained?.valid ?? []).filter(entry => !value.valid.some(current => current.id === entry.id))],
    } : value,
  };
}

const list = (value: unknown): any[] => Array.isArray(value) ? value : [];

export const unavailableArtifacts = (workspace: any): any[] =>
  list(workspace?.artifacts).filter(item => item?.status !== 'ok' && !(item?.kind === 'url' && item?.status === 'external'));

export const materialUnavailable = (workspace: any, collection: 'briefs' | 'notes'): boolean =>
  list(workspace?.attention).includes(`${collection}_unreadable`);

export const materialContents = (workspace: any, collection: 'briefs' | 'notes'): string => {
  if (materialUnavailable(workspace, collection)) return `${collection === 'briefs' ? 'Briefs' : 'Notes'} unavailable — collection could not be read`;
  const count = list(workspace?.[collection]).length;
  return `${count} saved ${count === 1 ? collection.slice(0, -1) : collection}`;
};

// One announcement owner for both the directory picker and master/detail page.
export function workspaceAnnouncements() {
  const announcedChecking = new Set<string>();
  let previousPane = '';
  let previousDirectory = '';
  let announced = '';
  return (pane: string, directory: string, checkingIdentity?: string): string => {
    const next = pane && pane !== previousPane ? pane : directory && directory !== previousDirectory ? directory : '';
    previousPane = pane;
    previousDirectory = directory;
    if (!next) return '';
    if (checkingIdentity !== undefined) {
      if (announcedChecking.has(checkingIdentity)) return '';
      announcedChecking.add(checkingIdentity);
    }
    if (next === announced) return '';
    announced = next;
    return next;
  };
}
