# Disk hygiene: reclaiming leaked temp, worktrees, and Docker

Machine-cleanup playbook from the 2026-10-03 session that reclaimed **55GB → 5.5GB** in `$TMPDIR` alone. Written to be lifted into a skill when this recurs.

## Reclaim map for `$TMPDIR` (`/var/folders/vy/<hash>/…`)

Find yours with `echo $TMPDIR`. Largest offenders first:

| Path | What leaks | Typical size | Rule |
|---|---|---|---|
| `X/com.google.Chrome.code_sign_clone/` | Chrome update leaves ~1.3GB app-bundle clones per update instead of cleaning up | 40GB+ accumulates | Delete all **except** the in-use clone (see safety below) |
| `T/credo-diff-*` | Every `mix credo diff` run leaks ~83MB; agent worktree pipelines run ~80/day | ~7GB/day | Delete all not tied to a live run |
| `T/` Chrome temp (`com.google.Chrome.*`) | Hundreds of tiny updater leftovers | MBs | Older than today |
| `T/pi-subagents-uid-501/` | Pi extension session state | ~650MB | **Do not bulk-delete**; it self-retains and active runs write here |
| `C/` | Apple caches, SIP-protected | ~2GB | Leave alone |

## Same pattern elsewhere

- **Abandoned worktrees** (`~/.worktrees/`): `git worktree list`, check for live processes (`lsof`, `ps aux | grep <path>`) before removing; `git worktree prune` for stale registrations.
- **Build artifacts in inactive worktrees** (2026-10-08: 14GB): Elixir `_build`/`deps` (~0.2–1.2GB per gtfs-planner worktree) and Terraform `.terraform` provider caches (8GB in one worktree with ~11 modules). Confirm no process has a cwd or open file under `~/.worktrees` (`lsof | grep /.worktrees/`), stage only paths that `git -C <wt> check-ignore -q <path>` confirms are ignored, then remove. Rebuilds with `mix deps.get && mix compile` and `tofu init`. In zsh, iterate the path list with `while read`; `for d in $list` doesn't word-split.
- **Docker**: `docker system df` to size; `docker image prune` (dangling), `docker container prune` (stopped), `docker builder prune` (build cache). Volumes need explicit review — they can hold data. Freed space stays inside `Docker.raw` and doesn't show in `df` until Docker Desktop trims the disk image.

## Safety procedure (in order)

1. **Check for live users before deleting anything**:
   - `lsof +D <dir>` — anything open?
   - `pgrep -fl <generator>` — is the producer running? (Chrome can *run* from a code-sign clone after an update: check the main process's open `txt` file. A live `mix credo diff` shows as `beam.smp … mix credo diff` and its newest diff dir is mid-write.)
2. **Age rule**: "older than today" = `find . -maxdepth 1 <pattern> -not -newermt "$(date +%F)"`. Keep anything newer.
3. **Review the exact targets**: move approved inactive targets into a staging directory on the same volume, verify its contents, then remove that explicit reviewed path. The move is reversible until removal. Respect command-policy rejections; staging does not grant additional deletion authority.
4. **In-use items stay**: the running Chrome's clone becomes deletable after Chrome fully quits and relaunches from `/Applications`.

## Root causes worth fixing at the source

- `mix credo diff` temp leak: consider trapping/cleanup in the worktree check script, or a launchd job pruning `$TMPDIR/credo-diff-*` older than a day.
- Chrome clone leak: benign, macOS/Chrome bug; just re-run this cleanup after Chrome updates.
