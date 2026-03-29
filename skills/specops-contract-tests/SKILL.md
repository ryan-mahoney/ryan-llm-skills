---
name: specops-contract-tests
description: "Generate framework-agnostic contract tests from a SpecOps analysis file. Use when: 'generate contract tests', 'spec-to-gate tests', 'create tests from analysis', 'contract tests for this analysis', 'test this spec', 'generate tests from specops'."
argument-hint: "<path-to-analysis-file>"
---

# SpecOps Contract Tests

Generate a framework-agnostic pytest test file from a SpecOps analysis file. The tests are derived from sections 2 (interfaces), 3 (data models), 4A (policy rules), 4B (behavioral scenarios), 6 (dependencies), 8 (error handling), and 10 (edge cases). The output is a single test file that can run against any implementation of the analyzed component.

If `$ARGUMENTS` is provided, treat it as the path to the analysis file.
If `$ARGUMENTS` is not provided, ask the user which analysis file to use.

## Arguments

- `analysis-file` -- path to the analysis markdown file (e.g., `docs/specops/analysis/topic-subscribe.md`)

## Before Starting

1. Confirm the analysis file exists at the given path. If not, stop and report.
2. Read the analysis file completely.
3. Extract the **target name** from the H1 header: `# SpecOps Analysis: {target-name}`. This becomes the test module name by replacing hyphens with underscores (e.g., `topic-subscribe` becomes `test_topic_subscribe.py`).
4. Extract the **Primary File** path from the file header to understand what source code is under test.
5. Determine the **surface type** by scanning Section 2:
   - **HTTP surface:** Section 2 contains HTTP verbs (`POST`, `GET`, `PUT`, `DELETE`, `PATCH`) with URL paths, an "HTTP Route" or "HTTP Surface" subsection, or status codes in the context of an endpoint.
   - **Behavioral surface:** Section 2 describes method signatures, class interfaces, or function contracts without HTTP semantics.
6. If a `docs/specops/spec-to-gate.md` exists in the project, read it for test infrastructure conventions (client factory pattern, mock configuration, fixture names). Adapt to those conventions.
7. If `tests/contracts/conftest.py` exists, read it to understand available fixtures. Do not duplicate fixtures already defined there.

## Steps

### 1. Extract Test-Relevant Information

Read and extract from these sections:

**Section 2 (Public Interfaces):**
- For HTTP targets: route path, HTTP method, request body fields, response status codes, response body shapes (success and error).
- For behavioral targets: method signature, parameters (names, types, optionality), return type and shape.

**Section 3 (Data Models):**
- Input schemas: field names, types, required/optional, validation rules (min/max length, allowed values).
- Output shapes: every distinct response structure (success, per-item error, wholesale error) with exact field names and literal values.
- Intermediate structures relevant to assertions (e.g., Firebase response objects used in mocks).

**Section 4A (Decision Logic & Policy Surface):**
- Each numbered rule with its boundary values, conditions, and enforcement mechanism.
- Focus on rules with testable thresholds (e.g., "60 days", "max 500", "at least one valid token").

**Section 4B (Policy Tests & Behavioral Scenarios):**
- Every numbered scenario. This is the primary test source.
- Identify the format: **Given/When/Then** or **Input/Expected/Coverage**.
- Record the scenario number for traceability.

**Section 6 (Dependencies):**
- External SDK methods from 6.2 -- these become mock targets.
- Internal singleton factories from 6.1 that provide external clients.
- Runtime dependencies from 6.3 (e.g., `datetime.now`) when they affect determinism.

**Section 8 (Error Handling):**
- Each exception type, its source, catch strategy, and resulting behavior.
- Each distinct error propagation path not already covered by a 4B scenario.

**Section 10 (Edge Cases):**
- Each numbered edge case that describes testable behavior.
- Skip purely observational notes (e.g., "variable shadowing makes debugging harder") that have no behavioral assertion.

### 2. Identify Mock Targets

From Section 6 extraction, build the mock target list:

- For each external SDK method the target calls (Section 6.2), record the full import path as it appears in the primary source file. Example: if `acm_server.py` calls `messaging.send_each`, the mock path is `firebase_admin.messaging.send_each`.
- For each internal factory that provides an external client (Section 6.1), record its module path. Example: `async_client_messaging_app.api.resources.connection_pool.get_azure_tables_client`.
- For each mock target, note what the happy-path return value looks like (from Section 3 intermediate structures).
- If wall-clock time or other non-deterministic values affect behavior (Section 6.3), include them as mock targets.

Use `monkeypatch.setattr` for all mocks. Do not use `@patch` decorators -- `monkeypatch` keeps mock scope explicit and avoids import-order issues across framework migrations.

### 3. Design Test Structure

Organize the test file as:

**Module docstring:**
```python
"""
Contract tests for {target name}.

Derived from: {analysis file path}
SpecOps target: {target name from header}
Sections used: 2 (Interfaces), 3 (Data Models), 4A (Policy), 4B (Scenarios), 8 (Errors), 10 (Edge Cases)
"""
```

**Test classes grouped by scenario category:**

| Class | Source | Purpose |
|-------|--------|---------|
| `TestHappyPath` | 4B happy-path scenarios | All inputs valid, all operations succeed |
| `Test{RuleName}` | 4A rules with testable boundaries | One class per significant rule (e.g., `TestTokenExpiry`, `TestBatchSizeLimit`) |
| `TestValidation` | 3 validation rules, 4B validation scenarios | Input validation rejects malformed requests |
| `TestErrorPropagation` | 8 failure modes, 4B error scenarios | Exception handling produces correct behavior |
| `TestEdgeCases` | 10 edge cases | Surprising or implicit behavior |

Not all classes are required. Only create classes that have test methods. If a category has no scenarios, omit it.

**Test methods:**
- One method per Section 4B scenario.
- Additional methods for 4A rules that lack 4B coverage.
- Additional methods for Section 8 failure modes not covered by 4B.
- Additional methods for Section 10 edge cases with testable behavior.
- Method names: `test_{what_happens}_when_{condition}` or `test_{condition}_{expected_outcome}`. Keep names readable as behavioral descriptions.

### 4. Generate the Test File

Write to `tests/contracts/test_{target_name}.py`. Create the `tests/contracts/` directory if it does not exist.

**For HTTP surface targets**, each test method follows:

```python
def test_scenario_description(self, client, mock_fixture):
    """Section 4B.N: Scenario title from analysis."""
    # Arrange: configure mocks for this scenario
    mock_fixture.return_value = ...

    # Act: HTTP request
    resp = client.post("/v1/path", json={...})

    # Assert: status code and response body
    assert resp.status_code == 207
    body = resp.json()
    assert body[0]["responseStatusCode"] == 200
```

**For behavioral surface targets**, each test method follows:

```python
def test_scenario_description(self, mock_fixture):
    """Section 4B.N: Scenario title from analysis."""
    # Arrange: configure mocks, instantiate target
    mock_fixture.return_value = ...
    target = TargetClass()

    # Act: direct method call
    result = target.method(arg1, arg2)

    # Assert: return value and mock interactions
    assert result == expected
    mock_fixture.assert_called_once_with(...)
```

**Fixture handling:**
- If `conftest.py` exists and defines the needed fixtures, use them by name.
- If `conftest.py` does not exist or lacks needed fixtures, define fixtures at the top of the test file with a comment noting they should be moved to `conftest.py` when shared across test files.
- For mock fixtures, prefer a single fixture per external system (e.g., one `mock_firebase` fixture for all Firebase SDK methods, one `mock_azure_tables` for the table client).

**Mock return value realism:**
- Use Section 3 intermediate structures to build realistic mock return values.
- For Firebase response objects, construct minimal but structurally correct objects (e.g., `TopicManagementResponse` with `.errors` list, `BatchResponse` with `.responses` list).
- If the SDK response type cannot be easily constructed, use `MagicMock` with the required attributes set.

### 5. Verify Completeness

After writing the file, verify and report:

1. **4B coverage:** List every Section 4B scenario number and its corresponding test method. Flag any scenario without a test.
2. **4A coverage:** List every Section 4A rule with testable boundaries and whether it has a dedicated test or is covered by a 4B test. Flag rules without coverage.
3. **Section 8 coverage:** List every distinct failure mode and whether it has a test. Skip modes that duplicate 4B scenarios.
4. **Section 10 coverage:** List every edge case and whether it has a test. Note which edge cases were skipped as non-testable.
5. **Implementation leakage check:** Confirm no test asserts on internal state, private method calls, or framework-specific objects. Tests assert on observable behavior only (HTTP responses, return values, mock call arguments).

Report the coverage summary to the user after writing the file.

## Conventions

- Analysis files follow the 11-section template defined by the `specops-analysis` skill.
- Test files go to `tests/contracts/` named `test_{target_name}.py` where `target_name` is the analysis file basename with hyphens replaced by underscores.
- Use pytest classes to group related scenarios. Class names: `Test` prefix + scenario category in PascalCase.
- Use pytest fixtures for shared setup. Use `conftest.py` for fixtures shared across multiple test files.
- Mock at the SDK boundary, never at the framework boundary. The same mocks must work regardless of which framework serves the HTTP layer.
- Use `monkeypatch.setattr` for all mocks.
- Use exact field names and string literals from the analysis (`'responseStatusCode'`, `'TOKEN MANAGEMENT ERROR'`). Do not rename or abstract.
- Test method names should be readable as behavioral descriptions. A non-technical stakeholder should understand what each test verifies from its name.
- Do not assert on log output. Logging is an implementation detail.
- Do not add attribution footers or AI-related signatures to generated files.

## Quality Bar

- Every test method traces to a specific analysis section and scenario number via its docstring.
- Mock return values use realistic shapes from Section 3, not minimal stubs.
- Boundary conditions from Section 4A are tested at the boundary (e.g., day 59 vs day 60 vs day 61 for a 60-day expiry rule).
- Error response assertions check the complete error shape (status code, error type, title, detail) as documented in Section 3, not just the status code.
- The generated test file is syntactically valid Python.
- No test depends on execution order. Each test is independent.
- If Section 4B notes existing test coverage, still generate all scenarios for completeness as contract tests but note the overlap.
