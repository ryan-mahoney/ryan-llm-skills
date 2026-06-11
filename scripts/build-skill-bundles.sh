#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${DIST:-$ROOT/dist/skill-bundles}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || date +%Y%m%d%H%M%S)}"

mkdir -p "$DIST"

copy_skill() {
  local bundle_dir="$1"
  local skill="$2"
  local src="$ROOT/skills/$skill"

  if [ ! -f "$src/SKILL.md" ]; then
    echo "ERROR: missing skill: $skill" >&2
    exit 1
  fi

  mkdir -p "$bundle_dir/skills"
  cp -R "$src" "$bundle_dir/skills/$skill"
}

copy_file() {
  local bundle_dir="$1"
  local src_rel="$2"
  local dest_rel="$3"
  local src="$ROOT/$src_rel"

  if [ ! -f "$src" ]; then
    echo "ERROR: missing adapter: $src_rel" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$bundle_dir/$dest_rel")"
  cp "$src" "$bundle_dir/$dest_rel"
}

write_install_script() {
  local bundle_dir="$1"

  cat > "$bundle_dir/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail

TARGET="agents"
MODE="copy"

usage() {
  cat <<'USAGE'
Usage: ./install.sh [--target agents|claude|codex|augment|opencode|cline|all] [--mode copy|link]

Targets:
  agents    Install skills to ~/.agents/skills (default, portable)
  claude    Install skills to ~/.claude/skills
  codex     Install skills to ~/.codex/skills
  augment   Install skills to ~/.augment/skills and agents to ~/.augment/agents
  opencode  Install skills to ~/.opencode/skills
  cline     Install skills to ~/.cline/skills
  all       Install to ~/.agents/skills and any existing harness config dirs

Modes:
  copy      Copy bundle files into the target directory (default)
  link      Symlink target entries to this extracted bundle directory
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  copy|link) ;;
  *)
    echo "ERROR: --mode must be copy or link" >&2
    exit 1
    ;;
esac

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install_entry() {
  local src="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"
  if [ "$MODE" = "link" ]; then
    rm -rf "$dest"
    ln -sfn "$src" "$dest"
  else
    rm -rf "$dest"
    if [ -d "$src" ]; then
      mkdir -p "$dest"
      cp -R "$src/." "$dest/"
    else
      cp "$src" "$dest"
    fi
  fi
}

install_skills_to() {
  local target_dir="$1"

  if [ ! -d "$BUNDLE_DIR/skills" ]; then
    return 0
  fi

  mkdir -p "$target_dir"
  for skill_dir in "$BUNDLE_DIR/skills"/*/; do
    [ -d "$skill_dir" ] || continue
    install_entry "$skill_dir" "$target_dir/$(basename "$skill_dir")"
  done
}

install_augment_agents_to() {
  local target_dir="$1"

  if [ ! -d "$BUNDLE_DIR/augment/agents" ]; then
    return 0
  fi

  mkdir -p "$target_dir"
  for agent_file in "$BUNDLE_DIR/augment/agents"/*.md; do
    [ -f "$agent_file" ] || continue
    install_entry "$agent_file" "$target_dir/$(basename "$agent_file")"
  done
}

install_target() {
  case "$1" in
    agents)
      install_skills_to "$HOME/.agents/skills"
      ;;
    claude)
      install_skills_to "$HOME/.claude/skills"
      ;;
    codex)
      install_skills_to "$HOME/.codex/skills"
      ;;
    augment)
      install_skills_to "$HOME/.augment/skills"
      install_augment_agents_to "$HOME/.augment/agents"
      ;;
    opencode)
      install_skills_to "$HOME/.opencode/skills"
      ;;
    cline)
      install_skills_to "$HOME/.cline/skills"
      ;;
    all)
      install_target agents
      [ -d "$HOME/.claude" ] && install_target claude
      [ -d "$HOME/.codex" ] && install_target codex
      [ -d "$HOME/.augment" ] && install_target augment
      [ -d "$HOME/.opencode" ] && install_target opencode
      [ -d "$HOME/.cline" ] && install_target cline
      ;;
    *)
      echo "ERROR: unknown target: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

install_target "$TARGET"
echo "Installed $(basename "$BUNDLE_DIR") to target '$TARGET' using mode '$MODE'."
INSTALL

  chmod +x "$bundle_dir/install.sh"
}

json_array() {
  local first=1
  printf '['
  for item in "$@"; do
    if [ "$first" -eq 0 ]; then
      printf ', '
    fi
    first=0
    printf '"%s"' "$item"
  done
  printf ']'
}

write_bundle_files() {
  local bundle_dir="$1"
  local name="$2"
  local title="$3"
  local description="$4"
  shift 4
  local skills=("$@")

  {
    printf '# %s\n\n' "$title"
    printf '%s\n\n' "$description"
    printf 'Version: `%s`\n\n' "$VERSION"
    printf '## Skills\n\n'
    for skill in "${skills[@]}"; do
      printf '%s\n' "- \`$skill\`"
    done
    if [ -d "$bundle_dir/augment/agents" ]; then
      printf '\n## Augment Agents\n\n'
      for agent in "$bundle_dir/augment/agents"/*.md; do
        [ -f "$agent" ] || continue
        printf '%s\n' "- \`augment/agents/$(basename "$agent")\`"
      done
    fi
    printf '\n## Install\n\n'
    printf '```bash\n./install.sh\n```\n\n'
    printf 'Use `./install.sh --help` for harness-specific targets.\n'
  } > "$bundle_dir/README.md"

  {
    printf '{\n'
    printf '  "name": "%s",\n' "$name"
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "description": "%s",\n' "$description"
    printf '  "skills": '
    json_array "${skills[@]}"
    printf ',\n'
    printf '  "augment_agents": '
    if [ -d "$bundle_dir/augment/agents" ]; then
      local agents=()
      local agent
      for agent in "$bundle_dir/augment/agents"/*.md; do
        [ -f "$agent" ] || continue
        agents+=("augment/agents/$(basename "$agent")")
      done
      json_array "${agents[@]}"
    else
      printf '[]'
    fi
    printf '\n}\n'
  } > "$bundle_dir/bundle.json"
}

build_bundle() {
  local name="$1"
  local title="$2"
  local description="$3"
  shift 3
  local skills=("$@")
  local bundle_dir="$DIST/$name"

  rm -rf "$bundle_dir"
  mkdir -p "$bundle_dir"

  local skill
  for skill in "${skills[@]}"; do
    copy_skill "$bundle_dir" "$skill"
  done

  if [ "$name" = "spec-skills" ]; then
    copy_file "$bundle_dir" "augment/agents/spec-step-implementer.md" "augment/agents/spec-step-implementer.md"
  fi

  write_install_script "$bundle_dir"
  write_bundle_files "$bundle_dir" "$name" "$title" "$description" "${skills[@]}"

  rm -f "$DIST/$name-$VERSION.tar.gz"
  (cd "$DIST" && tar -czf "$name-$VERSION.tar.gz" "$name")
  echo "Built $DIST/$name-$VERSION.tar.gz"

  if command -v zip >/dev/null 2>&1; then
    rm -f "$DIST/$name-$VERSION.zip"
    (cd "$DIST" && zip -qr "$name-$VERSION.zip" "$name")
    echo "Built $DIST/$name-$VERSION.zip"
  else
    echo "Skipped $DIST/$name-$VERSION.zip because zip is not installed" >&2
  fi
}

spec_skills=(
  spec-architect-initial
  spec-architect-critics
  spec-write
  spec-review
  spec-branch
  spec-branch-worktree
  spec-run
  spec-dev-workflow
)

specops_skills=()
while IFS= read -r skill_dir; do
  specops_skills+=("$(basename "$skill_dir")")
done < <(find "$ROOT/skills" -maxdepth 1 -type d -name 'specops-*' | sort)

build_bundle \
  "spec-skills" \
  "Spec Skills" \
  "Local-first spec-driven development workflow skills." \
  "${spec_skills[@]}"

build_bundle \
  "specops-skills" \
  "SpecOps Skills" \
  "SpecOps analysis, implementation-spec, migration, and verification skills." \
  "${specops_skills[@]}"
