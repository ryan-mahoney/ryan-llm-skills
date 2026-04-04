#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/.agents"

# Claude Code: instructions, rule symlinks, and skill symlinks
if [ -d "$HOME/.claude" ]; then
  cp "$AGENTS_DIR/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  mkdir -p "$HOME/.claude/rules"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.claude/rules/$(basename "$f")"
  done
  mkdir -p "$HOME/.claude/skills"
  for d in "$AGENTS_DIR/skills/"*/; do
    skill="$(basename "$d")"
    ln -sfn "$d" "$HOME/.claude/skills/$skill"
  done
  echo "Synced Claude Code instructions, rules, and skills."
fi

# Codex: instructions, guide symlinks, and skill symlinks
if [ -d "$HOME/.codex" ]; then
  cp "$AGENTS_DIR/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
  mkdir -p "$HOME/.codex/guides"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.codex/guides/$(basename "$f")"
  done
  mkdir -p "$HOME/.codex/skills"
  for d in "$AGENTS_DIR/skills/"*/; do
    skill="$(basename "$d")"
    ln -sfn "$d" "$HOME/.codex/skills/$skill"
  done
  echo "Synced Codex instructions, guides, and skills."
fi

# Cline: skill symlinks
if [ -d "$HOME/.cline" ]; then
  mkdir -p "$HOME/.cline/skills"
  for d in "$AGENTS_DIR/skills/"*/; do
    skill="$(basename "$d")"
    target="$HOME/.cline/skills/$skill"
    # Remove stale target (old SKILL.md-only dirs or broken symlinks)
    if [ -d "$target" ] && [ ! -L "$target" ]; then
      rm -rf "$target"
    fi
    ln -sfn "$d" "$target"
  done
  echo "Synced Cline skills."
fi

# Augment: skill symlinks
if [ -d "$HOME/.augment" ]; then
  mkdir -p "$HOME/.augment/skills"
  for d in "$AGENTS_DIR/skills/"*/; do
    skill="$(basename "$d")"
    target="$HOME/.augment/skills/$skill"
    # Remove stale target (old SKILL.md-only dirs or broken symlinks)
    if [ -d "$target" ] && [ ! -L "$target" ]; then
      rm -rf "$target"
    fi
    ln -sfn "$d" "$target"
  done
  echo "Synced Augment skills."
fi

# OpenCode: rule symlinks and skill symlinks
if [ -d "$HOME/.opencode" ]; then
  mkdir -p "$HOME/.opencode/rules"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.opencode/rules/$(basename "$f")"
  done
  mkdir -p "$HOME/.opencode/skills"
  for d in "$AGENTS_DIR/skills/"*/; do
    skill="$(basename "$d")"
    target="$HOME/.opencode/skills/$skill"
    if [ -d "$target" ] && [ ! -L "$target" ]; then
      rm -rf "$target"
    fi
    ln -sfn "$d" "$target"
  done
  echo "Synced OpenCode rules and skills."
fi
