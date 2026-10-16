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
    input/package/          # fixture package files -> the cell's package_dir (spec-location)
    input/project-context.md  # -> the cell's workspace project-context.md
```

Only `input/` is materialized into a cell. `scenario.json` and the `scenarios/`
tree never enter a worker's repository.

## scenario.json rules

- `id` matches `^[a-z0-9][a-z0-9-]{1,63}$` and equals the folder name.
- `skill` equals the parent folder name and is an eligible `spec-*` skill.
- `driver` is `leaf`, `managed-step`, or `changeset`.
- `status` is `draft` or `ready`.
- `timeout_ms` is a positive integer.
- `task` and `purpose` are non-empty.
- `task` may contain `{package}`; the runner replaces it with the cell's
  package directory before the task is sent.
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

## Experimental changeset driver

`driver: changeset` runs a tool-free planner once through the configured Pi model
runtime, then executes the emitted plan through `scripts/changeset/`. It requires
`input/package/spec.md` and `execution` with `concurrency` (1..32), `simple_model`
and `involved_model` selectors; optional `max_tokens` is 1..32000. Set the
`CHANGESET_BUDGET` environment variable to a persistent ledger outside the checkout.
The ledger caps the campaign at USD 50 including conservative reservations for
unknown charges. Provider pricing metadata is an estimate, not an invoice.

The manifest freezes `changeset_sha256` over runtime and gym sources. Each cell
retains `execution.json`, planner JSON, and receipts for every planner/editor call;
reported model usage includes all tiers. Cells share no mutable workspace.

`node-check` runs a trusted curator-owned Node script under `graders/`, outside
worker inputs. Specify `script: graders/name.mjs` and `timeout_ms: 1..60000`.
The script receives checkout and package paths as argv[2] and argv[3]. Exit zero
passes; nonzero, timeout or excess output fails. Environment contains PATH and LANG
only. Grader files are included in the frozen scenario version. Scripts and their
parents must not be symlinks. This is process isolation, not an OS sandbox; graders
must be trusted and must not spawn persistent child processes. A check can inspect
behavior without relying on worker-authored assertions or claimed results.

`execution.review_model` enables the integrated impact workflow;
`execution.max_repairs` is an integer 0..2. Optional `execution.repair_model`
selects the model used for model operations in subsequent repair batches. These
selectors are curator-owned and must be explicitly authorized. Repairs retain
successful staged outputs, and each repaired batch repeats behavior verification
and impact review. The original plan, per-round drafts, repairs and all calls are
retained. Changing execution settings changes the scenario version even when
source inputs and assertions stay identical.
