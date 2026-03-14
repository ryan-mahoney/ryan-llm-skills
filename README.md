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
| **spec** | `/spec [issue]` | Write an implementation spec to a GitHub issue |
| **review** | `/review <issue>` | Review a spec for gaps, then edit the issue |
| **branch** | `/branch <issue>` | Create a local branch from a GitHub issue |
| **run** | `/run <issue> <step(s)>` | Implement specific steps from a spec |
| **run-agents** | `/run-agents <issue>` | Implement all steps, one subagent per step |
| **commit** | `/commit [issue]` | Conventional commit of staged files |
| **pr** | `/pr [issue]` | Commit, push, and open a pull request |
| **pr-review** | `/pr-review [pr]` | Review a PR's code and submit comments |
| **pr-feedback** | `/pr-feedback [pr]` | Address PR review comments one by one |
| **specops-initial-plan** | `/specops-initial-plan [scope]` | Create a generalized SpecOps analysis and initial implementation-agnostic plan |
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
