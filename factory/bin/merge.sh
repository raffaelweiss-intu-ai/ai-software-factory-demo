#!/usr/bin/env bash
# Merge a job's PR: sync with the base branch, gate again, then `gh pr merge`.
# The only place that merges. Usage: merge.sh <worktree> <pr-number> <job-report-path>
set -euo pipefail
worktree="$1"; pr="$2"; report="$3"
here="$(cd "$(dirname "$0")" && pwd)"
cd "$worktree"
git fetch origin
git merge --no-edit origin/main
python3 "$here/gate.py" "$worktree" "$report"   # exits 1 on FAIL, which aborts here
gh pr ready "$pr" 2>/dev/null || true   # builders open drafts; a draft cannot be merged
gh pr merge "$pr" --merge
