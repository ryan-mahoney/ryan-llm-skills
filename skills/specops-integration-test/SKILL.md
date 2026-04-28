---
name: specops-integration-test
description: Generate integration tests for normative application runs in a SpecOps migration — pathways the system exercises in normal use that cross multiple modules and traverse real seams between them. The skill discovers significant pathways from both the analysis specs (intended integration points) and the migrated code (actual call graph), generates tests that reuse the project's existing unit-test mocks, and places them where the target platform stores integration tests. Use this skill whenever the user mentions integration tests, end-to-end tests, normative runs, cross-module test coverage, testing the migration as a system, generating tests that exercise multiple modules together, or verifying the migration's seams. Also trigger when the user asks "what should I integration test," "test the system end-to-end," or describes wanting tests beyond what unit tests cover. Run this after at least one round of code generation has produced runnable migrated code with passing unit tests, and re-run as the migration evolves to add tests for newly-completed pathways.
---

# SpecOps Integration Test Generation

Unit tests verify modules in isolation. Spec-driven verification skills (ambiguity, conformance, drift) verify descriptions of behavior. Neither catches a class of bugs the migration is most exposed to: behaviors that emerge only when modules interact across real seams — file system, subprocess lifecycle, SSE streams, job state transitions, retry interactions, lock contention.

This skill generates integration tests for **normative application runs** — pathways the system exercises in normal use, end-to-end across multiple modules. It does not regenerate unit-test coverage at a higher level; it tests the seams unit tests cannot reach.

The skill operates in three phases: discover pathways from specs and code, discover the project's existing test infrastructure (mocks, fixtures, conventions), and generate tests that compose existing mocks against real seams.

## Inputs

Confirm with the user before starting:

- **Analysis specs directory** — provides intent. Section 9 (Integration Points & Data Flow) and the upstream/downstream descriptions in each spec are the primary source. Default: `docs/specs/analysis/`.
- **Migrated source directory** — provides actual seams. Default: looking for `src-ts/`, `src/`, or whatever the project's `AGENTS.md` indicates.
- **Existing unit tests directory** — discovered, not asked. The skill scans the project for the platform's test convention (e.g., `__tests__/`, `tests/`, `*.test.ts` siblings) and uses whatever is established. The integration tests will live in the same root, with a clear subdivision (e.g., `tests/integration/` next to `tests/unit/`, or whatever the project already does).
- **Optional scope filter** — limit pathway discovery to a subset of modules for incremental work. Default is the full migrated surface.

If the migrated code doesn't yet build or run, stop and tell the user — integration tests against non-running code are useless. Wait until at least one code-gen iteration has produced a system that boots.

---

## Phase 1: Discover the project's test infrastructure

Before generating anything, the skill inventories what already exists. This is what makes generated tests fit the project rather than impose a foreign style.

### What to inspect

- **Test runner and framework.** Read `package.json` (or equivalent) for the test script. Inspect existing tests for syntax (vitest vs jest vs bun:test vs node:test, etc.). Match exactly.
- **Test file naming convention.** Sample existing tests: `foo.test.ts`, `foo.spec.ts`, `__tests__/foo.ts`. Match the dominant convention.
- **Test location.** Where do unit tests live? (`tests/unit/`, `__tests__/`, sibling files, etc.) Integration tests will live in a parallel location: `tests/integration/`, `__tests__/integration/`, etc., creating it if needed.
- **Mock conventions.** This is the most important discovery:
  - `__mocks__/` directories with manual mocks
  - `vi.mock()` / `jest.mock()` factory patterns inline in test files
  - MSW handlers for HTTP mocking
  - Fixture directories (`tests/fixtures/`, `__fixtures__/`)
  - Spy/stub patterns the project uses (e.g., custom `createMockProvider()` factory)
  - Environment variable scaffolding (`.env.test`, `setup.ts`)
- **Test setup/teardown.** Global setup files, `beforeAll` / `beforeEach` patterns, fixture cleanup approaches.
- **What's already mocked.** Build a registry: "the LLM provider is mocked via `tests/mocks/llm-provider.ts`," "the file system is real but uses tmp directories," "child_process.spawn is mocked via vi.mock factory in `tests/setup.ts`," etc.

### Output of Phase 1

A discovery summary written to `docs/specs/integration-test-plan.md` (overwritten on each run; it represents current state):

```markdown
# Integration Test Plan

- **Generated:** <date>
- **Target platform:** <e.g., TypeScript on Bun, vitest test runner>
- **Test root:** <e.g., tests/>
- **Integration test location:** <e.g., tests/integration/>
- **Convention:** <e.g., *.test.ts siblings to source — but using a parallel tests/integration/ tree per project layout>

## Mock registry (existing)
| Service | Mock location | Style | Notes |
|---|---|---|---|
| LLM provider | tests/mocks/llm-provider.ts | factory function | covers anthropic, openai, gemini |
| child_process.spawn | tests/setup.ts | vi.mock global | returns scripted exit codes |
| fs (specific paths) | n/a | real, uses tmp dirs via beforeEach | |
| HTTP (external) | tests/mocks/msw-handlers.ts | MSW | covers provider endpoints |

## Fixtures (existing)
- tests/fixtures/jobs/ — sample job descriptors
- tests/fixtures/pipelines/ — sample pipeline definitions

## Setup files
- tests/setup.ts — global before/after hooks
```

This file is also surfaced to the user — they can correct or extend it before pathway discovery proceeds.

---

## Phase 2: Discover normative pathways

Pathways come from intersection of two sources: spec intent and code reality.

### From specs (intent)

Read every analysis spec in scope. Extract from each:

- **Section 9 — Integration Points & Data Flow** — explicit upstream/downstream relationships
- **Section 1 — Purpose & Responsibilities** — primary use cases the module serves
- **Section 4 — Behavioral Contracts** — invariants that span calls

Cluster these into candidate pathways: sequences of module interactions that, taken together, accomplish a user-meaningful outcome. Examples in a job-orchestration system:

- Job submission → file watcher detects → orchestrator spawns runner → status writer records lifecycle → SSE broadcasts to UI
- LLM provider call → retry on transient failure → token cost recorded → artifact written to disk
- UI polls for job list → state-snapshot reads from disk → list returned with consistent ordering

### From code (seams)

For each candidate pathway, verify the seams actually exist in the migrated code:

- Does `orchestrator.ts` actually import `pipeline-runner.ts`?
- Does the file watcher actually trigger the spawn function?
- Is the SSE broadcast actually wired to the status writer's events?

This is the reality check. A spec-described pathway that doesn't exist in code becomes a *gap* (logged in the plan, no test generated). A code seam not described in any spec becomes *scope creep* (logged in the plan, no test generated, surfaced for review).

Pathways that appear in both sources become **test candidates**.

### Filter by "normative"

A pathway is normative if it represents how the system is *normally* used. Filter out:

- Failure-mode-specific paths that are better tested in unit tests of the affected module
- Initialization-only paths that run once at boot (cover with a smoke test, not multiple integration tests)
- Path variants that differ only in input data (parameterize one test rather than generating many)

The bar: would a developer reasonably say "this is one of the things the system does"? If yes, it's a pathway worth an integration test. If it's "this is one specific edge case in one specific situation," it's not.

### Output of Phase 2

Append to `integration-test-plan.md`:

```markdown
## Pathways

### IT-orch-001: Job submission → completion
- **Modules traversed:** core/orchestrator → core/pipeline-runner → core/task-runner → core/status-writer
- **Spec sources:** core/orchestrator.md §9, core/pipeline-runner.md §9, core/status-writer.md §1
- **Code seams verified:**
  - src-ts/core/orchestrator.ts:142 → spawnRunner()
  - src-ts/core/pipeline-runner.ts:78 → runTasks()
  - src-ts/core/status-writer.ts:45 → writeStatus()
- **Mocks required:** child_process.spawn (existing), LLM provider (existing)
- **Real components:** file system (tmp dir), status writer queue, in-process orchestrator
- **Normative outcome:** A submitted job descriptor produces a completed status file with the expected lifecycle stages recorded.

### IT-prov-001: Provider retry on transient failure
- **Modules traversed:** providers/anthropic → llm/index → core/retry → core/task-runner
- ...

## Gaps (in specs but not in code)
- IT-ui-002: SSE broadcast on job state change — described in ui/server.md §9 but the corresponding code seam isn't yet implemented in src-ts/. Not generated.

## Scope creep (in code but not in specs)
- src-ts/core/orchestrator.ts:230 → directly invokes ui/sse-broadcast — no spec describes this seam. Surface for review; not generated.
```

The audit runs end-to-end without pausing. Phase 2 outputs the plan; Phase 3 starts immediately.

---

## Phase 3: Generate tests via parallel subagents

Spawn one subagent per test candidate (each `IT-` entry from Phase 2 with a verified pathway), all in the same turn. Each subagent generates one integration test file matching the project's conventions and reusing the project's existing mocks.

### Subagent prompt template

```
You are generating one integration test for a SpecOps migration. The test verifies a normative application pathway end-to-end through real seams between multiple modules. Reuse the project's existing test conventions and mock library — do not invent new patterns.

# The pathway
- ID: <e.g., IT-orch-001>
- Title: <e.g., Job submission → completion>
- Modules traversed: <list>
- Code seams: <list of file:line references>
- Normative outcome: <what should be true at the end>

# Test infrastructure (from Phase 1 discovery)
- Test runner: <e.g., vitest>
- Test file convention: <e.g., *.test.ts in tests/integration/>
- Mock registry: <full registry from Phase 1>
- Fixtures: <list>
- Setup files: <list>

# Mocks to reuse for this test
<for each module/service in this pathway, the matching entry from the existing mock registry>

# Spec sources (for behavioral expectations)
<paths to relevant analysis spec sections>

# Your task
1. Read the relevant spec sections to understand the normative outcome and any behavioral contracts (ordering, atomicity, idempotency) the test should verify.
2. Read the relevant migrated code to understand the actual call interfaces.
3. Read the existing mocks you'll be reusing — confirm they expose what this test needs. If they don't, note this as a finding rather than extending them; mock extensions need human review.
4. Write one integration test file.

# Test structure requirements
- Use the project's exact test runner syntax (no inventing).
- Import existing mocks; do not redefine them. If a mock factory exists, call it. If a global vi.mock setup mocks a module, rely on it.
- Use the project's fixture directories where applicable.
- Test the normative outcome: the test passes when the pathway produced the expected end-to-end result. Don't assert on intermediate steps unless the spec explicitly identifies them as observable contracts.
- Include teardown that returns the file system / state to the pre-test condition.
- Add a header comment with the test ID, the pathway summary, and a reference to the spec sources. This is what makes the test grep-able and traceable.

# Output format
Return a JSON object only:

{
  "test_id": "<IT-...>",
  "test_file_path": "<full path under the project's integration test root>",
  "test_file_content": "<complete file contents — the actual test code>",
  "mocks_used": ["<mock name>", ...],
  "fixtures_used": ["<fixture name>", ...],
  "missing_infrastructure": "<if any mock or fixture you'd need doesn't exist, describe what's missing — do not extend mocks; flag for human>",
  "deferred": <true | false>,
  "defer_reason": "<if deferred — usually because required infrastructure is missing>"
}
```

### Running the subagents

Spawn all subagents in one turn. They run independently — each generates one test file.

If the host has no subagent capability, generate tests serially using the same prompt and output structure.

---

## Phase 4: Place tests, idempotency check, report

When all subagents return:

1. **Idempotency check (append-only).** For each generated test:
   - Compute the test's stable identifier from the test ID (e.g., `IT-orch-001`).
   - Check whether a test file already exists at the target path **OR** any file in the integration test root contains the test ID in its header comment.
   - If yes → **leave the existing test alone**, even if the newly-generated content differs. Re-runs never modify or delete tests; they only add. Note this as "skipped (already exists)" in the report.
   - If no → write the new test to its target path.

2. **Place each new test** at the path determined in Phase 1's convention discovery.

3. **Log deferred items.** Tests with `deferred: true` (typically: required mock infrastructure is missing) get logged in the plan with full context — the test is *not* generated, but the gap is recorded so the human can extend infrastructure or decide to skip the pathway.

4. **Update `integration-test-plan.md`** with the run results:

   ```markdown
   ## Run history

   ### <YYYY-MM-DD> — Test generation run
   - Pathways evaluated: <count>
   - Tests generated (new): <count>
   - Tests skipped (already exist): <count>
   - Deferred (missing infrastructure): <count>
   - Spec gaps surfaced: <count>
   - Code scope-creep surfaced: <count>
   - Test files added:
     - <list of new test file paths>
   - Deferred items:
     - <DD-IT-N entries with context>
   ```

5. **Run the test suite.** If the project's test command is well-known and lightweight, attempt to run only the newly-added integration tests to confirm they execute (not necessarily pass — failing tests against incomplete code are expected during migration). Capture the result. If running the suite is heavy or unclear, skip this step and tell the user to run it.

6. **Summarize for the user.**
   - Counts: pathways found, tests generated, tests skipped (idempotency), deferred.
   - Gaps surfaced (specs without code, code without specs) — these are useful findings independent of the test generation.
   - The plan file path so they can see the discovery details.
   - If the suite was run, the result of the new tests.

---

## Important behaviors

- **Run end-to-end without stopping.** Phases 1–4 chain automatically. The user reviews artifacts asynchronously.
- **Append-only across runs.** Generated tests never get modified or deleted by re-runs of this skill. The user owns the tests once they're written. The skill only adds tests for pathways it hasn't tested before. This means tests can be hand-edited safely without losing the edits on re-run.
- **Match project conventions exactly.** The skill discovers and matches; it does not impose. If the project uses jest with `__tests__/` colocated, the integration tests use jest with a parallel `__tests__/integration/` directory. The skill never argues with the project's choices.
- **Reuse mocks, don't extend them.** If a pathway needs a mock that doesn't exist or doesn't expose what's needed, the test is deferred with a note about missing infrastructure. Extending mock libraries is a human decision (the new mock affects all tests using it); the skill flags but doesn't act.
- **Normative, not exhaustive.** Each pathway gets one test that exercises the typical case. Edge cases, failure modes, and parameterized variants are not the goal here — those belong in unit tests of the affected module. If a spec lists 5 distinct error modes, that's 5 unit tests, not 5 integration tests.
- **Spec gaps and scope creep are findings, not problems.** A pathway described in specs but not in code means the migration isn't done with that pathway. A seam in code but not in specs means either the spec is incomplete or the code grew beyond intent. Both are useful surface area for review; neither blocks test generation for the other pathways.
- **Tests are documentation.** Each test header references its pathway ID and spec sources. A new developer reading the integration test suite sees, in plain form, what the system's normative behaviors are. This is a downstream benefit of the spec-driven approach.
- **Re-run after each material code-gen iteration.** New seams come into existence as more modules migrate. Re-running adds tests for newly-completed pathways without touching existing ones.

---

## Example flow

User: "Generate integration tests for the migration."

1. Inspect the project: `package.json` shows vitest; existing tests in `tests/unit/` use `*.test.ts` naming; mocks in `tests/mocks/` (LLM provider, MSW handlers); fixtures in `tests/fixtures/`. Integration tests will go in `tests/integration/`. Write the discovery to `docs/specs/integration-test-plan.md`.
2. Read 17 analysis specs and the migrated code. Identify 12 candidate normative pathways; 9 verified in both spec and code, 2 spec-only (not yet implemented), 1 code-only (scope creep — direct UI broadcast from orchestrator). Append to plan.
3. Spawn 9 subagents in one turn.
4. Results: 7 tests generated successfully; 2 deferred (one needs a chokidar mock that doesn't exist; one needs a child_process mock variant that returns streamed stdout, not just exit codes).
5. Idempotency check: this is a fresh run — no tests exist yet. All 7 are new files.
6. Write 7 test files into `tests/integration/`. Append run history and deferred items (DD-IT-1, DD-IT-2) to the plan.
7. Run `bun test tests/integration/` — 5 pass, 2 fail (against current incomplete migration code). Capture output.
8. Summarize: "Generated 7 integration tests in `tests/integration/`. 2 deferred — see DD-IT-1 (chokidar mock needed) and DD-IT-2 (streamed stdout child_process mock needed). 2 spec-described pathways aren't yet implemented in code (gaps). 1 code seam isn't described in any spec (review). 5 of 7 new tests pass against current migrated code; 2 fail — expected during ongoing migration."

User edits one of the generated tests to add a project-specific assertion. A week later, the user runs the skill again after another code-gen iteration. The edited test is preserved (idempotency); two new tests are generated for newly-completed pathways; the chokidar deferral is now resolved because someone added the missing mock; one new test is generated for the previously-deferred pathway.

---

## Where this fits in the SpecOps pipeline

This skill operates after code generation. It complements (does not replace) unit tests, which the migration's code-generation process should already produce. Unit tests verify modules in isolation; this skill verifies pathways across modules.

Updated pipeline ordering:

1. Generate analysis specs from legacy source.
2. `specops-ambiguity-audit` — harden each spec individually.
3. `specops-spec-coherence` — cross-spec consistency, implementation order.
4. `specops-dependency-survey` — profile target dependencies.
5. `specops-dependency-graft` — apply profiles to specs.
6. Domain experts verify the now-modernized analysis spec set.
7. Generate implementation specs in dependency order.
8. `specops-spec-conformance` — implementation specs faithful to analysis.
9. Generate code from implementation specs (with unit tests as part of the code-gen output).
10. **`specops-integration-test`** (this skill) — add integration tests for normative pathways.
11. `specops-implementation-drift` — re-analyze code, diff against analysis, generate corrections, iterate.

Steps 10 and 11 alternate as the migration evolves: drift surfaces correction specs, code regenerates from corrections, integration tests are re-run to add coverage for newly-completed pathways, drift runs again. The migration is converged when integration tests are stable and drift produces only Cosmetic findings.
