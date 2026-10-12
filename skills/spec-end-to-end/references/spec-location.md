# Spec Location

The first step of every spec, epic, and capture skill. Spec packages, project context, epics, plans, designs, and
captures live in the workspace's adjacent storage, never in a repository checkout. `spec-location` is the only code
that maps a workspace, kit, or package reference to a path. A skill never builds a path from a slug.

## Check

Input is a package reference (`<workspace>/<slug>`), a package folder, or a file inside one:

```bash
node ~/.agents/scripts/spec-location/cli.mjs check <package ref or folder>
```

On success it prints `{ ok: true, locations }`. On refusal it exits 2 and prints `{ ok: false, code, message, remedy }`:
print `message` and `remedy` to the user and stop. Do not choose a location, copy files, or retry with a different
path. The checks cover the storage root, the execution host, `locations.json`, every recorded path, and each target
repository on this machine.

Before a package exists (only `spec-architect-initial` starts here), resolve the workspace from the current
repository instead:

```bash
node ~/.agents/scripts/spec-location/cli.mjs resolve --cwd .
```

Pass `--workspace <name>` when the repository belongs to several kits or no repository is involved. The refusal rules
are the same.

## Planning on another machine

Planning stages (`spec-architect-initial`, `spec-architect-critics`, `spec-write`, `spec-subspec-write`, `spec-upgrade`,
`spec-issue`) pass `--authoring` to `resolve`, `new`, `check`, and `scope`. They write only package documents, so they
may run on a machine other than the workspace's execution host. Every other stage omits the flag and refuses with
`wrong-host` there, because runs, leases, worktrees, and Sentinel observation exist only on the execution host.

Off the execution host:

- `check --authoring` prints locations computed for this machine and leaves `locations.json` unchanged; that file
  holds the execution host's paths. Take paths from the printed `locations`, not from the file.
- `new` and `scope` write this machine's paths into `locations.json`. After syncing workspace storage, run
  `spec-location materialize <ref>` on the execution host; its `check` refuses with `path-missing` until then.
- A package whose `locations.json` records a worktree refuses with `execution-started`: its execution has begun, and
  further changes belong on the execution host.
- `new` checks the slug only against this machine's copy of storage. Sync before creating a package and after
  finishing.

## Read paths by field name

Take every path by field name from the `locations` that `check` prints. On the execution host it is the content of
`<package_dir>/locations.json`; off the host with `--authoring` it is computed for this machine:

| Need | Field |
|---|---|
| Package folder (spec, cards, evidence, reviews, tour, `runtime/`) | `package_dir` |
| Project context | `project_context` |
| Plan, epic record | `plan`, `epic` (null when none) |
| Design packages | `designs[].dir` |
| Screenshots and workflow captures | `captures_dir` (`<captures_dir>/<repo id>/...`) |
| Target repository checkout | `targets[].primary` |
| Branch and worktree for that target | `targets[].branch`, `targets[].worktree` |

`package_ref` is the identity written into receipts, publication records, and handoffs. The top of `context.md`,
`spec.md`, and each step card carries a generated block between `<!-- spec-location:begin -->` and
`<!-- spec-location:end -->` listing the same paths. Edit the rest of the document, never the block, and never edit
`locations.json` or `scope.json` by hand.

A handoff between stages carries `package_ref` and `package_dir`. The receiving skill runs `check` on the folder, then
reads `locations.json`; it does not search for the package.

## Code and specs stay apart

- Code, Git, builds, and tests run in one worktree per target repository. `targets[].worktree` is where the runtime
  recorded it; before dispatch it is null and the target's `primary` is the base.
- Spec files are never inside a checkout. Never create, copy, or symlink a spec folder, `.gitignore` entry, or
  project-context file into a repository or worktree. Evidence and artifacts reference package files by package-relative
  path and target files as `<repo id>:<path>`.
- Resolve any command output destination to an absolute path before running it, so a relative redirect or screenshot
  path cannot land in the worktree.
- If `check` reports a package path inside a checkout (`legacy-location`) or untracked legacy spec folders
  (`legacy-specs-present`), stop with its remedy (`spec-location migrate`).

## Change scope

Targets, designs, the plan, and the epic of an existing package change only through the CLI, which rewrites
`scope.json` and `locations.json` and restamps the documents:

```bash
node ~/.agents/scripts/spec-location/cli.mjs scope <ref> [--add-target ID[:BRANCH]] [--add-design REF] [--plan NAME|--no-plan] [--epic SLUG|--no-epic]
```

Use the `locations` it prints afterward. Only `spec-architect-initial` creates a package (`new`); no other skill does.

## Epics

An epic record is `epic.json` in the workspace's `epics/` folder; `locations.epic` holds its path for a package that belongs to one. Its members are package
slugs in the same workspace. To list members with their folders:

```bash
node ~/.agents/scripts/spec-location/cli.mjs epics --workspace <workspace>
```

Each member prints `{ slug, packageDir, exists }`. Run `check` on a member's `packageDir` before using it.
