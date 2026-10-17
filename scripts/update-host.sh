#!/usr/bin/env bash
# Update ~/.agents on an execution host over SSH and restart Sentinel.
#
# Runs the documented update (git pull --ff-only, sync.sh, restart spec-sentinel)
# on the host. It refuses to touch a checkout that is not on main or has tracked
# changes, so a failed fast-forward never leaves a half-updated host.
#
# Restarts only spec-sentinel. Terminal services stay up, and interactive Pi
# sessions must be restarted by hand to load extension changes.
set -euo pipefail

HOST="restory-box"
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "Usage: update-host.sh [host]"
      echo "Pull ~/.agents on the host, run sync.sh, and restart spec-sentinel."
      echo "Host defaults to $HOST."
      exit 0
      ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) HOST="$arg" ;;
  esac
done

ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd "$HOME/.agents"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "Refusing to update: checkout is on '$branch', not main." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to update: tracked files have local changes." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

before="$(git rev-parse --short HEAD)"
git pull --ff-only --quiet
after="$(git rev-parse --short HEAD)"

# sync.sh is verbose; show its output only when it fails.
if ! sync_out="$(./sync.sh 2>&1)"; then
  echo "$sync_out" >&2
  echo "sync.sh failed; spec-sentinel was not restarted." >&2
  exit 1
fi

systemctl --user restart spec-sentinel
sleep 3
if ! systemctl --user is-active --quiet spec-sentinel; then
  systemctl --user status spec-sentinel --no-pager >&2 || true
  echo "spec-sentinel is not active after restart." >&2
  exit 1
fi

if [ "$before" = "$after" ]; then
  echo "$(hostname): already at $after; spec-sentinel restarted."
else
  git log --oneline "$before..$after" | head -20
  echo "$(hostname): $before -> $after; spec-sentinel restarted."
fi
REMOTE
