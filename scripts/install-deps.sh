#!/usr/bin/env bash
# Install the locked local dependencies for this checkout's runnable packages.
#
# The Pi execution extension and the Jev tool import npm packages directly, so a
# fresh clone that has only been linked (via sync.sh) has no node_modules and the
# extensions fail to load. This script closes that gap using each package's own
# committed lockfile.
#
# Idempotent: a package whose node_modules already exists is skipped unless
# --force is passed. A missing toolchain (npm/bun) is reported and skipped, never
# fatal; a present toolchain that fails to install is a real error.
set -euo pipefail

AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: install-deps.sh [--force]"
      echo "Install locked dependencies for the Pi extension, Jev, and optional repo-search."
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

install_npm() {
  local name="$1" dir="$2"
  if [ ! -f "$dir/package-lock.json" ]; then
    echo "skip  $name (no committed package-lock.json)"
    return 0
  fi
  if [ "$FORCE" -eq 0 ] && [ -d "$dir/node_modules" ]; then
    echo "ok    $name (already installed; use --force to refresh)"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "warn  $name: npm not found; install with: npm ci --prefix $dir --ignore-scripts" >&2
    return 0
  fi
  echo "npm   $name"
  npm ci --prefix "$dir" --ignore-scripts --no-audit --no-fund
}

install_bun() {
  local name="$1" dir="$2"
  if [ ! -f "$dir/bun.lock" ]; then
    echo "skip  $name (no committed bun.lock)"
    return 0
  fi
  if [ "$FORCE" -eq 0 ] && [ -d "$dir/node_modules" ]; then
    echo "ok    $name (already installed; use --force to refresh)"
    return 0
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "warn  $name: bun not found; install with: (cd $dir && bun install --frozen-lockfile)" >&2
    return 0
  fi
  echo "bun   $name"
  ( cd "$dir" && bun install --frozen-lockfile )
}

# Required by the Pi step runtime (chokidar) and by the review/verification skills.
install_npm "pi/extensions/spec-runtime" "$AGENTS_DIR/pi/extensions/spec-runtime"
install_npm "scripts/jev" "$AGENTS_DIR/scripts/jev"
# Optional: only used when the local repo-search skill is enabled.
install_bun "scripts/repo-search" "$AGENTS_DIR/scripts/repo-search"

echo "Local dependencies are ready."
