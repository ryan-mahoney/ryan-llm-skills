# LLM Skills & Rules

Shared configuration for LLM coding agents (Claude Code, Codex, Augment, Cline, OpenCode). Contains reusable skills, design rules, optional harness adapters, and per-agent instruction files.

## Structure

```
~/.agents/
├── sync.sh        # Sync instructions, rules, skills, and adapters
├── augment/       # Augment-specific adapter files, such as CLI subagents
├── skills/        # Agent Skills / slash-command skills
├── rules/         # Design and copy guidance (symlinked into each agent)
├── claude/        # Claude Code global instructions → ~/.claude/CLAUDE.md
└── codex/         # Codex global instructions → ~/.codex/AGENTS.md
```

## Skills

Skills are slash commands that automate common development workflows. Each skill lives in `skills/<name>/SKILL.md` and uses the Agent Skills format.

Spec-driven development skills use `.specs/<feature-slug>/` as the local source of truth. GitHub issues are optional mirrors only when the current repository is hosted on GitHub and `gh` is authenticated.

| Skill | Command | Purpose |
|---|---|---|
| **agents-update** | `/agents-update [path-or-scope]` | Analyze a repository's architecture and generate or update `AGENTS.md` for coding agents and contributors |
| **identify-where** | `/identify-where [plain-language functionality] [optional scope]` | Locate the top-level file(s) where a described behavior or feature likely lives |
| **feature-list** | `/feature-list [target-scope]` | Produce a language-agnostic inventory of user- and operator-facing features grouped by capability, with entry points and supporting modules |
| **spec-architect-initial** | `/spec-architect-initial [problem-or-feature]` | Review the existing system architecture and write `.specs/<slug>/proposal.md`, or explain why the request does not fit |
| **architect-inspect** | `/architect-inspect [top-level-file] [optional output path]` | Inspect and describe current architecture around a specific feature/component entry file |
| **spec-architect-critics** | `/spec-architect-critics [proposal-or-file]` | Stress-test `.specs/<slug>/proposal.md` using expert or expert-lens critique and write `.specs/<slug>/critique.md` |
| **controller-refactor-plan** | `/controller-refactor-plan [path to controller file] [optional output markdown path]` | Analyze one controller file for dead handlers and responsibility growth beyond controller boundaries |
| **ux-auditor** | `/ux-auditor [prototype html] [component file]` | Audit UI implementation parity against an HTML prototype and produce a grouped correction checklist |
| **design-align** | `/design-align [path-to-top-level-component]` | Audit a React component tree against the FirstWho design system and recommend Tailwind CSS corrections |
| **form-modernizer** | `/form-modernizer [FormComponentPath]` | Modernize a form via multi-phase analysis, redesign, TypeScript typing, and visual verification |
| **angular-pr-complexity** | `/angular-pr-complexity <commit-hash>` | Score an Angular/Nx merge commit on size, spread, file types, and cognitive load |
| **bun-test-fix** | `/bun-test-fix <path-to-test-file>` | Bring a test file into compliance with Bun test rules from `AGENTS.md` |
| **spec-write** | `/spec-write [feature-slug-or-issue]` | Write `.specs/<slug>/spec.md` and optionally mirror it to a GitHub issue |
| **spec-review** | `/spec-review [feature-slug-or-spec-path]` | Review a local spec for gaps, edit `spec.md`, and optionally mirror changes to GitHub |
| **spec-criteria** | `/spec-criteria [feature-slug-or-spec-path]` | Compile a frozen spec's normative prose into an executable conformance checklist under `.specs/<slug>/criteria/`, blind to the implementation, accumulating cross-phase invariants in `invariants.md` |
| **spec-branch** | `/spec-branch [description-or-feature-slug]` | Create a local branch from a spec, description, or issue/ticket reference |
| **spec-branch-worktree** | `/spec-branch-worktree [description-or-feature-slug]` | Create a named branch and git worktree, copy the spec folder, then open VSCode |
| **spec-run** | `/spec-run [feature-slug-or-spec-path]` | Implement all steps from `spec.md`, one subagent per step when supported |
| **spec-audit** | `/spec-audit [feature-slug-or-spec-path]` | Execute the frozen conformance checklist against the implementation diff; PASS/VIOLATION/UNVERIFIABLE per criterion with evidence, report-only |
| **spec-remediate** | `/spec-remediate [feature-slug-or-spec-path]` | Fix audit VIOLATIONs with one smart subagent per finding, converging code back to the frozen spec, then re-audit until clean; escalates spec/criteria defects |
| **skill-factory** | `/skill-factory [description of task to automate]` | Create a reusable skill by extracting an existing repository workflow into a grounded `SKILL.md` |
| **commit** | `/commit [issue]` | Conventional commit of staged files |
| **pr** | `/pr [issue]` | Commit, push, and open a pull request |
| **pr-review** | `/pr-review [pr]` | Review a PR's code and submit comments |
| **pr-feedback** | `/pr-feedback [pr]` | Address PR review comments one by one |
| **specops-initial-plan** | `/specops-initial-plan [scope]` | Create a generalized SpecOps analysis and initial implementation-agnostic plan |
| **specops-refactor-plan** | `/specops-refactor-plan [target-folder] [refactor-goal]` | Create a refactor-focused SpecOps plan for an existing source folder and explicit goal |
| **specops-analysis** | `/specops-analysis [scope]` | Produce a generalized SpecOps implementation-agnostic analysis/specification |
| **specops-make-spec** | `/specops-make-spec [scope]` | Convert SpecOps analysis into a generalized deterministic implementation spec |
| **specops-orchestrate-analysis** | `/specops-orchestrate-analysis [initial-plan]` | Orchestrate sequential subagents that generate one analysis per target from an initial plan |
| **specops-orchestrate-spec-create** | `/specops-orchestrate-spec-create [analysis-files-or-dir]` | Orchestrate sequential subagents that generate one spec per analysis file |
| **specops-ambiguity-audit** | `/specops-ambiguity-audit [analysis-file]` | Audit a SpecOps analysis spec for ambiguities, resolve them via parallel legacy-source research, and patch the spec |
| **specops-spec-coherence** | `/specops-spec-coherence [analysis-dir]` | Audit a set of analysis specs for cross-spec coherence (dependency order, integration contracts, shared models, terminology) and patch gaps |
| **specops-spec-conformance** | `/specops-spec-conformance [analysis-spec] [implementation-spec]` | Audit an implementation spec against its source analysis spec for dropped or weakened behavior and patch the implementation spec |
| **specops-contract-tests** | `/specops-contract-tests [analysis-file]` | Generate a framework-agnostic pytest contract test file from a SpecOps analysis |
| **specops-integration-test** | `/specops-integration-test [analysis-dir] [migrated-folder]` | Generate integration tests for normative cross-module pathways discovered from analysis specs and the migrated call graph, reusing existing unit-test mocks |
| **specops-implementation-drift** | `/specops-implementation-drift [migrated-folder] [original-analysis]` | Re-analyze migrated code, diff against the original analysis, and produce corrective specs for each behavioral divergence |

## Rules

Design and copy guidance applied to frontend and UX work. Files in `rules/` are symlinked into harness-specific rule/guide directories.

| File | Scope |
|---|---|
| `functionalist-design.md` | Layout, typography, color, visual design |
| `form-design.md` | Form structure, labels, validation |
| `table-row-design.md` | Table layout, alignment, row interaction |
| `cta-design.md` | Button wording, hierarchy, accessibility |

## Agent Instructions

Each agent reads a global instruction file from its own config directory. The canonical source lives here and is copied during sync.

| Source | Destination |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `skills/*/SKILL.md` | Harness skill directories when needed; Augment also discovers `~/.agents/skills/` natively |
| `augment/agents/*.md` | `~/.augment/agents/*.md` |

## Setup

Run `sync.sh` after any changes to instructions, rules, or guides:

```bash
~/.agents/sync.sh
```

This copies instruction files, refreshes rule symlinks, syncs skills where needed, prunes stale skill symlinks after renames, and syncs harness adapters such as Augment CLI agents. Each target directory is only updated if it already exists.

## Distribution Bundles

Build portable installable skill bundles with:

```bash
scripts/build-skill-bundles.sh
```

This produces:

- `dist/skill-bundles/spec-skills-<version>.tar.gz`
- `dist/skill-bundles/spec-skills-<version>.zip`
- `dist/skill-bundles/specops-skills-<version>.tar.gz`
- `dist/skill-bundles/specops-skills-<version>.zip`

Each archive contains a `skills/` directory, `bundle.json`, `README.md`, and `install.sh`. The `spec-skills` bundle also includes the Augment CLI subagent adapter under `augment/agents/`.

Use `VERSION=<release>` to control the archive name and bundle metadata:

```bash
VERSION=2026.06.11 scripts/build-skill-bundles.sh
```

Generated bundle artifacts live under `dist/` and are ignored by git.

Pushing a `v*` tag runs the GitHub Actions release workflow, builds both
archives for each bundle, generates `SHA256SUMS`, and attaches the files to the
GitHub Release:

```bash
git tag v2026.06.11
git push origin v2026.06.11
```

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

## Code Review (Optional): roborev

`roborev` adds automated post-commit review for agent-driven workflows, so issues are surfaced right after commits instead of later in PR review.

Install `roborev` globally (Homebrew recommended):

```bash
brew install roborev-dev/tap/roborev
```

Optional install alternatives:

```bash
curl -fsSL https://roborev.io/install.sh | bash
go install github.com/roborev-dev/roborev/cmd/roborev@latest
```

Global vs per-repo setup:

- Global defaults/config live in `~/.roborev/config.toml`
- Each repository still needs `roborev init` once to install git hooks

Quick start:

```bash
# one-time global setup
brew install roborev-dev/tap/roborev
roborev config set default_agent codex --global

# per repository
cd /path/to/repo
roborev init
```

Optional global auto-fix loop on failed reviews:

```toml
# ~/.roborev/config.toml
[[hooks]]
event = "review.completed"
command = "test {verdict} = F && roborev refine --max-iterations 5"
```

This runs an iterative fix + re-review loop when a review fails.
