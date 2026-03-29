# LLM Skills & Rules

Shared configuration for LLM coding agents (Claude Code, Codex, Cline). Contains reusable skills, design rules, and per-agent instruction files.

## Structure

```
~/.agents/
├── sync.sh        # Sync instructions and rules to agent config dirs
├── skills/        # Slash-command skills for Claude Code
├── rules/         # Design and copy guidance (symlinked into each agent)
├── claude/        # Claude Code global instructions → ~/.claude/CLAUDE.md
└── codex/         # Codex global instructions → ~/.codex/AGENTS.md
```

## Skills

Skills are slash commands that automate common development workflows. Each skill lives in `skills/<name>/SKILL.md` and is shared across Claude Code and Cline.

| Skill | Command | Purpose |
|---|---|---|
| **agents-update** | `/agents-update [path-or-scope]` | Analyze a repository's architecture and generate or update `AGENTS.md` for coding agents and contributors |
| **identify-where** | `/identify-where [plain-language functionality] [optional scope]` | Locate the top-level file(s) where a described behavior or feature likely lives |
| **architect-initial** | `/architect-initial [problem-or-feature]` | Review the existing system architecture and propose a compatible implementation approach or explain why it does not fit |
| **architect-inspect** | `/architect-inspect [top-level-file] [optional output path]` | Inspect and describe current architecture around a specific feature/component entry file |
| **architect-critics** | `/architect-critics [proposal-or-file]` | Stress-test a proposal using expert or expert-lens critique and produce prioritized architectural feedback |
| **controller-refactor-plan** | `/controller-refactor-plan [path to controller file] [optional output markdown path]` | Analyze one controller file for dead handlers and responsibility growth beyond controller boundaries |
| **ux-auditor** | `/ux-auditor [prototype html] [component file]` | Audit UI implementation parity against an HTML prototype and produce a grouped correction checklist |
| **spec** | `/spec [issue]` | Write an implementation spec to a GitHub issue |
| **review** | `/review <issue>` | Review a spec for gaps, then edit the issue |
| **branch** | `/branch <issue>` | Create a local branch from a GitHub issue |
| **run** | `/run <issue> <step(s)>` | Implement specific steps from a spec |
| **run-agents** | `/run-agents <issue>` | Implement all steps, one subagent per step |
| **skill-factory** | `/skill-factory [description of task to automate]` | Create a reusable skill by extracting an existing repository workflow into a grounded `SKILL.md` |
| **dev-workflow** | `/dev-workflow [issue]` | Full pipeline: spec → review (Codex) → branch → implement → PR |
| **commit** | `/commit [issue]` | Conventional commit of staged files |
| **pr** | `/pr [issue]` | Commit, push, and open a pull request |
| **pr-review** | `/pr-review [pr]` | Review a PR's code and submit comments |
| **pr-feedback** | `/pr-feedback [pr]` | Address PR review comments one by one |
| **specops-initial-plan** | `/specops-initial-plan [scope]` | Create a generalized SpecOps analysis and initial implementation-agnostic plan |
| **specops-refactor-plan** | `/specops-refactor-plan [target-folder] [refactor-goal]` | Create a refactor-focused SpecOps plan for an existing source folder and explicit goal |
| **specops-analysis** | `/specops-analysis [scope]` | Produce a generalized SpecOps implementation-agnostic analysis/specification |
| **specops-make-spec** | `/specops-make-spec [scope]` | Convert SpecOps analysis into a generalized deterministic implementation spec |
| **specops-orchestrate-analysis** | `/specops-orchestrate-analysis [initial-plan]` | Orchestrate sequential subagents from initial-plan output across analysis and spec phases |
| **specops-orchestrate-spec-create** | `/specops-orchestrate-spec-create [analysis-files-or-dir]` | Orchestrate sequential subagents that generate one spec per analysis file |

## Rules

Design and copy guidance applied to frontend and UX work. Files in `rules/` are symlinked into `~/.claude/rules/` and `~/.codex/guides/`.

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
| `skills/*/SKILL.md` | `~/.cline/skills/*/SKILL.md` (symlinked) |

## Setup

Run `sync.sh` after any changes to instructions, rules, or guides:

```bash
~/.agents/sync.sh
```

This copies instruction files, refreshes rule symlinks, and syncs skills. Each target directory (`~/.claude`, `~/.codex`, `~/.cline`) is only updated if it already exists.

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
