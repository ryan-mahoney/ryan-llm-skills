# Ideas for the Sol-only changeset executor

Observations come from the two Sol-only iteration runs (`01-patch-editors`,
`02-direct-edits`) and the retained native Sol reference transcripts for the same
three tasks. Code paths are relative to the agents repository checkout on branch
`spec-changeset-execution-poc`.

## Where the changeset arm loses

The failures so far are process gaps the harness could catch mechanically, not
generation quality.

| Task | Native Sol | patch-editors | direct-edits |
|---|---:|---:|---:|
| context calibration | 23 s pass | 37 s pass | 18 s pass |
| dependency handoff | 245 s pass, 1 repair | 243 s fail, 99/101 | in progress |
| lifecycle extraction | 207 s pass | 240 s fail, >1,550 lines | not run |

- **Handoff, patch-editors.** The editor wrote the five `wave handoff:` tests, but
  nothing ran them. The visible check in `scripts/changeset-study/cell.mjs` runs only
  the task's check command, which names six pre-existing tests. The reviewer accepted
  a candidate whose own new tests fail. Native Sol ran its new tests, hit the same two
  defects (`reason` not `null` for accepted dependencies; `git -z` output trimmed) and
  fixed them inside its single repair. The changeset arm never saw that signal.
- **Handoff, direct-edits.** All twelve replace anchors matched and the plan applied
  cleanly, but the plan omitted the test file entirely. The one repair is being spent
  on an omission that a deliverables check would have caught at zero cost.
- **Lifecycle, patch-editors.** The editor received 111k input tokens and returned
  `{"edits": []}` after reasoning that a one-shot bounded answer was impossible. The
  instruction asked a no-tools model to emit a new ~500-line module and the matching
  removals in one JSON reply. Native Sol did the same move by slicing byte ranges with
  a node script and only typed the delegate wrappers.

Calibration shows the ceiling on small tasks is a few seconds. The win has to come
from the large tasks, and there the arm has been losing on correctness, not speed.
Quality gates first, call-count trimming second.

## Changes, in the order to try them

### 1. Run the candidate's own changed tests before review

After execution, collect every touched `*.test.mjs` plus the task's check command,
run them in the sandbox, and put the output in both review input and repair
feedback. This is not hidden-test leakage: the tests are the candidate's own. It
restores parity with native, which always had this loop. Of everything here, this is
the change most likely to have delivered handoff on the first attempt.

### 2. Mechanical completeness gate from planner-declared deliverables

Have the planner emit a `deliverables` list up front: paths, new exported names, new
test names. After execution the engine verifies each path is in the diff and each
name appears in the right file. Add `node --check` on every changed `.mjs` and a
dynamic `import()` of each changed module to catch broken wiring. Failures block
before the model reviewer runs and hand the repair planner exact gaps instead of
prose findings. Several hard-spec acceptance items (line limits, no import cycle,
re-exported names) are already mechanical predicates; run them every round.

### 3. Line-range and symbol moves for extraction

The uncommitted `source-ranges` work (compose, replace-range) is the right
direction. Two refinements:

- Anchor on line numbers plus the file hash precondition rather than unique strings.
  The planner already sees `sed -n` and `rg -n` output with line numbers during
  discovery. Typing a unique anchor verbatim from a 143 KB file at low reasoning is
  where it will slip.
- Compute a deterministic top-level symbol table per `.mjs` (name, kind, start line,
  end line) and include it in the discovery output. A `move-symbols` edit
  (`from`, `to`, `names`, `export`) would do most of lifecycle extraction with
  near-zero output tokens. Class method bodies are not top-level; those still need a
  small model-written delegate, which is the part native Sol typed by hand too.

### 4. Per-operation mechanical retry that does not consume the batch repair

Empty edits, anchor mismatch and precondition failure are format errors, not logic
errors. One immediate re-ask of the same operation with the exact error text is
cheap and keeps the single batch repair for behavioral feedback. This changes the
protocol's repair accounting, so declare it in `ITERATION-PROTOCOL.md` rather than
folding it in silently.

### 5. Recover concurrency and caching

- In handoff the test operation depended on wiring and profiles, serializing four
  editor calls (about 129 s of the 243 s). The spec's test cases are fully
  specified, so tests can be written from the contract in parallel with the
  implementation. Let the planner declare an interface contract (exported names and
  signatures) so dependents compile against it instead of waiting for the file.
- Every receipt in both runs shows zero cache reads. Put the stable prefix (source
  files, task contract) first and the per-operation instruction last. Whether this
  provider caches at all is unverified; it costs nothing to check.

## Cautions

- The handoff spec is unusually plan-shaped (decisions D1 to D14, exact assertions),
  so it is the best case for plan-first execution. Losing it by omission is
  informative and fixable; it is not evidence against the approach.
- Gates 1 and 2 are generic and would apply to any task, so they stay inside the
  protocol's rule against task-specific routing. Record them as strategy changes
  with their own frozen iteration.
