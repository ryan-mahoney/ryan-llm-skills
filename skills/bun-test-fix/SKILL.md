---
name: bun-test-fix
description: "Fix a test file to comply with Bun test rules from AGENTS.md. Use when: 'fix this test', 'make this test compliant', 'bun test fix', 'audit this test file'."
argument-hint: "<path-to-test-file>"
---

# Bun Test Fix

Take a single test file, audit it against the Test Rules in `AGENTS.md`, and rewrite it to be fully compliant. The goal is to eliminate mock leaking, remove legacy assertion libraries, and prefer `deps` injection over `mock.module()` wherever possible.

## Arguments

- `path` — Absolute or repo-relative path to the test file to fix (e.g., `app/test/contexts/foo.test.js`)

## Before Starting

1. Read the target test file in full.
2. Read the AGENTS.md `## Test Rules` section (starting from "### Location") to confirm the current rules. Do not rely solely on this skill document — the rules may have been updated.
3. Identify the subject(s) under test by reading the imports and `await import(...)` calls.
4. Read the subject file(s) to determine whether they accept a `deps` parameter. This is the single most important check — it decides the entire rewrite strategy.

## Audit Checklist

Work through every item. For each violation found, note the line numbers and the fix required.

### A. Assertion Library

| Check | Rule |
|-------|------|
| A1 | No `chai` imports (`expect` from chai, `assert` from chai, `should` from chai). Replace with `expect` from `bun:test`. |
| A2 | No `mocha` imports (`describe`/`it` from mocha). Replace with `bun:test`. |
| A3 | No bare Node `assert` module. Replace with `bun:test` `expect`. |
| A4 | The file imports `describe`, `it`, `expect`, `mock`, `beforeEach`, `afterEach`, `afterAll` etc. only from `"bun:test"`. |

### B. `deps` Injection Preference

| Check | Rule |
|-------|------|
| B1 | If the subject function accepts `deps`, the test MUST use `deps` injection — not `mock.module()` for those dependencies. |
| B2 | When using `deps`, import the subject directly (no dynamic `await import()`), pass mock functions through `deps`, and assert on those mocks. |
| B3 | Follow the pattern in `app/test/contexts/job-manager-candidate.test.js`: create mocks inline per test, pass via `deps`, assert on calls. |

### C. `mock.module()` Rules (only when `deps` is unavailable)

| Check | Rule |
|-------|------|
| C1 | Register both module paths: `mock.module("path/mod.js", factory)` AND `mock.module("path/mod", factory)`. Use the `mockBoth` helper. |
| C2 | Import the subject AFTER all `mock.module()` calls, using `await import()`. Never use static `import` for the subject when mocks are in play. |
| C3 | Never call `real.default(...)` (or other real module functions) inside a `mock.module()` factory for the same module. Snapshot the module first with `await import("path?snapshot")`, then spread the snapshot. |
| C4 | For model default exports, prefer explicit minimal stubs: `default: () => ({ methodUnderTest: mockFn })`. |
| C5 | Never re-register `mock.module()` inside `beforeEach` or `afterEach`. Only reset mock implementations there (`mockFn.mockImplementation(...)`, `mockFn.mockReset()`). |
| C6 | Call `mock.restore()` once in `afterAll`. |
| C7 | Restore all mocked modules in `afterAll` using `restoreBoth` with the original snapshots. |
| C8 | Don't mock what you don't call. Remove mocks for modules that no test case actually exercises. |

### D. File Structure

| Check | Rule |
|-------|------|
| D1 | File lives in `app/test/`, mirroring the source structure. |
| D2 | File uses `.test.js` extension. |
| D3 | No `/* eslint-disable */` broader than necessary. Prefer targeted disables. |

### E. General Quality

| Check | Rule |
|-------|------|
| E1 | `expect.fail("Should have thrown")` in try/catch is acceptable but `expect(...).rejects.toThrow(...)` is preferred for cleaner error assertions. |
| E2 | Tests are deterministic — no reliance on real clock, random values, or external state unless it's an integration test in `app/test/integration/`. |
| E3 | Each `it` block tests one behavior. |

## Rewrite Strategy

Based on the audit, choose the appropriate strategy:

### Strategy 1: Convert to `deps` injection (preferred)

Use when the subject accepts `deps`. This is the cleanest path.

1. Remove all `mock.module()` calls and related snapshot/restore machinery.
2. Import the subject directly with a normal `await import()` or static `import`.
3. In each `it` block, create mock functions inline and pass them via `deps`.
4. Assert on the mock functions directly.

**Pattern reference:** Follow the structure in `app/test/contexts/job-manager-candidate.test.js`.

### Strategy 2: Fix existing `mock.module()` usage

Use when the subject does NOT accept `deps` and module mocking is required.

1. Add the `mockBoth` / `restoreBoth` helpers at the top of the file.
2. Snapshot every mocked module BEFORE calling `mock.module()`.
3. Register both `.js` and extensionless paths.
4. Move the subject import to AFTER all mock registrations, using `await import()`.
5. Add `afterAll` with `restoreBoth` for every mocked module, plus `mock.restore()`.
6. Move any `mock.module()` calls out of `beforeEach` — use `mockFn.mockImplementation()` / `mockFn.mockReset()` there instead.

**Pattern reference:** Follow the structure in `app/test/contexts/rejection-message.test.js`.

### Strategy 3: Integration test (DB-backed)

Use when the test intentionally hits a real database.

1. Ensure it lives in `app/test/integration/` or is clearly a DB-backed context test.
2. Use `bun:test` imports only.
3. Clean up test data in `afterEach` — delete in reverse dependency order.
4. No `mock.module()` unless absolutely necessary for non-DB concerns.

**Pattern reference:** Follow the structure in `app/test/contexts/candidate-stage.test.js`.

## After Rewriting

1. Run the single test file: `bun test <path-to-test-file>`
2. If it fails, diagnose and fix. Common issues:
   - Missing `deps` property that the subject expects
   - Mock return values that don't match the shape the subject reads
   - Async issues — ensure mocks return promises where the subject `await`s
3. Run the full test suite to check for cross-file leaking: `bun test`
4. If the full suite passes, the fix is complete.

## Conventions

- Use `mock()` from `bun:test` to create mock functions (not `sinon.stub()` in new code, though `sinon.stub()` is acceptable in existing deps-injection tests).
- Prefer `expect(...).rejects.toThrow(...)` over try/catch with `expect.fail`.
- When a context function supports `deps`, always test through `deps` — never reach for `mock.module()` as a shortcut.
- Model mocks should return the minimal shape needed. Don't replicate entire model APIs.
- Keep `beforeEach` for resetting mock state, not for re-registering mocks.
- The `/* eslint-disable no-undef */` pragma is acceptable when `mock`, `describe`, etc. come from `bun:test` globals.
