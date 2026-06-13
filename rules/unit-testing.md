# Unit Testing Guide (v1.0)

**Core rule:** Test behavior, not implementation.

## 1. What to Test
- The public contract only
- Edge cases and failure modes are first-class, not afterthoughts
- One behavior per test

## 2. Naming
- Name states behavior + condition: "rejects empty slug"
- Never numbered tests or bare method names

## 3. Structure
- Arrange–Act–Assert, visually separated
- No logic in tests: no loops, no conditionals
- Keep shared setup minimal; inline what makes the test readable

## 4. Assertions
- Assert outcomes, not call counts — unless the call is the contract
- Exact values over loose matchers
- A failure message should diagnose without a debugger

## 5. Test Doubles
- Mock boundaries (network, clock, filesystem), not your own modules
- Needing to mock your own module is a design smell
- Fake time; never sleep
- Prefer fakes/stubs with real behavior over broad mocks
- Mock at the narrowest boundary and restore it in the same test lifecycle
- Do not assert incidental interaction details unless the interaction is the contract

## 6. Global State & Mutation
- Treat globals as hazardous dependencies: env vars, clocks, random seeds, process cwd, module caches, singleton registries, feature flags, shared clients, and global DOM/storage
- Every mutation of global state must be paired with cleanup in `afterEach`, `finally`, or the framework's scoped restore API
- Capture the original value before changing it; restore by assignment or deletion to the exact prior state
- Prefer dependency injection over patching module-level variables
- Avoid tests that depend on import order, test order, or cached module initialization
- If a module reads global state at import time, isolate/reset the module cache for that test or refactor to read state at call time
- Do not share mutable fixtures across tests; create fresh objects per test or freeze shared fixtures
- A test that only passes when run alone is broken

## 7. Determinism & Speed
- No real network, clock, or randomness
- Order-independent
- Fast enough to run on every save

## 8. Coverage
- Cover branches that matter, not lines
- An untested error path is an untested feature
- Delete tests that pin implementation detail

## 9. Final Test
1. Does it fail when the behavior breaks?
2. Does it survive a refactor?
3. Can a reader infer the contract from the tests alone?
4. Does it leave the process exactly as it found it?
