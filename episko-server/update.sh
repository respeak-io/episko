#!/usr/bin/env bash
# Move a Docker deployment of episko-server to a release tag (the newest by default):
#   ./update.sh [vX.Y.Z]
# Backs up ./data first and keeps the last three backups. See README.md § Update it.
set -euo pipefail

# One function, called on the last line: bash reads a script as it runs, and the checkout
# below rewrites this very file.
main() {
  cd "$(dirname "$0")"

  if [ -n "$(git status --porcelain --untracked-files=no -- .)" ]; then
    git status --short --untracked-files=no -- .
    echo "Tracked files here are modified, so the checkout would fail or carry them along."
    echo "Settings belong in .env (see .env.example), proxy wiring in docker-compose.override.yml."
    echo "Both are untracked. Move your changes there, then: git checkout -- . && ./update.sh"
    exit 1
  fi

  git fetch --tags --quiet origin
  local target=${1:-$(git tag --list 'v*' --sort=-v:refname | head -n1)}
  git rev-parse -q --verify "refs/tags/$target" >/dev/null || { echo "No tag '$target'."; exit 1; }
  local current back
  current=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
  back=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)

  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$target^{commit}")" ]; then
    echo "Already on $target."
    exit 0
  fi

  echo "episko-server: $current -> $target"
  if git merge-base --is-ancestor "$target" HEAD; then
    echo "That is a downgrade. The database is not migrated back; the backup is your way home."
  else
    git --no-pager log --oneline --no-merges HEAD.."$target" -- . ../episko-proto | sed 's/^/  /'
  fi

  # A release never needs a new variable to keep working (README § Configure it): this informs.
  local added v
  added=$(git diff HEAD "$target" -- .env.example | sed -n 's/^+# *\(EPISKO_[A-Z_]*\)=.*/\1/p')
  if [ -n "$added" ]; then
    echo "New settings (described in .env.example):"
    for v in $added; do
      if [ -f .env ] && grep -q "^$v=" .env; then echo "  $v  set in .env"
      else echo "  $v  not set in .env"; fi
    done
  fi
  echo "Release notes: ../CHANGELOG.md, section ${target#v}"

  git -c advice.detachedHead=false checkout --quiet "$target"
  if ! docker compose build; then
    git checkout --quiet "$back"
    echo "Build failed. Back on $current; the running server was not touched."
    exit 1
  fi

  # Stopped rather than removed, so `start` brings the old version back if the copy fails.
  docker compose stop
  local bak="data.bak-$current"
  if [ -d data ]; then
    rm -rf "$bak"
    if ! cp -a data "$bak"; then
      git checkout --quiet "$back"
      docker compose start
      echo "Could not back up data/ (owned by root? try: sudo ./update.sh $target)."
      echo "Back on $current and running."
      exit 1
    fi
    echo "Backed up data/ to $bak"
    ls -1dt data.bak-* | tail -n +4 | while read -r old; do rm -rf "$old"; done
  fi

  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker compose up -d
  for _ in $(seq 20); do
    if docker compose logs --since "$since" episko-server 2>/dev/null | grep -q "listening on"; then
      echo "episko-server $target is up."
      exit 0
    fi
    sleep 1
  done
  docker compose logs --tail 20 episko-server
  echo "Not listening after 20s. To go back: ./update.sh $current (backup: $bak)"
  exit 1
}

main "$@"
