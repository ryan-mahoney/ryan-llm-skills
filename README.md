# LLM Skills & Rules

Shared configuration for LLM coding agents (Claude Code, Codex, Augment, Cline, OpenCode). The centerpiece is two installable skill bundles with three workflow families: **spec-skills** contains both the spec-driven development workflow and the design-driven front-half, while **specops-skills** contains the legacy migration workflow. Design-spec is not a separate bundle because it depends on the same `.specs/<feature-slug>/` contract, conformance checklist, implementation back-half, rules, and Augment adapter as the spec workflow. Alongside the bundles sit standalone utility skills, design rules, and per-agent instruction files.

Skills are slash commands defined in `skills/<name>/SKILL.md` using the Agent Skills format.

## Bundles And Workflows

Two portable, installable bundles produce three documented workflows. Build the bundles with `scripts/build-skill-bundles.sh`; each archive contains a `skills/` directory plus `bundle.json`, `README.md`, and `install.sh`. The `spec-skills` archive also includes the shared `rules/` guides used by both spec and design-spec workflows.

### spec-skills: spec-driven development

A local-first workflow that turns a goal into reviewed architecture, then a deterministic implementation spec, then verified execution. Every stage reads and writes `.specs/<feature-slug>/` as the source of truth. GitHub issues are optional mirrors, used only when the repository is hosted on GitHub and `gh` is authenticated.

Run the stages in order; each consumes the previous stage's artifact:

1. `spec-architect-initial`: propose an architecture (`proposal.md`)
2. `spec-architect-critics`: stress-test it (`critique.md`), optional
3. `spec-write`: commit to an implementation spec (`spec.md`)
4. `spec-review`: check the spec against the codebase, for difficult changes or handoffs
5. `spec-criteria`: compile the frozen spec into a conformance checklist (`criteria.md`), before implementing
6. `spec-branch` / `spec-branch-worktree`: create a branch (and worktree) carrying the spec folder
7. `spec-run`: implement every step, one subagent per step; each step self-plans first
8. `spec-audit`: verify the implementation against the checklist
9. `spec-remediate`: fix any findings, then re-audit until clean

| Skill | Command | Purpose |
|---|---|---|
| **spec-architect-initial** | `/spec-architect-initial [problem-or-feature]` | Review the existing system architecture and write `.specs/<slug>/proposal.md`, or explain why the request does not fit |
| **spec-architect-critics** | `/spec-architect-critics [proposal-or-file]` | Stress-test `proposal.md` using expert or expert-lens critique and write `.specs/<slug>/critique.md` |
| **spec-write** | `/spec-write [feature-slug-or-issue]` | Write `.specs/<slug>/spec.md` from the proposal and critique, and optionally mirror it to a GitHub issue |
| **spec-subspec-write** | `/spec-subspec-write [step-number] [feature-slug]` | Write a minimal, code-grounded plan for one step at `.specs/<slug>/subspecs/<n>-spec.md`; invoked by `spec-run` before coding each step |
| **spec-review** | `/spec-review [feature-slug-or-spec-path]` | Review a local spec for gaps, edit `spec.md`, and optionally mirror changes to GitHub |
| **spec-criteria** | `/spec-criteria [feature-slug-or-spec-path]` | Compile a frozen spec's normative prose into an executable conformance checklist at `.specs/<slug>/criteria.md`, blind to the implementation, accumulating cross-phase invariants in `invariants.md` |
| **spec-branch** | `/spec-branch [description-or-feature-slug]` | Create a local branch from a spec, description, or issue/ticket reference |
| **spec-branch-worktree** | `/spec-branch-worktree [description-or-feature-slug]` | Create a named branch and git worktree, copy the spec folder, then open VSCode |
| **spec-run** | `/spec-run [feature-slug-or-spec-path]` | Implement all steps from `spec.md`, one subagent per step; each step self-plans via `spec-subspec-write` before coding |
| **spec-audit** | `/spec-audit [feature-slug-or-spec-path]` | Execute the frozen conformance checklist against the implementation diff; PASS/VIOLATION/UNVERIFIABLE per criterion with evidence, report-only |
| **spec-remediate** | `/spec-remediate [feature-slug-or-spec-path]` | Fix audit VIOLATIONs with one smart subagent per finding, converging code back to the frozen spec, then re-audit until clean; escalates spec/criteria defects |

The `spec-skills` bundle also ships the Augment CLI subagent adapter `augment/agents/spec-step-implementer.md`, which `spec-run` uses to delegate one step at a time.

### design-spec: design-driven front-half

The same pipeline, entered from design instead of architecture. It ships in the `spec-skills` bundle and reuses the canonical `.specs/<feature-slug>/` artifacts (`proposal.md`, `critique.md`, `spec.md`). Once a design spec is written, the engineering back-half runs against it unchanged: `spec-criteria`, `spec-branch`, `spec-run`, `spec-audit`, `spec-remediate`.

The architect classifies each surface on two axes. Posture picks the applicable rule: Functional uses `functionalist-design.md`, Expressive uses `expressive-design.md`. Deliverable is Prototype or Real, in-code. The writer carries the selected posture rule into the spec's Applicable Rules, so `spec-run` applies it at implementation time.

Run the design stages, then hand off to `spec-run`:

1. `design-spec-architect`: classify and propose a design direction (`proposal.md`)
2. `design-spec-prototype`: build and serve a viewable prototype (`prototype/`), optional
3. `design-spec-critique`: critique the prototype, else the proposal (`critique.md`), optional
4. `design-spec-writer`: commit to a `spec.md` in the standard 8-section contract
5. `design-spec-review`: design-lens gap and ambiguity review of `spec.md`
6. Hand off to `spec-criteria` / `spec-branch` / `spec-run` / `spec-audit` / `spec-remediate` as usual

| Skill | Command | Purpose |
|---|---|---|
| **design-spec-architect** | `/design-spec-architect [surface-or-feature]` | Review the design system and rules, classify posture and deliverable, and write `.specs/<slug>/proposal.md`, or explain that no new design is needed |
| **design-spec-prototype** | `/design-spec-prototype [feature-slug or stack override]` | Build a fast, viewable prototype (default: single static HTML + Tailwind CDN) into `.specs/<slug>/prototype/` and serve it on localhost for comment |
| **design-spec-critique** | `/design-spec-critique [feature-slug]` | Stress-test the prototype (else the proposal) through two real design practitioners or named design lenses and write `.specs/<slug>/critique.md` |
| **design-spec-writer** | `/design-spec-writer [feature-slug or issue]` | Write `.specs/<slug>/spec.md` in the standard 8-section contract from the proposal, critique, and approved prototype, with design-specialized acceptance criteria and steps |
| **design-spec-review** | `/design-spec-review [feature-slug-or-spec-path]` | Review `spec.md` from a design lens (token/state/accessibility coverage, design ambiguity, traceability) and edit it |

### specops-skills: legacy migration

A SpecOps pipeline for migrating legacy code: analyze the source into implementation-agnostic specs, harden and reconcile them, derive deterministic implementation specs, generate code, and verify the result preserves original behavior.

| Skill | Command | Purpose |
|---|---|---|
| **specops-initial-plan** | `/specops-initial-plan [scope]` | Create a generalized SpecOps analysis and initial implementation-agnostic plan |
| **specops-refactor-plan** | `/specops-refactor-plan [target-folder] [refactor-goal]` | Create a refactor-focused SpecOps plan for an existing source folder and explicit goal |
| **specops-analysis** | `/specops-analysis [scope]` | Produce a generalized SpecOps implementation-agnostic analysis/specification |
| **specops-orchestrate-analysis** | `/specops-orchestrate-analysis [initial-plan]` | Orchestrate sequential subagents that generate one analysis per target from an initial plan |
| **specops-ambiguity-audit** | `/specops-ambiguity-audit [analysis-file]` | Audit a SpecOps analysis spec for ambiguities, resolve them via parallel legacy-source research, and patch the spec |
| **specops-spec-coherence** | `/specops-spec-coherence [analysis-dir]` | Audit a set of analysis specs for cross-spec coherence (dependency order, integration contracts, shared models, terminology) and patch gaps |
| **specops-make-spec** | `/specops-make-spec [scope]` | Convert SpecOps analysis into a generalized deterministic implementation spec |
| **specops-orchestrate-spec-create** | `/specops-orchestrate-spec-create [analysis-files-or-dir]` | Orchestrate sequential subagents that generate one spec per analysis file |
| **specops-spec-conformance** | `/specops-spec-conformance [analysis-spec] [implementation-spec]` | Audit an implementation spec against its source analysis spec for dropped or weakened behavior and patch the implementation spec |
| **specops-run-spec** | `/specops-run-spec [spec-file]` | Implement every step in a SpecOps implementation spec via sequential subagents, committing each independently |
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

There is no separate `design-spec-skills` archive. The design-spec skills ship inside `spec-skills` because they write the same `spec.md` contract and then hand off to `spec-criteria`, `spec-run`, `spec-audit`, and `spec-remediate`.

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
| **design-align** | `/design-align [path-to-top-level-component]` | Audit a React component tree against the FirstWho design system and recommend Tailwind CSS corrections |
| **form-modernizer** | `/form-modernizer [FormComponentPath]` | Modernize a form via multi-phase analysis, redesign, TypeScript typing, and visual verification |
| **angular-pr-complexity** | `/angular-pr-complexity <commit-hash>` | Score an Angular/Nx merge commit on size, spread, file types, and cognitive load |
| **bun-test-fix** | `/bun-test-fix <path-to-test-file>` | Bring a test file into compliance with Bun test rules from `AGENTS.md` |
| **skill-factory** | `/skill-factory [description of task to automate]` | Create a reusable skill by extracting an existing repository workflow into a grounded `SKILL.md` |
| **commit** | `/commit [issue]` | Conventional commit of staged files |
| **pr** | `/pr [issue]` | Commit, push, and open a pull request |
| **pr-review** | `/pr-review [pr]` | Review a PR's code and submit comments |
| **pr-feedback** | `/pr-feedback [pr]` | Address PR review comments one by one |

## Rules

Design and copy guidance applied to frontend and UX work. Files in `rules/` are symlinked into harness-specific rule/guide directories.

| File | Scope |
|---|---|
| `functionalist-design.md` | Functional surfaces: layout, typography, color, data-ink restraint |
| `expressive-design.md` | Expressive surfaces: brand/marketing direction, distinctive type, atmosphere, motion |
| `form-design.md` | Form structure, labels, validation |
| `table-row-design.md` | Table layout, alignment, row interaction |
| `cta-design.md` | Button wording, hierarchy, accessibility |
| `ux-states.md` | Required states for data-driven views (empty, loading, error, partial, ideal) |

## Agent Instructions

Each agent reads a global instruction file from its own config directory. The canonical source lives here and is copied during sync.

| Source | Destination |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `opencode/opencode.jsonc` | `~/.config/opencode/opencode.jsonc` |
| `skills/*/SKILL.md` | Harness skill directories when needed; Augment also discovers `~/.agents/skills/` natively |
| `augment/agents/*.md` | `~/.augment/agents/*.md` |

### OpenCode permissions

Claude Code and Codex both expose a runtime switch to eliminate every permission
prompt for a session — `claude --dangerously-skip-permissions` and
`codex --dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). OpenCode has
no equivalent flag: the only way to run it without approval prompts is to declare
it in config. `opencode/opencode.jsonc` is that config, kept here as the source
of truth and synced to `~/.config/opencode/opencode.jsonc`.

It sets every permission to `allow`. The prompts that are easy to miss are not
bash patterns — reading `~/.agents/rules` and writing `/tmp` are gated by
`external_directory`, which defaults to `ask` for any path outside the project
directory OpenCode was launched in. The two `deny` bash patterns (`mkfs`, `dd`)
block silently rather than prompting, as a safety net against unrecoverable disk
wipes; remove them for unrestricted allow.

## Repository Layout & Sync

```
~/.agents/
├── sync.sh        # Sync instructions, rules, skills, and adapters
├── augment/       # Augment-specific adapter files, such as CLI subagents
├── skills/        # Agent Skills / slash-command skills
├── rules/         # Design and copy guidance (symlinked into each agent)
├── claude/        # Claude Code global instructions → ~/.claude/CLAUDE.md
├── codex/         # Codex global instructions → ~/.codex/AGENTS.md
├── opencode/      # OpenCode permission config → ~/.config/opencode/opencode.jsonc
└── scripts/       # Bundle build script
```

Run `sync.sh` after any change to instructions, rules, or skills:

```bash
~/.agents/sync.sh
```

This copies instruction files, refreshes rule symlinks, syncs skills where needed, prunes stale skill symlinks after renames, and syncs harness adapters such as Augment CLI agents. Each target directory is only updated if it already exists.

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
