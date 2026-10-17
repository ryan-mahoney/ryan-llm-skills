# Compile settled changes, then verify the batch

The changeset prototype turns a bounded coding assignment into an executable plan.
A capable planner reads the specification and relevant current source, chooses the
changes, and describes their dependencies. The executor applies those decisions
without a reasoning conversation around every file. Behavioral verification and
impact review happen after the batch; failures can trigger a bounded batch repair.

This is an implemented research runtime. Integration with the managed
`spec-end-to-end` workflow is [proposed separately](INTEGRATION.md).
The [offline visual](visual.html) explains the mechanism and measured results.
All code paths below are relative to the repository root.

## 1. Build a plan against current source

The planner receives the task, preservation constraints, acceptance requirements,
and source context. The matched study supplies source directly for six synthetic
tasks and permits read-only discovery for two extracted historical fixes.

A plan contains `schema_version: 1` and `operations`. Each operation names an `id`,
`executor`, `reads`, `writes`, and `depends_on`. Deterministic operations contain
exact edits; model operations contain an instruction. Optional SHA-256 preconditions
bind operations to expected contents. Preconditions must describe the contents at
that operation's execution point, including prior dependent edits.

The runtime supports three executor labels:

- `deterministic`: create, exact-count replace, delete, rename, or JSON key update.
- `simple`: one model request using the configured simple-editor adapter.
- `involved`: one model request using the configured involved-editor adapter.

These labels are capabilities, not evidence that a particular cheaper model is
reliable. The matched study used the same model in every role within each arm.

## 2. Compile dependencies and stage changes

`scripts/changeset/engine.mjs` validates operation IDs, paths and dependencies,
rejects cycles, and infers additional ordering for overlapping reads and writes.
Declared dependencies determine ordering; remaining conflicts follow the compiler's
stable order. Disjoint work can run concurrently, with a default limit of four.

`scripts/changeset/workspace.mjs` keeps a private in-memory candidate. An operation
receives the current contents of its declared files when it starts. For example:

```text
A: update config.json's timeout ──→ C: add config.json's retry setting
B: rename an independent helper ─→ D: update that helper's caller
```

A and B may run together. C sees A's updated configuration, and D sees B's result.
Shared-file work is serialized rather than merged after two writers independently
edit stale copies. Exact replacement anchors still need to match the updated text;
the runtime does not invent a new edit when an anchor becomes stale.

## 3. Execute once per operation

Deterministic operations require no model inference. Model operations receive
declared context and return structured file contents in a single request. The
executor enforces write ownership and validates supported syntax (JSON and JS/MJS).
It does not initiate a local editor conversation. A failed operation blocks its
dependents; independent work may finish and be retained as a private repair draft.

This eliminates some model round trips, not the need to read source or check
behavior. The planner must understand the change, adapters need current context,
and syntax alone cannot establish that the intended behavior was preserved.

## 4. Verify and review the integrated candidate

`scripts/changeset/workflow.mjs` combines execution with a verification callback and
an impact-review callback. The verifier receives an isolated candidate; mutation
of that candidate is rejected. The reviewer receives execution results, the draft,
and prior rounds. It returns acceptance, findings, and optionally a repair plan.

The default permits one batch repair (configurable from zero to two). Successful
staged changes carry into the repair draft. The caller's workspace is updated only
when execution, verification, and review accept the candidate. Rejected drafts remain
unpublished. This is bounded iteration at a batch boundary, not a guarantee of zero
iteration.

Disk publication is a separate operation. It checks original snapshot contents for
staleness and attempts rollback on synchronous write failures. It requires an
exclusive writer and is **not crash-atomic**. The current loader accepts bounded
UTF-8 text snapshots (2,000 files / 8 MiB), excludes `.git` and `node_modules`, and
rejects symlinks, binary files and unsupported encodings. Production integration
needs a scoped snapshot and explicit handling of unsupported inputs.

## 5. Measure complete outcomes

The study compares this approach with Pi's native coding-agent tools, including
normal batching and parallel tool execution. Both arms use identical tasks and a
common impact-review stage. Hidden tests run only after the candidate freezes and
never provide implementation or repair feedback. Timing includes planning,
discovery, execution, checks, review, repair, startup and terminal grading.

Across 16 Sol trials per arm, mean time fell from 20.45 to 15.60 seconds, calls from
77 to 41, and reported tokens from 180,424 to 78,622. Both arms passed 16/16 under
the original and supplemental checks. Fifteen of sixteen Sol changeset trials needed
no separate model editor: exact edits came directly from the planner.

DeepSeek and Mercury lost acceptance under changesets. The finding supports capable
planning with executable edits on this bounded corpus; it does not establish a
general gain from cheap-model routing or quantify savings in `spec-end-to-end`.
See [findings](FINDINGS.md), [protocol](PROTOCOL.md), and [full results](results.md).
