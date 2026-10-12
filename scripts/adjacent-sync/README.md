# Adjacent sync

`adjacent-sync` uses Unison to sync selected workspace content between two machines over SSH.
It uses your existing SSH aliases, keys, and Tailscale setup. It does not start a network service.

The repo contains the tool and public defaults. Your machine names, SSH details, and local paths
belong in a private config file. Do not add these details or credentials to this repository.

## Requirements

- Install Node.js on the machine that starts each sync.
- Install Unison separately on both machines.
- Use Unison 2.52 or a newer compatible version on both machines.
- Make sure SSH can reach the other machine through your existing alias and authentication.
- Run `~/.agents/sync.sh` to link `adjacent-sync` into `~/.local/bin`.

On macOS, install Unison with `brew install unison`. On Debian or Ubuntu, use
`sudo apt-get install unison`. For a user-local host installation, set `remote_unison` to its absolute executable path.
If the shell cannot find `adjacent-sync`, add `~/.local/bin` to `PATH`.

Run `adjacent-sync init` on the machine that starts the sync. The host does not need a local
config or an `adjacent-sync` install.

Generated profiles and client scan history stay in `sync-state` beside the private config. The
host stores its Unison history in its private `~/.unison` directory. These files do not belong in
the repository.

## Configure

Run the initializer on the machine that starts the sync:

```sh
adjacent-sync init
```

This creates a private config at `$XDG_CONFIG_HOME/adjacent/sync.json`, or at
`~/.config/adjacent/sync.json` when `XDG_CONFIG_HOME` is not set. The file is owner-only and
`init` does not overwrite an existing file. Edit it with the machine aliases and paths for your
setup. Use `scripts/adjacent-sync/config.example.json` as the public reference for its fields.

| Field | Value |
| --- | --- |
| `schema_version` | `1` |
| `local_root` | Absolute client data path, or a path with a `~/` prefix |
| `ssh_host` | Existing SSH alias. Set the username and authentication in SSH config. |
| `remote_root` | Absolute host data path. Both data folders must exist. |
| `unison` | Client executable name or absolute path. Default: `unison`. |
| `remote_unison` | Host executable name or absolute path without spaces. Default: `unison`. |

The tool refuses config and state inside Git checkouts or inside the client data folder.
It also refuses a config file that other users can read. Keep its permissions at `600`.

The public ignore profile is `scripts/adjacent-sync/ignore.prf`. It excludes spec-package
`runtime/` folders, journey QA `ux-qa/runs/` output (harness sessions hold database URLs),
`.sentinel/`, `.adjacent/`, `.DS_Store`, lock and temporary files, SQLite files,
`.workspace-publish-*`, and `.syncthing.*`. It also excludes `threads/`, `sessions/`, and
`assignments/` under `projects/<name>/`. Review the profile before syncing a workspace.

## Use

Run these commands from the machine that starts the sync:

```sh
adjacent-sync status
adjacent-sync preview
adjacent-sync run
```

`status` reports the local config, dependencies, SSH access, and remote readiness. Normal output
labels the machines as `client` and `host` and redacts private details. It opens an SSH connection
to check the host folder and Unison version. It does not change workspace data.

`preview` shows the changes Unison would make. It never propagates changes. Unison can update its
private scan history during a preview, but it does not change the shared workspace data.

`run` propagates nonconflicting changes. It returns a nonzero status when conflicts need a human
to resolve them. Unison also refuses a whole-root deletion. Resolve conflicts, then run `preview`
again before the next sync.

There is no automatic schedule. Run `adjacent-sync preview` before `adjacent-sync run` whenever you
want to sync. You can also run `adjacent-sync status` to check readiness.

Pass `--config PATH` to use a different private config file. Add `--verbose` only when you need
raw diagnostics. Verbose output can include private paths and SSH details, so treat it as local
diagnostic data and do not paste it into public logs or repository files.

```sh
adjacent-sync status --config /path/to/private-sync.json
adjacent-sync preview --verbose
```
