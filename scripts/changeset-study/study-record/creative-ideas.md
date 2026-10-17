# Creative directions for batched, pre-planned file execution

`ideas.md` lists the near-term fixes. This file borrows patterns from compilers,
hardware, databases, build systems, biology and operations, and asks what each would
look like for a plan-first executor. Each entry names the pattern, the shape it would
take here, the payoff, and the cost or risk. None is measured; treat them as
hypotheses to freeze and test one at a time.

## From compilers and build systems

### Treat the plan as an IR with passes

A compiler does not emit machine code from the parse tree. It lowers to an
intermediate representation and runs passes: constant folding, dead code
elimination, verification. The changeset plan is already an IR; today it gets one
pass (compile) and then codegen (execute).

- **Passes to add:** merge adjacent replaces on the same file into one; drop
  operations whose write set is untouched by their edits; verify every `reads` path
  exists before any model call; estimate output size per operation and refuse or
  split operations that will not fit.
- **Payoff:** cheaper and more predictable execution without touching prompts.
- **Risk:** passes that rewrite the plan must be deterministic and logged, or the
  frozen-code audit trail breaks.

### Content-addressed operation cache (make, Bazel)

Build systems rerun only targets whose inputs changed. A repair round today
re-plans and re-executes the whole batch.

- **Shape:** key each model operation by hash(instruction, declared input contents).
  On a repair round, operations whose key is unchanged replay their recorded output
  with no model call. Deterministic operations are free anyway.
- **Payoff:** a repair round costs only the operations the feedback actually touched.
  In the handoff run, four of five operations would have replayed.
- **Risk:** a replayed output that was subtly wrong stays wrong. Only replay
  operations whose own gates passed.

### Semantic patches instead of textual ones (Coccinelle)

Coccinelle expresses Linux kernel refactors as patterns over syntax, not text:
"rename this function and update every caller." Most of the hard tasks are
structural: move declarations, re-export a name, add a parameter.

- **Shape:** a small vocabulary of structural edits resolved by a tokenizer or a
  light parser: `move-symbols`, `rename-symbol`, `add-import`, `add-export`,
  `wrap-method-as-delegate`. The engine resolves ranges; the model names intent.
- **Payoff:** output tokens drop by an order of magnitude on refactors, and anchors
  stop being fragile.
- **Risk:** a parser for JavaScript modules is a real dependency. Start with
  top-level declarations only, where a regex over line starts is adequate.

## From hardware

### Speculative execution

CPUs execute both sides of a branch before the condition resolves and discard the
loser. When the planner is unsure whether an operation is deterministic or needs an
editor, it currently picks one.

- **Shape:** for a marked operation, run the deterministic edits and a bounded editor
  call concurrently. Apply whichever passes its gates first; cancel the other.
- **Payoff:** latency of the faster path, correctness of the safer path.
- **Risk:** spends tokens on the discarded branch. Limit to operations whose editor
  input is small.

### Pipelining

An assembly line does not wait for the whole car before painting. The batch today
runs all operations, then all checks, then review.

- **Shape:** as soon as an operation lands, run the cheapest checks that touch only
  its write set: `node --check`, dynamic import, the test files it owns. Feed early
  failures back as per-operation retries while later operations are still running.
- **Payoff:** failures surface tens of seconds earlier and before the single batch
  repair is needed.
- **Risk:** partial checks can pass on a file that the batch as a whole breaks. Keep
  the batch-level gate.

### Streaming fail-fast

Edits arrive as a JSON array; the engine waits for the closing bracket. If the model
emits NDJSON, one edit per line, the engine can validate anchor one while the model
is still generating anchor five.

- **Shape:** stream edits; on the first stale anchor, abort the call and retry with
  the error, saving the remaining output tokens.
- **Payoff:** cheaper failures, faster retries.
- **Risk:** needs provider streaming and a tolerant parser; worth it only if stale
  anchors turn out to be the dominant editor failure.

## From databases and distributed systems

### Savepoints inside the transaction

The executor already treats a batch as a transaction. Add savepoints per operation
so a repair rolls back to the last good operation instead of the start.

- **Payoff:** combined with the operation cache, a repair becomes "resume from the
  failed operation with new instructions."
- **Risk:** operations after the savepoint that read the failed operation's output
  must also be invalidated; the dependency graph already encodes that.

### Interface stubs as the handoff token

In a relay the baton moves before the runner finishes. Dependent operations wait for
the producer's whole file when they only need its exported shape.

- **Shape:** the planner declares each operation's exported interface (names,
  signatures, one-line contracts). The engine writes a stub module from the
  declaration so dependents, especially tests, can be authored concurrently and
  compile against it. The real module replaces the stub on landing.
- **Payoff:** removes the serialization that cost about 129 seconds in the handoff
  run.
- **Risk:** a wrong declared interface produces two coherent halves that do not
  meet. The deliverables gate catches this at the batch boundary.

### Double-entry bookkeeping for deliverables

Every obligation in the spec gets a ledger entry that must be closed by two
independent records: an artifact in the diff and an observation from a check.

- **Shape:** the planner emits the obligations; the engine closes them mechanically;
  the reviewer only sees open entries. An unclosed entry blocks publication without
  a model call.
- **Payoff:** omissions, the failure mode in both handoff attempts, become
  impossible to accept silently.
- **Risk:** the planner can under-declare. Compare declared obligations against
  spec nouns (paths and backticked identifiers) deterministically to flag gaps.

## From biology

### Negative selection (the immune system)

T cells that react to the body's own tissue are destroyed before release. A test
that passes with the implementation reverted tests nothing.

- **Shape:** after execution, for each new test, revert the implementation edits
  (not the test edits) in a scratch copy and run the test. A test that still passes
  is flagged as inert. This is mutation testing with exactly one mutant: the
  original.
- **Payoff:** test deliverables acquire real evidence instead of existence.
  Test-first steps get their "observed intended failure" for free.
- **Risk:** doubles test runtime for the new tests only; cheap on these tasks.

### Stigmergy (ant trails)

Ants coordinate through traces left in the environment, not messages. Operations
today communicate only through full file contents.

- **Shape:** a shared blackboard that each operation updates deterministically on
  landing: symbol table deltas, new exports, changed signatures, line-count changes.
  Dependents read the blackboard and request only the ranges they need.
- **Payoff:** editor input drops from whole files (111k tokens in lifecycle) to the
  windows that matter.
- **Risk:** a blackboard that drifts from the files is worse than no blackboard.
  Rebuild it from the files after every operation; never let a model write it.

### Graceful degradation ladder (annealing)

Materials cool from a disordered hot state into an ordered one. Let the engine, not
the planner, choose how much freedom an operation gets, and only melt where the cold
path fails.

- **Shape:** every operation starts at the coldest rung that could work:
  deterministic edits, then bounded patch editor, then a tool-capable mini-agent
  confined to the operation's write set. The engine escalates one rung on mechanical
  failure, never on its own initiative.
- **Payoff:** the planner stops guessing executors; most operations stay cheap and
  the expensive rung is reserved for the few that need it.
- **Risk:** the top rung reintroduces the native agent's cost. Bound its tool calls
  and keep it inside the operation's declared files.

### Apoptosis (programmed cell death)

A cell that detects its own damage destroys itself rather than endangering the
organism. An editor that sees it cannot complete in one bounded reply should say so
in a structured way instead of returning an empty edit list.

- **Shape:** allow the editor to return `{"split": [{"instruction": ..., "writes":
  ...}, ...]}` proposing two or three narrower operations. The engine compiles them
  into the plan and runs them. One level of splitting only.
- **Payoff:** the lifecycle failure ("Editor returned no edits") becomes a plan
  refinement instead of a dead round.
- **Risk:** a model that splits instead of working. Charge the split against the
  per-operation retry, not the batch repair, and cap depth at one.

## From operations and craft

### Review as a failing test, not findings

An aviation incident report ends in a checklist item, not an essay. Reviewer prose
today is translated by the repair planner back into edits, with loss.

- **Shape:** when the reviewer rejects, it must return at least one concrete test
  case (name, fixture, assertion) that the candidate fails. The engine adds it to
  the test file and runs it. If it passes, the finding is discarded as unfounded.
- **Payoff:** every rejection becomes a regression test and self-verifies.
  Unfounded findings stop consuming repairs.
- **Risk:** some findings are structural (line limits, import cycles) and belong in
  mechanical predicates instead. Give the reviewer both channels.

### Just-in-time anchor binding at spec time

The spec cards already contain edit sequences. Compile a plan skeleton when the spec
is prepared, with symbol-level anchors (function and constant names) instead of
text anchors. At execution, bind the symbols to the current source.

- **Payoff:** planning cost moves to spec preparation, where it is amortized and
  reviewable; execution starts with a plan that only needs re-anchoring.
- **Risk:** source drift between preparation and execution. Symbol anchors tolerate
  most drift; a missing symbol fails loudly and falls back to live planning.

### Best-of-two with a mechanical judge

Sports use tournaments because a judge comparing two finished performances is more
reliable than one grading in the abstract.

- **Shape:** for cheap editor operations, request two samples concurrently and let
  the gates pick: syntax, import, owned tests. If both pass, prefer the smaller
  diff. No model judge.
- **Payoff:** reliability on the operations that cause repairs most often, at
  roughly the token cost of the operation itself.
- **Risk:** doubles token cost on the operations where it is used. Restrict to
  operations with small inputs and known-flaky history.

### Cost before commitment (markets)

Price each operation before running it: estimated input tokens from declared reads,
estimated output tokens from the instruction. Refuse operations above a threshold
and ask the planner to narrow reads or split, before any model call.

- **Payoff:** the 111k-token editor call never happens; the planner is told why.
- **Risk:** estimates are crude. Use byte counts, which the models.mjs client
  already does for the request bound, and make the threshold a strategy parameter.

## Measurement that would make iteration faster

- **Attribute every failed trial to its first mechanical cause** (missing
  deliverable, stale anchor, empty edit, inert test, logic) so iterations target a
  failure class instead of an aggregate score.
- **Show stage timing as small multiples across iterations**, one row per task, one
  column per strategy, so a change that moves time between stages is visible even
  when totals barely move.
- **Record the counterfactual repair.** When a gate would have caught a failure that
  the model reviewer accepted, log it. The count of "gate would have caught this"
  is the cheapest evidence that a gate is worth freezing into the next iteration.
