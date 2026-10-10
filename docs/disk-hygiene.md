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
- **Sibling worktrees in `~/Documents`** (`<repo>-<feature>`, `.git` is a file): same treatment (2026-10-08 second pass: 16GB across 43 worktrees). Gauge activity by the worktree's git `index` mtime (`git rev-parse --absolute-git-dir`), not the folder's mtime, and skip anything touched today or with a live `lsof` path. Some repos don't ignore every artifact folder (gtfs-planner root `node_modules`), so the `check-ignore` gate matters. In zsh, `echo -` prints nothing, so don't use `-` as a column placeholder.
- **Tool caches** (2026-10-08 third pass), using each tool's own garbage collection:
  - **mise runtimes**: Swift toolchains are about 5–6GB each. `mise prune` fails when any worktree `mise.toml` is untrusted and only counts trusted configs, so find references yourself (`mise.toml`, `.tool-versions`, `.swift-version`, `swift-tools-version` minimums), then run `mise uninstall tool@ver`. Removing Swift 6.2 and 6.2.4 freed 11.8GB.
  - **`uv cache prune`**: removes unreferenced entries. It reported 9.5GiB, but `df` barely moved because uv clones cache files into venvs on APFS.
  - **`npm cache verify`**: garbage-collects unreferenced content (small).
  - **Playwright browsers**: `~/Library/Caches/ms-playwright/.links/*` name the projects whose `browsers.json` pins each build. Keep any build a live link references.
- **Docker**: `docker system df` to size; `docker image prune` (dangling), `docker container prune` (stopped), `docker builder prune` (build cache). Volumes need explicit review — they can hold data. Freed space stays inside `Docker.raw` and doesn't show in `df` until Docker Desktop trims the disk image. After the host disk hit 100%, `docker builder prune` and `docker system df` returned `input/output error` on buildkit and overlay2 paths. Don't repeat prunes against a VM in that state.

## Safety procedure (in order)

1. **Check for live users before deleting anything**:
   - `lsof +D <dir>` — anything open?
   - `pgrep -fl <generator>` — is the producer running? (Chrome can *run* from a code-sign clone after an update: check the main process's open `txt` file. A live `mix credo diff` shows as `beam.smp … mix credo diff` and its newest diff dir is mid-write.)
2. **Age rule**: "older than today" = `find . -maxdepth 1 <pattern> -not -newermt "$(date +%F)"`. Keep anything newer.
3. **Review the exact targets**: move approved inactive targets into a staging directory on the same volume, verify its contents, then remove that explicit reviewed path. The move is reversible until removal. Respect command-policy rejections; staging does not grant additional deletion authority.
4. **In-use items stay**: the running Chrome's clone becomes deletable after Chrome fully quits and relaunches from `/Applications`.

## Root causes worth fixing at the source

- `mix credo diff` temp leak: consider trapping/cleanup in the worktree check script, or a launchd job pruning `$TMPDIR/credo-diff-*` older than a day.
- Terraform provider duplication: each module's `.terraform` holds its own provider binaries (~700MB per module, ~8GB per gtfs-planner/warbler checkout, ~32GB total on 2026-10-08), and every worktree copies them again. Setting `TF_PLUGIN_CACHE_DIR` (or `plugin_cache_dir` in `~/.terraformrc`) lets every module share one provider store.
- Chrome clone leak: benign, macOS/Chrome bug; just re-run this cleanup after Chrome updates.
