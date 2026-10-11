# Adjacent storage operations

Operator runbook for running workspace storage on two machines: the Linux execution host (`<host>`) and a Mac client. The host owns all live state (threads, sessions, assignments, `.sentinel/`, spec `runtime/`). Syncthing carries only authored material between machines. Design and rationale: `docs/adjacent-architecture.md`. CLI reference: `scripts/workspaces/README.md` and `scripts/spec-location/README.md`.

Each step is tagged with where it runs: **[Mac]**, **[Host]**, or **[Both]**. `W` is a workspace id. `WS` is the CLI shorthand used below:

```bash
WS="node $HOME/.agents/scripts/workspaces/cli.mjs"
SL="node $HOME/.agents/scripts/spec-location/cli.mjs"
```

Run `~/.agents/sync.sh` on each machine first so it has the current code and the ignore list.

## a. Set up storage on a machine

1. **[Both]** Save the storage root. The `adjacent-storage-setup` skill does the same thing interactively.

   ```bash
   $WS setup --root ~/Documents/adjacent-storage --save
   $WS status        # expect source: config, boundary: ok
   ```

   Restart the Sentinel service so it reads the saved root: `systemctl --user restart spec-sentinel` on the host. The host unit no longer needs `Environment=ADJACENT_STORAGE_ROOT`.

2. **[Mac]** Name the execution host in every kit, then replace the Mac-absolute repository paths with `~`. Preview each command first by leaving off `--apply`.

   ```bash
   for w in $(ls ~/Documents/adjacent-storage/projects); do
     $WS set-execution-host "$w" --host <host> --apply
     $WS rewrite-paths "$w" --from /Users/ryanmahoney --to '~' --apply
   done
   ```

   `--host` is compared with the first DNS label of the machine's hostname, lowercased. Do this before seeding or the first sync, so the host receives portable kits. Each kit edit keeps a `kit.yaml.prev-*` backup; `$WS kit-backups W` lists them.

3. **[Host]** Clone each kit repository to the path its kit names (`~/Documents/<repo>`). A repository missing from the host shows as `missing` in `$WS show W` and makes spec checks refuse with `target-missing`.

## b. Seed the host from the Mac

The host starts its own live state. Copy only the cold set: everything except what `scripts/workspaces/stignore` lists.

1. **[Mac]** Back up the whole store, live state included.

   ```bash
   cp -R ~/Documents/adjacent-storage ~/adjacent-storage-backup-$(date +%F)
   ```

2. **[Host]** Run step a.1 so the host has a root and `projects/`. Confirm Tailscale SSH works: `tailscale up --ssh` on the host, then `ssh <host> true` from the Mac.

3. **[Mac]** Copy the cold set with rsync. The `sed` turns the Syncthing ignore list into rsync excludes (it drops comments and the `(?d)` prefix). Run once with `-n` to preview.

   ```bash
   sed -e '/^\/\//d' -e '/^$/d' -e 's/^(?d)//' ~/.agents/scripts/workspaces/stignore > /tmp/seed-excludes
   rsync -an --stats --exclude-from=/tmp/seed-excludes ~/Documents/adjacent-storage/ <host>:Documents/adjacent-storage/
   rsync -a  --stats --exclude-from=/tmp/seed-excludes ~/Documents/adjacent-storage/ <host>:Documents/adjacent-storage/
   ```

   Tar alternative when rsync is unavailable. `COPYFILE_DISABLE=1` keeps macOS `._*` files out of the archive.

   ```bash
   COPYFILE_DISABLE=1 tar -C ~/Documents/adjacent-storage \
     --exclude='./.sentinel' --exclude='./.adjacent' --exclude='./projects/*/.adjacent' \
     --exclude='./projects/*/threads' --exclude='./projects/*/sessions' --exclude='./projects/*/assignments' \
     --exclude='projects/*/specs/*/runtime' --exclude='.DS_Store' --exclude='*.lock' --exclude='*.tmp' --exclude='*.sqlite*' \
     --exclude='.workspace-publish-*' --exclude='.syncthing.*' -cf - . \
   | ssh <host> 'tar -C ~/Documents/adjacent-storage -xf -'
   ```

4. **[Host]** Verify that no live state arrived, then check the kits.

   ```bash
   find ~/Documents/adjacent-storage -maxdepth 3 \( -name threads -o -name sessions -o -name assignments -o -name .sentinel -o -name .adjacent \)   # expect no output
   $WS list
   ```

## c. Syncthing

Syncthing does not sync `.stignore`, so put it in place before the folder exists in Syncthing. Otherwise the first scan sees everything. After that, `sync.sh` keeps it current on any machine where Syncthing has created `.stfolder`.

**[Both]** `cp ~/.agents/scripts/workspaces/stignore ~/Documents/adjacent-storage/.stignore`

### Install

**[Host]** Linux, systemd user unit with linger (the service survives logout, as the Sentinel host does):

```bash
sudo apt install syncthing          # or the Syncthing apt repository for a current version
systemctl --user enable --now syncthing.service
loginctl enable-linger "$USER"
systemctl --user status syncthing --no-pager
```

The GUI listens on `127.0.0.1:8384`. Reach it from the Mac with `ssh -L 8384:127.0.0.1:8384 <host>`, then open `http://127.0.0.1:8384`.

**[Mac]**

```bash
brew install syncthing
brew services start syncthing
```

The GUI is at `http://127.0.0.1:8384`. macOS must let the daemon read `~/Documents`: allow the prompt, or in System Settings > Privacy & Security > Files and Folders grant `syncthing` access to Documents. If the scan reports permission errors, grant Full Disk Access to `/opt/homebrew/opt/syncthing/bin/syncthing`.

### Pair over the tailnet

1. **[Both]** In Settings > Connections, turn off Global Discovery, Local Discovery, and Relaying. Devices connect only over Tailscale.
2. **[Both]** Add the other device under Add Remote Device with its device ID (Actions > Show ID). Set its address to `tcp://<tailnet-name>:22000`, using the MagicDNS name from `tailscale status`. Accept the request on the other side.
3. **[Host]** Add the folder: ID `adjacent-storage`, path `~/Documents/adjacent-storage`, type Send & Receive, no versioning. Share it with the Mac.
4. **[Mac]** Accept the share with the same path and type **Receive Only**. Because the Mac already holds the same files, the first scan should find nothing to transfer.
5. **[Mac]** When the folder reads Up to Date with no "Locally changed items", change its type to Send & Receive (Folder > Edit > Advanced). If locally changed items appear, read the list first. Do not click Revert Local Changes unless the host's version should replace the Mac's, because revert deletes Mac-only files. The backup from step b.1 is the recovery copy.

Check: edit a kit on the Mac, for example `$WS set-name W --name "..." --apply`, and confirm it reaches the host in under a minute. Nothing under `threads/`, `sessions/`, `assignments/`, `.sentinel/` or `runtime/` should ever appear on the other machine.

## d. Client access to live work

**[Mac]** Thread interaction. The dashboard refuses thread requests that arrive through Tailscale Serve and accepts them from loopback, which a port forward provides.

```bash
ssh -L 4319:127.0.0.1:4319 <host>      # leave open, then browse http://127.0.0.1:4319
```

**[Mac]** Attach to a running assignment in tmux over Tailscale SSH:

```bash
ssh -t <host> 'node ~/.agents/scripts/workspaces/cli.mjs assignments'
ssh -t <host> 'node ~/.agents/scripts/workspaces/cli.mjs attach <assignment-id>'
```

`attach` needs a terminal, hence `-t`. Detach with the tmux prefix and `d`, which leaves the run going.

## e. Back up the host store

Syncthing is not a backup: it propagates deletions and corruption. **[Host]** snapshot the store daily and exclude the Whisper model cache and raw run transcripts.

restic, to a local or mounted repository:

```bash
export RESTIC_REPOSITORY=/mnt/backup/adjacent RESTIC_PASSWORD_FILE=$HOME/.config/restic/password
restic init                                            # once
restic backup ~/Documents/adjacent-storage \
  --exclude '.adjacent/asr-cache' --exclude '**/runtime/runs'
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

borg equivalent:

```bash
borg create --exclude '*/.adjacent/asr-cache' --exclude '*/runtime/runs' \
  /mnt/backup/adjacent::'{now:%F}' ~/Documents/adjacent-storage
borg prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6 /mnt/backup/adjacent
```

Run the chosen commands from a systemd user timer (`OnCalendar=daily`, `Persistent=true`) with `loginctl enable-linger` already set. Check the backup with `restic snapshots` (or `borg list`) and restore one file into a scratch directory at least once.

## f. Cut over a workspace from `.specs/`

Do one workspace at a time. Until it is migrated, spec skills refuse in it with `legacy-specs-present`. Pilot on `agent-tooling`.

1. **[Mac]** (the machine holding the legacy `.specs/` data) Stop the workspace's runs. `migrate` refuses with `run-active` while a run's coordinator is alive.
2. **[Mac]** Preview, read the plan, then apply. A preview writes nothing. `slug-collision` lists conflicting slugs across repositories; rename them and rerun.

   ```bash
   $SL migrate --workspace W
   $SL migrate --workspace W --apply
   ```

   Add `--include-transcripts` only if the raw `runtime/runs/*` should move into storage. It leaves the transcripts in the legacy archive otherwise.

3. **[Mac]** Review `projects/W/project-context.md`. Migration appends one `## Repository: <id>` section per repository, and the sections can contradict each other.
4. **[Both]** Wait for Syncthing to show both folders Up to Date.
5. **[Host]** Materialize each package for the host (needs `jq`). `check` confirms the result.

   ```bash
   for ref in $($SL packages --workspace W | jq -r '.packages[].ref'); do
     $SL materialize "$ref" && $SL check "$ref"
   done
   ```

   A refusal prints its remedy: `target-missing` means a repository is not cloned at its kit path (step a.3); `execution-host-unset` means run `set-execution-host`.

6. **[Host]** Open the Sentinel dashboard. Confirm the workspace's packages appear and no `legacy-location` row remains.

## g. Clean up

1. **[Mac, and any machine with a checkout]** After a repository's `.specs/` is migrated, remove its `.specs/` lines from `.gitignore` and commit. Leave repositories that track `.specs/` in git (`firstwho/app`, `rearrange-writer`) until the decision on their tracked copies is made.

   ```bash
   grep -n '\.specs' <repo>/.gitignore
   ```

2. **[Machine that ran migrate]** After the retention period, delete the archives. `migrate` moved untracked `.specs/` entries there and nothing else holds them.

   ```bash
   ls ~/.local/share/spec-location/legacy/W/
   rm -rf ~/.local/share/spec-location/legacy/W/<repo-id>-<YYYYMMDD>
   ```

3. **[Any machine]** Remove stale `.specs` copies from linked worktrees. List first, check each is not tracked, then delete the ones you reviewed.

   ```bash
   git -C <repo> worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
     [ -d "$wt/.specs" ] && echo "$wt/.specs"
   done
   rm -rf <reviewed .specs path>
   ```
