#!/usr/bin/env bash
# Refuses a deploy whose tree is missing a file that HEAD says should be there.
#
# This exists because a clean `git status` is not proof the files are on disk.
# A detached worktree created for a deploy came up reporting no changes while
# web/vendor/chart.umd.js was simply absent, so Cloud Build packaged an image
# with no charting library and the market dashboard 404'd in production. Nothing
# failed: the build was green, the site served, and only the browser console
# knew. `git status` compares the index to the worktree and a stat-cache entry
# can claim a file is unchanged when it is gone.
#
# Run from the tree that is about to be uploaded.
set -uo pipefail

missing=0
while IFS= read -r f; do
  [ -e "$f" ] || { echo "MISSING: $f"; missing=$((missing + 1)); }
done < <(git ls-tree -r HEAD --name-only)

if [ "$missing" -gt 0 ]; then
  echo "refusing to deploy: $missing tracked file(s) absent from this tree"
  echo "recover with: git checkout -- ."
  exit 1
fi

# The browser needs these specifically, and each one fails silently: a missing
# script is a console 404 on a page that still renders.
for f in web/index.html web/app.js web/app.css web/vendor/chart.umd.js; do
  [ -s "$f" ] || { echo "refusing to deploy: $f is missing or empty"; exit 1; }
done

echo "deploy tree OK: $(git ls-tree -r HEAD --name-only | wc -l) tracked files present"
