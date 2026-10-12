# spec-location

The only code that maps a workspace, kit or package reference to paths. A spec
package lives in the synced storage root, not in a repository checkout:

```
<storage root>/projects/<workspace>/
  kit.yaml                 execution_host, repositories[{id,path}]
  project-context.md       "## Repository: <id>" sections where repo-specific
  specs/<slug>/            scope.json (synced), locations.json (host paths), runtime/ (never synced)
  epics/<slug>/epic.json   members are package slugs of this workspace
  plans/<name>.md
  captures/<repository id>/
```

`scope.json` is machine-neutral: `targets[{id, branch}]` (kit repository ids), `designs`, `plan`, `epic`.
`locations.json` is materialized for the execution host from scope + kit + storage root.
Only this module and the runtime's `setWorktree` write either file.

## Library (`index.mjs`)

All functions are async and resolve to `{ ok: true, ... }` or a refusal
`{ ok: false, code, message, remedy }`. Every function takes `{ root, env, home, hostname, cwd }` options
(`root` overrides the storage root; `hostname` replaces `os.hostname()`). `authoring: true` (CLI `--authoring` on
`resolve`, `new`, `check`, `scope`) skips the execution-host refusals for planning stages. Off the execution host,
`checkPackage` then returns locations computed for this machine without reading or writing `locations.json`, and
any operation on a package whose `locations.json` records a worktree refuses with `execution-started`.

`resolveWorkspace`, `newPackage`, `locatePackage`, `checkPackage`, `materialize`, `stamp`, `updateScope`,
`setWorktree` (records any path, for the runtime), `recordWorktree` (refuses unless PATH is the root of a git worktree of the target's repository, then restamps), `listPackages`, `listEpics`, `legacySpecs`, `migrate`.

Refusal codes: `storage-unavailable`, `workspace-not-found`, `kit-invalid`, `repository-not-in-kit`,
`repository-in-multiple-kits`, `execution-host-unset`, `wrong-host` (the first DNS label, lowercased, of the
machine hostname and of `execution_host` differ; `Box.local` matches `box`), `legacy-specs-present`, `legacy-check-failed`
(`git ls-files` failed in a kit repository), `package-exists`, `target-not-in-kit`,
`target-exists`, `target-not-in-scope`, `not-a-worktree`, `package-not-found`, `legacy-location`, `locations-missing`,
`path-missing`, `target-missing`, `execution-started`, `invalid-input` (also: `plan` must be a plain file name; target branches must pass `git check-ref-format --branch`), `slug-collision`, `run-active`, `verify-failed`.

`materialize` also creates `project-context.md` and `captures/` when absent so every recorded path exists, and keeps
a recorded target worktree while its directory exists. The stamp is a plain-Markdown block between
`<!-- spec-location:begin -->` and `<!-- spec-location:end -->` inserted after the first H1 of `context.md`,
`spec.md` and each `step-NNN-subspec.md`; rerunning it changes nothing.

## CLI

`node scripts/spec-location/cli.mjs <command>`; JSON on stdout; exit 0 ok, 2 refusal, 1 error. `--root PATH` selects the storage root.

```
resolve [--cwd D] [--workspace W] [--authoring]
new --workspace W --slug S --target ID[:BRANCH]... [--design REF]... [--plan NAME] [--epic SLUG] [--authoring]
check REF [--authoring]
locate REF | materialize REF | stamp REF
worktree REF TARGET_ID PATH
scope REF [--add-target ID[:BRANCH]] [--add-design REF] [--plan NAME|--no-plan] [--epic SLUG|--no-epic] [--authoring]
epics --workspace W
migrate --workspace W [--apply] [--include-transcripts]
```

REF is `<workspace>/<slug>`, a package directory, or a file inside one.

## migrate

Moves untracked `.specs/` content of every kit repository's primary checkout into the workspace. Preview is the
default and writes nothing. `--apply` copies each package, keeping run receipts under `runtime/runs/` but leaving raw
`*.jsonl` and `*.log` files there in the archive unless `--include-transcripts`,
rewrites the old package path in package JSON files outside `runtime/runs/`, reshapes a single-target `pr-url.json`
to `{ package_ref, targets: { <repo id>: {...} } }` (`submittedAt` becomes `submitted_at`, `isDraft`/`is_draft`/`draft`
become `mode: draft|ready`, a `tour` path under the old package points at the new one), converts epics (member
`repository` dropped, plans in `_plans/` referenced by file name), copies `_plans/`, `images/`, `ux-qa/` (except
`ux-qa/runs/`, whose harness session files contain database URLs; it stays in the archive and is listed under
`unmigrated`), appends `project-context.md` under
`## Repository: <id>` (review it afterwards), checks the sha256 of every copied file it did not rewrite, then moves
the repository's untracked `.specs/` entries to `${XDG_DATA_HOME:-~/.local/share}/spec-location/legacy/<workspace>/<repo id>-<YYYYMMDD>/`
and removes `.specs/` if empty. It refuses `run-active` when a legacy `runtime/run.json` is running, cancelling or blocked
and its recorded `coordinator_pid` or `pid` is alive, and `slug-collision` (listing every conflict) before copying. A rerun after a failure continues: a destination package whose
`scope.json` targets only this repository and slug counts as already migrated (not copied again, the legacy copy is still
archived). A leftover epic, plan or capture from the failed run still collides and must be removed first.
A copy or verification failure removes what the run created and leaves the originals untouched.

## Tests

`node --test scripts/spec-location/*.test.mjs` (`fixture.mjs` builds the temp storage root and git repositories).
