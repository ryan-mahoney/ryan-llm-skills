---
name: agents-update
description: "Analyze a code repository's architecture and produce (or update) an AGENTS.md file that gives LLM coding agents a map of the project. Use this skill whenever the user says 'generate AGENTS.md', 'create AGENTS.md', 'update AGENTS.md', 'map this repo', 'document this project for agents', 'analyze the architecture', or any variation of 'help an LLM understand this codebase'. Also trigger when the user asks to onboard an AI agent onto a project, describe a repo's structure for Claude/Copilot/Cursor, or identify the architectural pattern of a codebase. If structured SpecOps agent docs exist, preserve or refresh the generated AGENTS.md index block rather than duplicating those docs inline."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "4"
---

# Agent — Repository Architecture Mapper

Generate or update an `AGENTS.md` file that gives coding agents and human contributors a reliable, opinionated map of a repository. The goal is to capture everything needed to work confidently in the codebase, especially the things a newcomer or agent would get wrong without being told.

## Why AGENTS.md Exists

Coding agents make assumptions. They assume Rails conventions in a Django project, guess that `src/` is the frontend when it's the backend, and hallucinate file paths. `AGENTS.md` exists to short-circuit those mistakes by giving contributors ground truth about the project up front.

---

## Step 1 — Reconnaissance

Survey the repository before writing anything. Use these checks as a recommended workflow and adapt the order to the repository's structure.

For large repositories (monorepos, 10+ top-level areas or packages), fan reconnaissance out: spawn parallel Explore subagents — one per package or top-level area — and synthesize their reports in the main context instead of reading everything yourself. Drill into a package only when its conventions differ from the root.

If the target has no dependency manifest and no source tree, report `out of scope: <path> is not a code repository` and stop.

### 1a. Top-level inventory

List the root directory contents. Pay attention to:

- Config files that reveal the stack: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle`, `composer.json`, `mix.exs`, `pubspec.yaml`, etc.
- Monorepo signals: `workspaces` in package.json, `lerna.json`, `nx.json`, `turbo.json`, `Cargo.toml` with `[workspace]`, `packages/` or `apps/` directories.
- Containerization: `Dockerfile`, `docker-compose.yml`, `.devcontainer/`.
- CI/CD: `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`.
- Infrastructure-as-code: `terraform/`, `cdk.json`, `serverless.yml`, `pulumi/`.

### 1b. Read dependency manifests

Read the dependency files. Extract:

- **Language and runtime version** (e.g., `"engines": {"node": ">=20"}`, `python_requires`, rust-toolchain.toml).
- **Framework and its version** (e.g., Next.js 14, Django 5.1, Rails 7.2, Spring Boot 3.x).
- **Key libraries** that shape how code is written — ORMs (Prisma, SQLAlchemy, ActiveRecord), state management (Redux, Zustand, Vuex), testing (Jest, pytest, RSpec), API layers (tRPC, GraphQL, REST via DRF/FastAPI).
- **Dev tooling** that affects how code should be formatted or linted: ESLint config, Prettier, Black, Ruff, rustfmt.

### 1c. Trace the directory tree

Trace the directory structure 2–3 levels deep. Identify:

- Where source code lives vs. generated/build output.
- The separation (or lack thereof) between frontend and backend.
- Any unconventional directory names or locations.

### 1d. Read key entry points and config

Read the files that reveal routing and wiring:

- **Backend entry points**: `app.py`, `main.go`, `src/index.ts`, `config/routes.rb`, `urls.py`, `Program.cs`.
- **Frontend entry points**: `app/layout.tsx`, `src/App.vue`, `src/main.tsx`, `pages/_app.tsx`.
- **Router config**: Look for route definitions, middleware chains, API versioning.
- **Database config**: Migration directories, ORM config files, schema files (`schema.prisma`, `models.py`, `db/migrate/`).

### 1e. Check for existing agent instruction files

- **AGENTS.md** — if one exists, read it fully. Step 4 covers how to update it.
- **Siblings** — if `CLAUDE.md`, `.cursorrules`, or `.github/copilot-instructions.md` are present, read them. Do not duplicate their content in AGENTS.md. Where they contradict the actual repo, mark the contradiction with `<!-- REVIEW: ... -->`.

### 1f. Check for structured SpecOps agent docs

If `docs/specops/targets.json` exists:

- Read the manifest summary and target list.
- Preserve any existing generated block between `<!-- agents-docs:start -->` and
  `<!-- agents-docs:end -->`.
- Do not copy per-target docs into AGENTS.md. The root AGENTS.md must contain only a compact
  index that links to `docs/specops/agents/<slug>.md` and `docs/specops/analysis/<slug>.md`.
- If the generated block is missing or stale, run `specops-index-agents` (it regenerates the
  index block). If you cannot run it, recommend it in your report.

### 1g. Mine for gotchas and ground-truth commands

The Gotchas and Commands sections are the highest-value parts of the output. Source them from evidence, not memory:

- **Commands**: `package.json` scripts, `Makefile`, `justfile`, and CI workflows (`.github/workflows/*`) are the source of truth — prefer the exact invocations CI runs. When the environment allows, verify cheap commands by running them (linter, `test --help`).
- **Gotchas**: path aliases in `tsconfig.json` or bundler config, env validation files, husky/pre-commit hooks, `CONTRIBUTING.md`, comments matching `HACK|WORKAROUND|XXX`, and config files that `git log` shows are touched repeatedly.

---

## Step 2 — Classification

Based on reconnaissance, determine:

### Architectural Pattern

Name the pattern precisely. Don't just say "MVC" — say which flavor. Examples:

- **Classic MVC** (Rails, Laravel, Django MTV which is MVC by another name)
- **Component-based SPA** (React/Vue/Svelte with client-side routing)
- **Server-rendered with islands** (Astro, Fresh)
- **API + SPA** (decoupled backend REST/GraphQL API serving a separate frontend app)
- **Monolithic fullstack** (Next.js / Nuxt / SvelteKit with colocated API routes)
- **Microservices** (multiple independently deployable services)
- **Serverless functions** (AWS Lambda, Vercel Functions, Cloudflare Workers)
- **Modular monolith** (single deploy unit, but code organized into bounded modules)
- **Hexagonal / Ports & Adapters**
- **CQRS / Event-sourced**
- **Library / SDK** (published package — the public API surface is the architecture)
- **CLI tool** (commands, flags, and exit codes matter more than layers)
- **Data pipeline / batch jobs** (stages, schedulers, input/output contracts)
- **Infrastructure repo** (Terraform/CDK modules, environments, state management)
- **Hybrid** — name the combination explicitly (e.g., "Next.js frontend + Rails API backend in a monorepo")

If the project doesn't fit a clean label, describe it honestly rather than forcing a name.

### Monorepo vs. Single-project

If monorepo: identify each package/service, its role, and how they relate.

---

## Step 3 — Write AGENTS.md

Produce the file using the template below. Every section exists because it prevents a specific category of contributor or agent mistake. Do not add fluff sections. When a section is verified and materially useful, include it. If a section is relevant but not confirmed from the repository, prefer omission; when it is too useful to omit, mark it with `<!-- REVIEW: reason -->`. Do not guess. This omit-or-mark rule is the single policy for unverified content — Steps 4 and 5 reference it rather than restating it.

**Finding-shaped sections have a defined zero:** if reconnaissance surfaces no verified gotchas or conventions, omit that section or write "None verified." Never invent an entry you cannot trace to a file.

**Write instructions as instructions:** the generated file is read by agents. Use imperative mood, one instruction per sentence, condition before its command, and never "should" — an agent reads "should" as optional.

**Length budget:** AGENTS.md is loaded into every agent's context, so size is a cost. Target under ~150 lines. When trimming, keep Key Conventions and Gotchas first; cut exhaustive directory listings and tech-stack rows that state the obvious.

**Adapt to the repo type:** the template assumes a web app. For a library, CLI, data pipeline, or infra repo, drop inapplicable sections (Routing, Frontend, Data Layer) and substitute ones that fit — Public API surface, CLI commands and flags, pipeline stages, module/environment layout.

````markdown
# AGENTS.md

> Auto-generated architecture guide for LLM coding agents.
> Last updated: YYYY-MM-DD

## Project Overview

One paragraph: what this project is, who it's for, what it does.

## Architecture

**Pattern:** [Named pattern from Step 2]
**Monorepo:** [Yes/No — if yes, list packages/services]

[2-4 sentences explaining how the pieces fit together. Focus on what a contributor or agent
would get wrong: "Despite having a `pages/` directory, routing is NOT file-based;
all routes are registered explicitly in `src/router/index.ts`."]

## Tech Stack

| Layer      | Technology | Version | Notes |
| ---------- | ---------- | ------- | ----- |
| Language   |            |         |       |
| Runtime    |            |         |       |
| Framework  |            |         |       |
| ORM / DB   |            |         |       |
| Frontend   |            |         |       |
| Styling    |            |         |       |
| Testing    |            |         |       |
| CI/CD      |            |         |       |
| Deployment |            |         |       |

## Directory Map

Annotated tree showing where things live. Only include directories that matter.
Use inline comments to explain non-obvious placements.
```

repo-root/
├── src/ # [what lives here]
│ ├── routes/ # [backend API route handlers]
│ ├── models/ # [ORM model definitions]
│ ├── services/ # [business logic layer]
│ └── ...
├── client/ # [frontend SPA]
│ ├── components/ # [React components]
│ └── pages/ # [client-side route pages]
├── db/
│ └── migrations/ # [database migrations — run with `X` command]
├── config/ # [app configuration files]
└── ...

```

## Routing

### Backend / API Routes
[How routes are defined, where they live, naming conventions.
Example: "Routes are defined in `src/routes/*.ts` and auto-loaded by the
framework. Each file exports a Hono router. API prefix is `/api/v1`."]

### Frontend Routes
[How pages map to URLs. File-based? Explicit router config? Both?
Example: "File-based routing via Next.js App Router. Layouts in `app/layout.tsx`.
Dynamic segments use `[param]` folder convention."]

## Data Layer

### Database
[What DB, how to connect, where the schema is defined.]

### Migrations
[Where migrations live, how to create and run them, any naming conventions.
Example: "`npx prisma migrate dev` to apply. Schema at `prisma/schema.prisma`."]

### Models / Schema
[Where models are defined. If there's a single source of truth (e.g., Prisma
schema generates types), say so. If models are hand-maintained, say that too.]

## Key Conventions

Things that deviate from what a coding agent or new contributor would assume by default:

- [e.g., "All API responses are wrapped in `{ data, error, meta }` — never
  return raw arrays or objects."]
- [e.g., "Use `snake_case` for DB columns and API fields, `camelCase` only
  in frontend TypeScript."]
- [e.g., "Never import from `@/utils` — use the domain-specific utility
  module like `@/billing/utils` instead."]
- [e.g., "Tests must be colocated: `foo.ts` → `foo.test.ts` in the same dir,
  not in a top-level `__tests__/` folder."]

## Commands

| Task                    | Command                         |
|-------------------------|---------------------------------|
| Install dependencies    | `...`                           |
| Run dev server          | `...`                           |
| Run tests               | `...`                           |
| Run linter              | `...`                           |
| Build for production    | `...`                           |
| Run database migrations | `...`                           |
| Generate types/code     | `...`                           |

## Gotchas & Unexpected Behavior

Things that WILL trip up a coding agent or new contributor if not stated explicitly:

- [e.g., "The `user` table is called `accounts` in the DB but `User` in the
  ORM — the mapping is in `src/models/user.ts`."]
- [e.g., "Environment variables are validated at startup via Zod in
  `src/env.ts` — adding a new env var requires updating the schema there,
  not just `.env`."]
- [e.g., "This project uses path aliases: `@/` maps to `src/` but `~/`
  maps to `client/src/` — don't confuse them."]
- [e.g., "Some routes are guarded by middleware defined in a non-obvious
  place: `src/middleware/auth.ts` wraps routes in `src/routes/admin/*`."]
- [e.g., "The `build` command doesn't just compile — it also runs codegen.
  If you edit a `.graphql` file, you must rebuild before types update."]

## Environment & Config

[Where env vars are defined, whether there's validation, any required
secrets for local dev. Mention `.env.example` if it exists.]

````

---

## Step 4 — Update vs. Create Logic

- **No existing AGENTS.md**: Create it fresh from the template.
- **Existing AGENTS.md**: Read it carefully. Then:
  - **Preserve** any human-written commentary, team-specific notes, or sections not covered by this template.
  - **Preserve** the generated SpecOps agent-docs block per Step 1f.
  - **Update** sections where the repo has changed (new dependencies, moved directories, changed patterns).
  - **Append** new sections from the template that are missing.
  - **Mark** anything you're unsure about with `<!-- REVIEW: [reason] -->` so a human can verify.
  - **Refresh** the `Last updated` date in the header.
  - If the existing prose style is good, keep it. Do not rewrite working sentences just to match the template's voice.
  - If a section communicates accurate project-specific guidance, keep it. The template does not limit which sections the file can have.

---

## Step 5 — Self-Review Checklist

Before finalizing, verify:

1. **Could a contributor find every file they need?** — If someone is asked to "add a new API endpoint," does `AGENTS.md` tell them exactly where to put the route file, the model, the test, and the migration?
2. **Are the gotchas real?** — Each gotcha must describe a mistake a coding agent or new contributor makes without it. Remove generic advice like "read the docs" or "follow best practices."
3. **Is the tech stack table complete?** — List every version that matters for compatibility.
4. **Are commands copy-pasteable?** — An agent must be able to run each command verbatim. Trace each command to a package script, Makefile target, or CI step per Step 1g — never reconstruct commands from memory.
5. **Is anything stale?** — If you found a discrepancy between AGENTS.md and the actual repo, mark it with `<!-- REVIEW: ... -->`.
6. **Did you avoid speculation?** — Never infer versions, commands, deployment targets, or architectural labels that are not evidenced by the repository. Apply the Step 3 omit-or-mark rule.

---

## Execution Notes

- This skill involves reading many files. Batch your reads — do not open files one at a time when you can scan directories and read multiple files in sequence.
- For a monorepo, the root AGENTS.md must be an overview with pointers, not exhaustive docs for every sub-package. For packages with their own distinct conventions, prefer nested `packages/<name>/AGENTS.md` files — the AGENTS.md convention resolves the closest file to the code being edited — over inflating the root file. (Reconnaissance strategy for large repos lives in Step 1.)
- Write `AGENTS.md` to the repository root.
- If the execution environment requires writing outputs to a staging path, follow that environment's documented file-output convention.
