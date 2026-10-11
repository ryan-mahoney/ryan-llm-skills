---
name: workspace-kit
description: "Edit a workspace kit (kit.yaml) through the workspace CLI: create a workspace, add, remove or repoint repositories, set roles, names, context, design system and execution host, rewrite paths for another machine, and list or restore kit backups. Use for 'add this repo to the workspace', 'move the workspace to this machine', 'set the execution host', or 'restore the kit'. Never hand-edit kit.yaml."
argument-hint: "<workspace-id> <request>"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Workspace Kit

Change a workspace's `kit.yaml` only through `node ~/.agents/scripts/workspaces/cli.mjs`.
The CLI validates the edit, keeps unknown keys byte for byte, and writes a backup on apply.
Do not open or hand-edit `kit.yaml`.

Contract: `scripts/workspaces/README.md`. Storage must already be set up (`adjacent-storage-setup`).

## Protocol for every edit

1. Run the command **without** `--apply`. The output is the planned hunk and writes nothing.
2. Show the preview to the operator, with the workspace id and the command.
3. Run the same command with `--apply` only after the operator confirms.

`remove-repo` also previews the threads, assignments, artifacts and designs that reference
the repository. They stay in place; say so in the summary.

Read the current state first when unsure:

```bash
node ~/.agents/scripts/workspaces/cli.mjs show <workspace-id>
```

## Request to command

Replace `ID` with the workspace id, `RID` with the repository id from the kit.

| Request | Command |
| --- | --- |
| Create a workspace | `create ID --name "Name"` |
| Rename the display name | `set-name ID --name "Name"` (the id never changes) |
| Add a repository | `add-repo ID --id RID --path ~/Documents/app [--role ROLE] [--remote URL]` |
| Remove a repository | `remove-repo ID --id RID` |
| Change where a repository lives | `set-path ID --id RID --path ~/Documents/app` |
| Set or change the remote | `set-remote ID --id RID --remote URL` |
| Set a role | `set-role ID --id RID --role ROLE` |
| Clear a role | `clear-role ID --id RID` |
| Add context file | `add-context ID --path REL` |
| Remove context file | `remove-context ID --path REL` |
| Set design system | `set-design-system ID --repo RID --path REL [--path REL...] [--applies-to all]` |
| Set execution host | `set-execution-host ID --host HOSTNAME` |
| Rewrite paths for another machine | `rewrite-paths ID --from /Users/me --to '~'` |
| List kit backups | `kit-backups ID` |
| Restore a backup | `restore-kit ID BACKUP` (preview, then `--apply`) |

Add `--apply` only after the preview is confirmed, for example
`add-repo ID --id RID --path ~/Documents/app --apply`.

## Path rules

- Prefer `~/...` for repository paths. A kit with `~/Documents/app` works on every machine.
  Absolute paths tie the kit to one machine.
- `add-repo` and `set-path` require the expanded path to exist and be a Git top level.
- To move an existing kit off absolute paths, use `rewrite-paths` with the machine's home
  prefix, for example `--from /Users/me --to '~'`. The CLI tolerates missing checkouts in
  that rewrite, so a kit can be fixed on a machine that lacks some repositories.

## Execution host

`set-execution-host ID --host HOSTNAME` sets the machine that runs this workspace's live
work. Spec work for the workspace runs only on that host; spec skills refuse elsewhere with
`wrong-host`. Use the exact hostname the target machine reports. Set it before running spec
work, or those skills refuse with `execution-host-unset`.

## Refusals this skill fixes

- `repository-not-in-kit`: the repository a spec or design names is not registered. Run
  `add-repo ID --id RID --path ...` with the checkout's path, preview first.
- `execution-host-unset`: the workspace has no execution host. Run
  `set-execution-host ID --host HOSTNAME`, preview first.
- `wrong-host`: the run is on a different machine than the execution host. Change the host
  only if the operator confirms the move; otherwise run on the named host.

## Failures

Exit `1` prints one JSON object `{"error","path"}` on stderr and changes nothing except a
retained backup when `path` names one. Report `error` and `path` verbatim. Do not retry with
a different edit to get past it. A held or stale `kit.yaml.lock` means another apply is
running or was interrupted: after confirming no apply is running, the operator removes
`kit.yaml.lock` by hand and the command is rerun.

## Report

Give the workspace id, the command, the preview summary, and whether `--apply` ran. Name the
backup path when one was created.
