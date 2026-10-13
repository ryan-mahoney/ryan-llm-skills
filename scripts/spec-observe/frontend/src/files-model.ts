// Pure four-source Files model shared by the Files destination and Workspaces.
// No fetching, destination state or filesystem access belongs in this module.

export type FileSource = 'workspace' | 'context' | 'package' | 'repository';

export type FileScope = {
  source: FileSource;
  workspace?: string;
  owner?: string;
};

export type FileEntry = {
  name: string;
  available: boolean;
  size?: number;
  reason?: string | null;
};

export type FileListing = {
  files: FileEntry[];
  next_cursor?: number | string | null;
  truncated?: boolean;
  errors?: { name: string; message: string }[];
  limits?: { entries: number; totalEntries: number; depth: number; bytes: number };
  checkout?: { repository: string; branch: string | null };
};

export type LoadedFile = {
  scopeKey: string;
  path: string;
  kind: string;
  text: string | null;
  type: string;
  size: number;
  receivedAt: number;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const fileQuery = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
};

/** Unknown or absent sources default to the workspace source. */
export function fileSource(value?: string): FileSource {
  return value === 'context' || value === 'package' || value === 'repository' ? value : 'workspace';
}

/**
 * Listing endpoint for a scope. Context rows derive from workspace.context, so
 * context has no listing URL. Missing mandatory workspace/owner returns null
 * rather than a malformed endpoint.
 */
export function listFileUrl(scope: FileScope, cursor?: number | string): string | null {
  const source = fileSource(scope?.source);
  const workspace = text(scope?.workspace);
  const owner = text(scope?.owner);
  if (source === 'context') return null;
  if (source === 'workspace') {
    if (!workspace) return null;
    return `/api/workspace-files?${fileQuery({ id: workspace, cursor })}`;
  }
  if (source === 'package') {
    if (!owner) return null;
    return `/api/package-files?${fileQuery({ package: owner, cursor })}`;
  }
  if (!workspace || !owner) return null;
  return `/api/repository-files?${fileQuery({ id: workspace, repository: owner, cursor })}`;
}

/**
 * Read endpoint for a scope. Context reads through workspace-file; the package
 * owner is the canonical absolute package path. Missing scope or path is null.
 */
export function readFileUrl(scope: FileScope, path: string, download = false): string | null {
  const source = fileSource(scope?.source);
  const name = text(path);
  if (!name) return null;
  const workspace = text(scope?.workspace);
  const owner = text(scope?.owner);
  const flag = download ? { download: '1' } : {};
  if (source === 'workspace' || source === 'context') {
    if (!workspace) return null;
    return `/api/workspace-file?${fileQuery({ id: workspace, file: name, ...flag })}`;
  }
  if (source === 'package') {
    if (!owner) return null;
    return `/api/package-file?${fileQuery({ package: owner, file: name, ...flag })}`;
  }
  if (!workspace || !owner) return null;
  return `/api/repository-file?${fileQuery({ id: workspace, repository: owner, file: name, ...flag })}`;
}

/**
 * Lexically resolve a registered context reference against the workspace
 * directory. Absolute references resolve . and .. before the containment check
 * and must stay inside directory; relative references pass through unchanged.
 */
export function contextRoutePath(directory: string, path: string): string | null {
  const requested = text(path);
  if (!requested) return null;
  const root = text(directory);
  if (requested.startsWith('/')) {
    // contextRecord resolves absolute references before containment checks.
    // Match that lexical resolution, without changing the file reader's checks.
    const segments = requested.split('/').reduce<string[]>((parts, part) =>
      part === '..' ? parts.slice(0, -1) : part && part !== '.' ? [...parts, part] : parts, []);
    const normalized = `/${segments.join('/')}`;
    if (!root || !normalized.startsWith(`${root}/`)) return null;
    return normalized.slice(root.length + 1);
  }
  return requested;
}

/**
 * Loaded-name filter: case-insensitive name substring plus an optional
 * directory prefix. Only a trailing-slash path is a prefix; an explicit file
 * path (no trailing slash) is a selection, not a filter.
 */
export function filterLoadedFiles(files: FileEntry[], query: string, prefix?: string): FileEntry[] {
  const needle = text(query).trim().toLowerCase();
  const directory = text(prefix);
  const scoped = directory.endsWith('/') ? directory : '';
  return (Array.isArray(files) ? files : []).filter(file => {
    const name = text(file?.name);
    if (scoped && !name.startsWith(scoped)) return false;
    return !needle || name.toLowerCase().includes(needle);
  });
}

/**
 * Resolve a Markdown link target relative to the current package file. Scheme,
 * absolute, fragment and query leaders are refused; the path is decoded before
 * ?/# are stripped; escapes above the package root and empty results are null.
 */
export function relativePackagePath(target: string, current: string): string | null {
  if (!target || /^(?:[a-z]+:|\/|#|\?)/i.test(target)) return null;
  const parts = (current.includes('/') ? current.slice(0, current.lastIndexOf('/')).split('/') : []).filter(Boolean);
  let decoded = '';
  try { decoded = decodeURIComponent(target.split(/[?#]/)[0]); } catch { return null; }
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/**
 * Known unavailable reason for a path. A complete successful listing can
 * establish absence; partial pages, errors and null listings stay unknown so
 * the file remains eligible for a direct read.
 */
export function fileUnavailableReason(path: string, listing: FileListing | null): string | null {
  if (!listing) return null;
  const name = text(path);
  const entry = (Array.isArray(listing.files) ? listing.files : []).find(file => file?.name === name);
  if (entry) return entry.available ? null : text(entry.reason) || 'Unavailable';
  if (listing.truncated || listing.next_cursor != null || (listing.errors?.length ?? 0) > 0) return null;
  return 'Not found';
}

/** Short deterministic kind badge label, from the file extension. */
export function fileKindLabel(name: string): string {
  const base = text(name).split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : 'file';
}

/** Deterministic byte-size label for reader/list metadata. */
export function fileSizeLabel(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Unambiguous source memory key: JSON tuple instead of a delimiter join. */
export function scopeKey(scope: FileScope): string {
  return JSON.stringify([text(scope?.workspace), fileSource(scope?.source), text(scope?.owner)]);
}
