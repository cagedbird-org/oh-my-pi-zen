#!/usr/bin/env bash
# Usage: rebase-onto.sh <old-tag> <new-tag> [branch]
# Rebase <branch> (default zen/main, must be checked out) from <old-tag> onto <new-tag>.
# On conflict: print the conflicting files (also to $GITHUB_STEP_SUMMARY), abort, exit 1.
set -euo pipefail
base="$1" next="$2" branch="${3:-zen/main}"
if ! git rebase --onto "$next" "$base" "$branch"; then
	files="$(git diff --name-only --diff-filter=U)"
	git rebase --abort
	{
		echo "### Rebase conflict: $branch onto $next"
		echo '```'
		echo "$files"
		echo '```'
	} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
	exit 1
fi
