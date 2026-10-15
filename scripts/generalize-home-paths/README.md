# Generalize home paths

Replace exact home-directory prefixes with `~` in UTF-8 file contents. Defaults to
`~/Documents/adjacent-storage/projects` and the current user's home plus its
`/Users/<user>` and `/home/<user>` counterparts. Python 3, standard library only.

Preview (no writes):

```sh
python3 ~/.agents/scripts/generalize-home-paths/cli.py
```

Apply after reviewing the listed files. Select the authored file paths explicitly
with `--include`; keep backups outside the scanned tree:

```sh
python3 ~/.agents/scripts/generalize-home-paths/cli.py --apply \
  --include '*/notes/*.md' --include '*/briefs/*.md' \
  --backup-dir "$HOME/Documents/home-path-backup-$(date +%Y%m%d-%H%M%S)"
```

For another storage root or an old username, pass explicit prefixes:

```sh
python3 ~/.agents/scripts/generalize-home-paths/cli.py /path/to/projects \
  --home /Users/old-user --home /home/old-user
```

The backup directory must not already exist. It holds original changed files at
the same relative paths; copy those files back to restore them. Writes are atomic
per file, retain file permissions, and stop on errors; a failed run can leave
previous files updated, with their backups retained. JSON lines report each match
and a final count. Paths in file names are not renamed.

Patterns match paths relative to the scanned root, including `/` separators.
Repeat `--include` to select several patterns; preview with the same patterns
before applying. Without patterns, preview inspects all eligible files.

The scan includes hidden authored files and structured text. It skips runtime,
sessions, threads, assignments, `.sentinel`, `.adjacent`, and `.git` directories;
`.git` files; `locations.json`, `scope.json`, `kit.yaml`, its backups, and
`config.json`; symlinks, hard-linked files, NUL-containing data, and non-UTF-8 files.
It refuses roots inside protected directories and fails on unreadable directories.
Both plain and JSON slash-escaped prefixes are recognized. Embedded path fragments
and `file:` URLs are left alone. It does not remove
personal names, email addresses, or home paths for unspecified users.

This is a text migration, not a schema migration. `~` works only where readers
expand it. Runtime identities, URLs, HTML links, shell strings with quoted tildes,
and some persisted manifests require other representations. Stop writers before
applying and review the preview against those consumers; pass a narrower root to
limit the migration to authored material. Use the workspace CLI's `rewrite-paths`
for kit repository paths when that is the only migration needed.
