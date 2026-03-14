#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/.agents"

# Claude Code: instructions and rule symlinks
if [ -d "$HOME/.claude" ]; then
  cp "$AGENTS_DIR/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  mkdir -p "$HOME/.claude/rules"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.claude/rules/$(basename "$f")"
  done
  echo "Synced Claude Code instructions and rules."
fi

# Codex: instructions and guide symlinks
if [ -d "$HOME/.codex" ]; then
  cp "$AGENTS_DIR/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
  mkdir -p "$HOME/.codex/guides"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.codex/guides/$(basename "$f")"
  done
  echo "Synced Codex instructions and guides."
fi

# Cline: skill symlinks
if [ -d "$HOME/.cline" ]; then
  mkdir -p "$HOME/.cline/skills"
  for d in "$AGENTS_DIR/skills/"*/; do
    skill="$(basename "$d")"
    target="$HOME/.cline/skills/$skill"

    # If the target skill directory is already a symlink to this source skill
    # directory, skip to avoid creating a self-referential SKILL.md link.
    if [ -L "$target" ]; then
      src_real="$(cd "$d" && pwd -P)"
      tgt_real="$(cd "$target" && pwd -P 2>/dev/null || true)"
      if [ -n "$tgt_real" ] && [ "$src_real" = "$tgt_real" ]; then
        echo "Skipped Cline skill $skill (directory already symlinked to source)."
        continue
      fi
    fi

    mkdir -p "$target"
    ln -sfn "$d/SKILL.md" "$target/SKILL.md"
  done
  echo "Synced Cline skills."
fi
