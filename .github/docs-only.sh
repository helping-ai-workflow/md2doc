#!/usr/bin/env bash
# Prints docs_only=true to $GITHUB_OUTPUT when a pull request changes nothing
# but README.md, CLAUDE.md and docs/**, so ci.yml and browser.yml can skip
# their install and test steps. The jobs still run and report success: both
# are required checks on main, and a required check that never reports (a
# path-filtered workflow) blocks the merge.
#
# An allow-list, not a deny-list: any other path runs the full suite.
# CHANGELOG.md is deliberately not on it, because editor-client-runtime.test.js
# edits the real CHANGELOG.md as a fixture.
#
# On pull_request the checkout is the PR's merge commit, so HEAD^1 is the tip
# of the base branch and the diff is exactly what the PR changes (needs
# fetch-depth: 2). Anything else (workflow_dispatch) runs the full suite.
set -euo pipefail

docs_only=false
if [ "${EVENT_NAME:-}" = pull_request ]; then
  files=$(git diff --name-only HEAD^1 HEAD)
  echo "changed files:"
  echo "$files"
  if [ -n "$files" ] && ! grep -vqE '^(README\.md|CLAUDE\.md|docs/.+)$' <<<"$files"; then
    docs_only=true
  fi
fi
echo "docs_only=$docs_only"
echo "docs_only=$docs_only" >> "${GITHUB_OUTPUT:-/dev/null}"
