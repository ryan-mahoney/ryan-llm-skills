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
