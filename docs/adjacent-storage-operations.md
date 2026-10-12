# Adjacent storage operations

Operator runbook for running workspace storage on two machines: the Linux execution host (`<host>`) and a Mac client. The host owns all live state (threads, sessions, assignments, `.sentinel/`, spec `runtime/`). Authored material moves between machines with `adjacent-sync` (Unison over SSH, run on demand). Design and rationale: `docs/adjacent-architecture.md`. CLI reference: `scripts/workspaces/README.md` and `scripts/spec-location/README.md`. Sync reference: `scripts/adjacent-sync/README.md`. To set up a new Linux host, start with `docs/linux-host-setup.md`.

Each step is tagged with where it runs: **[Mac]**, **[Host]**, or **[Both]**. `W` is a workspace id. `WS` is the CLI shorthand used below:

```bash
WS="node $HOME/.agents/scripts/workspaces/cli.mjs"
SL="node $HOME/.agents/scripts/spec-location/cli.mjs"
```

Run `~/.agents/sync.sh` on each machine first so it has the current code, the ignore list, and the `adjacent-sync` link.

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

The host starts its own live state. The first `adjacent-sync run` copies the authored set from the Mac. `scripts/adjacent-sync/ignore.prf` keeps host-owned live state and secrets out of the transfer.

1. **[Mac]** Back up the whole store, live state included.

   ```bash
   cp -R ~/Documents/adjacent-storage ~/adjacent-storage-backup-$(date +%F)
   ```

2. **[Host]** Run step a.1 so the host has a root. Make sure `~/Documents/adjacent-storage` exists and is empty before the first sync; the step may create `projects/`, and empty directories are fine. Confirm Tailscale SSH works: `tailscale up --ssh` on the host, then `ssh <host> true` from the Mac. Install Unison on both machines first (section c).

3. **[Mac]** Create the sync config, check it, and review the preview before the first run.

   ```bash
   adjacent-sync init                 # creates ~/.config/adjacent/sync.json (owner-only)
   # edit the config: ssh_host = <host>, local_root = ~/Documents/adjacent-storage,
   # remote_root = the absolute host path, for example /home/<user>/Documents/adjacent-storage
   adjacent-sync status               # SSH, host folder, and Unison version
   adjacent-sync preview              # transfers nothing; review the list
   adjacent-sync run                  # first run copies the authored set
   ```

   Stop before `run` if the preview lists anything under `threads/`, `sessions/`, `assignments/`, `runtime/`, `.sentinel/`, or `.adjacent/`. Check that `ignore.prf` is current on this machine (`~/.agents/sync.sh`) and preview again.

4. **[Host]** Verify that no live state arrived, then check the kits.

   ```bash
   find ~/Documents/adjacent-storage -maxdepth 3 \( -name threads -o -name sessions -o -name assignments -o -name .sentinel -o -name .adjacent \)   # expect no output
   $WS list
   ```

## c. Syncing with adjacent-sync

`adjacent-sync` uses Unison over SSH to sync the authored workspace content between the Mac and the host. It runs only when you start it. No timer or daemon runs it.

### Install

Install Unison on both machines. Both need Unison 2.52 or a newer compatible version.

**[Host]** `sudo apt-get install unison`, or a user-local binary. For a user-local binary, set `remote_unison` in the config to its absolute path.

**[Mac]**

```bash
brew install unison
```

### Use

**[Mac]** Run these from the Mac, which holds the private config (`~/.config/adjacent/sync.json`):

```bash
adjacent-sync status      # config, dependencies, SSH, and host readiness; changes no data
adjacent-sync preview     # shows what would change; propagates nothing
adjacent-sync run         # propagates nonconflicting changes
```

Run `preview` before `run`. The config fields are documented in `scripts/adjacent-sync/README.md`, and the exclusion list is `scripts/adjacent-sync/ignore.prf`.

### Conflicts

`run` exits nonzero when a file changed on both machines and needs a decision. Resolve each conflicting file so the version you want is the only one left, then run `adjacent-sync preview` again, then `adjacent-sync run`.

### When to sync

There is no schedule. Run `preview` and then `run` when you switch between the Mac and the host. Syncing before you start work on the other machine is a manual habit, not a timer.

Check: edit a kit on the Mac, for example `$WS set-name W --name "..." --apply`, run `adjacent-sync run`, and confirm the change appears on the host. Nothing under `threads/`, `sessions/`, `assignments/`, `.sentinel/` or `runtime/` should ever appear on the other machine.

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

`adjacent-sync` is not a backup: it propagates deletions and corruption. **[Host]** snapshot the store daily and exclude the Whisper model cache and raw run transcripts.

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
4. **[Mac]** Run `adjacent-sync preview`, then `adjacent-sync run`, so the migrated packages reach the host.
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
