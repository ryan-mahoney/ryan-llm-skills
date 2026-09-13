# LLM Skills & Rules

Shared configuration for LLM coding agents (Claude Code, Codex, Augment, Cline, and OpenCode). Two installable bundles carry the main workflows: **spec-skills** for prepared spec-driven development, including its design front-half, and **specops-skills** for legacy migration and structured agent documentation. Standalone utilities, design rules, and harness-specific instructions live alongside them.

Skills are slash commands defined in `skills/<name>/SKILL.md` using the Agent Skills format.

## Bundles And Workflows

Two portable, installable bundles cover spec-driven development, its design entry point, and SpecOps. Build the bundles with `scripts/build-skill-bundles.sh`; each archive contains a `skills/` directory plus `bundle.json`, `README.md`, and `install.sh`. The `spec-skills` archive also includes the shared `rules/` guides and workflow documentation. Product-documentation skills are available separately in this repository.

### spec-skills: spec-driven development

A standalone workflow that turns a goal into architecture, an explicit evidence posture, an immutable implementation package, sequential commits with owned proof, an independent convergent branch audit, and a commit-bound HTML work tour. Human review is optional input; executable evidence is the merge authority.

Use `spec-end-to-end` when one top-level agent should orchestrate the complete sequence and publish the pull request. It composes the stages below, resumes from valid existing artifacts, and preserves run-wide directives such as worktree choice or named delegation.

```text
/spec-end-to-end add CSV export for the filtered results, using a worktree
/spec-end-to-end resume .specs/results-export/ through PR publication
```

See the [end-to-end workflow guide](docs/spec-workflow.md) for prerequisites, goal-mode prompts,
compact handoffs, OpenCode nested workers, recovery, and completion criteria. The workflow ends at
a published PR with current evidence; merging the PR is a separate action.

The orchestrator runs these stages, which can also be invoked separately:

1. `spec-architect-initial`: write `.specs/<feature>/proposal.md`.
2. `spec-architect-critics`: stress-test the proposal and write `critique.md` (optional).
3. `spec-write`: write `spec.md`, `spec-steps.json`, and the AC → claim → failure → gate `evidence-plan.json`.
4. `spec-prepare`: code-ground both implementation and proof, derive guardrails, plan every step, and publish their hash-bound manifest last.
5. Workspace handoff: the top-level agent chooses a branch or worktree and preserves the complete `.specs/<feature>/` package when needed.
6. `spec-run`: implement each step, produce its gates and QA artifacts, assemble pre-audit evidence, and commit separately.
7. `spec-branch-refine`: independently audit code and evidence, fix, and converge to a commit-bound proven verdict.
8. `spec-work-tour`: emit required `work-tour.json` and browser-ready `work-tour.html` for the proven commit.
9. `spec-pr`: rebase, re-prove when necessary, require a ready tour, and publish the evidence PR.

`spec-issue` is an optional standalone convenience for mirroring a Markdown spec to GitHub. It writes no pipeline state and does not influence preparation, execution, review, or PR behavior.

| Skill | Command | Purpose |
|---|---|---|
| **spec-end-to-end** | `/spec-end-to-end [goal-or-feature] [modifiers]` | Orchestrate the complete workflow from goal or existing spec through a published PR |
| **spec-architect-initial** | `/spec-architect-initial [problem-or-feature]` | Review the architecture and write `.specs/<feature>/proposal.md` |
| **spec-architect-critics** | `/spec-architect-critics [proposal-or-file]` | Stress-test `proposal.md` and write `critique.md` |
| **spec-write** | `/spec-write [feature-slug-or-spec-path]` | Write the spec, step index, evidence posture, and claim/gate graph |
| **spec-prepare** | `/spec-prepare [feature-slug-or-spec-path]` | Correct and ground the spec, derive prose guardrails, prepare every step, and publish the hash-bound manifest |
| **spec-subspec-write** | `/spec-subspec-write [step-number] [spec-path]` | Leaf planner used sequentially by `spec-prepare` to write one immutable step subspec |
| **spec-branch** | `/spec-branch [description-or-feature-slug]` | Create a local branch from a spec, description, or issue/ticket reference |
| **spec-branch-worktree** | `/spec-branch-worktree [description-or-feature-slug]` | Create a branch/worktree and hand off the matching `.specs` package |
| **spec-run** | `/spec-run [feature-slug-or-spec-path]` | Execute prepared steps and assemble commit-bound pre-audit evidence |
| **spec-step-run** | delegated | Implement one prepared step and produce its owned code/evidence/QA artifacts |
| **spec-branch-refine** | `/spec-branch-refine [spec-path]` | Alternate integrated evidence audits and fixes until proven or blocked |
| **spec-branch-review** | delegated | Independently falsify code and claim/gate evidence per commit and integrated branch |
| **spec-branch-fix** | delegated | Apply or dismiss structured branch findings and commit fixes |
| **spec-work-tour** | `/spec-work-tour [spec-path]` | Build commit-bound HTML/JSON architecture, evidence, QA, and deploy tour |
| **spec-pr** | `/spec-pr [spec-path]` | Rebase, re-establish evidence, require ready tour, and publish the PR |
| **spec-issue** | `/spec-issue [markdown-path] [issue-number]` | Standalone GitHub issue creation or update with no pipeline integration |

The `spec-skills` bundle also ships the Augment CLI subagent adapter `augment/agents/spec-step-implementer.md`, which `spec-run` uses to delegate one step at a time.

`spec-branch` and `spec-branch-worktree` remain available as backwards-compatible convenience
utilities. They are not required stages of `spec-end-to-end`; the top-level agent owns workspace
strategy directly.

### design-spec: design-driven front-half

The same standalone pipeline, entered from design instead of architecture. Prototypes produce rendered-state evidence; the writer emits the same evidence plan; production implementation must prove real wiring and accessibility rather than relying on prototype approval or manual QA.

The architect classifies each surface on two axes. Posture picks the applicable rule: Functional uses `functionalist-design.md`, Expressive uses `expressive-design.md`. Deliverable is Prototype or Real, in-code. The writer carries the selected posture rule into the spec's Applicable Rules, so `spec-run` applies it at implementation time.

Run the design stages, then hand off to the explicit engineering back-half:

1. `design-spec-architect`: classify and propose a design direction (`proposal.md`)
2. `design-spec-prototype`: build and serve a viewable prototype (`prototype/`), optional
3. `design-spec-critique`: critique the prototype, else the proposal (`critique.md`), optional
4. `design-spec-writer`: write `spec.md`, its step index, and `evidence-plan.json`.
5. Hand the existing spec to `spec-end-to-end`, or run `spec-prepare`, workspace setup, `spec-run`, `spec-branch-refine`, `spec-work-tour`, and `spec-pr` separately.

| Skill | Command | Purpose |
|---|---|---|
| **design-spec-architect** | `/design-spec-architect [surface-or-feature]` | Review the design system and write `.specs/<feature>/proposal.md` |
| **design-spec-prototype** | `/design-spec-prototype [feature-or-stack-override]` | Build and serve `.specs/<feature>/prototype/` |
| **design-spec-critique** | `/design-spec-critique [feature]` | Critique the prototype or proposal and write `critique.md` |
| **design-spec-writer** | `/design-spec-writer [feature]` | Write the design-focused `spec.md` and machine step index without GitHub side effects |

### product-docs: screens and journeys

Three chained skills that document a product's user-facing surfaces from the access model outward. Each writes one artifact that the next reads, so the expensive derivation happens once. Run them in order; each also runs alone and says so when an upstream file is absent. Plain-English guide: [`docs/product-documentation.md`](docs/product-documentation.md).

| Skill | Command | Writes |
|---|---|---|
| **build-permission-model** | `/build-permission-model [scope]` | `docs/permissions/permission-model.md` — roles, capability matrix, route guards, audience predicates, findings |
| **build-screen-inventory** | `/build-screen-inventory [scope]` | `docs/screen-inventory.md` + `docs/inventories/*.md` — screens partitioned by who can reach them |
| **document-screen-behavior** | `/document-screen-behavior <screen>` | `docs/screens/SCRN-###-*.md` + `docs/screenshots/SCRN-###/` — one full screen specification |

Handoffs: the permission model supplies `AUD-##` predicates as the inventory's partition axes, and `ROLE-##` / `CAP-##` IDs to the screen pages. The inventory supplies each screen's ID and the queue of undocumented screens. Every downstream file pins the upstream version in `derived_from`, so drift is visible rather than silent.

Three companion skills trace a user's goal across repositories. Run `build-journey-map` to register
journeys, `document-journey` for each registered journey, then `visualize-journey` for a visual map.

| Skill | Command | Writes |
|---|---|---|
| **build-journey-map** | `/build-journey-map [repository-set]` | `docs/journey-registry.md` with stable journey IDs and repository seams |
| **document-journey** | `/document-journey <JRNY-###>` | `docs/journeys/JRNY-###-<slug>.md` with stages, carried context, and evidence |
| **visualize-journey** | `/visualize-journey <JRNY-###>` | `docs/journeys/visuals/JRNY-###/` with a manifest and HTML map, plus a portfolio index |

### specops-skills: SpecOps / agent documentation

A SpecOps pipeline for migrating legacy code and maintaining structured, agent-readable system docs: decompose the source into a stable target manifest, analyze each target into implementation-agnostic specs, compress those specs into target docs optimized for coding agents, index them from `AGENTS.md`, and keep the set fresh as branches change.

Generated artifacts in target repos:

- `docs/specops/targets.json` — deterministic target manifest and freshness spine.
- `docs/specops/analysis/<slug>.md` — deep implementation-agnostic analysis.
- `docs/specops/agents/<slug>.md` — compressed target doc an agent should read first.
- `AGENTS.md` — compact generated index between `<!-- agents-docs:start -->` and `<!-- agents-docs:end -->`.
- `docs/specops/history/ledger.jsonl` — append-only commit-coverage ledger (one row per commit, per lens).
- `docs/specops/history/frontier.json` — last covered commit per lens (`doc`, `intent`, `rework`).
- `docs/specops/history/decisions/active.md` and `superseded.md` — product decisions reconstructed from history.
- `docs/specops/history/rework.md` — rework hotspot report and Context Map.

Two common flows:

1. **Bootstrap structured docs:** run `specops-decompose`, then `specops-orchestrate-analysis`. The orchestrator analyzes each manifest target, builds compressed agent docs, and refreshes the `AGENTS.md` index.
2. **Refresh a branch or PR:** run `specops-branch-refresh`. It maps changed files to targets, refreshes affected deep analysis docs, rebuilds compressed agent docs, stamps manifest freshness fields, and updates the `AGENTS.md` index.

`specops-agent-docs` and `specops-index-agents` are leaf utilities. They are usually invoked by `specops-orchestrate-analysis` or `specops-branch-refresh`, but can be run manually to repair compressed docs or the index.

#### Understanding changes: commit coverage, decisions, and rework

Three capabilities read git history to keep docs honest and to recover *why* the code became what it is. They share a commit-coverage **ledger** under `docs/specops/history/`, backed by the deterministic `scripts/commit-ledger.mjs`.

**The problem they solve.** The manifest's `source_hash` is a content hash: it answers "is this target stale right now?" but not "which commits were processed, by whom, when?". The ledger answers the second question. It records, per commit, which "lens" has processed it — `doc` (documentation refreshed), `intent` (decisions extracted), or `rework` (churn audited) — and a per-lens *frontier* pointing at the last covered commit. Because the ledger is a committed file, the record **survives squash-merge** even though the branch SHAs do not. When a squash or rebase orphans the frontier, `node scripts/commit-ledger.mjs reconcile <repo>` re-anchors it to the newest still-reachable commit, or records a single squash-boundary row and reports that per-commit granularity was lost — rather than silently double-counting.

- **Doc coverage and catch-up.** `specops-branch-refresh` records `doc` coverage after each clean refresh, so missed runs are detectable. `specops-doc-catchup` is the recovery orchestrator: it reads the uncovered commits and fans out subagents to bring docs current commit-by-commit, then records coverage. Run it with `--status` for a read-only report of undocumented commits.
- **Decision archaeology.** `specops-decision-ledger` walks history forward, extracting each commit's intent and product decisions via the `specops-intent-extract` leaf (a two-step micro-pipeline: "what changed" then "why"). It maintains `active.md` (decisions in force) and, when a later commit overrides an earlier decision, moves the abrogated one to `superseded.md`, annotated with the overriding commit.
- **Rework audit.** `specops-rework-audit` combines deterministic churn metrics with supersession density from the decision ledger, classifies hotspots as healthy iteration or a likely process gap, and produces a **Context Map** — who holds the relevant context and what to ask them. It is explicitly framed for process improvement and knowledge transfer, never blame.

The split is deliberate: mechanical git accounting (commit enumeration, file→target mapping, churn, frontier math, squash reconciliation) is deterministic; interpretation (intent, supersession, healthy-vs-process-gap, who-to-consult) stays with the LLM, fanned out across subagents for large histories.

Get started in a repo that already has `docs/specops/targets.json`:

```bash
# which commits are undocumented? (read-only)
node scripts/commit-ledger.mjs status <repo-root>

/specops-doc-catchup            # catch up any missed doc coverage
/specops-decision-ledger        # reconstruct active + superseded product decisions
/specops-rework-audit           # find rework hotspots and who to consult

# after a squash/rebase orphaned a frontier:
node scripts/commit-ledger.mjs reconcile <repo-root>
```

| Skill | Command | Purpose |
|---|---|---|
| **specops-decompose** | `/specops-decompose [repo-root]` | Produce or refresh `docs/specops/targets.json`, deriving stable target slugs/globs/coverage mechanically and filling only target names, scopes, and system summary prose |
| **specops-initial-plan** | `/specops-initial-plan [scope]` | Create a generalized SpecOps analysis and initial implementation-agnostic plan |
| **specops-refactor-plan** | `/specops-refactor-plan [target-folder] [refactor-goal]` | Create a refactor-focused SpecOps plan for an existing source folder and explicit goal |
| **specops-analysis** | `/specops-analysis [scope]` | Produce a generalized SpecOps implementation-agnostic analysis/specification |
| **specops-update-spec** | `/specops-update-spec [target manifest entry + branch/diff context]` | Update one target's deep spec in place from a branch or diff, then return refreshed `source_hash` and `last_synthesized` for the orchestrator |
| **specops-orchestrate-analysis** | `/specops-orchestrate-analysis [manifest-path-or-repo-root]` | Orchestrate sequential per-target analysis from `docs/specops/targets.json` in-harness; also supports the legacy initial-plan flow as a fallback |
| **specops-agent-docs** | `/specops-agent-docs [manifest-path-or-repo-root] [target-slug]` | Build compressed per-target agent docs from deep SpecOps analysis under `docs/specops/agents/` |
| **specops-index-agents** | `/specops-index-agents [manifest-path-or-repo-root]` | Update the generated `AGENTS.md` table of contents for structured SpecOps agent docs |
| **specops-branch-refresh** | `/specops-branch-refresh [repo-root] [base-ref]` | Refresh affected analysis docs, compressed agent docs, manifest freshness, and the AGENTS index for the current branch; record `doc` coverage in the ledger |
| **specops-doc-catchup** | `/specops-doc-catchup [repo-root] [--status]` | Catch up agent docs for commits the ledger shows as undocumented, fanning out subagents; reconcile a frontier broken by squash or rebase |
| **specops-intent-extract** | `/specops-intent-extract <commit-sha-or-range> [repo-root]` | Leaf: extract one commit's intent and product decisions from its message and code; returns a structured intent record |
| **specops-decision-ledger** | `/specops-decision-ledger [repo-root] [--since ref]` | Walk history forward, reconstructing `active.md` and `superseded.md` product decisions; abrogated decisions move aside with their overriding commit |
| **specops-rework-audit** | `/specops-rework-audit [repo-root] [--since ref]` | Find rework/churn hotspots and a non-blame Context Map of who to consult, from churn metrics plus supersession density |
| **specops-ambiguity-audit** | `/specops-ambiguity-audit [analysis-file]` | Audit a SpecOps analysis spec for ambiguities, resolve them via parallel legacy-source research, and patch the spec |
| **specops-spec-coherence** | `/specops-spec-coherence [analysis-dir]` | Audit a set of analysis specs for cross-spec coherence (dependency order, integration contracts, shared models, terminology) and patch gaps |
| **specops-make-spec** | `/specops-make-spec [scope]` | Convert analysis into an implementation spec plus executable evidence plan |
| **specops-orchestrate-spec-create** | `/specops-orchestrate-spec-create [analysis-files-or-dir]` | Orchestrate sequential subagents that generate one spec per analysis file |
| **specops-spec-conformance** | `/specops-spec-conformance [analysis-spec] [implementation-spec]` | Audit an implementation spec against its source analysis spec for dropped or weakened behavior and patch the implementation spec |
| **specops-run-spec** | `/specops-run-spec [spec-file]` | Implement sequential evidence-owning commits, converge independent gates, and emit the HTML work tour |
| **specops-contract-tests** | `/specops-contract-tests [analysis-file]` | Generate a framework-agnostic pytest contract test file from a SpecOps analysis |
| **specops-integration-test** | `/specops-integration-test [analysis-dir] [migrated-folder]` | Generate integration tests for normative cross-module pathways discovered from analysis specs and the migrated call graph, reusing existing unit-test mocks |
| **specops-implementation-drift** | `/specops-implementation-drift [migrated-folder] [original-analysis]` | Re-analyze migrated code, diff against the original analysis, and produce corrective specs for each behavioral divergence |

### Build and install

```bash
scripts/build-skill-bundles.sh
```

This produces, under `dist/skill-bundles/` (git-ignored):

- `spec-skills-<version>.tar.gz` / `.zip`
- `specops-skills-<version>.tar.gz` / `.zip`

There is no separate `design-spec-skills` archive. The design-spec skills ship inside `spec-skills` because they write the same artifact contract and hand off to `spec-prepare`, `spec-run`, `spec-branch-refine`, and `spec-work-tour`.

Extract an archive and run `./install.sh` (see `./install.sh --help` for harness-specific targets). Set `VERSION` to control the archive name and bundle metadata:

```bash
VERSION=2026.06.12 scripts/build-skill-bundles.sh
```

Pushing a `v*` tag runs the GitHub Actions release workflow, which builds both archives for each bundle, generates `SHA256SUMS`, and attaches the files to the GitHub Release:

```bash
git tag v2026.06.12
git push origin v2026.06.12
```

## Other Skills

Standalone skills outside the two distributions.

| Skill | Command | Purpose |
|---|---|---|
| **agents-update** | `/agents-update [path-or-scope]` | Analyze a repository's architecture and generate or update `AGENTS.md` for coding agents and contributors |
| **architect-inspect** | `/architect-inspect [top-level-file] [optional output path]` | Inspect and describe the current architecture around a specific feature/component entry file |
| **identify-where** | `/identify-where [plain-language functionality] [optional scope]` | Locate the top-level file(s) where a described behavior or feature likely lives |
| **feature-list** | `/feature-list [target-scope]` | Produce a language-agnostic inventory of user- and operator-facing features grouped by capability, with entry points and supporting modules |
| **controller-refactor-plan** | `/controller-refactor-plan [controller-file] [optional output path]` | Analyze one controller file for dead handlers and responsibility growth beyond controller boundaries |
| **ux-auditor** | `/ux-auditor [prototype html] [component file]` | Audit UI implementation parity against an HTML prototype and produce a grouped correction checklist |
| **see** | `/see` | Probe whether the running model can view images, and relay image analysis to a vision model when it cannot |
| **uishot** | `/uishot [url]` | Screenshot a running page once it has finished rendering, for inspection through `see` |
| **design-align** | `/design-align [path-to-top-level-component]` | Audit a React component tree against the FirstWho design system and recommend Tailwind CSS corrections |
| **form-modernizer** | `/form-modernizer [FormComponentPath]` | Modernize a form via multi-phase analysis, redesign, TypeScript typing, and visual verification |
| **angular-pr-complexity** | `/angular-pr-complexity <commit-hash>` | Score an Angular/Nx merge commit on size, spread, file types, and cognitive load |
| **bun-test-fix** | `/bun-test-fix <path-to-test-file>` | Bring a test file into compliance with Bun test rules from `AGENTS.md` |
| **skill-factory** | `/skill-factory [description of task to automate]` | Create a reusable skill by extracting an existing repository workflow into a grounded `SKILL.md` |
| **simple-english** | `/simple-english [text or file]` | Write or check technical text against ASD-STE100 Simplified Technical English — sentence limits, one word one meaning, active voice, condition before command ([upstream](https://github.com/AminBlg/SimpleEnglish), MIT) |
| **axi-checker** | `/axi-checker [path to prompt/SKILL.md/AGENTS.md]` | Audit a prompt, skill, or agent instruction file against the 10 [AXI](https://axi.md/) principles and recommend structural and content fixes; delegates the sentence-level pass to `simple-english` |
| **rules-from-experts** | `/rules-from-experts [topic]` | Research named experts, resolve disagreements, and produce a cited report plus agent-readable rules |
| **ux-cover-critique** | `/ux-cover-critique [cover and positioning]` | Critique a book cover against its genre, audience, and market positioning |
| **ux-information-critique** | `/ux-information-critique [pages and reading job]` | Critique informational pages for typography, hierarchy, and reading usability |
| **ux-page-critique** | `/ux-page-critique [screenshot and user job]` | Critique an application page and prioritize UX and visual improvements |
| **commit** | `/commit [issue]` | Conventional commit of staged files |
| **pr-review** | `/pr-review [pr]` | Review a PR's code and submit comments |
| **pr-feedback** | `/pr-feedback [pr]` | Address PR review comments one by one |

## Rules

Design, copy, implementation, and testing guidance. Files in `rules/` are symlinked into harness-specific rule/guide directories; apply each guide when relevant to the task.

| File | Scope |
|---|---|
| `functionalist-design.md` | Functional surfaces: layout, typography, color, data-ink restraint |
| `expressive-design.md` | Expressive surfaces: brand/marketing direction, distinctive type, atmosphere, motion |
| `form-design.md` | Form structure, labels, validation |
| `table-row-design.md` | Table layout, alignment, row interaction |
| `cta-design.md` | Button wording, hierarchy, accessibility |
| `ux-states.md` | Required states for data-driven views (empty, loading, error, partial, ideal) |
| `minimal-implementation.md` | Keep implementation scope focused and avoid unnecessary abstractions |
| `unit-testing.md` | Write useful unit tests with clear boundaries and meaningful assertions |

## Agent Instructions

Each agent reads a global instruction file from its own config directory. The canonical source lives here and is copied during sync.

| Source | Destination |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `skills/*/SKILL.md` | Harness skill directories when needed; Augment also discovers `~/.agents/skills/` natively |
| `augment/agents/*.md` | `~/.augment/agents/*.md` |

## Repository Layout & Sync

```
~/.agents/
├── sync.sh        # Sync instructions, rules, skills, and adapters
├── augment/       # Augment-specific adapter files, such as CLI subagents
├── skills/        # Agent Skills / slash-command skills
├── rules/         # Design and copy guidance (symlinked into each agent)
├── claude/        # Claude Code global instructions → ~/.claude/CLAUDE.md
├── codex/         # Codex global instructions → ~/.codex/AGENTS.md
├── docs/          # Workflow, evidence review, and product-documentation guides
├── bundles/       # Distribution contents and installation guide
└── scripts/       # Bundle build, skill lint, and SpecOps tooling
```

Run `sync.sh` after any change to instructions, rules, or skills:

```bash
~/.agents/sync.sh
```

This copies instruction files, refreshes rule symlinks, syncs skills where needed, prunes stale skill symlinks after renames, and syncs harness adapters such as Augment CLI agents. Each target directory is only updated if it already exists.

OpenCode runtime settings live separately in `~/.config/opencode/opencode.jsonc` or `opencode.json`.
`sync.sh` does not install provider credentials or edit those settings. See
[OpenCode delegation setup](docs/spec-workflow.md#opencode-nested-delegation) for the optional second worker level.

## Augment Support

Augment support has two layers:

- Skills: Augment discovers Agent Skills from `~/.agents/skills/`, so the canonical `skills/*/SKILL.md` files are already usable by current Augment clients. The `~/.augment/skills/` mirror exists only for older clients and compatibility.
- Subagents: Augment CLI subagents are separate markdown configs under `~/.augment/agents/` or `./.augment/agents/`. The spec workflow includes `augment/agents/spec-step-implementer.md` for `spec-run` to delegate one implementation step at a time.

If Augment is already installed and `~/.augment/` exists, normal sync installs the adapter:

```bash
~/.agents/sync.sh
```

If Augment has not created `~/.augment/` yet, bootstrap the documented user-level config dirs with:

```bash
SYNC_AUGMENT=1 ~/.agents/sync.sh
```

For a repository-shared Augment setup, copy or symlink `augment/agents/spec-step-implementer.md` into that repo's `./.augment/agents/` directory.
