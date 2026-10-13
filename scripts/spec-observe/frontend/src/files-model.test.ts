import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contextRoutePath,
  fileKindLabel,
  fileSizeLabel,
  fileSource,
  fileUnavailableReason,
  filterLoadedFiles,
  listFileUrl,
  readFileUrl,
  relativePackagePath,
  scopeKey,
  type FileEntry,
  type FileListing,
  type FileScope,
} from './files-model';

test('fileSource defaults absent and unknown values to workspace and keeps the declared sources', () => {
  assert.equal(fileSource(), 'workspace');
  assert.equal(fileSource(''), 'workspace');
  assert.equal(fileSource('bogus'), 'workspace');
  assert.equal(fileSource('Workspace'), 'workspace');
  assert.equal(fileSource('workspace'), 'workspace');
  assert.equal(fileSource('context'), 'context');
  assert.equal(fileSource('package'), 'package');
  assert.equal(fileSource('repository'), 'repository');
});

test('listFileUrl encodes workspace package and repository owners plus cursor with URLSearchParams', () => {
  assert.equal(
    listFileUrl({ source: 'workspace', workspace: 'fixture browser' }),
    '/api/workspace-files?id=fixture+browser',
  );
  assert.equal(
    listFileUrl({ source: 'workspace', workspace: 'fixture' }, 0),
    '/api/workspace-files?id=fixture&cursor=0',
  );
  assert.equal(
    listFileUrl({ source: 'workspace', workspace: 'café/包' }, 'page 2'),
    '/api/workspace-files?id=caf%C3%A9%2F%E5%8C%85&cursor=page+2',
  );
  assert.equal(
    listFileUrl({ source: 'package', owner: '/home/operator/café 包' }),
    '/api/package-files?package=%2Fhome%2Foperator%2Fcaf%C3%A9+%E5%8C%85',
  );
  assert.equal(
    listFileUrl({ source: 'repository', workspace: 'agent tooling', owner: 'agents/repo' }, 7),
    '/api/repository-files?id=agent+tooling&repository=agents%2Frepo&cursor=7',
  );
  assert.equal(listFileUrl({ source: 'context', workspace: 'fixture' }), null);
});

test('listFileUrl returns null instead of a malformed endpoint when mandatory scope is missing', () => {
  assert.equal(listFileUrl({ source: 'workspace' }), null);
  assert.equal(listFileUrl({ source: 'workspace', workspace: '' }), null);
  assert.equal(listFileUrl({ source: 'package' }), null);
  assert.equal(listFileUrl({ source: 'package', owner: '' }), null);
  assert.equal(listFileUrl({ source: 'repository', workspace: 'agent-tooling' }), null);
  assert.equal(listFileUrl({ source: 'repository', owner: 'agents' }), null);
});

test('readFileUrl routes context through workspace-file and encodes every source owner and path', () => {
  assert.equal(
    readFileUrl({ source: 'workspace', workspace: 'fixture browser' }, 'docs/café notes.md'),
    '/api/workspace-file?id=fixture+browser&file=docs%2Fcaf%C3%A9+notes.md',
  );
  assert.equal(
    readFileUrl({ source: 'context', workspace: 'fixture' }, 'briefs/a.md'),
    '/api/workspace-file?id=fixture&file=briefs%2Fa.md',
  );
  assert.equal(
    readFileUrl({ source: 'package', owner: '/home/operator/café 包' }, 'docs/notes 1.md', true),
    '/api/package-file?package=%2Fhome%2Foperator%2Fcaf%C3%A9+%E5%8C%85&file=docs%2Fnotes+1.md&download=1',
  );
  assert.equal(
    readFileUrl({ source: 'repository', workspace: 'agent-tooling', owner: 'agents' }, 'src/café notes.md', true),
    '/api/repository-file?id=agent-tooling&repository=agents&file=src%2Fcaf%C3%A9+notes.md&download=1',
  );
});

test('readFileUrl returns null for missing scope or empty path and appends download only when requested', () => {
  assert.equal(
    readFileUrl({ source: 'workspace', workspace: 'fixture' }, 'a.md', false),
    '/api/workspace-file?id=fixture&file=a.md',
  );
  assert.equal(readFileUrl({ source: 'workspace', workspace: 'fixture' }, ''), null);
  assert.equal(readFileUrl({ source: 'workspace' }, 'a.md'), null);
  assert.equal(readFileUrl({ source: 'context', workspace: 'fixture' }, ''), null);
  assert.equal(readFileUrl({ source: 'package' }, 'a.md'), null);
  assert.equal(readFileUrl({ source: 'repository', workspace: 'agent-tooling' }, 'a.md'), null);
  assert.equal(readFileUrl({ source: 'repository', owner: 'agents' }, 'a.md'), null);
});

test('contextRoutePath normalizes a contained absolute reference with dot and dot-dot segments', () => {
  assert.equal(
    contextRoutePath('/home/operator/work', '/home/operator/work/./a/../briefs/../briefs/note.md'),
    'briefs/note.md',
  );
  assert.equal(contextRoutePath('/home/operator/work', '/home/operator/work/../../../etc/passwd'), null);
  assert.equal(contextRoutePath('/home/operator/work', 'briefs/note.md'), 'briefs/note.md');
  assert.equal(contextRoutePath('/home/operator/work', ''), null);
});

test('contextRoutePath refuses empty sibling-prefix and outside absolute references', () => {
  assert.equal(contextRoutePath('/home/operator/work', '/home/operator/workshop/file.md'), null);
  assert.equal(contextRoutePath('/home/operator/work', '/home/operator/work-colleague/file.md'), null);
  assert.equal(contextRoutePath('/home/operator/work', '/etc/passwd'), null);
  assert.equal(contextRoutePath('/home/operator/work', '/home/operator/work'), null);
  assert.equal(contextRoutePath('', '/home/operator/work/file.md'), null);
});

const loadedFiles: FileEntry[] = [
  { name: 'briefs/a.md', available: true },
  { name: 'briefs/b.md', available: true },
  { name: 'briefs-archive/c.md', available: true },
  { name: 'notes/café.md', available: true },
];

test('filterLoadedFiles applies a case-insensitive substring and a trailing-slash prefix only', () => {
  assert.deepEqual(
    filterLoadedFiles(loadedFiles, '', 'briefs/').map(file => file.name),
    ['briefs/a.md', 'briefs/b.md'],
  );
  assert.deepEqual(filterLoadedFiles(loadedFiles, 'NOTES').map(file => file.name), ['notes/café.md']);
  assert.deepEqual(filterLoadedFiles(loadedFiles, 'CAFÉ').map(file => file.name), ['notes/café.md']);
  assert.deepEqual(
    filterLoadedFiles(loadedFiles, 'B', 'briefs/').map(file => file.name),
    ['briefs/a.md', 'briefs/b.md'],
  );
  assert.deepEqual(filterLoadedFiles(loadedFiles, 'zzz').map(file => file.name), []);
});

test('filterLoadedFiles does not treat an explicit file path without a trailing slash as a prefix', () => {
  assert.deepEqual(
    filterLoadedFiles(loadedFiles, '', 'briefs/a.md').map(file => file.name),
    ['briefs/a.md', 'briefs/b.md', 'briefs-archive/c.md', 'notes/café.md'],
  );
});

test('relativePackagePath normalizes decoded relative targets and refuses escapes or schemes', () => {
  assert.equal(relativePackagePath('../images/pic one.png', 'docs/guide/a.md'), 'docs/images/pic one.png');
  assert.equal(relativePackagePath('diagram%201.svg#view', 'docs/a.md'), 'docs/diagram 1.svg');
  assert.equal(relativePackagePath('../../secret.txt', 'docs/a.md'), null);
  assert.equal(relativePackagePath('.', 'a.md'), null);
  assert.equal(relativePackagePath('https://example.com/x.png', 'docs/a.md'), null);
  assert.equal(relativePackagePath('/etc/passwd', 'docs/a.md'), null);
  assert.equal(relativePackagePath('#anchor', 'docs/a.md'), null);
  assert.equal(relativePackagePath('?query=1', 'docs/a.md'), null);
  assert.equal(relativePackagePath('%E0%A4%A', 'docs/a.md'), null);
});

const completeListing: FileListing = {
  files: [
    { name: 'a.md', available: true },
    { name: 'big.bin', available: false, reason: 'Exceeds 8 MiB' },
    { name: 'no-reason.bin', available: false },
  ],
};

test('fileUnavailableReason reports a known unavailable entry but never absence from an incomplete listing', () => {
  assert.equal(fileUnavailableReason('a.md', completeListing), null);
  assert.equal(fileUnavailableReason('big.bin', completeListing), 'Exceeds 8 MiB');
  assert.equal(fileUnavailableReason('no-reason.bin', completeListing), 'Unavailable');
  assert.equal(fileUnavailableReason('missing.md', completeListing), 'Not found');
  assert.equal(fileUnavailableReason('missing.md', null), null);
  assert.equal(fileUnavailableReason('missing.md', { ...completeListing, truncated: true }), null);
  assert.equal(fileUnavailableReason('missing.md', { ...completeListing, next_cursor: '2' }), null);
  assert.equal(
    fileUnavailableReason('missing.md', { ...completeListing, errors: [{ name: 'docs', message: 'Unreadable' }] }),
    null,
  );
  assert.equal(fileUnavailableReason('big.bin', { ...completeListing, truncated: true }), 'Exceeds 8 MiB');
});

test('scopeKey distinguishes memory tuples with unambiguous JSON encoding', () => {
  assert.equal(
    scopeKey({ source: 'workspace', workspace: 'agent-tooling' }),
    '["agent-tooling","workspace",""]',
  );
  assert.equal(
    scopeKey({ source: 'repository', workspace: 'agent-tooling', owner: 'agents' }),
    '["agent-tooling","repository","agents"]',
  );
  assert.equal(scopeKey({ source: 'context', workspace: 'a:b' }), '["a:b","context",""]');
  assert.notEqual(
    scopeKey({ source: 'context', workspace: 'a:b' }),
    scopeKey({ source: 'context', workspace: 'a', owner: 'b' }),
  );
  assert.equal(scopeKey({ source: 'bogus' } as unknown as FileScope), '["","workspace",""]');
});

test('fileKindLabel and fileSizeLabel are deterministic display labels', () => {
  assert.equal(fileKindLabel('README.md'), 'md');
  assert.equal(fileKindLabel('docs/report.JSON'), 'json');
  assert.equal(fileKindLabel('archive.tar.gz'), 'gz');
  assert.equal(fileKindLabel('Makefile'), 'file');
  assert.equal(fileKindLabel('.gitignore'), 'file');
  assert.equal(fileSizeLabel(8388608), '8 MiB');
  assert.equal(fileSizeLabel(1024), '1 KiB');
  assert.equal(fileSizeLabel(512), '512 bytes');
  assert.equal(fileSizeLabel(0), '0 bytes');
  assert.equal(fileSizeLabel(undefined), '');
});
