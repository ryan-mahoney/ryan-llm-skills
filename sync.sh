#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/.agents"
SYNC_AUGMENT="${SYNC_AUGMENT:-0}"

sync_dir_symlinks() {
  local source_dir="$1"
  local target_dir="$2"

  mkdir -p "$target_dir"

  # Remove stale symlinks that point back into this source tree but whose source
  # no longer exists. This keeps renamed skills from leaving old slash commands.
  for target in "$target_dir"/*; do
    [ -L "$target" ] || continue
    local link
    link="$(readlink "$target")"
    case "$link" in
      "$source_dir"/*)
        [ -e "$target" ] || rm -f "$target"
        ;;
    esac
  done

  for d in "$source_dir"/*/; do
    [ -d "$d" ] || continue
    local name
    name="$(basename "$d")"
    local target="$target_dir/$name"
    if [ -d "$target" ] && [ ! -L "$target" ]; then
      rm -rf "$target"
    fi
    ln -sfn "$d" "$target"
  done
}

sync_file_symlinks() {
  local source_dir="$1"
  local target_dir="$2"

  [ -d "$source_dir" ] || return 0
  mkdir -p "$target_dir"

  for target in "$target_dir"/*; do
    [ -L "$target" ] || continue
    local link
    link="$(readlink "$target")"
    case "$link" in
      "$source_dir"/*)
        [ -e "$target" ] || rm -f "$target"
        ;;
    esac
  done

  for f in "$source_dir"/*; do
    [ -f "$f" ] || continue
    ln -sfn "$f" "$target_dir/$(basename "$f")"
  done
}

# Claude Code: instructions, rule symlinks, and skill symlinks
if [ -d "$HOME/.claude" ]; then
  cp "$AGENTS_DIR/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  mkdir -p "$HOME/.claude/rules"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.claude/rules/$(basename "$f")"
  done
  sync_dir_symlinks "$AGENTS_DIR/skills" "$HOME/.claude/skills"
  echo "Synced Claude Code instructions, rules, and skills."
fi

# Codex: instructions, guide symlinks, and skill symlinks
if [ -d "$HOME/.codex" ]; then
  cp "$AGENTS_DIR/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
  mkdir -p "$HOME/.codex/guides"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.codex/guides/$(basename "$f")"
  done
  sync_dir_symlinks "$AGENTS_DIR/skills" "$HOME/.codex/skills"
  echo "Synced Codex instructions, guides, and skills."
fi

# Cline: skill symlinks
if [ -d "$HOME/.cline" ]; then
  sync_dir_symlinks "$AGENTS_DIR/skills" "$HOME/.cline/skills"
  echo "Synced Cline skills."
fi

# Augment: skills and CLI subagent configs.
#
# Augment discovers ~/.agents/skills natively in current clients, but CLI
# subagents still live under ~/.augment/agents. Set SYNC_AUGMENT=1 to bootstrap
# those user-level Augment config dirs even before Augment has created them.
if [ -d "$HOME/.augment" ] || [ "$SYNC_AUGMENT" = "1" ]; then
  # Augment now discovers ~/.agents/skills natively, but this mirror keeps older
  # clients working and prunes stale aliases after skill renames.
  sync_dir_symlinks "$AGENTS_DIR/skills" "$HOME/.augment/skills"
  sync_file_symlinks "$AGENTS_DIR/augment/agents" "$HOME/.augment/agents"
  echo "Synced Augment skills and agents."
fi

# OpenCode: rule symlinks and skill symlinks
if [ -d "$HOME/.opencode" ]; then
  mkdir -p "$HOME/.opencode/rules"
  for f in "$AGENTS_DIR/rules/"*; do
    ln -sfn "$f" "$HOME/.opencode/rules/$(basename "$f")"
  done
  sync_dir_symlinks "$AGENTS_DIR/skills" "$HOME/.opencode/skills"
  echo "Synced OpenCode rules and skills."
fi

# OpenCode permission config. Unlike Claude Code and Codex, OpenCode has no
# runtime flag to skip permission prompts, so the "allow everything" posture
# must live in config. Copy it to the live global config path if it exists.
if [ -d "$HOME/.config/opencode" ]; then
  cp "$AGENTS_DIR/opencode/opencode.jsonc" "$HOME/.config/opencode/opencode.jsonc"
  echo "Synced OpenCode permission config."
fi
