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

### Optional: live terminal preview (asciinema 3.x)

The dashboard can show a read-only live view of an assignment's tmux session. It is
optional and requires `asciinema` 3.x on the dashboard's `PATH`. Nothing validates the
version: when the binary is missing the panel shows **Not installed**, and an older binary
may fail instead. The viewer panel ships with the dashboard frontend; this section covers
the host prerequisite and the route/lifecycle contract behind it.

```bash
asciinema --version   # install asciinema 3.x; nothing validates the version, and
                      # distribution packages are often older
```

The stream starts only from the host-local dashboard. Terminal routes refuse the configured
public host and any forwarding headers, so view the preview by forwarding the loopback port
instead of opening the Tailscale Serve URL:

```bash
ssh -N -L 4319:127.0.0.1:4319 <host>
# then open http://127.0.0.1:4319/ on the client
```

The view attaches tmux read-only and writes no recording; it stops after the last dashboard
viewer leaves or on dashboard shutdown, signalled only through the dashboard's own
`asciinema` child. While a stream is active, the upstream loopback port asciinema opens
accepts reads from any browser origin; that residual exposure is accepted outside the
dashboard-only promise. Direct readers of the upstream port cannot start a stream and never
count as viewers, so they cannot retain one past the proxy's last-viewer grace window or
its unused-open timer. Restarting the dashboard or a stopped view is an operator action —
nothing restarts automatically.

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

**[Host]** Set `AGENT_SKILLS_REPOSITORY_URL` to this repository's clone URL, then clone it to `~/.agents` and run `sync.sh`:

```bash
git clone "${AGENT_SKILLS_REPOSITORY_URL:?Set the repository clone URL first}" "$HOME/.agents"
~/.agents/sync.sh
```

`sync.sh` does these things:

- installs the locked npm dependencies for the Pi spec runtime and Jev;
- links skills into each installed harness;
- links the spec runtime extension and agent profiles into `~/.pi/agent`;
- links `adjacent-sync` into `~/.local/bin`;
- links the `clauded` and `codexd` exec wrappers into `~/.local/bin`.

Assignments that run Claude Code or Codex use those two wrappers. `clauded` runs
`claude --dangerously-skip-permissions` and `codexd` runs
`codex --dangerously-bypass-approvals-and-sandbox`; both skip the CLIs' approval prompts,
and the execution host itself is the sandbox. The wrappers exec the installed `claude` and
`codex` names through the service PATH from section 7
(`$HOME/.local/share/pi-node/current/bin:$HOME/.local/bin:...`), so they survive CLI
updates. Do not replace them with shell aliases: tmux and the systemd service exec argv
directly and never read shell profiles.

Before the first non-Pi assignment, authenticate both CLIs as the operator user. Run
`claude` and `codex` once interactively with the section 7 PATH, sign in, and accept each
CLI's first-run trust prompt; credentials live in the operator's home, outside this
repository. A first-run or bypass prompt can also appear during a launch, in which case
attach to the assignment's tmux session and answer it there.

Run it again after every `git pull`.

## Native resources and bubblewrap support

Contained Linux waves need cgroup v2 controllers delegated to the user systemd
manager and the unit properties this repository's systemd adapter uses. The runtime
host command checks both, installs the owned policy and slice, and reports the
admitted width:

```bash
node ~/.agents/scripts/spec-observe/cli.mjs runtime-host check
node ~/.agents/scripts/spec-observe/cli.mjs runtime-host setup
```

`check` is read-only unless `--probe` is passed, and it exits nonzero on refusal.
`setup` always runs the isolated user-service probe, verifies the user manager and
refuses when a property is unsupported; re-running it with unchanged inputs
rewrites nothing. The three advanced policy inputs
(`--lifecycle-memory-mib`, `--lifecycle-tasks`, `--aggregate-tasks`) are optional.
Defaults, the automatic pool and the sizing examples are in
[agent-resource-limits.md](agent-resource-limits.md).

### Bubblewrap and overlay isolation

Waves use an unprivileged bubblewrap overlay instead of writing to the project
checkout directly. The host needs:

- bubblewrap 0.11 or newer from the distribution package, built without setuid.
  Earlier releases lack the overlay options, and a setuid binary changes the
  privilege model.
- Kernel OverlayFS usable from an unprivileged user namespace, with the retained
  upper and work directories on one local filesystem.
- On distributions that restrict user namespaces (for example Ubuntu 24.04 with
  its AppArmor profile), the OS-provided unprivileged user-namespace profile. Do
  not copy a binary from another machine, install a custom privileged helper, or
  disable the global restriction; the remedy belongs to the distribution package
  or profile.

The probe runs on `setup` and on `check --probe`: it launches the fixed
namespace-local overlay twice (copy-up and whiteout through the merged view, then a
remount proving both survived phase exit) and reports the observed bubblewrap
version and options, backing filesystem and kernel result. `check` without
`--probe` stays read-only and leaves the capability explicitly unverified.

Overlay mounts are namespace-local: the host mount table is unchanged and the
merged view exists only inside the launch. A rename that crosses mounts can fail
with EXDEV when lower and upper layers live on different mounts, so layers belong
on one local filesystem. Builds and native tests that introspect the mount table,
probe for writable layers or rename across mounts are capability-sensitive, and no
universal support is claimed for them.

A resource-policy refusal never falls back: the launch refuses. The only fallback
is the explicitly reported bounded worktree route, and only when the isolated
probe observes an enumerated overlay capability failure (absent bubblewrap, absent
overlay options, denied user namespace, denied mount, failed kernel semantics,
unsupported layer filesystem). Corruption, exhaustion, unknown kernel effects and
indeterminate probe execution stay blocked.

### Required native rehearsal before activation

Before activation, the operator runs the real native rehearsal on the target host.
It is required and is not evidence already passed. This guide does not run it. The
rehearsal records actual observations:

1. Run `runtime-host setup` and record its check output: user manager version,
   utilities, delegated controllers, required unit properties, bubblewrap
   version/options and the isolated probe result.
2. Launch a real wave service and record the cgroup evidence: the unit's
   `ControlGroup` and `InvocationID`, the memory, task, CPU and `RuntimeMaxSec`
   properties it inherits from `spec-runtime.slice`, and the separate systemd-run
   launcher versus `MainPID`.
3. Prove the registration gate: the worker starts only after the unit and
   `InvocationID` are registered, and a launch without registration cannot
   proceed.
4. Cancel a populated unit and show the cgroup drains; trigger an OOM kill and a
   deadline timeout, and show each result is retained with its distinct reason
   until a positive drain is observed.
5. Clean up the rehearsal's units, gates and transient files, and record the
   observed revision with the evidence artifact.

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

Spec execution skills refuse with `wrong-host` on any other machine. Planning skills (architecture,
spec writing) may run elsewhere; after syncing a package they created or changed, run `materialize` on the host. The host must also write its
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

## Assignment terminals and Sentinel updates

Background assignments use a separate user service named
`adjacent-tmux-<socket-hash>.service`. The launcher starts it on demand with
`systemd-run --user`; it runs `tmux -D` on the workspace's dedicated socket.
The user systemd manager must be available (keep lingering enabled as above).
The service is independent of `spec-sentinel`: restarting Sentinel reconnects
observation without stopping the terminal server or its agents. Keep Sentinel's
normal `KillMode=control-group`. Do not add `PartOf=spec-sentinel.service` to
terminal services or include them in a Sentinel restart command.

Client session creation forbids automatic server startup. If the independent
server fails during launch, the assignment retains an uncertain outcome for
inspection instead of creating a server inside Sentinel. A failed terminal
service does not automatically restart an agent or repeat its prompt.

Before the first update from the older launcher, inspect the **server** PID
(`tmux -S <socket> display-message -p '#{pid}'`) and `/proc/<pid>/cgroup`, as well
as the pane PID. A pane in `tmux-spawn.scope` can still depend on a server inside
`spec-sentinel.service`. Existing servers are not moved or killed automatically:
let their sessions finish before migrating. An existing unmanaged server causes
new managed launches to refuse with a migration message. Start the independent
service on the next launch after the old server has exited. Never delete a live
server's socket to force migration.

For an already-started spec, open its detail and choose **Relaunch agent** after
the previous agent and its workers have stopped. This generates the standard package prompt for
`spec-end-to-end` in a new conversation, preserving
the previous target, model settings and publication authority. The earlier prompt
does not need to have been saved. The skill inspects
existing progress and continues unfinished work. Earlier conversations and files
remain available. Specs without a saved assignment use the normal package-bound
launch form under **Run spec again**. Uncertain ownership prevents a second launch.

On macOS, assignment terminals keep the existing detached tmux transport. The
Linux user-service isolation does not claim protection from a macOS service
manager stopping an entire process group.
