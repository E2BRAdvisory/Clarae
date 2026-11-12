#!/bin/sh
# Fails when a build switch (or the output folder) of the front end is set in the environment of a release build. The esbuild scripts of
# the desktop frontend and of the Web UI read them, so a variable exported in the shell of whoever builds would
# reach the release without a trace:
#
#   MEMOBRAIN_AI           lets the editor ask for the AI assistant (ADR-0050)
#   MEMOBRAIN_COLLAB       puts the collaboration code in the build (ADR-0050)
#   MEMOBRAIN_E2E          the in-memory binding mock / the OIDC test double of the end-to-end tests
#   MEMOBRAIN_DIST         builds the front end somewhere else: Go would embed (or the image copy) whatever an
#                          older build left in apps/desktop/frontend/dist or web/dist, a test build included
#
#   scripts/release/check-editor-switches.sh
#
# Plain POSIX sh: the cloud image runs it in a node:alpine stage (services/cloud/Dockerfile), which has no bash.
# The scripts that call it: build-desktop-bin.sh --release, release/build-desktop.sh --release, `task web-build`.
# The other half of the guard is check-dist.sh, which looks at what was built.
set -eu

set_vars=""
for name in MEMOBRAIN_AI MEMOBRAIN_COLLAB MEMOBRAIN_E2E MEMOBRAIN_DIST; do
  eval "value=\${$name:-}"
  [ -z "$value" ] || set_vars="$set_vars $name"
done
if [ -n "$set_vars" ]; then
  echo "error: a release build must not have these build variables set:$set_vars (unset them: they put the AI assistant, collaboration or the test doubles in the release, or build the UI where the release does not look)" >&2
  exit 1
fi
