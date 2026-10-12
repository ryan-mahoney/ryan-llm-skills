# repo-local-config-transfer

This CLI helps a person move selected ignored local files into the matching repository on another machine. It copies portable files only; it does not install software, provision credentials, or configure services.

## Requirements

- Node.js on the sending machine
- SSH access configured for the destination host
- Python 3 and Git on the destination
- An existing destination Git checkout

## Scan and select

```sh
repo-local-config-transfer scan /absolute/path/to/repo --output /path/outside/repo/manifest.json
```

The manifest contains paths, reasons, size, modification time, mode, and SHA-256. It never stores file contents. The scanner lists Git-ignored files (including repository, `.git/info/exclude`, and global excludes) and separately flags common untracked configuration and credential path names. It excludes common dependency, build, cache, log, dump, and database locations. It skips files larger than 2 MiB and refuses candidate paths containing symlinks. Review the manifest, then set `selected` to `true` only for files you intend to copy. Keep the manifest private because its paths can reveal local configuration details.

## Preview and transfer

```sh
repo-local-config-transfer transfer --manifest /path/to/manifest.json --to my-host:/absolute/path/to/repo
repo-local-config-transfer transfer --manifest /path/to/manifest.json --to my-host:/absolute/path/to/repo --apply
```

Transfer previews by default. The client checks selected sources against their scan metadata and hash before sending. A preview sends only path, size, and hash metadata; file bytes travel only when `--apply` is present. The destination verifies that the target is exactly a Git root, validates every path, rejects symlinks and tracked destinations, and checks the entire batch before writing. New files use owner-only permissions and atomic per-file replacement. Existing destinations require both `--apply` and `--overwrite`:

```sh
repo-local-config-transfer transfer --manifest /path/to/manifest.json --to my-host:/absolute/path/to/repo --apply --overwrite
```

The client sends file bytes over SSH stdin to a fixed Python helper. Paths and data are sent as structured JSON; they are not interpolated into shell commands. The remote helper requires Python 3 and Git. No live host access is needed to scan or edit a manifest.

## Limits

Path-name heuristics cannot identify every useful local file or every secret. A Git-ignored file may contain data that should not be moved. Inspect selected paths and make sure the destination is the intended checkout. Scanning hashes file bytes to detect changes; transfer necessarily reads selected file bytes to copy them. Git inventory is bounded by an eight-second command timeout. Writes are atomic one file at a time, so an interruption during application can leave a partial batch; rerun preview after resolving the reported destination state. This is a one-way copy and does not delete or synchronize source files.
