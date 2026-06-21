#!/usr/bin/env bash
# lint-skills.sh — structural frontmatter checks for skills/*/SKILL.md
#
# Blocking errors (deterministic, universal invariants):
#   - frontmatter block present and closed (`---` … `---`)
#   - `name:` present and equal to the skill's directory name
#   - non-empty `description:`
#   - `version:` present (under metadata)
#
# Advisory warnings (intent-dependent — never block):
#   - missing `disable-model-invocation:`  (omitted on purpose by model-invocable skills)
#   - missing `argument-hint:`             (omitted on purpose by skills that take no args)
#
# Usage:
#   scripts/lint-skills.sh            # check staged SKILL.md files (pre-commit)
#   scripts/lint-skills.sh --all      # check every skills/*/SKILL.md
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-staged}"

# Collect the SKILL.md files to check.
files=()
if [ "$mode" = "--all" ]; then
  while IFS= read -r f; do files+=("$f"); done < <(find skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort)
else
  # Staged additions/modifications only — legacy skills are grandfathered until touched.
  while IFS= read -r f; do
    case "$f" in
      skills/*/SKILL.md) [ -f "$f" ] && files+=("$f") ;;
    esac
  done < <(git diff --cached --name-only --diff-filter=ACM)
fi

if [ "${#files[@]}" -eq 0 ]; then
  exit 0
fi

errors=0
warnings=0

# Print the value of a top-level frontmatter key (first match, column 0).
frontmatter_value() {
  awk -F': ' -v key="$1" '
    $0 == "---" { seen++; if (seen == 2) exit; next }
    seen == 1 && $0 ~ "^" key ":" { sub("^" key ": *", ""); gsub(/^"|"$/, ""); print; exit }
  ' "$2"
}

for f in "${files[@]}"; do
  dir="$(basename "$(dirname "$f")")"

  # Frontmatter must open on line 1 and close with a second `---`.
  if [ "$(head -n 1 "$f")" != "---" ] || [ "$(grep -c '^---$' "$f")" -lt 2 ]; then
    echo "ERROR  $f: missing or unclosed YAML frontmatter block"
    errors=$((errors + 1))
    continue
  fi

  name="$(frontmatter_value name "$f")"
  if [ -z "$name" ]; then
    echo "ERROR  $f: frontmatter has no 'name:'"
    errors=$((errors + 1))
  elif [ "$name" != "$dir" ]; then
    echo "ERROR  $f: name '$name' does not match directory '$dir'"
    errors=$((errors + 1))
  fi

  if [ -z "$(frontmatter_value description "$f")" ]; then
    echo "ERROR  $f: empty or missing 'description:'"
    errors=$((errors + 1))
  fi

  if ! grep -Eq '^[[:space:]]*version:' "$f"; then
    echo "ERROR  $f: no 'version:' in metadata"
    errors=$((errors + 1))
  fi

  if ! grep -q '^disable-model-invocation:' "$f"; then
    echo "warn   $f: no 'disable-model-invocation:' — intentional only if this skill is meant to be model-invocable"
    warnings=$((warnings + 1))
  fi
  if ! grep -q '^argument-hint:' "$f"; then
    echo "warn   $f: no 'argument-hint:' — intentional only if this skill takes no arguments"
    warnings=$((warnings + 1))
  fi
done

echo "lint-skills: checked ${#files[@]} file(s), $errors error(s), $warnings warning(s)"
[ "$errors" -eq 0 ]
