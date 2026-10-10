# Scenario contract

A scenario is the tracked fixture and deterministic checks for one frozen workload.
Curators own it; `spec-gym` validates and replays it.

## Layout

```text
scenarios/<exact-spec-skill-name>/
  scenarios.md              # generated index; never hand-edit
  <scenario-id>/
    scenario.json           # the scenario contract and checks
    input/repository/       # fixture repository files, copied into a fresh Git repo
    input/package/          # fixture package files -> <repo>/.specs/<feature>/
    input/project-context.md  # -> <repo>/.specs/project-context.md
```

Only `input/` is materialized into a cell. `scenario.json` and the `scenarios/`
tree never enter a worker's repository.

## scenario.json rules

- `id` matches `^[a-z0-9][a-z0-9-]{1,63}$` and equals the folder name.
- `skill` equals the parent folder name and is an eligible `spec-*` skill.
- `driver` is `leaf` or `managed-step`.
- `status` is `draft` or `ready`.
- `timeout_ms` is a positive integer.
- `task` and `purpose` are non-empty.
- `fixture.feature` is a non-empty package folder name.
- `managed-step` requires a positive `fixture.step` and a non-empty
  `roles.editor_model`; `roles`, when present, must be an object.
- `leaf` must not declare `roles`.
- `input/package/` and `input/project-context.md` must exist; `input/repository/`
  may be empty.
- For `managed-step`, `input/package/` must contain the prepared set — `context.md`,
  `spec.md`, `spec-prepare.md`, `evidence-plan.json`, `spec-steps.json`, every
  indexed `step-NNN-subspec.md`, and `../project-context.md` mapped to
  `input/project-context.md`.
- `expectation_sources` is an array; `checks` is an array of objects with a
  non-empty `id` and a kind from the table below.
- Any symlink under `input/` is refused before the first write.

## Ready-only rules

`status: ready` additionally requires every file under the scenario folder to be
tracked by Git (`git ls-files --error-unmatch`), non-empty `expectation_sources`,
at least one check, and no check with `todo: true`. A fixture containing ignored
files such as `dist/` or `tmp/` is refused, because `.gitignore` would silently
keep it out of the tracked library.

## Version

`version` is one sha256 over `scenario.json` with `status` removed (keys sorted
recursively) and every file under `input/`, sorted by relative path. Changing only
`status` leaves the version unchanged. Changing behavior or inputs changes the
version: keep the id and accept the new version, or create a new id.

## Generated index

`scenarios.md` is generated: title `# Scenarios: <skill>`, one row per scenario
sorted by id (`id`, `status`, first 12 version characters, `driver`, `purpose`,
folder link), then the fixed not-covered sentence. `validate` fails when the
committed file differs from the generated text; `validate --write-index` and
`extract` regenerate it atomically. Never hand-edit the index.

## Checks

`root` is `package` (`input/package/` materialized), `checkout` or `repo` (the
fixture repository; `checkout` and `repo` are the same directory for `leaf` cells).

| kind | semantics |
|---|---|
| `file-exists` | the path exists |
| `file-absent` | the path does not exist |
| `line-1` | `pattern` (regex) matches line 1 only |
| `text-match` | `pattern` (regex) occurs in the file; `absent: true` inverts; a missing file fails both forms |
| `json-equals` | `path` parsed as JSON and `pointer` (`/`-separated key path) compared with `equals` by `JSON.stringify` |
| `git-untouched` | `paths` show no working-tree or committed difference relative to the cell's initial fixture commit |
| `run-state` | `managed-step` only; equals the run record `state` |

Every check records `{ id, ok, detail }`; `detail` cites the inspected path or value.

## Grader reads

Checks never enter worker inputs: only `input/` materializes. A retained session
whose `read`, `grep`, `find`, `ls` or `bash` tool call arguments name the absolute
scenario folder marks the cell `invalid` with reason `grader-read`.
