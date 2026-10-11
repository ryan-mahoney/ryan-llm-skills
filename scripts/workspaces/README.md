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
| `launch` | `launch ID --brief REL (--instructions TEXT \| --instructions-file PATH) [--target RID] [--skill NAME] [--id UUID] [--yes \| --digest SHA]` — preview the resolved contract, then start Pi in a dedicated tmux session after confirmation |
| `locate` | `locate ID [--json]` — reconcile one assignment and print its envelope |
| `assignments` | `assignments [--workspace ID] [--json]` — list assignment envelopes |
| `attach` | `attach ID` — attach this terminal to a live assignment's recorded session (requires a TTY) |
| `takeover` | `takeover ID [--run RUN]` — deliver a coordinator hold for a spec assignment, then attach when a TTY is present |
| `resume` | `resume ID --hold ID [--run RUN]` — deliver a release direction naming one retained hold; never releases it |

`launch` always prints the resolved contract and its `contract_digest` first. In a
terminal, `--yes` then typing `yes` confirms; without a TTY, `--digest` must match
the previewed digest. `--brief` is relative to the workspace directory (for example
the `briefs/...` path `add-brief` prints). `--target` names a repository id from
`kit.yaml`; by default the session uses the root's dedicated socket
`<root>/.sentinel/adjacent.sock`.

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

## Assignment observation and attach

`locate ID` reconciles one persisted assignment under the shared root claim
and prints a stable envelope `{record, attach_command, attention}`.
`assignments [--workspace ID]` prints an array of the same envelopes. `--json`
prints the raw envelope(s); the human form lists the assignment id, state,
execution directory, socket, session, a copy-pasteable `attach` command and
any attention entries. `attach_command` is an argv array that round-trips
through this CLI and the resolved root.

`attach ID` requires a TTY on stdin and stdout, a `live` reconciled state, an
absolute recorded tmux socket, a saved pane id, and the recorded pane still
resolving to that exact id with a pane process whose PID and start time still
match the reconciled Pi identity; a mismatch or unknown identity refuses
before any client starts. It then runs `tmux` with an argument array against
the recorded socket and exact `=session` target, with inherited stdio and no
shell. The root claim is released before the attach client starts, so an
attached terminal never blocks a launch, and detaching only ends the client.
The launcher never stops, kills or signals the Pi process; ending an assignment
is operator-owned.

`live` records a confirmed, observable Pi identity and is retained until
reconciliation confirms the assignment is gone. It does not guarantee ongoing
progress or liveness under ambiguous reads: an unreachable tmux server or an
unreadable process identity is unknown, not gone, so the record stays `live`.
A trust prompt or provider wait that the Pi process is sitting in is still
`live`, usually with attention entries, and `attach` is how an operator
answers such a prompt.

Process observation is conservative: the default flattened `ps` scan treats
any process whose argv contains the assignment UUID as a positive candidate.
The `locate` command's own argv contains the UUID, so a `locate` run can list
itself as a candidate and keep reporting `live` plus attention after the Pi
process exited. That evidence only reserves the assignment; no automatic retry
or state change follows from it, and a later observation or operator action
decides.

Local and remote usage:

```bash
node scripts/workspaces/cli.mjs locate <uuid> --json
node scripts/workspaces/cli.mjs attach <uuid>

# Remote: ssh -t forces a TTY so attach is accepted.
ssh -t user@host 'node ~/scripts/workspaces/cli.mjs attach <uuid> --root ~/Documents/adjacent-storage'
```

## Takeover and resume

`takeover ID [--run RUN]` reads the persisted assignment. It requires a
recorded `spec_package`; without one it attaches only (see the non-spec note
below). A spec record must resolve a run: `--run` may fill a missing
`workflow_id` but never overrides a differing recorded one, and the run must
have an exact retained, non-complete checkpoint in the canonical package at
implementation or review stage. The command publishes one `kind: hold`,
`audience: coordinator` original through the single overseer writer and prints
its id, path, sha256 and status before any attach. A TTY attaches only after
the delivery status is confirmed; without a TTY it prints the copy-pasteable
attach command and stops. A hold is a safe boundary, not immediate control:
effects already in flight and the running process are not stopped, and the
hold is released only when the coordinator records an `applied` outcome bound
to both the hold and direction hashes. If the attach fails after delivery, the
receipt reports the error and the message stays held pending; no extra
original is written.

`resume ID --hold ID [--run RUN]` verifies through the real inbox guard that
the named original is a retained `kind: hold` for the same run, then publishes
one `kind: direction` original naming the hold id and hash. It never attaches,
archives, edits or releases anything; the result stays "release requested,
waiting for the coordinator". Wrong run, unknown hold id, a missing checkpoint
and symlinked or absent mailboxes refuse with the ordinary `{error,path}`
envelope and write nothing. Conflicting copies of one hold id, a hold whose
live hash differs from the retained checkpoint hash, and missing hold history
refuse the same way: a release direction is published only for one uniquely
observed, hash-matching hold original.

A non-spec assignment has no automatic actor: `takeover` prints that note,
writes no inbox file and attaches only when a TTY is present.

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
