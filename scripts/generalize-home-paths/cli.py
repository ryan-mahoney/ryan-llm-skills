#!/usr/bin/env python3
"""Preview or replace explicit home-directory prefixes in UTF-8 text files."""
import argparse
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile


PROTECTED_DIRECTORIES = {'.git', '.sentinel', '.adjacent', 'runtime', 'sessions', 'threads', 'assignments'}
PROTECTED_FILES = {'.git', 'locations.json', 'scope.json', 'kit.yaml', 'config.json'}


def generalize(text, homes):
    # Longest first; a username prefix must not match a different username.
    for home in sorted(set(homes), key=len, reverse=True):
        text = re.sub(r'(?<![\w./\\~:-])' + re.escape(home) + r'(?=/|[\s\x22\x27`<>\]\)},;:]|$)', '~', text)
        # JSON can legally escape forward slashes.
        escaped = home.replace('/', r'\/')
        text = re.sub(r'(?<![\w./\\~:-])' + re.escape(escaped) + r'(?=\\/|[\s\x22\x27`<>\]\)},;:]|$)', '~', text)
    return text


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', type=Path,
                        default=Path.home() / 'Documents/adjacent-storage/projects')
    parser.add_argument('--home', action='append', dest='homes',
                        help='Exact old home prefix; repeat for several homes. Defaults to this home and its macOS/Linux counterparts.')
    parser.add_argument('--include', action='append', default=[], metavar='GLOB',
                        help='Select relative file paths with shell-style globs; required with --apply')
    parser.add_argument('--apply', action='store_true', help='Write replacements (default: preview only)')
    parser.add_argument('--backup-dir', type=Path, help='New directory outside root; required with --apply')
    args = parser.parse_args(argv)
    root = args.root.expanduser().resolve(strict=True)
    if not root.is_dir():
        parser.error('root must be a directory')
    if any(part in PROTECTED_DIRECTORIES for part in root.parts):
        parser.error('root is inside a protected runtime or version-control directory')
    homes = args.homes or [str(Path.home()), f'/Users/{Path.home().name}', f'/home/{Path.home().name}']
    if any(not h.startswith('/') or h == '/' or h.endswith('/') for h in homes):
        parser.error('--home must be an absolute prefix without a trailing slash')
    backup = None
    if args.apply:
        if not args.include:
            parser.error('--apply requires at least one reviewed --include pattern')
        if args.backup_dir is None:
            parser.error('--apply requires --backup-dir')
        backup = args.backup_dir.expanduser().resolve()
        if backup == root or root in backup.parents:
            parser.error('--backup-dir must be outside root')
        backup.mkdir(parents=True, exist_ok=False, mode=0o700)

    changed = skipped = 0
    def walk_error(error):
        raise error

    for folder, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        # Do not touch version control internals or follow links outside the tree.
        dirs[:] = sorted(d for d in dirs if d not in PROTECTED_DIRECTORIES and not (Path(folder) / d).is_symlink())
        for name in sorted(files):
            path = Path(folder) / name
            relative = path.relative_to(root)
            if name in PROTECTED_FILES or name.startswith('kit.yaml.prev-'):
                skipped += 1
                continue
            if args.include and not any(fnmatchcase(relative.as_posix(), pattern) for pattern in args.include):
                continue
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                skipped += 1
                continue
            raw = path.read_bytes()
            if b'\0' in raw:
                skipped += 1
                continue
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                skipped += 1
                continue
            result = generalize(text, homes).encode('utf-8')
            if result == raw:
                continue
            if backup is not None:
                destination = backup / relative
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(path, destination)
                temporary = None
                try:
                    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
                        temporary = Path(stream.name)
                        stream.write(result)
                        stream.flush()
                        os.fsync(stream.fileno())
                    temporary.chmod(stat.S_IMODE(info.st_mode))
                    # Refuse a file that changed during the scan.
                    if path.is_symlink() or path.read_bytes() != raw:
                        raise RuntimeError(f'file changed during cleanup: {relative}')
                    os.replace(temporary, path)
                finally:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
            changed += 1
            print(json.dumps({'file': relative.as_posix(), 'action': 'updated' if args.apply else 'would-update'}))
    print(json.dumps({'mode': 'apply' if args.apply else 'preview', 'changed_files': changed,
                      'skipped_files': skipped, 'backup_dir': str(backup) if backup else None}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
