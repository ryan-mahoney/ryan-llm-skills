---
name: adjacent-storage-setup
description: "Designate a folder as this machine's workspace storage: show the current root and its source, confirm or choose the root, save it with the workspace CLI, verify the boundary, optionally create the first workspace, and restart the Sentinel service so it reads the saved root. Use for 'set up workspace storage', 'where is the adjacent storage', or when a spec skill refuses with storage-unavailable."
argument-hint: "[--root PATH]"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Adjacent Storage Setup

Designate one folder as this machine's workspace storage. The workspace CLI owns every
step; this skill only runs it and reports the result. Spec work requires storage: spec
skills refuse with `storage-unavailable` until this setup is done.

Contract: `docs/adjacent-architecture.md` and `scripts/workspaces/README.md`.

Run the CLI from the Adjacent checkout as `node ~/.agents/scripts/workspaces/cli.mjs`.

## Step 1 — Show the current root

```bash
node ~/.agents/scripts/workspaces/cli.mjs status --json
```

Report `root` and `source`:

- `flag`, `env`: a one-off override is in effect; saving changes the config file only
  for later runs without that override.
- `config`: the root is already saved. Stop unless the operator wants a different root.
- `default`: nothing is saved yet. Continue to Step 2.

Report `boundary` too. `missing_root` or `missing_projects` means setup is still needed.
`invalid_*` or `unreadable` means stop and report the path; do not overwrite it.

## Step 2 — Confirm the root

The default is `~/Documents/adjacent-storage`. Ask the operator to confirm it or name another
absolute path. Do not pick a path silently.

Rules:

- Never move, delete, or rewrite an existing store. If the chosen folder already holds
  workspaces, keep them where they are and point the root at that folder.
- The parent directory must already exist. Setup never creates parents recursively.
- A malformed config file refuses with its path. Fix or move that file by hand after the
  operator agrees; do not replace it from this skill.

## Step 3 — Create the root and save it

```bash
node ~/.agents/scripts/workspaces/cli.mjs setup --root /abs/path/adjacent-storage --save
```

`setup` creates a missing root and `projects/` one component at a time. Repeated runs are
no-ops. `--save` writes `{"storage_root": "/abs/path/adjacent-storage"}` to
`${XDG_CONFIG_HOME:-~/.config}/adjacent/config.json` after the folders exist.

## Step 4 — Verify

```bash
node ~/.agents/scripts/workspaces/cli.mjs status
```

Expect `source: config` and `boundary: ok`. Any other result is a failure: report the
boundary value and stop.

## Step 5 — Create the first workspace (optional)

Ask whether the operator wants a workspace now. If yes:

```bash
node ~/.agents/scripts/workspaces/cli.mjs create <workspace-id> --name "Display name"
```

The id is permanent. It must be a valid workspace id; duplicates refuse. Then add
repositories with the `workspace-kit` skill.

## Step 6 — Restart Sentinel

The Sentinel host, dashboard and Pi extension read the saved root on start, so a running
service keeps the old value until it restarts.

- Linux (systemd user unit):

  ```bash
  systemctl --user restart spec-sentinel
  systemctl --user status spec-sentinel --no-pager
  ```

- macOS: restart the host process that runs Sentinel. Stop it and start it again from
  the same command you use for it. Do not guess a launchd label; ask the operator for it
  if it is not already known.

Do not restart a service while a spec run is active unless the operator confirms.

## Report

State the root, its source, the boundary from Step 4, whether a workspace was created,
and whether Sentinel was restarted. If any step was skipped, say which and why.
