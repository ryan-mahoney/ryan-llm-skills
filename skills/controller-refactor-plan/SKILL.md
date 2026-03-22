---
name: controller-refactor-plan
description: "Analyze one controller file, determine which handlers are no longer wired from routes, and assess whether controller responsibilities have grown beyond validation/response orchestration. Produce analysis only (no implementation plan). Use this when the user says 'analyze this controller', 'is this controller still used', 'find dead controller handlers', or 'does this controller do too much'."
argument-hint: "[path to controller file] [optional output markdown path]"
---

# Controller Analysis

Use this skill to audit a single controller in `firstwho-app` and produce an analysis document. The analysis answers three questions: which controller handlers are still reachable from routes, where controller code exceeds controller scope, and what context boundaries are implicated. This skill is analysis-only and does not propose implementation sequencing.

## Arguments

- `$1` - Required. Path to a controller file, usually under `app/controllers/` (example: `app/controllers/orders/orders-controller.js`).
- `$2` - Optional. Output path for the markdown analysis. If omitted, write to `docs/<controller-name>-analysis.md`.

## Before Starting

1. Confirm you are in repo root and `AGENTS.md` exists.
2. Confirm `$1` exists and is a file.
3. Set defaults:

```bash
controller_path="$1"
controller_name="$(basename "$controller_path" .js)"
output_path="${2:-docs/${controller_name}-analysis.md}"
mkdir -p "$(dirname "$output_path")"
```

4. Normalize controller import key for route lookups:

```bash
controller_rel="${controller_path#app/controllers/}"
controller_no_ext="${controller_rel%.js}"
```

## Steps

### 1. Build a route reachability map

Find where this controller is imported and where its handlers are used in routing.

```bash
rg -n "controllers/${controller_no_ext}(\\.js)?" app/routes
```

Then read each matching route file (always include `app/routes/backend-routes.js`) and build a table:

- Import style (`default import`, `named import`, `alias import`)
- Handler symbol in route (`controller.method` or direct function)
- HTTP verb + path

**Pattern reference:** Route wiring style is defined in `app/routes/backend-routes.js` with both default-object handlers (for example `calibrate.updateProfile`) and named imports (for example `createPaymentIntent as ordersCreatePaymentIntent` from `app/controllers/orders/orders-controller.js`).

### 2. Enumerate controller handlers exported by the file

Extract all handlers this controller makes externally reachable.

```bash
rg -n "export const [A-Za-z0-9_]+\s*=|export default\s*\{" "$controller_path"
```

Also inspect inline handler definitions in default exports:

```bash
rg -n "^[[:space:]]*[A-Za-z0-9_]+:\s*async\s*\(|^[[:space:]]*[A-Za-z0-9_]+:\s*\(" "$controller_path"
```

Create a handler inventory table:

- Handler name
- Export mode (`named` or `default object`)
- Route references found in Step 1
- Reachability status (`active`, `possibly-unused`, `indirect/unknown`)

Treat handlers with no route references as `possibly-unused` until a repo-wide search confirms no non-router callers:

```bash
handler_name="<handler>"
rg -n "\\b${handler_name}\\b" app
```

### 3. Score controller responsibility boundaries

Audit whether handlers are mainly orchestration or contain domain logic that belongs in contexts.

Use fast signals:

```bash
rg -n "from \"\.\./\.\./models|from \"\.\./models|from \"\.\./\.\./libraries/nodejs-manager/src/libraries/db-conn|from \"\.\./libraries/nodejs-manager/src/libraries/db-conn|\.transaction\(|await db\." "$controller_path"
rg -n "from \"\.\./\.\./contexts|from \"\.\./contexts" "$controller_path"
rg -n "new Stripe|new OpenAI|S3Client|axios|fetch\(" "$controller_path"
```

For each handler, classify responsibilities:

- `controller-appropriate`: request/session validation, auth gate, selecting status code, `renderPage/jsonResponse`.
- `should-live-in-context`: model queries, transactions, business rule branching, third-party orchestration, heavy data shaping.

**Pattern reference (healthy split):** `app/controllers/community/calibrate-controller.js` keeps route handlers thin and delegates business logic to `app/contexts/calibrate.js`.

**Pattern reference (scope creep example):** `app/controllers/community/community-resources-controller.js` and large managers such as `app/controllers/opportunities/opportunities-job-manager.js` include substantial model/data logic directly in controllers.

### 4. Map logic to existing contexts

Prefer reusing existing contexts where themes already exist.

1. List likely context candidates by domain keyword from the controller name and imports.
2. Inspect matching context files under `app/contexts/`.
3. Decide for each extracted responsibility:

- `move to existing context` (name the exact file)
- `create new context` (propose exact path and thematic scope)

Guideline for new context creation: only add a new file when responsibilities do not fit existing context boundaries.

### 5. Produce an analysis markdown

Write the plan to `$output_path` using this structure:

```markdown
# Controller Analysis: <controller path>

## 1. Route Reachability
| Handler | Export | Route(s) | Status |
| --- | --- | --- | --- |

## 2. Findings: Controller Scope
- <finding with file/line references>

## 3. Dead or Orphaned Handlers
- <handler> - <evidence>

## 4. Context Boundary Analysis
- Existing contexts related to controller concerns
- Responsibilities currently in controller that align with those contexts
- Responsibilities with no clear existing context home

## 5. Risk + Test Surface
- Behavior risks
- Regression checks
- Existing tests and apparent gaps in `app/test/controllers/` and `app/test/contexts/`
```

### 6. Keep output strictly analytical

Do not include:

- step-by-step implementation plans
- PR sequencing
- explicit code-change instructions
- specific function-by-function rewrite directives

You may include observations such as:

- "likely extraction candidate"
- "possibly dead route handler"
- "responsibility appears split across controller and context"

but keep them evidence-based and non-prescriptive.

## Conventions

- Routes are explicitly wired in `app/routes/backend-routes.js`; there is no auto-registration.
- Controllers should remain thin: validate request/session, call contexts, and return page/API output.
- Contexts own domain orchestration, model access, and data transforms (see `app/contexts/calibrate.js` and `app/contexts/orders.js`).
- Keep tests in `app/test/` (not adjacent to implementation).
- If route usage is ambiguous, mark as `indirect/unknown` and show search evidence instead of guessing.
