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
(`root` overrides the storage root; `hostname` replaces `os.hostname()`).

`resolveWorkspace`, `newPackage`, `locatePackage`, `checkPackage`, `materialize`, `stamp`, `updateScope`,
`setWorktree`, `listPackages`, `listEpics`, `legacySpecs`, `migrate`.

Refusal codes: `storage-unavailable`, `workspace-not-found`, `kit-invalid`, `repository-not-in-kit`,
`repository-in-multiple-kits`, `execution-host-unset`, `wrong-host` (first DNS label of the hostname,
lowercased, differs from `execution_host`), `legacy-specs-present`, `package-exists`, `target-not-in-kit`,
`target-exists`, `target-not-in-scope`, `package-not-found`, `legacy-location`, `locations-missing`,
`path-missing`, `target-missing`, `invalid-input`, `slug-collision`, `run-active`, `verify-failed`.

`materialize` also creates `project-context.md` and `captures/` when absent so every recorded path exists, and keeps
a recorded target worktree while its directory exists. The stamp is a plain-Markdown block between
`<!-- spec-location:begin -->` and `<!-- spec-location:end -->` inserted after the first H1 of `context.md`,
`spec.md` and each `step-NNN-subspec.md`; rerunning it changes nothing.

## CLI

`node scripts/spec-location/cli.mjs <command>`; JSON on stdout; exit 0 ok, 2 refusal, 1 error. `--root PATH` selects the storage root.

```
resolve [--cwd D] [--workspace W]
new --workspace W --slug S --target ID[:BRANCH]... [--design REF]... [--plan NAME] [--epic SLUG]
locate REF | check REF | materialize REF | stamp REF
scope REF [--add-target ID[:BRANCH]] [--add-design REF] [--plan NAME|--no-plan] [--epic SLUG|--no-epic]
epics --workspace W
migrate --workspace W [--apply] [--include-transcripts]
```

REF is `<workspace>/<slug>`, a package directory, or a file inside one.

## migrate

Moves untracked `.specs/` content of every kit repository's primary checkout into the workspace. Preview is the
default and writes nothing. `--apply` copies each package (without `runtime/runs/` unless `--include-transcripts`),
rewrites the old package path in package JSON files outside `runtime/runs/`, reshapes a single-target `pr-url.json`
to `{ package_ref, targets: { <repo id>: {...} } }`, converts epics (member `repository` dropped, plans in `_plans/`
referenced by file name), copies `_plans/`, `images/`, `ux-qa/`, appends `project-context.md` under
`## Repository: <id>` (review it afterwards), checks the sha256 of every copied file it did not rewrite, then moves
the repository's untracked `.specs/` entries to `${XDG_DATA_HOME:-~/.local/share}/spec-location/legacy/<workspace>/<repo id>-<YYYYMMDD>/`
and removes `.specs/` if empty. It refuses `run-active` when a legacy `runtime/run.json` is running or cancelling
and its recorded `coordinator_pid` or `pid` is alive, and `slug-collision` (listing every conflict) before copying.
A copy or verification failure removes what the run created and leaves the originals untouched.

## Tests

`node --test scripts/spec-location/*.test.mjs` (`fixture.mjs` builds the temp storage root and git repositories).
