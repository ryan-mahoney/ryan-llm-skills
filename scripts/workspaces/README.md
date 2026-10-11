# Workspace storage CLI

`scripts/workspaces/cli.mjs` is the single operator entry point for the
workspace store. It delegates to `store.mjs` (filesystem primitives and the
exclusive kit replacement), `kit.mjs` (line-preserving kit planning) and
`../repo-search/identity.mjs` (checkout resolution); it writes only under the
resolved storage root and never writes a target repository.

## Usage

```bash
node scripts/workspaces/cli.mjs <command> [options]
```

| Command | Form |
| --- | --- |
| `status` | `status` — report the root boundary (`ok`, `missing_root`, `missing_projects`, `invalid_*`, `unreadable`) without creating anything |
| `setup` | `setup` — create a missing root and `projects/` one component at a time; repeated runs are no-ops |
| `list` | `list` — read-only catalog of valid and invalid workspace manifests |
| `show` | `show ID` — read-only workspace detail with repository, context, brief, note and artifact status |
| `create` | `create ID [--name NAME]` — publish an empty `kit.yaml` exclusively; duplicate ids refuse |
| `add-repo` | `add-repo ID --id RID --path ABS [--role ROLE] [--remote URL] [--apply]` |
| `set-role` | `set-role ID --id RID --role ROLE [--apply]` |
| `add-brief` | `add-brief ID --title TITLE [--from FILE]` |
| `add-note` | `add-note ID --title TITLE [--from FILE]` |
| `add-artifact` | `add-artifact ID (--repository RID --path REL \| --url URL) [--title T] [--note N]` |

`add-brief` and `add-note` read stdin completely when `--from` is absent; with
`--from FILE` the file is the only source and stdin is never touched.

`add-artifact` requires exactly one target: `--repository RID` with a
repository-relative `--path`, or an absolute `http(s)` `--url`. Missing
repository targets are retained with an unavailable status; URLs are never
fetched.

## Options

- `--root PATH` — override the storage root for this run.
- `--json` — print structured JSON to stdout instead of human text. With
  `--apply`, two NDJSON documents are printed: the exact plan first, then the
  `{path,backup}` result.

## Storage root resolution

1. `--root PATH`, when given;
2. else `ADJACENT_STORAGE_ROOT`, which must be an absolute path;
3. else `~/Documents/adjacent-storage`.

The default matches Adjacent's dev default (`../adjacent-storage` beside an
Adjacent checkout at `~/Documents/adjacent`). Production Adjacent requires
`ADJACENT_STORAGE_ROOT`, so set it to the same value for both.

`status`, `list` and `show` never create the root, `projects/` or any workspace
file. Setup creates only a missing root and `projects/` one component at a
time; the parent of a missing root must already exist and is never created
recursively.

## Kit edits require `--apply`

`add-repo` and `set-role` always print the planned hunk first. `add-repo`
requires an absolute `--path` for previews as well as `--apply`; a relative path
refuses before any plan is printed. Without `--apply` the plan is the only
output and nothing is written. With `--apply` the same
plan is re-read against the current `kit.yaml` and replaced under the exclusive
operator window: one `kit.yaml.prev-<UTC>-<UUID>` copy of the original bytes is
published first, then a `wx` `kit.yaml.lock` is acquired, then the original is
re-read and byte-compared immediately before the atomic replacement. Keep the
exclusion window: do not edit `kit.yaml` while an apply runs. A held or stale
lock refuses without breaking it. An interrupted apply can leave `kit.yaml.lock`
behind; once no apply is running, remove that file by hand and rerun. A changed
original, duplicate repository id, or invalid/non-Git absolute path refuses
without touching the kit. Errors after the prior copy is published report the
retained backup path in `path`.

Back up the storage root before pointing this CLI at a real store for the
first time; the tests use disposable temporary roots only.

## Exit codes

- `0` — success, including a preview that changed nothing.
- `1` — refusal: stderr is one JSON object `{"error":"...","path":"..."}`.
  Exit 1 does not imply no file was created: a prior backup may remain after a
  post-backup failure, and `path` then names that retained copy.

Unknown commands or flags, missing or duplicate option values, dual artifact
targets and malformed ids/paths exit `1` before any store mutation.
