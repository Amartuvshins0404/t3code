#!/usr/bin/env bash
set -euo pipefail

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes. Commit or remove them first." >&2
  exit 1
fi

git fetch --quiet origin main
git fetch --quiet fork amaraa-mode

behind=$(git rev-list --count fork/amaraa-mode..origin/main)
if [ "$behind" -eq 0 ]; then
  echo "Up to date"
  exit 0
fi

branch="sync/upstream-$(date +%F)"
if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
  echo "$branch already exists. Finish or delete it first." >&2
  exit 1
fi
git switch --quiet -c "$branch" fork/amaraa-mode
echo "$behind upstream commits to merge on $branch"

if git merge --quiet --no-ff --no-commit origin/main; then
  echo "Clean merge. Commit it, then run the checks in docs/upstream-sync.md."
  exit 0
fi

echo "Conflicts:"
git diff --name-only --diff-filter=U
exit 2
