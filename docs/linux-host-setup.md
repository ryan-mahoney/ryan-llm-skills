# Setting up a Linux execution host

The execution host runs all spec work. It runs Pi with the spec runtime and the Sentinel
dashboard, owns live workspace state (threads, sessions, assignments, spec `runtime/`), and
keeps interactive agents in tmux. Clients such as a Mac reach it over Tailscale and sync
authored workspace material with `adjacent-sync`.

This guide takes a fresh Linux machine to a working host. Steps marked **[Host]** run on the
new machine; **[Client]** steps run on a machine that already has the setup. The examples use
`<host>` for the machine's short hostname, `<tailnet>` for its tailnet domain, and
`~/Documents` as the home for repositories and workspace storage.

After setup, `docs/adjacent-storage-operations.md` covers daily operations: syncing,
backups and migrating a workspace.

## 1. System packages and network

**[Host]** Install the packages that need `sudo` once:

```bash
sudo apt-get install -y git gh jq ripgrep tmux unison curl
```

- `tmux` hosts interactive Pi sessions that survive disconnects; assignment launches need it.
- `unison` must be 2.52 or newer and protocol-compatible with the client's Unison. Without
  `sudo`, see [Unison without sudo](#unison-without-sudo).

**[Host]** Join the tailnet and confirm the machine's name:

```bash
sudo tailscale up
tailscale status --json | jq -r '.Self.DNSName'     # <host>.<tailnet>.
```

**[Client]** Confirm the client can reach the host by SSH without a password prompt:
`ssh -o BatchMode=yes <host> true`. `adjacent-sync` and remote administration depend on it.

## 2. GitHub access

**[Host]** Spec runs create branches, push and open pull requests:

```bash
gh auth login           # choose SSH, or HTTPS with `gh auth setup-git`
ssh -T git@github.com   # expect the "successfully authenticated" greeting
```

Repositories cloned over SSH need the host's key added to GitHub. HTTPS remotes use the `gh`
credential helper.

## 3. Pi and Node

**[Host]** Install Pi with its installer. It installs Node 22.19 or newer if the system has
none, and puts `pi` in `~/.local/bin`:

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi --version
```

The installer keeps its Node at `~/.local/share/pi-node/current/bin/node`. Use that Node, or
any Node 22.19 or newer, for every command in this guide. Distribution packages are often
older. Ubuntu 24.04 ships Node 18, which cannot run the Sentinel or the workspace CLI
(`No such built-in module: node:sqlite`).

Non-interactive SSH sessions do not read the shell profile, so `node` may resolve to the
system version there. Put the right Node first on `PATH` in scripts and remote commands:

```bash
export PATH="$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:$PATH"
node --version     # v22.19 or newer
```

**[Host]** Give Pi its providers:

- **Built-in providers:** start `pi` and run `/login`.
- **Copied configuration:** copy from an existing machine's `~/.pi/agent/` the files
  `auth.json`, `models.json`, `settings.json`, `spec-runtime.json` and any key files that
  `models.json` reads, for example `~/.pi/agent/<name>-key.txt`.
  - Set them to mode `600`.
  - Replace the other machine's home path in `models.json` and `spec-runtime.json` with
    this machine's.
  - Then install the packages listed in `settings.json`:

    ```bash
    jq -r '.packages[]' ~/.pi/agent/settings.json | while read -r pkg; do pi install "$pkg"; done
    ```

## 4. Agent tooling

**[Host]** Clone this repository to `~/.agents` and run `sync.sh`:

```bash
git clone git@github.com:ryan-mahoney/ryan-llm-skills.git ~/.agents
~/.agents/sync.sh
```

`sync.sh` does four things:

- installs the locked npm dependencies for the Pi spec runtime and Jev;
- links skills into each installed harness;
- links the spec runtime extension and agent profiles into `~/.pi/agent`;
- links `adjacent-sync` into `~/.local/bin`.

Run it again after every `git pull`.

## 5. Repositories

**[Host]** Clone each repository a workspace kit lists into `~/Documents/<repository>`. Kits
record repository paths as `~/Documents/<repository>`, so the same kit resolves on every
machine. Install each repository's own dependencies as its README describes. Files that git
does not track, such as `.env`, must be copied separately.

`node ~/.agents/scripts/workspaces/cli.mjs show <workspace> --json` lists each repository's
path and `status`. `missing` means the clone is absent or in a different folder.

## 6. Workspace storage and sync

**[Host]** Create and save this machine's storage root:

```bash
WS="node $HOME/.agents/scripts/workspaces/cli.mjs"
$WS setup --root ~/Documents/adjacent-storage --save
$WS status --json | jq '{status, source, root}'     # status "ok", source "config"
```

**[Client]** Run the first `adjacent-sync` from the client. It runs Unison over SSH, so the host
needs Unison installed but no configuration of its own. Seeding the host, the ignore rules
and conflict handling are in `docs/adjacent-storage-operations.md` (sections b and c).

**[Client or Host]** Make this machine the execution host for each workspace it should run:

```bash
$WS set-execution-host <workspace> --host <host> --apply
```

Spec skills refuse with `wrong-host` on any other machine. The host must also write its
own absolute paths into every package it received through sync:

```bash
SL="node $HOME/.agents/scripts/spec-location/cli.mjs"
for ref in $($SL packages --workspace <workspace> | jq -r '.packages[].ref'); do $SL materialize "$ref"; done
```

### Unison without sudo

Download and unpack the distribution package into your home directory, then point the
client's `adjacent-sync` configuration (`remote_unison` in `~/.config/adjacent/sync.json`) at
the binary:

```bash
D=~/.local/share/adjacent-sync/unison/<version>; T=$(mktemp -d); cd "$T"
apt-get download unison-2.53
dpkg-deb -x unison-2.53_*.deb x
mkdir -p "$D" && cp x/usr/bin/unison-2.53 "$D/unison" && chmod 755 "$D/unison"
"$D/unison" -version
```

Unison 2.52 and newer interoperate across minor versions and OCaml builds. For example, a
Mac with 2.54 syncs with a host running 2.53.

## 7. Sentinel service

**[Host]** Run the Sentinel as a systemd user service. Pin the Node from step 3; systemd does
not read the shell profile:

```bash
NODE=$HOME/.local/share/pi-node/current/bin/node
TSNAME=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/spec-sentinel.service <<EOF
[Unit]
Description=Spec Sentinel host
After=network-online.target

[Service]
ExecStart=$NODE $HOME/.agents/pi/extensions/spec-runtime/sentinel-host.mjs --root $HOME/Documents --port 4319 --public-host $TSNAME
Environment=PATH=$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now spec-sentinel
loginctl enable-linger "$USER"        # keep running without a login session
journalctl --user -u spec-sentinel -n 5 --no-pager
```

The `pi-node/current` link survives Pi's Node updates. The journal shows one JSON line with
`"type":"ready"` once the host is observing.

Only one Sentinel may own `~/.pi/agent`. If Pi already started a host in a session, stop it
before enabling the service.

## 8. Dashboard over Tailscale

**[Host]** Publish the dashboard to the tailnet only:

```bash
sudo tailscale set --operator=$USER     # once, so `tailscale serve` runs without sudo
tailscale serve --bg --https=443 http://127.0.0.1:4319
tailscale serve status
```

Open `https://<host>.<tailnet>.ts.net/` from any tailnet device. Remote viewers can read the
dashboard but cannot complete work or post to threads. For thread interaction from a client,
forward the port and use `http://localhost:4319`:

```bash
ssh -L 4319:127.0.0.1:4319 <host>
```

Never enable Tailscale Funnel for the dashboard.

## 9. Running spec work

**[Host]** Start interactive Pi in tmux so it keeps working after you disconnect:

```bash
tmux new -s spec -c ~/.agents      # later: tmux attach -t spec
pi
```

Inside Pi, invoke the spec skills as usual, for example `/spec-end-to-end` with a goal. A
client attaches with `ssh -t <host> tmux attach -t spec`. Spec packages are created in the
workspace that lists the current repository. When a skill refuses, it prints the command
that fixes the setup.

## 10. Updating

**[Host]**

```bash
cd ~/.agents && git pull --ff-only && ./sync.sh
systemctl --user restart spec-sentinel
```

Restart interactive Pi sessions to load extension changes.

## Checks

Run these on the host after setup and after changes:

| Check | Command | Expect |
|---|---|---|
| Node | `node --version` (with the PATH from step 3) | 22.19 or newer |
| Storage | `$WS status --json` | `status: ok`, `source: config` |
| Workspace | `$SL resolve --workspace <workspace>` | `ok: true` with this host |
| Sentinel | `systemctl --user is-active spec-sentinel` | `active` |
| Dashboard | `curl -s https://<host>.<tailnet>.ts.net/api/state \| jq '.observers[] \| select(.state=="observing") \| .snapshot.coverage.state'` from a client | `complete` |
| Sync | `adjacent-sync status` on the client | both sides `ready` |

## Troubleshooting

- **`No such built-in module: node:sqlite`:** the command ran under an old Node, often the
  distribution's. Use the Node from step 3.
- **`wrong-host` or `execution-host-unset`:** set the workspace's execution host (step 6). The
  comparison uses the first label of the hostname, so `box.local` matches `box`.
- **`repository-not-in-kit`:** add the repository with `workspace-kit` or
  `$WS add-repo <workspace> --id <id> --path '~/Documents/<repo>' --apply`.
- **`legacy-specs-present`, or a `legacy-location` row on the dashboard:** a repository still
  holds `.specs/` data. Migrate it with `spec-location migrate --workspace <workspace>` on the
  machine that holds the data (`docs/adjacent-storage-operations.md`, section f).
- **`path-missing` after a sync:** the package carries another machine's paths. Run
  `$SL materialize <workspace>/<slug>` on the host.
- **Repositories show `missing`:** the clone is absent or not at `~/Documents/<repository>`.
