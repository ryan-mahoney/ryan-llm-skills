# Unit Testing Guide

**Core rule:** Retain tests for the useful protection they add at reasonable execution
and maintenance cost. Test observable behavior, not incidental implementation.

Apply when creating, changing, reviewing, or removing tests. Use the value and reduction
guidance for all test layers. Repository instructions govern required checks and execution.
Ordinary feature work needs this guide, not a separate suite audit or per-test ledger.

## Evaluate value before volume

An obligation is an accepted business rule, public contract, technical invariant, or
important regression that needs protection. Evaluate cases within a behavior group,
then compare the relevant retained tests across layers.

| Dimension | Question |
|---|---|
| Purpose | What obligation does the test protect, and where does it come from? |
| Failure detection | What plausible wrong behavior does this assertion reject? |
| Added protection | What input class, boundary, regression, independent oracle, or useful diagnosis does this add? |
| Refactoring tolerance | Can internal implementation change without breaking this contract? |
| Oracle quality | Is the expected result independent of the production logic under examination? |
| Cost and clarity | Is setup, execution, diagnosis, and maintenance proportional to the protection? |

For an audit, use `strong`, `concern`, or `unknown` with concrete evidence. Do not sum
these into a deletion score. A weak assertion for valuable behavior needs improvement.
A slow test with unique protection needs cheaper setup or appropriate scheduling.
Test counts, source-line overlap, and coverage percentages alone justify neither additions
nor removals. Coverage can locate gaps, but it cannot establish assertion quality.

## Select maintained cases

- Inspect existing tests and fixtures before adding a case or file. Reuse sufficient evidence.
- A new case needs a credible failure existing evidence does not adequately reject, or a
  concrete improvement in diagnosis or execution cost. Put the reason in its name or
  existing planning prose, not a new mandatory metadata record.
- Select examples that distinguish input classes, decision boundaries, material error
  paths, or known regressions. Do not invent unsupported input contracts or speculative
  permutations to make coverage appear complete.
- Use pure tests for rule permutations and focused integration tests for actual wiring,
  persistence, transactions, serialization, authorization, and process boundaries.
  Use the smallest boundary that can expose the failure. Do not duplicate a full matrix
  across layers unless crossing a boundary can change the outcome.
- Retain tests of distinct contracts even when their scenarios or executed lines overlap.
  Simple wrappers can own meaningful representation or compatibility contracts.
- Do not require one new test per function, file, rule, claim, or implementation step.
  Existing evidence can suffice. Temporary discovery tests need not become maintained tests
  unless they add ongoing protection or useful diagnosis.

## Test economy

Every test costs time to write, run, and maintain. Before adding or running one:

1. Name the credible failure. A requirement, a sourced invariant, a bug report, or an
   observed failure justifies a test. The existence of a behavior does not.
2. Pick the smallest check that rejects that failure: an existing case, then one new case,
   then a file. Measure "smallest" in elapsed time and attention, not case count; a
   two-second file beats a minute spent composing a filter.
3. Run that check first and read its result before running anything broader. Run more
   only when the result leaves a concrete question open.
4. Stop when the question is answered. Prior passing evidence stands until an affected
   change or a named uncertainty invalidates it.

Do not write these without a requirement or bug report naming them: an input gained
focus, an attribute or class name is present, a component renders without crashing, a
snapshot matches, a wrapper forwards a call, a default equals itself, or a layout detail
a screenshot already shows. When a step produces inspected screenshots, those captures
are the visual evidence; add a browser assertion only for behavior that will regress
silently in later edits, such as a state transition or a data-driven render.

Make each new case selectable on its own: give it a name the runner's filter can match,
keep its setup inside the case or a fixture it owns, and do not rely on sibling cases or
a shared mutable `beforeAll` to establish its state. Record the command that runs the
case alone next to the case.

Measure a new test's elapsed time on its first run. When the case or its setup adds more
than five seconds, or exceeds a repository-stated threshold, name the cost and the
reduction before shipping it: a cheaper fixture, a narrower module, removed waits, or a
unit case in place of an integration case. A slow test with unique protection may stay,
with its cost recorded.

## Structure and assertions

- Name the behavior and condition, such as `rejects empty slug`, rather than numbering
  tests or using bare method names. Keep each case focused on one behavior.
- Separate arrange, act, and assert. Keep shared setup minimal and relevant facts visible.
- Allow named table cases and reproducible properties when they reduce repetition without
  hiding failures. Identify the failing input. Parameterization reduces text, not executed cases.
- Avoid branches or calculations in expectations that copy the production algorithm.
  Use hand-derived examples, known vectors, or independently justified properties.
  For predicates, consider both matching and nonmatching inputs: always-true implementations
  can survive properties that only generate matching cases.
- Assert outcomes, not incidental calls or order, unless the interaction is the contract.
  Use exact values for exact contracts. Use partial or structural assertions when omitted
  details are intentionally outside the contract, not to weaken the expected result.
- Keep fixture reuse subordinate to readable failures. A short repeated fact is preferable
  to a helper that hides why the assertion is correct. Do not merge unrelated cases into
  a large test merely to reduce the count.

## Dependencies and state

- Prefer real, fast, deterministic collaborators. Excessive mocking of owned modules is
  a design smell. Use scoped fakes or stubs at the narrowest appropriate external boundary.
  Exercise an isolated real dependency when a fake cannot expose the claimed failure.
  A real-boundary requirement does not authorize live-service access.
- Control time and randomness. Preserve seeds or failing examples for generated cases.
  Use fake time or observable synchronization instead of sleeps.
- Treat environment variables, random seeds, process cwd, module caches, singleton registries,
  feature flags, shared clients, and global DOM/storage as shared state.
- Pair every shared-state mutation with cleanup in `afterEach`, `finally`, or the framework's
  scoped restore API. Capture the prior value and restore it exactly, including absence.
- Prefer dependency injection over module-level patches. If code reads state at import time,
  isolate the module cache or use a runtime read when appropriate to the design.
- Create fresh mutable fixtures or freeze shared fixtures. Tests must not depend on import
  order, execution order, or another test's cleanup. A test that only passes alone is broken.

## Reduce tests without losing obligations

For a proposed removal, inspect relevant callers, nearby tests, requirements, and history.
Record the named retained evidence or the sourced reason the obligation no longer applies.
Compare input classes, boundaries, asserted outcomes, and oracle independence before calling
cases redundant. A passing suite after deletion does not establish equivalent protection.

Repair a weak or brittle test for valuable behavior before removing it. Preserve required
security, tenant isolation, retained-data, and historical regression protection through
equivalent evidence unless a sourced decision retires the obligation. Unknown intent calls
for investigation, not automatic deletion. Keep unresolved candidates unchanged.

When equivalence remains disputed, a targeted deliberate fault or old regression in a
disposable checkout can demonstrate that retained tests reject that specific failure.
Use this only when proportionate. It does not prove equivalence for every future fault.
Zero removals is a valid result. Never use a target reduction percentage.

## Business rules and evidence

Reuse existing domain requirements, decision records, and rule identifiers. Treat extracted
specifications and current tests as evidence of observed behavior, not automatic authority
for business intent. Distinguish approved decisions, external contracts, and unresolved inference.

When important rules recur across features, keep the condition, outcome, material exceptions,
source/status, distinguishing examples, and named evidence in the existing domain document.
Update affected links with the behavior. Do not create a parallel global rule catalog or
require IDs on every assertion. A test can support several rules, and one rule can require
several boundaries. Technical invariants deserve protection without being called business rules.

## Execution and completion

Remove unused database, server, network, and fixture setup before removing valuable cases.
Separate execution frequency from retention value. Apply
[Verification and Review](verification-and-review.md), including its Jev checkpoints. Run
focused checks after coherent edits when they inform a concrete decision or debugging.
Let configured CI own broad suites; otherwise defer them to operator-managed testing outside
agent evidence without blocking completion. Preserve acceptance and known-failure obligations.
Do not repeat broad suites for each finding or claim unseen testing passed.

Measure savings with comparable commands and environments. Record observed elapsed time,
revision, result, and limits when reporting verification or savings. Do not infer runtime
improvement from fewer lines or test declarations. Stop when required checks pass unless
a relevant change or unresolved failure invalidates them.

Before completion, check that changed tests reject the intended failure, tolerate internal
refactors, explain their contract, and restore state. Check that each removal preserves its
obligation or cites its retirement. Keep optional unrelated cleanup in a follow-up.
