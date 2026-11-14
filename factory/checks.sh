#!/usr/bin/env bash
# The project's checks. Exit 0 only when the branch is fit to be reviewed.
# The gate runs the copy of this file from `main`, with the job's worktree as working directory.
# Keep it fast, deterministic and non-interactive: no watch modes, no prompts, no auto-fix.
#
# The installer replaces the failing default below with the project's real commands, e.g.:
#   npm ci --prefer-offline && npm run lint && npm run typecheck && npm test -- --run && npm run build
set -euo pipefail

npm run lint
npm test
