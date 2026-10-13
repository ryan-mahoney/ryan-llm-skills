// Kit-authorized repository file routes for the Sentinel dashboard. Every
// request re-reads the fresh catalog, resolves the declared repository path
// through store.mjs and requires its canonical path to be the Git checkout top
// level. Git processes are argv-only, bounded by one request deadline and never
// mutate the checkout.
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolveCheckout } from '../repo-search/identity.mjs';
import { resolveRepositoryPath } from '../workspaces/store.mjs';
import { PACKAGE_FILE_LIMITS, readPackageFile, resolvePackageFilePath, sendFile } from './package-files.mjs';

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const REQUEST_DEADLINE_MS = 5000;
// A metadata failure is "known" only when the listing can state it directly:
// missing, symlink, non-regular or oversized. Anything else is reported as a
// bounded page error instead of a raw exception.
const KNOWN_REASON_BY_MESSAGE = { 'Symbolic links are unavailable': 'Symbolic link' };

// Bounded, argv-only Git invocation with optional locks and prompts off. No
// shell is involved and -z output is never trimmed: names may contain any byte
// except NUL.
function git(cwd, args, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error('Repository request deadline expired'), { code: 'timeout' }));
  return new Promise((resolveGit, rejectGit) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      timeout: Math.min(GIT_TIMEOUT_MS, remaining),
      killSignal: 'SIGKILL',
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error) {
        rejectGit(Object.assign(new Error(`git ${args[0]} failed`), { code: error.code, killed: error.killed, signal: error.signal }));
        return;
      }
      resolveGit(stdout);
    });
  });
}

const parentDirectories = name => name.split('/').length - 1;
const withinDepth = name => parentDirectories(name) <= PACKAGE_FILE_LIMITS.depth;
const isExcluded = (name, exclude) => typeof exclude === 'function' && name.split('/').some(part => exclude(part));

async function entryFor(root, name, exclude) {
  let info;
  try {
    info = await lstat(await resolvePackageFilePath(root, name, { exclude }));
  } catch (error) {
    const known = error?.code === 'ENOENT' ? 'Missing file' : KNOWN_REASON_BY_MESSAGE[error?.message];
    return {
      entry: { name, available: false, reason: known ?? 'Unavailable' },
      error: known ? null : { name, message: 'Metadata unavailable' },
    };
  }
  if (!info.isFile()) return { entry: { name, available: false, reason: 'Not a regular file' } };
  if (info.size > PACKAGE_FILE_LIMITS.bytes) return { entry: { name, size: info.size, available: false, reason: 'Exceeds 8 MiB limit' } };
  return { entry: { name, size: info.size, available: true, reason: null } };
}

// HEAD is provenance only: prefer the branch name (including unborn branches),
// otherwise use the detached short HEAD identity.
async function repositoryBranch(root, deadline) {
  try {
    const branch = await git(root, ['symbolic-ref', '--short', '--quiet', 'HEAD'], deadline);
    return branch.endsWith('\n') ? branch.slice(0, -1) : branch;
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  try {
    const head = await git(root, ['rev-parse', '--verify', '--quiet', '--short', 'HEAD'], deadline);
    return head.endsWith('\n') ? head.slice(0, -1) : head;
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

async function listRepositoryFiles(root, url, deadline, exclude, repositoryId) {
  const cursor = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= PACKAGE_FILE_LIMITS.totalEntries) throw new Error('Invalid listing cursor');
  const listed = (await git(root, ['ls-files', '-z', '-co', '--exclude-standard'], deadline)).split('\0').filter(name => name !== '');
  const candidates = [...new Set(listed)].sort().filter(name => !isExcluded(name, exclude));
  const visible = candidates.filter(withinDepth);
  const bounded = visible.slice(0, PACKAGE_FILE_LIMITS.totalEntries);
  const page = bounded.slice(cursor, Math.min(cursor + PACKAGE_FILE_LIMITS.entries, bounded.length));
  const next = cursor + PACKAGE_FILE_LIMITS.entries;
  const files = [], errors = [];
  for (const name of page) {
    if (Date.now() >= deadline) throw new Error('Repository request deadline expired');
    const { entry, error } = await entryFor(root, name, exclude);
    files.push(entry);
    if (error) errors.push(error);
  }
  return {
    files,
    truncated: visible.length > bounded.length || visible.length !== candidates.length || next < bounded.length,
    next_cursor: next < bounded.length ? next : null,
    errors,
    limits: PACKAGE_FILE_LIMITS,
    checkout: { repository: repositoryId, branch: await repositoryBranch(root, deadline) },
  };
}

// Direct reads require an exact unique Git member before the shared bounded
// reader serves bytes.
async function readRepositoryFile(root, name, deadline, exclude) {
  if (typeof name !== 'string' || name === '') throw new Error('Invalid file path');
  if (!withinDepth(name)) throw new Error('File is outside the repository depth limit');
  const members = new Set((await git(root, ['ls-files', '-z', '-co', '--exclude-standard', '--', `:(literal)${name}`], deadline)).split('\0').filter(member => member !== ''));
  if (members.size !== 1 || !members.has(name)) throw new Error('File is not in the repository');
  return readPackageFile(root, name, { exclude });
}

export function createRepositoryFileRoutes({ authorizedKit, exclude } = {}) {
  return async (request, response, url) => {
    const pathname = url.pathname;
    if (pathname !== '/api/repository-files' && pathname !== '/api/repository-file') return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return true;
    }
    const deadline = Date.now() + REQUEST_DEADLINE_MS;
    const repositoryId = url.searchParams.get('repository');
    const entry = await authorizedKit(url.searchParams.get('id'));
    const repository = (entry.kit?.repositories ?? []).find(item => item?.id === repositoryId);
    if (!repository || typeof repository.path !== 'string' || repository.path === '') throw new Error('Repository is unavailable');
    const root = await realpath(resolveRepositoryPath(entry.directory, repository.path));
    const identity = await resolveCheckout(root, { deadline });
    if (identity.root !== root) throw new Error('Repository root is not the checkout top level');
    if (pathname === '/api/repository-file') {
      const name = url.searchParams.get('file');
      sendFile(request, response, name, await readRepositoryFile(root, name, deadline, exclude), { download: url.searchParams.has('download') });
    } else {
      const listing = await listRepositoryFiles(root, url, deadline, exclude, repositoryId);
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(listing));
    }
    return true;
  };
}
