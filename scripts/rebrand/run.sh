#!/usr/bin/env bash
# The one-off mechanical pass of the rebrand to "Clarae notanda" (ADR-0052, M17-F1).
#
#   scripts/rebrand/run.sh
#
# On a tree with no change to tracked files it
#  1. renames the old product name in content and paths (rename.mjs), except where allowlist.tsv allows it;
#  2. formats what moved (9 -> 6 letters shifts aligned columns and Markdown tables);
#  3. relinks the workspaces and regenerates the generated code (`task gen`), which is never edited by hand;
#  4. runs the guard (check.mjs).
# What it leaves in the working tree is the mechanical commit: running it again on the parent commit gives the
# same diff. The compatibility with data and clients of 1.x is NOT part of it (M17, F2 and F3). Verify with
# `task check-gen` and `task ci` before committing.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"
cd "$ROOT"

for tool in git node yarn go task golangci-lint buf sqlc oapi-codegen; do need "$tool"; done
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "tracked files have changes: commit or stash them first"

log "renaming content and paths"
node scripts/rebrand/rename.mjs

log "formatting Go"
for m in shared/go services/cloud apps/desktop; do (cd "$m" && golangci-lint fmt ./...); done
gofmt -w tools scripts

log "linking the renamed workspaces"
yarn install

log "regenerating the generated code"
(cd tools/release && GOWORK=off go mod tidy)
rm -rf packages/workbench/wailsjs build/wasm bin apps/desktop/build/bin
task gen
node scripts/parity.mjs

log "formatting the rest"
git diff --name-only --diff-filter=ACMR -z | xargs -0 yarn prettier --write --ignore-unknown --log-level warn

log "guard"
node scripts/rebrand/check.mjs
ok "renamed: now run 'task check-gen' and 'task ci'"
